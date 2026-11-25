import {
  chebyshevDistance,
  clonePiece,
  cloneTiles,
  coordEquals,
  createEmptyTiles,
  createTile,
  findLegalMove,
  getEffectiveDriftSign,
  getPieceAt,
  getPieceById,
  getTile,
  hasFrenzyHaste,
  inBounds,
  isKnightMove,
  isTileWalkable,
  manhattanDistance,
  opponentOf,
  shouldPromotePawn,
} from './board';
import {
  advanceAllSpikes,
  applySpikeTrapDamageAt,
  buildIgnitedTile,
  collapseCrackedTile,
  collectPathCrackedCollapses,
  compareIdsCanonical,
  findArrowEmitterById,
  findMiasmaIgnitionOrigins,
  fireArrowEmitter,
  getExtinguishTargetTile,
  hasActiveShield,
  hasMiasma,
  isPieceImmuneToMiasmaSuffocation,
  isPressurePlate,
  resolveGasDetonation,
  shouldChokeOnMiasmaLanding,
  tickPressurePlateCooldowns,
  tickTemporaryMiasma,
  triggerPressurePlate,
} from './dungeon';
import { recomputeAllFog } from './fog';
import { seedToRngState } from './prng';
import {
  adjustComposure,
  evaluateDisobedience,
  evolveChimeraOnCapture,
  findCanonicalAdjacentPiece,
  getComposure,
  isSilenced,
  runSaintEndOfTurnAuras,
} from './psychology';
import {
  applyFrostTouch,
  enqueueNecromancerSpawn,
  hasTrait,
  resolvePushOutcome,
} from './traits';
import {
  Coord,
  DEFAULT_BURN_TURNS,
  FactionPassive,
  GameAction,
  GameEvent,
  GameMode,
  GameState,
  MAX_CHAIN_ITERATIONS,
  MIASMA_SUFFOCATION_THRESHOLD,
  MatchEndReason,
  PendingSpawn,
  Piece,
  Side,
  StepResult,
  TileState,
} from './types';

export interface CreateGameStateConfig {
  width: number;
  height: number;
  tiles?: readonly (readonly TileState[])[];
  pieces: readonly Piece[];
  mode?: GameMode;
  turn?: Side;
  factions?: Partial<Record<Side, FactionPassive>>;
  seed?: string | number;
  bossCooldown?: number;
}

const EXPLOSIVE_OFFSETS: readonly Coord[] = [
  { x: 0, y: 0 },
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

function cloneAction(action: GameAction): GameAction {
  if (action.type === 'MOVE') {
    return { type: 'MOVE', pieceId: action.pieceId, to: { x: action.to.x, y: action.to.y } };
  }
  if (action.type === 'USE_ABILITY') {
    return {
      type: 'USE_ABILITY',
      pieceId: action.pieceId,
      ability: action.ability,
      target: { x: action.target.x, y: action.target.y },
    };
  }
  return { type: 'END_TURN' };
}

function cloneGameState(state: GameState): GameState {
  return {
    width: state.width,
    height: state.height,
    tiles: cloneTiles(state.tiles),
    pieces: state.pieces.map(clonePiece),
    turn: state.turn,
    turnNumber: state.turnNumber,
    mode: state.mode,
    factions: { PLAYER: state.factions.PLAYER, ENEMY: state.factions.ENEMY },
    fog: {
      PLAYER: state.fog.PLAYER.map((row) => row.slice()),
      ENEMY: state.fog.ENEMY.map((row) => row.slice()),
    },
    pendingSpawns: state.pendingSpawns.map((sp) => ({
      pos: { x: sp.pos.x, y: sp.pos.y },
      turnsRemaining: sp.turnsRemaining,
      side: sp.side,
      pieceType: sp.pieceType,
    })),
    bonusMovePieceId: state.bonusMovePieceId,
    rngState: state.rngState,
    actionHistory: state.actionHistory.map(cloneAction),
    winner: state.winner,
    nextEntityId: state.nextEntityId,
    bossCooldown: state.bossCooldown,
  };
}

function snapshotTurnStartVisibility(state: GameState, side: Side): void {
  const oppFog = state.fog[opponentOf(side)];
  for (let i = 0; i < state.pieces.length; i++) {
    const p = state.pieces[i]!;
    if (p.side !== side) continue;
    p.usedDashThisTurn = false;
    p.wasVisibleAtTurnStart = oppFog[p.pos.y]?.[p.pos.x] === 'VISIBLE';
  }
}

/**
 * Creates a fully initialized, JSON-serializable GameState with initial Fog of War
 * and turn-start visibility snapshots computed.
 */
export function createGameState(config: CreateGameStateConfig): GameState {
  const tiles =
    config.tiles !== undefined
      ? cloneTiles(config.tiles)
      : createEmptyTiles(config.width, config.height, 'PLAIN');
  const pieces = config.pieces.map(clonePiece);
  const turn: Side = config.turn ?? 'PLAYER';
  const factions: Record<Side, FactionPassive> = {
    PLAYER: config.factions?.PLAYER ?? 'NONE',
    ENEMY: config.factions?.ENEMY ?? 'NONE',
  };

  const baseBoard = {
    width: config.width,
    height: config.height,
    tiles,
    pieces,
    factions,
  };
  const fog = recomputeAllFog(baseBoard);

  const state: GameState = {
    width: config.width,
    height: config.height,
    tiles,
    pieces,
    turn,
    turnNumber: 1,
    mode: config.mode ?? 'SANDBOX',
    factions,
    fog,
    pendingSpawns: [],
    bonusMovePieceId: null,
    rngState: seedToRngState(config.seed ?? 'default-seed'),
    actionHistory: [],
    winner: null,
    nextEntityId: 1,
    bossCooldown: config.bossCooldown ?? 0,
  };

  snapshotTurnStartVisibility(state, turn);
  return state;
}

interface KingLossTracker {
  hadPlayerKing: boolean;
  hadEnemyKing: boolean;
  playerCause: MatchEndReason | null;
  enemyCause: MatchEndReason | null;
}

type ReactiveTask =
  | { kind: 'TRIGGER_PLATE'; pos: Coord; triggeredByPieceId: string }
  | { kind: 'BERSERK_PUSH'; pusherId: string; targetId: string }
  | {
      kind: 'PIECE_DIED';
      piece: Piece;
      cause: MatchEndReason;
      pos: Coord;
      fellInPit: boolean;
    }
  | { kind: 'IGNITE_TILE'; pos: Coord; burnTurns: number; fromBlast: boolean }
  | { kind: 'DETONATE_GAS'; origin: Coord };

/**
 * Local per-stepGame() execution context (never persisted to GameState).
 */
interface StepContext {
  newlyFrozenIds: Set<string>;
  firedPlateIds: Set<string>;
  newlySilencedIds: Set<string>;
  allyDeathShakenIds: Set<string>;
  kingTracker: KingLossTracker;
  reactiveQueue: ReactiveTask[];
  damagedEnemyIds: string[];
  enemyCombatCoords: Coord[];
}

function recordKingDeathCause(
  tracker: KingLossTracker,
  piece: Piece,
  cause: MatchEndReason,
): void {
  if (piece.type !== 'KING') return;
  if (piece.side === 'PLAYER' && tracker.playerCause === null) {
    tracker.playerCause = cause;
  } else if (piece.side === 'ENEMY' && tracker.enemyCause === null) {
    tracker.enemyCause = cause;
  }
}

function checkMatchEnd(
  pieces: readonly Piece[],
  tracker: KingLossTracker,
): { winner: Side | 'DRAW'; reason: MatchEndReason } | null {
  const hasPlayerKing = pieces.some((p) => p.side === 'PLAYER' && p.type === 'KING');
  const hasEnemyKing = pieces.some((p) => p.side === 'ENEMY' && p.type === 'KING');

  const playerLost = tracker.hadPlayerKing && !hasPlayerKing;
  const enemyLost = tracker.hadEnemyKing && !hasEnemyKing;

  if (playerLost && enemyLost) {
    return { winner: 'DRAW', reason: 'MUTUAL_ELIMINATION' };
  }
  if (enemyLost) {
    return { winner: 'PLAYER', reason: tracker.enemyCause ?? 'KING_CAPTURED' };
  }
  if (playerLost) {
    return { winner: 'ENEMY', reason: tracker.playerCause ?? 'KING_CAPTURED' };
  }
  return null;
}

function executePushPhysics(
  next: GameState,
  pusher: Piece,
  pushedPiece: Piece,
  ctx: StepContext,
  events: GameEvent[],
): void {
  const origPos = { x: pushedPiece.pos.x, y: pushedPiece.pos.y };
  const targetHadFrenzyHaste = hasFrenzyHaste(next, pushedPiece);
  const outcome = resolvePushOutcome(next, pusher, pushedPiece);

  if (pushedPiece.side === 'ENEMY') {
    ctx.enemyCombatCoords.push({ x: pushedPiece.pos.x, y: pushedPiece.pos.y });
  }

  if (outcome.blocked) {
    events.push({
      type: 'PIECE_PUSHED',
      pieceId: pushedPiece.id,
      byPieceId: pusher.id,
      from: origPos,
      to: origPos,
    });
    if (pushedPiece.side === 'ENEMY') {
      ctx.damagedEnemyIds.push(pushedPiece.id);
    }
    return;
  }

  const pushedPath: Coord[] =
    outcome.slidePath.length > 0
      ? [origPos, ...outcome.slidePath]
      : [origPos, { x: outcome.dest.x, y: outcome.dest.y }];

  // Collapse CRACKED departure / pass-through tiles
  const collapses = collectPathCrackedCollapses(next.tiles, pushedPath, false);
  for (let i = 0; i < collapses.length; i++) {
    const col = collapses[i]!;
    collapseCrackedTile(next.tiles, next.width, next.height, col.at, col.reason, events);
  }

  events.push({
    type: 'PIECE_PUSHED',
    pieceId: pushedPiece.id,
    byPieceId: pusher.id,
    from: origPos,
    to: { x: outcome.dest.x, y: outcome.dest.y },
  });

  if (outcome.slid && outcome.slidePath.length > 0) {
    const slideEnd = outcome.slidePath[outcome.slidePath.length - 1]!;
    events.push({
      type: 'PIECE_SLID',
      pieceId: pushedPiece.id,
      path: outcome.slidePath.map((c) => ({ x: c.x, y: c.y })),
      to: { x: slideEnd.x, y: slideEnd.y },
    });
  }

  let pushedSurvived = true;

  if (outcome.fellInPit) {
    pushedSurvived = false;
    const pitPos =
      outcome.slidePath.length > 0
        ? outcome.slidePath[outcome.slidePath.length - 1]!
        : outcome.dest;
    const idx = next.pieces.findIndex((p) => p.id === pushedPiece.id);
    if (idx !== -1) {
      next.pieces.splice(idx, 1);
    }
    events.push({
      type: 'PIECE_FELL_IN_PIT',
      pieceId: pushedPiece.id,
      pos: { x: pitPos.x, y: pitPos.y },
      pieceType: pushedPiece.type,
      side: pushedPiece.side,
    });
    ctx.reactiveQueue.push({
      kind: 'PIECE_DIED',
      piece: pushedPiece,
      cause: 'KING_FELL_IN_PIT',
      pos: { x: pitPos.x, y: pitPos.y },
      fellInPit: true,
    });
  } else if (outcome.finalPos !== null) {
    pushedPiece.pos = { x: outcome.finalPos.x, y: outcome.finalPos.y };
    if (pushedPiece.side === 'ENEMY') {
      ctx.damagedEnemyIds.push(pushedPiece.id);
    }
  }

  // Trigger any PRESSURE_PLATE entered along pushedPath[1..n]
  for (let i = 1; i < pushedPath.length; i++) {
    const stepPos = pushedPath[i]!;
    const stepTile = next.tiles[stepPos.y]?.[stepPos.x];
    if (isPressurePlate(stepTile)) {
      ctx.reactiveQueue.push({
        kind: 'TRIGGER_PLATE',
        pos: { x: stepPos.x, y: stepPos.y },
        triggeredByPieceId: pushedPiece.id,
      });
    }
  }

  // Immediate EXTENDED SPIKES check on pushed landing square
  if (pushedSurvived && outcome.finalPos !== null) {
    const spikeHit = applySpikeTrapDamageAt(
      next.tiles,
      next.pieces,
      pushedPiece.id,
      outcome.finalPos,
      events,
    );
    if (spikeHit.shieldBroken) {
      adjustComposure(pushedPiece, -1, 'SHIELD_BROKEN', events, ctx.newlyFrozenIds);
    }
    if (spikeHit.killedPiece !== null) {
      pushedSurvived = false;
      ctx.reactiveQueue.push({
        kind: 'PIECE_DIED',
        piece: spikeHit.killedPiece.piece,
        cause: 'KING_SKEWERED',
        pos: spikeHit.killedPiece.pos,
        fellInPit: false,
      });
    }
  }

  // Immediate MIASMA landing choke for pushed PAWN / KING
  if (pushedSurvived && outcome.finalPos !== null) {
    const landingTile = getTile(next, outcome.finalPos);
    if (shouldChokeOnMiasmaLanding(pushedPiece, landingTile, targetHadFrenzyHaste)) {
      pushedPiece.frozenTurns = Math.max(pushedPiece.frozenTurns, 1);
      ctx.newlyFrozenIds.add(pushedPiece.id);
      events.push({
        type: 'PIECE_CHOKED_BY_MIASMA',
        pieceId: pushedPiece.id,
        at: { x: outcome.finalPos.x, y: outcome.finalPos.y },
      });
    }
  }
}

function drainReactiveQueue(
  next: GameState,
  ctx: StepContext,
  events: GameEvent[],
): void {
  let iterations = 0;

  while (ctx.reactiveQueue.length > 0 && iterations < MAX_CHAIN_ITERATIONS) {
    iterations += 1;
    const task = ctx.reactiveQueue.shift()!;

    switch (task.kind) {
      case 'TRIGGER_PLATE': {
        const trig = triggerPressurePlate(
          next.tiles,
          next.width,
          next.height,
          task.pos,
          task.triggeredByPieceId,
          ctx.firedPlateIds,
          events,
        );
        if (!trig.triggered) break;

        for (let i = 0; i < trig.emitterIds.length; i++) {
          const emitterId = trig.emitterIds[i]!;
          const found = findArrowEmitterById(next.tiles, next.width, next.height, emitterId);
          if (found === null) continue;

          const shot = fireArrowEmitter(
            next.tiles,
            next.pieces,
            next.width,
            next.height,
            found.pos,
            events,
          );

          for (let k = 0; k < shot.killedPieces.length; k++) {
            const victim = shot.killedPieces[k]!;
            ctx.reactiveQueue.push({
              kind: 'PIECE_DIED',
              piece: victim.piece,
              cause: 'KING_SKEWERED',
              pos: victim.pos,
              fellInPit: false,
            });
          }

          for (let s = 0; s < shot.shieldBrokenPieceIds.length; s++) {
            const brokenId = shot.shieldBrokenPieceIds[s]!;
            const broken = getPieceById(next.pieces, brokenId);
            if (broken !== undefined) {
              adjustComposure(broken, -1, 'SHIELD_BROKEN', events, ctx.newlyFrozenIds);
              if (broken.side === 'ENEMY') {
                ctx.damagedEnemyIds.push(broken.id);
                ctx.enemyCombatCoords.push({ x: broken.pos.x, y: broken.pos.y });
              }
            }
          }

          if (shot.firstMiasmaHit !== null) {
            ctx.reactiveQueue.push({
              kind: 'DETONATE_GAS',
              origin: shot.firstMiasmaHit,
            });
          }
        }
        break;
      }

      case 'BERSERK_PUSH': {
        const pusher = getPieceById(next.pieces, task.pusherId);
        const target = getPieceById(next.pieces, task.targetId);
        if (pusher === undefined || target === undefined) break;
        if (manhattanDistance(pusher.pos, target.pos) !== 1) break;
        executePushPhysics(next, pusher, target, ctx, events);
        break;
      }

      case 'PIECE_DIED': {
        recordKingDeathCause(ctx.kingTracker, task.piece, task.cause);
        if (task.piece.side === 'ENEMY') {
          ctx.enemyCombatCoords.push({ x: task.pos.x, y: task.pos.y });
        }

        // Nearby friendly composure shock (Chebyshev <= 2, max -1 per piece per stepGame())
        const nearbyAllies = next.pieces
          .filter(
            (p) =>
              p.side === task.piece.side &&
              chebyshevDistance(p.pos, task.pos) <= 2 &&
              !ctx.allyDeathShakenIds.has(p.id),
          )
          .sort((a, b) => compareIdsCanonical(a.id, b.id));

        for (let i = 0; i < nearbyAllies.length; i++) {
          const ally = nearbyAllies[i]!;
          ctx.allyDeathShakenIds.add(ally.id);
          adjustComposure(ally, -1, 'ALLY_DEATH', events, ctx.newlyFrozenIds);
        }

        if (!task.fellInPit) {
          if (hasTrait(task.piece, 'EXPLOSIVE', next.factions)) {
            for (let i = 0; i < EXPLOSIVE_OFFSETS.length; i++) {
              const off = EXPLOSIVE_OFFSETS[i]!;
              ctx.reactiveQueue.push({
                kind: 'IGNITE_TILE',
                pos: { x: task.pos.x + off.x, y: task.pos.y + off.y },
                burnTurns: DEFAULT_BURN_TURNS,
                fromBlast: true,
              });
            }
          }
          enqueueNecromancerSpawn(next.pendingSpawns, task.piece, next.factions, next.tiles);
        }
        break;
      }

      case 'IGNITE_TILE': {
        if (!inBounds(next, task.pos)) break;
        const row = next.tiles[task.pos.y];
        const current = row?.[task.pos.x];
        if (row === undefined || current === undefined) break;
        if (current.type === 'WALL' || current.type === 'PIT') break;

        if (hasMiasma(current)) {
          ctx.reactiveQueue.push({
            kind: 'DETONATE_GAS',
            origin: { x: task.pos.x, y: task.pos.y },
          });
          break;
        }

        if (task.fromBlast && current.type === 'CRACKED') {
          const adjGasOrigins = findMiasmaIgnitionOrigins(next.tiles, next.width, next.height, task.pos);
          collapseCrackedTile(next.tiles, next.width, next.height, task.pos, 'BLAST', events);

          const victimIdx = next.pieces.findIndex(
            (p) => p.pos.x === task.pos.x && p.pos.y === task.pos.y,
          );
          if (victimIdx !== -1) {
            const victim = next.pieces[victimIdx]!;
            next.pieces.splice(victimIdx, 1);
            events.push({
              type: 'PIECE_FELL_IN_PIT',
              pieceId: victim.id,
              pos: { x: task.pos.x, y: task.pos.y },
              pieceType: victim.type,
              side: victim.side,
            });
            ctx.reactiveQueue.push({
              kind: 'PIECE_DIED',
              piece: victim,
              cause: 'KING_FELL_IN_PIT',
              pos: { x: task.pos.x, y: task.pos.y },
              fellInPit: true,
            });
          }

          if (adjGasOrigins.length > 0) {
            ctx.reactiveQueue.push({
              kind: 'DETONATE_GAS',
              origin: adjGasOrigins[0]!,
            });
          }
          break;
        }

        row[task.pos.x] = buildIgnitedTile(current, task.burnTurns);
        events.push({
          type: 'TILE_IGNITED',
          pos: { x: task.pos.x, y: task.pos.y },
          burnTurns: task.burnTurns,
        });

        const gasOrigins = findMiasmaIgnitionOrigins(next.tiles, next.width, next.height, task.pos);
        if (gasOrigins.length > 0) {
          ctx.reactiveQueue.push({
            kind: 'DETONATE_GAS',
            origin: gasOrigins[0]!,
          });
        }
        break;
      }

      case 'DETONATE_GAS': {
        const blast = resolveGasDetonation(
          next.tiles,
          next.pieces,
          next.width,
          next.height,
          task.origin,
          events,
        );

        for (let k = 0; k < blast.killedPieces.length; k++) {
          const victim = blast.killedPieces[k]!;
          ctx.reactiveQueue.push({
            kind: 'PIECE_DIED',
            piece: victim.piece,
            cause: victim.cause === 'PIT' ? 'KING_FELL_IN_PIT' : 'KING_INCINERATED',
            pos: victim.pos,
            fellInPit: victim.cause === 'PIT',
          });
        }

        for (let s = 0; s < blast.shieldBrokenPieceIds.length; s++) {
          const brokenId = blast.shieldBrokenPieceIds[s]!;
          const broken = getPieceById(next.pieces, brokenId);
          if (broken !== undefined) {
            adjustComposure(broken, -1, 'SHIELD_BROKEN', events, ctx.newlyFrozenIds);
            if (broken.side === 'ENEMY') {
              ctx.damagedEnemyIds.push(broken.id);
              ctx.enemyCombatCoords.push({ x: broken.pos.x, y: broken.pos.y });
            }
          }
        }
        break;
      }
    }
  }
}

function applyBossElementalRing(
  next: GameState,
  center: Coord,
  ctx: StepContext,
  events: GameEvent[],
): void {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const pos: Coord = { x: center.x + dx, y: center.y + dy };
      if (!inBounds(next, pos)) continue;
      const row = next.tiles[pos.y];
      const current = row?.[pos.x];
      if (row === undefined || current === undefined) continue;
      if (current.type === 'WALL' || current.type === 'PIT') continue;

      if (Math.abs(dx) + Math.abs(dy) === 1) {
        if (hasMiasma(current)) {
          ctx.reactiveQueue.push({ kind: 'DETONATE_GAS', origin: pos });
          continue;
        }
        row[pos.x] = buildIgnitedTile(current, DEFAULT_BURN_TURNS);
        events.push({
          type: 'TILE_IGNITED',
          pos,
          burnTurns: DEFAULT_BURN_TURNS,
        });
        const gasOrigins = findMiasmaIgnitionOrigins(next.tiles, next.width, next.height, pos);
        if (gasOrigins.length > 0) {
          ctx.reactiveQueue.push({ kind: 'DETONATE_GAS', origin: gasOrigins[0]! });
        }
      } else if (current.type === 'PLAIN' && current.trap === undefined) {
        row[pos.x] = createTile('ICE', 0, undefined, {
          gas: current.gas !== undefined ? { ...current.gas } : undefined,
        });
      }
    }
  }
}

function updateCampaignAlerts(
  state: GameState,
  damagedEnemyIds: readonly string[],
  enemyCombatCoords: readonly Coord[],
  events: GameEvent[],
): void {
  if (state.mode !== 'CAMPAIGN') return;

  const playerFog = state.fog.PLAYER;
  for (let i = 0; i < state.pieces.length; i++) {
    const piece = state.pieces[i]!;
    if (piece.side !== 'ENEMY' || piece.aggro !== 'SLEEPING') continue;

    const seenByPlayer = playerFog[piece.pos.y]?.[piece.pos.x] === 'VISIBLE';
    const directlyDamaged = damagedEnemyIds.includes(piece.id);
    const allyAttackedNearby = enemyCombatCoords.some(
      (coord) => chebyshevDistance(piece.pos, coord) <= 2,
    );

    if (seenByPlayer || directlyDamaged || allyAttackedNearby) {
      piece.aggro = 'ALERTED';
      events.push({
        type: 'ENEMY_ALERTED',
        pieceId: piece.id,
        pos: { x: piece.pos.x, y: piece.pos.y },
      });
    }
  }
}

function finishWithMatchEnd(
  next: GameState,
  matchEnd: { winner: Side | 'DRAW'; reason: MatchEndReason },
  events: GameEvent[],
): void {
  next.fog = recomputeAllFog(next, next.fog);
  next.winner = matchEnd.winner;
  next.bonusMovePieceId = null;
  events.push({
    type: 'MATCH_ENDED',
    winner: matchEnd.winner,
    reason: matchEnd.reason,
  });
}

function runEndOfTurnSteps7To9(
  next: GameState,
  finishingSide: Side,
  preAlertedIds: readonly string[],
  ctx: StepContext,
  events: GameEvent[],
): void {
  // Step 7: End-of-turn environment, psychology, Saint auras, silence & unfreeze (canonical piece.id order)
  const activeIds = next.pieces
    .filter((p) => p.side === finishingSide)
    .map((p) => p.id)
    .sort(compareIdsCanonical);

  // 7.1: BURNING tile damage & -1 composure for survivors
  for (let i = 0; i < activeIds.length; i++) {
    const pieceId = activeIds[i]!;
    const idx = next.pieces.findIndex((p) => p.id === pieceId);
    if (idx === -1) continue;
    const piece = next.pieces[idx]!;
    const tile = getTile(next, piece.pos);
    if (tile === undefined || tile === null || tile.type !== 'BURNING') continue;

    const pos = { x: piece.pos.x, y: piece.pos.y };
    if (hasActiveShield(piece)) {
      piece.shieldActive = false;
      events.push({
        type: 'SHIELD_BROKEN',
        pieceId: piece.id,
        pos,
        source: 'BURN',
      });
      events.push({
        type: 'PIECE_BURNED',
        pieceId: piece.id,
        pos,
        killed: false,
      });
      adjustComposure(piece, -1, 'HAZARD', events, ctx.newlyFrozenIds);
    } else {
      next.pieces.splice(idx, 1);
      events.push({
        type: 'PIECE_BURNED',
        pieceId: piece.id,
        pos,
        killed: true,
      });
      ctx.reactiveQueue.push({
        kind: 'PIECE_DIED',
        piece,
        cause: 'KING_BURNED',
        pos,
        fellInPit: false,
      });
    }
  }

  // 7.2: MIASMA exposure (+1 exposure, -1 composure; >= 2 suffocation)
  for (let i = 0; i < activeIds.length; i++) {
    const pieceId = activeIds[i]!;
    const idx = next.pieces.findIndex((p) => p.id === pieceId);
    if (idx === -1) continue;
    const piece = next.pieces[idx]!;
    if (isPieceImmuneToMiasmaSuffocation(piece)) continue;

    const tile = getTile(next, piece.pos);
    if (hasMiasma(tile)) {
      const nextExposure = (piece.miasmaExposure ?? 0) + 1;
      piece.miasmaExposure = nextExposure;
      const pos = { x: piece.pos.x, y: piece.pos.y };
      events.push({
        type: 'PIECE_MIASMA_TICK',
        pieceId: piece.id,
        at: pos,
        exposure: nextExposure,
      });

      if (nextExposure >= MIASMA_SUFFOCATION_THRESHOLD) {
        if (hasActiveShield(piece)) {
          piece.shieldActive = false;
          piece.miasmaExposure = 1;
          events.push({
            type: 'SHIELD_BROKEN',
            pieceId: piece.id,
            pos,
            source: 'MIASMA',
          });
          adjustComposure(piece, -1, 'HAZARD', events, ctx.newlyFrozenIds);
        } else {
          next.pieces.splice(idx, 1);
          events.push({
            type: 'PIECE_SUFFOCATED',
            pieceId: piece.id,
            at: pos,
          });
          ctx.reactiveQueue.push({
            kind: 'PIECE_DIED',
            piece,
            cause: 'KING_SUFFOCATED',
            pos,
            fellInPit: false,
          });
        }
      } else {
        adjustComposure(piece, -1, 'HAZARD', events, ctx.newlyFrozenIds);
      }
    } else if ((piece.miasmaExposure ?? 0) > 0) {
      delete piece.miasmaExposure;
    }
  }

  // Drain any reactive chains triggered by Step 7.1–7.2 deaths
  drainReactiveQueue(next, ctx, events);

  const step7MidEnd = checkMatchEnd(next.pieces, ctx.kingTracker);
  if (step7MidEnd !== null) {
    finishWithMatchEnd(next, step7MidEnd, events);
    return;
  }

  // 7.3: Saint Auras (SAINT_FAITH 7x7 Cleanse & 2-turn Silence; SAINT_MADNESS Berserk Ready; Decay)
  runSaintEndOfTurnAuras(next, finishingSide, events, ctx.newlyFrozenIds);

  // 7.4: Decrement frozenTurns (!newlyFrozenIds) & recover breakdown (0 -> 1)
  const survivingActive = next.pieces
    .filter((p) => p.side === finishingSide)
    .sort((a, b) => compareIdsCanonical(a.id, b.id));

  for (let i = 0; i < survivingActive.length; i++) {
    const piece = survivingActive[i]!;
    if (piece.frozenTurns > 0 && !ctx.newlyFrozenIds.has(piece.id)) {
      piece.frozenTurns = Math.max(0, piece.frozenTurns - 1);
      if (piece.frozenTurns === 0 && getComposure(piece) === 0) {
        adjustComposure(piece, 1, 'BREAKDOWN_RECOVERY', events, ctx.newlyFrozenIds);
      }
    }
  }

  // 7.5: Decrement silencedTurns (!newlySilencedIds) for active side
  for (let i = 0; i < survivingActive.length; i++) {
    const piece = survivingActive[i]!;
    if (
      piece.type !== 'CHIMERA' &&
      (piece.silencedTurns ?? 0) > 0 &&
      !ctx.newlySilencedIds.has(piece.id)
    ) {
      const nextSil = (piece.silencedTurns ?? 0) - 1;
      if (nextSil <= 0) {
        delete piece.silencedTurns;
        events.push({ type: 'PIECE_SILENCE_EXPIRED', pieceId: piece.id });
      } else {
        piece.silencedTurns = nextSil;
      }
    }
  }

  // Step 8: Rhythmic SPIKES & Global Counters
  const spikeRes = advanceAllSpikes(next.tiles, next.pieces, next.width, next.height, events);
  for (let s = 0; s < spikeRes.shieldBrokenPieceIds.length; s++) {
    const broken = getPieceById(next.pieces, spikeRes.shieldBrokenPieceIds[s]!);
    if (broken !== undefined) {
      adjustComposure(broken, -1, 'SHIELD_BROKEN', events, ctx.newlyFrozenIds);
    }
  }
  for (let k = 0; k < spikeRes.killedPieces.length; k++) {
    const victim = spikeRes.killedPieces[k]!;
    ctx.reactiveQueue.push({
      kind: 'PIECE_DIED',
      piece: victim.piece,
      cause: 'KING_SKEWERED',
      pos: victim.pos,
      fellInPit: false,
    });
  }
  drainReactiveQueue(next, ctx, events);

  // 8.2: Decrement burnTurns on all BURNING tiles; extinguish those reaching 0
  for (let y = 0; y < next.height; y++) {
    const row = next.tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < next.width; x++) {
      const tile = row[x];
      if (tile === undefined || tile.type !== 'BURNING') continue;
      tile.burnTurns -= 1;
      if (tile.burnTurns <= 0) {
        const restored = getExtinguishTargetTile(tile);
        row[x] = restored;
        events.push({
          type: 'TILE_EXTINGUISHED',
          pos: { x, y },
          revertedTo: restored.type,
        });
      }
    }
  }

  // 8.3: Tick temporary MIASMA and PRESSURE_PLATE cooldowns
  tickTemporaryMiasma(next.tiles, next.width, next.height);
  tickPressurePlateCooldowns(next.tiles, next.width, next.height);

  // 8.4: Decrement pendingSpawns; spawn skeleton Pawns on empty walkable tiles when 0
  const remainingSpawns: PendingSpawn[] = [];
  for (let i = 0; i < next.pendingSpawns.length; i++) {
    const sp = next.pendingSpawns[i]!;
    sp.turnsRemaining -= 1;
    if (sp.turnsRemaining <= 0) {
      const tile = getTile(next, sp.pos);
      const occupant = getPieceAt(next.pieces, sp.pos);
      if (isTileWalkable(tile) && occupant === undefined) {
        const spawnedId = `spawn_${next.nextEntityId}`;
        next.nextEntityId += 1;
        const spawned: Piece = {
          id: spawnedId,
          side: sp.side,
          type: sp.pieceType,
          pos: { x: sp.pos.x, y: sp.pos.y },
          traits: [],
          shieldActive: false,
          frozenTurns: 0,
          hasMoved: true,
          aggro: 'ACTIVE',
          usedDashThisTurn: false,
          wasVisibleAtTurnStart: false,
        };
        next.pieces.push(spawned);
        events.push({
          type: 'UNIT_SPAWNED',
          pieceId: spawned.id,
          pos: { x: spawned.pos.x, y: spawned.pos.y },
          side: spawned.side,
          pieceType: spawned.type,
        });
      }
    } else {
      remainingSpawns.push(sp);
    }
  }
  next.pendingSpawns = remainingSpawns;

  // 8.5: Boss 3-turn Ice/Fire elemental ring around surviving Boss King
  if (finishingSide === 'ENEMY' && next.bossCooldown > 0) {
    const boss = next.pieces.find((p) => p.side === 'ENEMY' && p.isBoss === true);
    if (boss !== undefined) {
      next.bossCooldown -= 1;
      if (next.bossCooldown <= 0) {
        next.bossCooldown = 3;
        applyBossElementalRing(next, boss.pos, ctx, events);
        drainReactiveQueue(next, ctx, events);
      }
    }
  }

  // Step 9: Final win check & turn handoff
  const finalEnd = checkMatchEnd(next.pieces, ctx.kingTracker);
  if (finalEnd !== null) {
    finishWithMatchEnd(next, finalEnd, events);
    return;
  }

  if (next.mode === 'CAMPAIGN') {
    for (let i = 0; i < next.pieces.length; i++) {
      const p = next.pieces[i]!;
      if (p.side === finishingSide && p.aggro === 'ALERTED' && preAlertedIds.includes(p.id)) {
        p.aggro = 'ACTIVE';
      }
    }
  }

  next.fog = recomputeAllFog(next, next.fog);
  updateCampaignAlerts(next, ctx.damagedEnemyIds, ctx.enemyCombatCoords, events);

  const nextTurn = opponentOf(finishingSide);
  next.turn = nextTurn;
  next.turnNumber += 1;
  next.bonusMovePieceId = null;

  snapshotTurnStartVisibility(next, nextTurn);

  events.push({
    type: 'TURN_CHANGED',
    nextTurn,
    turnNumber: next.turnNumber,
  });
}

function reject(state: GameState, error: string): StepResult {
  return { nextState: state, events: [], error };
}

function createStepContext(state: GameState): StepContext {
  return {
    newlyFrozenIds: new Set<string>(),
    firedPlateIds: new Set<string>(),
    newlySilencedIds: new Set<string>(),
    allyDeathShakenIds: new Set<string>(),
    kingTracker: {
      hadPlayerKing: state.pieces.some((p) => p.side === 'PLAYER' && p.type === 'KING'),
      hadEnemyKing: state.pieces.some((p) => p.side === 'ENEMY' && p.type === 'KING'),
      playerCause: null,
      enemyCause: null,
    },
    reactiveQueue: [],
    damagedEnemyIds: [],
    enemyCombatCoords: [],
  };
}

/**
 * Pure event-producing reducer implementing the unified 9-step deterministic turn resolution pipeline.
 * Never mutates `state`; returns original `state` with `error` on invalid actions.
 */
export function stepGame(state: GameState, action: GameAction): StepResult {
  if (state.winner !== null) {
    return reject(state, 'Match has already ended');
  }

  const activeSide = state.turn;
  const ctx = createStepContext(state);
  const preAlertedIds = state.pieces
    .filter((p) => p.side === activeSide && p.aggro === 'ALERTED')
    .map((p) => p.id);

  // Anti-softlock / turn pass action
  if (action.type === 'END_TURN') {
    const next = cloneGameState(state);
    const events: GameEvent[] = [];
    next.actionHistory.push(cloneAction(action));
    next.bonusMovePieceId = null;
    runEndOfTurnSteps7To9(next, activeSide, preAlertedIds, ctx, events);
    return { nextState: next, events };
  }

  // Step 1: Common piece validation for MOVE and USE_ABILITY
  const actorOrig = getPieceById(state.pieces, action.pieceId);
  if (actorOrig === undefined) {
    return reject(state, `Piece not found: ${action.pieceId}`);
  }
  if (actorOrig.side !== activeSide) {
    return reject(state, `Piece ${action.pieceId} does not belong to active side ${activeSide}`);
  }
  if (state.bonusMovePieceId !== null && state.bonusMovePieceId !== actorOrig.id) {
    return reject(
      state,
      `Bonus move must be performed by piece ${state.bonusMovePieceId} or ended via END_TURN`,
    );
  }
  if (actorOrig.frozenTurns > 0) {
    return reject(state, `Piece ${action.pieceId} is frozen for ${actorOrig.frozenTurns} turn(s)`);
  }
  if (state.mode === 'CAMPAIGN' && actorOrig.side === 'ENEMY' && actorOrig.aggro !== 'ACTIVE') {
    return reject(state, `Campaign enemy piece ${action.pieceId} is ${actorOrig.aggro}, not ACTIVE`);
  }

  // Handle MOVE
  if (action.type === 'MOVE') {
    const legalMove = findLegalMove(state, actorOrig, action.to, state.bonusMovePieceId);
    if (legalMove === undefined) {
      return reject(
        state,
        `Illegal move for piece ${action.pieceId} to (${action.to.x}, ${action.to.y})`,
      );
    }

    // Disobedience check: if fragile piece refuses, turn does NOT change
    const disob = evaluateDisobedience(
      state,
      actorOrig,
      legalMove,
      state.fog[activeSide],
      state.turnNumber,
    );
    if (disob.disobeyed) {
      return {
        nextState: state,
        events: [
          {
            type: 'PIECE_DISOBEYED',
            pieceId: actorOrig.id,
            attemptedTo: { x: action.to.x, y: action.to.y },
            quote: disob.quote ?? 'O kareye yürümüyorum!',
          },
        ],
      };
    }

    const next = cloneGameState(state);
    const events: GameEvent[] = [];
    next.actionHistory.push(cloneAction(action));
    next.bonusMovePieceId = null;

    const mover = getPieceById(next.pieces, action.pieceId)!;
    const moverHadFrenzyHaste = hasFrenzyHaste(next, mover);
    const res = legalMove.resolution;
    const isJump =
      mover.type === 'KNIGHT' ||
      (mover.type === 'CHIMERA' && isKnightMove(legalMove.from, legalMove.to));
    let shieldBrokenTargetId: string | null = null;
    let berserkBonusGranted = false;

    mover.hasMoved = true;

    // Step 2: CRACKED tile departure & pass-through collapses
    const collapses = collectPathCrackedCollapses(next.tiles, res.path, isJump);
    for (let i = 0; i < collapses.length; i++) {
      const col = collapses[i]!;
      collapseCrackedTile(next.tiles, next.width, next.height, col.at, col.reason, events);
    }

    // Step 3: Primary movement, 45° Drift, ICE sliding, combat & path triggers
    if (legalMove.isDrifted === true) {
      const usedSign = legalMove.driftSign ?? getEffectiveDriftSign(mover);
      mover.driftSign = usedSign === 1 ? -1 : 1;
      events.push({
        type: 'PIECE_DRIFTED',
        pieceId: mover.id,
        path: res.path.map((c) => ({ x: c.x, y: c.y })),
        driftSign: usedSign,
      });
    }

    if (res.slid) {
      events.push({
        type: 'PIECE_MOVED',
        pieceId: mover.id,
        from: { x: legalMove.from.x, y: legalMove.from.y },
        to: { x: legalMove.to.x, y: legalMove.to.y },
      });

      const iceStartIdx = res.path.findIndex((c) => coordEquals(c, legalMove.to));
      const slideSegment =
        iceStartIdx >= 0
          ? res.path.slice(iceStartIdx).map((c) => ({ x: c.x, y: c.y }))
          : [{ x: legalMove.to.x, y: legalMove.to.y }];
      const slideEnd = slideSegment[slideSegment.length - 1]!;
      events.push({
        type: 'PIECE_SLID',
        pieceId: mover.id,
        path: slideSegment,
        to: { x: slideEnd.x, y: slideEnd.y },
      });
    } else if (res.finalPos !== null && !coordEquals(legalMove.from, res.finalPos)) {
      events.push({
        type: 'PIECE_MOVED',
        pieceId: mover.id,
        from: { x: legalMove.from.x, y: legalMove.from.y },
        to: { x: res.finalPos.x, y: res.finalPos.y },
      });
    }

    let moverSurvived = true;

    if (res.fellInPit) {
      moverSurvived = false;
      const pitPos = res.path[res.path.length - 1] ?? legalMove.to;
      const moverIdx = next.pieces.findIndex((p) => p.id === mover.id);
      if (moverIdx !== -1) {
        next.pieces.splice(moverIdx, 1);
      }
      events.push({
        type: 'PIECE_FELL_IN_PIT',
        pieceId: mover.id,
        pos: { x: pitPos.x, y: pitPos.y },
        pieceType: mover.type,
        side: mover.side,
      });
      ctx.reactiveQueue.push({
        kind: 'PIECE_DIED',
        piece: mover,
        cause: 'KING_FELL_IN_PIT',
        pos: { x: pitPos.x, y: pitPos.y },
        fellInPit: true,
      });
    } else if (res.finalPos !== null) {
      mover.pos = { x: res.finalPos.x, y: res.finalPos.y };

      if (res.brokeShield && res.hitPieceId !== null && res.hitPos !== null) {
        const hitTarget = getPieceById(next.pieces, res.hitPieceId);
        if (hitTarget !== undefined) {
          hitTarget.shieldActive = false;
          shieldBrokenTargetId = hitTarget.id;
          events.push({
            type: 'SHIELD_BROKEN',
            pieceId: hitTarget.id,
            pos: { x: res.hitPos.x, y: res.hitPos.y },
            source: 'ATTACK',
          });
          adjustComposure(hitTarget, -1, 'SHIELD_BROKEN', events, ctx.newlyFrozenIds);
          if (hitTarget.side === 'ENEMY') {
            ctx.damagedEnemyIds.push(hitTarget.id);
            ctx.enemyCombatCoords.push({ x: res.hitPos.x, y: res.hitPos.y });
          }
        }
      } else if (res.captured && res.hitPieceId !== null && res.hitPos !== null) {
        const targetIdx = next.pieces.findIndex((p) => p.id === res.hitPieceId);
        if (targetIdx !== -1) {
          const capturedPiece = next.pieces[targetIdx]!;
          next.pieces.splice(targetIdx, 1);
          events.push({
            type: 'PIECE_CAPTURED',
            pieceId: capturedPiece.id,
            byPieceId: mover.id,
            pos: { x: res.hitPos.x, y: res.hitPos.y },
            pieceType: capturedPiece.type,
            side: capturedPiece.side,
          });

          // Attacker composure recovery (+1)
          adjustComposure(mover, 1, 'CAPTURE', events, ctx.newlyFrozenIds);

          // CHIMERA 2-slot FIFO evolution
          if (mover.type === 'CHIMERA') {
            evolveChimeraOnCapture(mover, capturedPiece, events);
          }

          // Berserk Chain (if active and not silenced): bonus move + knockback adjacent piece
          if (mover.berserkReady === true && !isSilenced(mover)) {
            delete mover.berserkReady;
            berserkBonusGranted = true;
            const kicked = findCanonicalAdjacentPiece(next.pieces, mover.pos, mover.id);
            events.push({
              type: 'BERSERK_CHAIN_TRIGGERED',
              pieceId: mover.id,
              at: { x: mover.pos.x, y: mover.pos.y },
              ...(kicked !== undefined ? { kickedPieceId: kicked.id } : {}),
            });
            if (kicked !== undefined) {
              ctx.reactiveQueue.push({
                kind: 'BERSERK_PUSH',
                pusherId: mover.id,
                targetId: kicked.id,
              });
            }
          }

          ctx.reactiveQueue.push({
            kind: 'PIECE_DIED',
            piece: capturedPiece,
            cause: 'KING_CAPTURED',
            pos: { x: res.hitPos.x, y: res.hitPos.y },
            fellInPit: false,
          });
        }
      }
    }

    // Queue PRESSURE_PLATE triggers along every newly entered tile in res.path[1..n]
    for (let i = 1; i < res.path.length; i++) {
      const stepPos = res.path[i]!;
      const stepTile = next.tiles[stepPos.y]?.[stepPos.x];
      if (isPressurePlate(stepTile)) {
        ctx.reactiveQueue.push({
          kind: 'TRIGGER_PLATE',
          pos: { x: stepPos.x, y: stepPos.y },
          triggeredByPieceId: mover.id,
        });
      }
    }

    // Immediate EXTENDED SPIKES check on landing square
    if (moverSurvived && res.finalPos !== null) {
      const spikeHit = applySpikeTrapDamageAt(
        next.tiles,
        next.pieces,
        mover.id,
        res.finalPos,
        events,
      );
      if (spikeHit.shieldBroken) {
        adjustComposure(mover, -1, 'SHIELD_BROKEN', events, ctx.newlyFrozenIds);
      }
      if (spikeHit.killedPiece !== null) {
        moverSurvived = false;
        ctx.reactiveQueue.push({
          kind: 'PIECE_DIED',
          piece: spikeHit.killedPiece.piece,
          cause: 'KING_SKEWERED',
          pos: spikeHit.killedPiece.pos,
          fellInPit: false,
        });
      }
    }

    // Immediate MIASMA landing choke for PAWN / KING (unless FRENZY_HASTE)
    if (moverSurvived && res.finalPos !== null) {
      const landingTile = getTile(next, res.finalPos);
      if (shouldChokeOnMiasmaLanding(mover, landingTile, moverHadFrenzyHaste)) {
        mover.frozenTurns = Math.max(mover.frozenTurns, 1);
        ctx.newlyFrozenIds.add(mover.id);
        events.push({
          type: 'PIECE_CHOKED_BY_MIASMA',
          pieceId: mover.id,
          at: { x: res.finalPos.x, y: res.finalPos.y },
        });
      }
    }

    // Step 4: Drain reactive chain queue (plates -> arrows -> berserk push -> deaths -> explosives -> gas blasts)
    drainReactiveQueue(next, ctx, events);

    const survivingMover = getPieceById(next.pieces, mover.id);
    moverSurvived = survivingMover !== undefined;

    if (moverSurvived && survivingMover !== undefined) {
      applyFrostTouch(next.pieces, survivingMover, shieldBrokenTargetId, events);

      if (shouldPromotePawn(survivingMover, survivingMover.pos, next.height)) {
        const fromType = survivingMover.type;
        survivingMover.type = 'QUEEN';
        events.push({
          type: 'PIECE_PROMOTED',
          pieceId: survivingMover.id,
          pos: { x: survivingMover.pos.x, y: survivingMover.pos.y },
          fromType,
          toType: 'QUEEN',
        });
      }
    }

    // Step 5: Mid-turn win check
    const matchEnd = checkMatchEnd(next.pieces, ctx.kingTracker);
    if (matchEnd !== null) {
      finishWithMatchEnd(next, matchEnd, events);
      return { nextState: next, events };
    }

    // Step 6: Fog, Campaign alerts, and bonus move check (Berserk Chain or DASH_ON_REVEAL)
    next.fog = recomputeAllFog(next, next.fog);
    updateCampaignAlerts(next, ctx.damagedEnemyIds, ctx.enemyCombatCoords, events);

    if (moverSurvived && survivingMover !== undefined && survivingMover.frozenTurns === 0) {
      if (berserkBonusGranted) {
        next.bonusMovePieceId = survivingMover.id;
        return { nextState: next, events };
      }

      if (
        hasTrait(survivingMover, 'DASH_ON_REVEAL', next.factions) &&
        !survivingMover.usedDashThisTurn &&
        !survivingMover.wasVisibleAtTurnStart &&
        next.fog[opponentOf(survivingMover.side)][survivingMover.pos.y]?.[survivingMover.pos.x] ===
          'VISIBLE'
      ) {
        survivingMover.usedDashThisTurn = true;
        next.bonusMovePieceId = survivingMover.id;
        return { nextState: next, events };
      }
    }

    // Steps 7–9: End-of-turn environment, psychology, auras, spikes, global counters, final win check & turn handoff
    runEndOfTurnSteps7To9(next, activeSide, preAlertedIds, ctx, events);
    return { nextState: next, events };
  }

  // Handle USE_ABILITY (PUSH / BREAK_WALL)
  if (!inBounds(state, action.target)) {
    return reject(state, `Ability target out of bounds: (${action.target.x}, ${action.target.y})`);
  }
  if (manhattanDistance(actorOrig.pos, action.target) !== 1) {
    return reject(state, `Ability ${action.ability} requires an orthogonally adjacent target`);
  }

  if (action.ability === 'BREAK_WALL') {
    if (state.factions[actorOrig.side] !== 'SIEGE_ENGINEERS') {
      return reject(state, 'BREAK_WALL requires SIEGE_ENGINEERS faction passive');
    }
    if (actorOrig.type !== 'ROOK') {
      return reject(state, 'BREAK_WALL can only be used by a ROOK');
    }
    const targetTile = getTile(state, action.target);
    if (targetTile === undefined || targetTile === null || targetTile.type !== 'WALL') {
      return reject(state, 'BREAK_WALL target must be a WALL tile');
    }

    const next = cloneGameState(state);
    const events: GameEvent[] = [];
    next.actionHistory.push(cloneAction(action));
    next.bonusMovePieceId = null;

    next.tiles[action.target.y]![action.target.x] = createTile('PLAIN');
    events.push({
      type: 'WALL_DESTROYED',
      pos: { x: action.target.x, y: action.target.y },
      byPieceId: actorOrig.id,
    });

    next.fog = recomputeAllFog(next, next.fog);
    updateCampaignAlerts(next, [], [], events);

    runEndOfTurnSteps7To9(next, activeSide, preAlertedIds, ctx, events);
    return { nextState: next, events };
  }

  if (action.ability === 'PUSH') {
    if (!hasTrait(actorOrig, 'PUSHER', state.factions)) {
      return reject(state, `Piece ${action.pieceId} does not have an active PUSHER trait`);
    }
    const targetOrig = getPieceAt(state.pieces, action.target, actorOrig.id);
    if (targetOrig === undefined || targetOrig.side === actorOrig.side) {
      return reject(state, 'PUSH target must be an orthogonally adjacent enemy piece');
    }

    const next = cloneGameState(state);
    const events: GameEvent[] = [];
    next.actionHistory.push(cloneAction(action));
    next.bonusMovePieceId = null;

    const pusher = getPieceById(next.pieces, actorOrig.id)!;
    const pushedPiece = getPieceById(next.pieces, targetOrig.id)!;

    executePushPhysics(next, pusher, pushedPiece, ctx, events);
    drainReactiveQueue(next, ctx, events);

    const survivingPushed = getPieceById(next.pieces, pushedPiece.id);
    if (
      survivingPushed !== undefined &&
      shouldPromotePawn(survivingPushed, survivingPushed.pos, next.height)
    ) {
      const fromType = survivingPushed.type;
      survivingPushed.type = 'QUEEN';
      events.push({
        type: 'PIECE_PROMOTED',
        pieceId: survivingPushed.id,
        pos: { x: survivingPushed.pos.x, y: survivingPushed.pos.y },
        fromType,
        toType: 'QUEEN',
      });
    }

    const matchEnd = checkMatchEnd(next.pieces, ctx.kingTracker);
    if (matchEnd !== null) {
      finishWithMatchEnd(next, matchEnd, events);
      return { nextState: next, events };
    }

    next.fog = recomputeAllFog(next, next.fog);
    updateCampaignAlerts(next, ctx.damagedEnemyIds, ctx.enemyCombatCoords, events);

    runEndOfTurnSteps7To9(next, activeSide, preAlertedIds, ctx, events);
    return { nextState: next, events };
  }

  return reject(state, `Unknown ability: ${String(action.ability)}`);
}

/**
 * Replays a sequence of actions from an initial GameState deterministically.
 */
export function replayActions(
  initialState: GameState,
  actions: readonly GameAction[],
): { state: GameState; allEvents: GameEvent[]; error?: string } {
  let current = initialState;
  const allEvents: GameEvent[] = [];

  for (let i = 0; i < actions.length; i++) {
    const step = stepGame(current, actions[i]!);
    if (step.error !== undefined) {
      return { state: current, allEvents, error: `Action #${i}: ${step.error}` };
    }
    current = step.nextState;
    for (let e = 0; e < step.events.length; e++) {
      allEvents.push(step.events[e]!);
    }
  }

  return { state: current, allEvents };
}

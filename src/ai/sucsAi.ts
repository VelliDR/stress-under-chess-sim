import {
  chebyshevDistance,
  clonePiece,
  cloneTile,
  cloneTiles,
  coordEquals,
  createTile,
  getLegalMoves,
  getPieceAt,
  getTile,
  inBounds,
  manhattanDistance,
  opponentOf,
} from '../engine/board';
import {
  findMiasmaIgnitionOrigins,
  hasActiveShield,
  hasMiasma,
  isExtendedSpikes,
  isPressurePlate,
  isTelegraphSpikes,
} from '../engine/dungeon';
import { computeFogForSide } from '../engine/fog';
import { nextInt, seedToRngState } from '../engine/prng';
import { isSilenced } from '../engine/psychology';
import { stepGame } from '../engine/reducer';
import { getLegalAbilities, hasTrait, LegalAbility } from '../engine/traits';
import {
  Coord,
  GameAction,
  GameState,
  LegalMove,
  Piece,
  Side,
  TileState,
  VisibleState,
} from '../engine/types';
import {
  AiMemory,
  AI_PIECE_VALUES,
  createAiMemory,
  recordAiSelfMove,
  updateAiMemory,
} from './campaignAi';

export type AiDifficulty = 'CALM' | 'TENSE' | 'PANIC';

export interface AiDifficultyProfile {
  id: AiDifficulty;
  name: string;
  badge: string;
  subtitle: string;
  timeBudgetMs: number;
  maxDepth: number;
  quiesceDepth: number;
  useBeliefRisk: boolean;
  useComboSetup: boolean;
  suboptimalBand: number;
}

export const AI_DIFFICULTY_PROFILES: Readonly<Record<AiDifficulty, AiDifficultyProfile>> = {
  CALM: {
    id: 'CALM',
    name: 'Stajyer',
    badge: 'SAKİN',
    subtitle: 'Temel hamleler yapar, tuzakları bazen gözden kaçırır.',
    timeBudgetMs: 45,
    maxDepth: 2,
    quiesceDepth: 0,
    useBeliefRisk: false,
    useComboSetup: false,
    suboptimalBand: 55,
  },
  TENSE: {
    id: 'TENSE',
    name: 'Taktisyen',
    badge: 'GERGİN',
    subtitle: 'Sis hafızası, gözetleme kuleleri ve taktiksel kombolar kullanır.',
    timeBudgetMs: 120,
    maxDepth: 3,
    quiesceDepth: 1,
    useBeliefRisk: true,
    useComboSetup: true,
    suboptimalBand: 2,
  },
  PANIC: {
    id: 'PANIC',
    name: 'S.U.C.S. Bot',
    badge: 'KABUS',
    subtitle:
      'Silüet inanç modeli, 2 hamleli İtme→Buz→Çukur tuzakları, Pusu zincirleri ve derin yakalama araması.',
    timeBudgetMs: 220,
    maxDepth: 4,
    quiesceDepth: 2,
    useBeliefRisk: true,
    useComboSetup: true,
    suboptimalBand: 1,
  },
};

export const ALL_AI_DIFFICULTIES: readonly AiDifficulty[] = ['CALM', 'TENSE', 'PANIC'];

export interface SucsAiOptions {
  difficulty?: AiDifficulty;
  timeBudgetMs?: number;
  maxDepth?: number;
  rngState?: number;
  aiSide?: Side;
  nowMs?: () => number;
}

export interface SucsAiDecision {
  action: GameAction;
  score: number;
  completedDepth: number;
  nodesSearched: number;
  ttHits: number;
  elapsedMs: number;
  timedOut: boolean;
  difficulty: AiDifficulty;
  tacticalTag?: string;
  memory: AiMemory;
  nextRngState: number;
}

export interface StressMetrics {
  percent: number;
  label: string;
  tone: 'calm' | 'tense' | 'sweat' | 'panic';
  reasons: string[];
}

const ORTHO_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const MAX_TT_ENTRIES = 12000;

interface BeliefContext {
  state: GameState;
  unexploredMask: boolean[][];
  oppKingVisibleAtRoot: boolean;
  beliefDangerGrid: number[][];
}

interface OrderedAction {
  action: GameAction;
  orderScore: number;
  isTactical: boolean;
}

type TTFlag = 'EXACT' | 'LOWER' | 'UPPER';

interface TTEntry {
  depth: number;
  score: number;
  flag: TTFlag;
  bestAction: GameAction | null;
}

function defaultNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function actionsEqual(a: GameAction, b: GameAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'END_TURN' && b.type === 'END_TURN') return true;
  if (a.type === 'MOVE' && b.type === 'MOVE') {
    return a.pieceId === b.pieceId && coordEquals(a.to, b.to);
  }
  if (a.type === 'USE_ABILITY' && b.type === 'USE_ABILITY') {
    return (
      a.pieceId === b.pieceId &&
      a.ability === b.ability &&
      coordEquals(a.target, b.target)
    );
  }
  return false;
}

function actionKey(a: GameAction): string {
  if (a.type === 'END_TURN') return 'E';
  if (a.type === 'MOVE') return `M:${a.pieceId}:${a.to.x},${a.to.y}`;
  return `A:${a.pieceId}:${a.ability}:${a.target.x},${a.target.y}`;
}

/**
 * Compact deterministic state signature for Transposition Table lookups.
 */
function buildSearchStateKey(state: GameState): string {
  const parts: string[] = [
    state.turn === 'PLAYER' ? 'P' : 'E',
    state.bonusMovePieceId ?? '-',
  ];
  for (let i = 0; i < state.pieces.length; i++) {
    const p = state.pieces[i]!;
    parts.push(
      `${p.id}@${p.pos.x},${p.pos.y}:${p.type[0]}:${p.shieldActive ? 1 : 0}:${p.frozenTurns}`,
    );
  }
  // Include dynamic tile mutations (broken walls / newly burning tiles)
  let tileSig = 0;
  for (let y = 0; y < state.height; y++) {
    const row = state.tiles[y]!;
    for (let x = 0; x < state.width; x++) {
      const t = row[x]!;
      if (t.type === 'BURNING') {
        tileSig = (tileSig * 31 + y * 17 + x * 3 + t.burnTurns) | 0;
      } else if (t.type === 'WALL') {
        tileSig = (tileSig * 31 + y * 13 + x * 7 + 99) | 0;
      }
    }
  }
  parts.push(`T:${tileSig}`);
  return parts.join('|');
}

/**
 * Builds a 100% fair Bayesian-style belief danger map strictly from VisibleState silhouettes
 * and AiMemory last-known coordinates (never peeks at hidden GameState).
 */
function buildBeliefDangerGrid(
  visible: VisibleState,
  memory: AiMemory,
  aiSide: Side,
): number[][] {
  const grid: number[][] = [];
  for (let y = 0; y < visible.height; y++) {
    grid.push(new Array<number>(visible.width).fill(0));
  }

  const stampHalo = (center: Coord, baseWeight: number): void => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = center.x + dx;
        const ny = center.y + dy;
        if (nx < 0 || nx >= visible.width || ny < 0 || ny >= visible.height) continue;
        const cheb = Math.max(Math.abs(dx), Math.abs(dy));
        const weight = cheb === 0 ? baseWeight * 1.4 : cheb === 1 ? baseWeight : baseWeight * 0.55;
        grid[ny]![nx] = Math.min(200, (grid[ny]![nx] ?? 0) + Math.round(weight));
      }
    }
  };

  // 1. '?' Silhouettes in the +2 radar ring represent immediate unseen threats
  for (let i = 0; i < visible.silhouettes.length; i++) {
    const sil = visible.silhouettes[i]!;
    if (sil.side !== aiSide) {
      stampHalo(sil.pos, 42);
    }
  }

  // 2. Remembered enemy pieces that slipped back into fog (decayed by turn age)
  const remembered = Object.values(memory.lastKnownPositions);
  for (let i = 0; i < remembered.length; i++) {
    const rem = remembered[i]!;
    // Skip if currently visible (already accounted for in exact minimax search)
    if (visible.pieces.some((p) => p.id === rem.pieceId)) continue;
    const age = Math.max(0, visible.turnNumber - rem.lastSeenTurn);
    if (age > 6) continue;
    const decay = Math.max(0.25, 1 - age * 0.14);
    const base =
      rem.type === 'QUEEN'
        ? 56
        : rem.type === 'ROOK' || rem.type === 'KNIGHT' || rem.type === 'BISHOP'
          ? 38
          : 22;
    stampHalo(rem.pos, base * decay);
  }

  return grid;
}

/**
 * Simulates a potential 1-tile push along (dx, dy) including ICE slide chain (pure & read-only).
 */
function previewDirectionalPushHazard(
  state: GameState,
  victimPos: Coord,
  dx: number,
  dy: number,
  victimImmuneToIce: boolean,
): 'PIT' | 'BURNING' | 'SAFE' | 'BLOCKED' {
  const first: Coord = { x: victimPos.x + dx, y: victimPos.y + dy };
  if (!inBounds(state, first)) return 'BLOCKED';
  const firstTile = getTile(state, first);
  if (firstTile === undefined || firstTile === null || firstTile.type === 'WALL') return 'BLOCKED';
  if (getPieceAt(state.pieces, first) !== undefined) return 'BLOCKED';
  if (firstTile.type === 'PIT') return 'PIT';
  if (firstTile.type === 'BURNING') return 'BURNING';

  if (firstTile.type !== 'ICE' || victimImmuneToIce) {
    return 'SAFE';
  }

  // Trace ice slide inertia chain
  let cur = first;
  for (let steps = 0; steps < 12; steps++) {
    const next: Coord = { x: cur.x + dx, y: cur.y + dy };
    if (!inBounds(state, next)) return 'SAFE';
    const nextTile = getTile(state, next);
    if (nextTile === undefined || nextTile === null || nextTile.type === 'WALL') return 'SAFE';
    if (getPieceAt(state.pieces, next) !== undefined) return 'SAFE';
    if (nextTile.type === 'PIT') return 'PIT';
    if (nextTile.type === 'BURNING') return 'BURNING';
    cur = next;
    if (nextTile.type !== 'ICE') return 'SAFE';
  }
  return 'SAFE';
}

function buildBeliefContext(
  visible: VisibleState,
  memory: AiMemory,
  aiSide: Side,
  rngState: number,
): BeliefContext {
  const tiles: TileState[][] = [];
  const unexploredMask: boolean[][] = [];

  for (let y = 0; y < visible.height; y++) {
    const tRow: TileState[] = [];
    const uRow: boolean[] = [];
    for (let x = 0; x < visible.width; x++) {
      const tile = visible.tiles[y]?.[x] ?? null;
      if (tile === null) {
        tRow.push(createTile('WALL'));
        uRow.push(true);
      } else {
        tRow.push(cloneTile(tile));
        uRow.push(false);
      }
    }
    tiles.push(tRow);
    unexploredMask.push(uRow);
  }

  const pieces: Piece[] = visible.pieces.map(clonePiece);

  const oppSide = opponentOf(aiSide);
  const oppKingVisibleAtRoot = pieces.some((p) => p.side === oppSide && p.type === 'KING');
  const aiFog = visible.fog.map((row) => row.slice());
  const oppFog = computeFogForSide(
    {
      width: visible.width,
      height: visible.height,
      tiles,
      pieces,
      factions: visible.factions,
    },
    oppSide,
  );

  const fog =
    aiSide === 'ENEMY'
      ? { PLAYER: oppFog, ENEMY: aiFog }
      : { PLAYER: aiFog, ENEMY: oppFog };

  const state: GameState = {
    width: visible.width,
    height: visible.height,
    tiles: cloneTiles(tiles),
    pieces,
    turn: visible.turn,
    turnNumber: visible.turnNumber,
    mode: visible.mode === 'CAMPAIGN' ? 'CAMPAIGN' : 'SKIRMISH',
    factions: { PLAYER: visible.factions.PLAYER, ENEMY: visible.factions.ENEMY },
    fog,
    pendingSpawns: visible.pendingSpawns.map((sp) => ({
      pos: { x: sp.pos.x, y: sp.pos.y },
      turnsRemaining: sp.turnsRemaining,
      side: sp.side,
      pieceType: sp.pieceType,
    })),
    bonusMovePieceId: visible.bonusMovePieceId,
    rngState: rngState || seedToRngState('sucs-belief'),
    actionHistory: [],
    winner: visible.winner,
    nextEntityId: 1000,
    bossCooldown: 0,
  };

  const beliefDangerGrid = buildBeliefDangerGrid(visible, memory, aiSide);
  return { state, unexploredMask, oppKingVisibleAtRoot, beliefDangerGrid };
}

function stepBeliefState(
  state: GameState,
  action: GameAction,
  aiSide: Side,
  oppKingVisibleAtRoot: boolean,
): ReturnType<typeof stepGame> {
  const step = stepGame(state, action);
  if (step.error !== undefined) return step;
  if (step.events.length === 1 && step.events[0]?.type === 'PIECE_DISOBEYED') {
    return { nextState: state, events: step.events, error: 'DISOBEYED' };
  }
  if (!oppKingVisibleAtRoot && step.nextState.winner === aiSide) {
    return {
      ...step,
      nextState: {
        ...step.nextState,
        winner: null,
      },
    };
  }
  return step;
}

function threatensKingSquare(mover: Piece, landing: Coord, oppKing: Piece | undefined): boolean {
  if (oppKing === undefined) return false;
  const dx = Math.abs(oppKing.pos.x - landing.x);
  const dy = Math.abs(oppKing.pos.y - landing.y);
  switch (mover.type) {
    case 'PAWN':
      return dx === 1 && oppKing.pos.y - landing.y === (mover.side === 'PLAYER' ? -1 : 1);
    case 'KNIGHT':
      return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
    case 'KING':
      return dx <= 1 && dy <= 1 && dx + dy > 0;
    case 'ROOK':
      return (dx === 0 || dy === 0) && dx + dy > 0;
    case 'BISHOP':
      return dx === dy && dx > 0;
    case 'QUEEN':
      return (dx === 0 || dy === 0 || dx === dy) && dx + dy > 0;
    case 'SAINT_FAITH':
    case 'SAINT_MADNESS':
      return (dx === 0 || dy === 0 || dx === dy) && Math.max(dx, dy) > 0 && Math.max(dx, dy) <= 2;
    case 'CHIMERA': {
      const dist = Math.max(dx, dy);
      if ((dx === 0 || dy === 0 || dx === dy) && dist > 0 && dist <= 3) return true;
      const forms = mover.absorbedForms ?? [];
      for (let i = 0; i < forms.length; i++) {
        const src = forms[i]!.sourceType;
        if ((src === 'ROOK' || src === 'QUEEN') && (dx === 0 || dy === 0) && dx + dy > 0) return true;
        if ((src === 'BISHOP' || src === 'QUEEN') && dx === dy && dx > 0) return true;
        if (src === 'KNIGHT' && ((dx === 1 && dy === 2) || (dx === 2 && dy === 1))) return true;
      }
      return false;
    }
  }
}

function scoreMoveOrdering(
  state: GameState,
  mover: Piece,
  move: LegalMove,
  oppKing: Piece | undefined,
): { priority: number; isTactical: boolean } {
  const res = move.resolution;
  if (res.fellInPit) return { priority: -50000, isTactical: false };

  let priority = 0;
  let isTactical = false;

  if (res.captured && res.hitPieceId !== null) {
    isTactical = true;
    const victim = state.pieces.find((p) => p.id === res.hitPieceId);
    const vVal = victim !== undefined ? AI_PIECE_VALUES[victim.type] : 100;
    if (victim?.type === 'KING') return { priority: 100000, isTactical: true };
    priority += 10000 + vVal * 10 - AI_PIECE_VALUES[mover.type];

    // High cut priority on enemies about to pop 3-turn Faith/Madness ultimates
    if (victim !== undefined) {
      if ((victim.faithCharge ?? 0) >= 2 || (victim.madnessCharge ?? 0) >= 2) {
        priority += 3600;
      }
      if (victim.berserkReady === true && !isSilenced(victim)) {
        priority += 2400;
      }
      // Capturing an EXPLOSIVE enemy next to MIASMA triggers GAS_CHAIN_DETONATED
      if (
        hasTrait(victim, 'EXPLOSIVE', state.factions) &&
        findMiasmaIgnitionOrigins(state.tiles, state.width, state.height, victim.pos).length > 0
      ) {
        priority += 2600;
      }
      // CHIMERA high-value form absorption bonus (KNIGHT / ROOK / QUEEN / SAINT_*)
      if (mover.type === 'CHIMERA') {
        if (victim.type === 'KNIGHT' || victim.type === 'ROOK') priority += 1800;
        else if (victim.type === 'QUEEN') priority += 2200;
        else if (victim.type === 'SAINT_FAITH' || victim.type === 'SAINT_MADNESS') priority += 1400;
      }
    }
  } else if (res.brokeShield) {
    isTactical = true;
    const victim =
      res.hitPieceId !== null ? state.pieces.find((p) => p.id === res.hitPieceId) : undefined;
    priority += victim?.type === 'KING' ? 5400 : 3400;
    if (hasTrait(mover, 'FROST_TOUCH', state.factions)) priority += 1200;
  }

  if (res.promotes) {
    isTactical = true;
    priority += 6500;
  }

  const endPos = res.finalPos ?? move.to;
  if (threatensKingSquare(mover, endPos, oppKing)) {
    priority += 2600;
  }

  // Quiescence tactical triggers: PRESSURE_PLATE activation along path, or 3rd-turn FAITH_ULTIMATE positioning
  for (let pIdx = 1; pIdx < res.path.length; pIdx++) {
    const pt = res.path[pIdx]!;
    const t = state.tiles[pt.y]?.[pt.x];
    if (isPressurePlate(t) && t?.trap?.kind === 'PRESSURE_PLATE' && t.trap.cooldown <= 0) {
      priority += 2800;
      isTactical = true;
      break;
    }
  }

  if ((mover.faithCharge ?? 0) >= 2) {
    const friendlyFaith = state.pieces.find(
      (p) =>
        p.side === mover.side &&
        p.type === 'SAINT_FAITH' &&
        !isSilenced(p) &&
        chebyshevDistance(p.pos, endPos) <= 2,
    );
    if (friendlyFaith !== undefined) {
      priority += 2400;
      isTactical = true;
    }
  }

  // Reward stepping onto a soon-to-hatch enemy Necromancer spawn marker to deny it
  const oppSide = opponentOf(mover.side);
  if (
    state.pendingSpawns.some(
      (sp) => sp.side === oppSide && sp.turnsRemaining === 1 && coordEquals(sp.pos, endPos),
    )
  ) {
    priority += 1500;
  }

  // Reward FROST_TOUCH moving next to unfrozen high-value enemies
  if (hasTrait(mover, 'FROST_TOUCH', state.factions)) {
    for (let d = 0; d < ORTHO_DIRS.length; d++) {
      const dir = ORTHO_DIRS[d]!;
      const adj = getPieceAt(state.pieces, { x: endPos.x + dir.x, y: endPos.y + dir.y }, mover.id);
      if (adj !== undefined && adj.side === oppSide && adj.frozenTurns === 0 && adj.type !== 'CHIMERA') {
        priority += adj.type === 'KING' || adj.type === 'QUEEN' ? 2200 : 1200;
        isTactical = true;
        break;
      }
    }
  }

  const endTile = state.tiles[endPos.y]?.[endPos.x];
  if (endTile?.type === 'WATCHTOWER') priority += 1300;
  const shielded = hasActiveShield(mover);
  if (res.endsOnBurning && !shielded) priority -= 8500;
  if (isExtendedSpikes(endTile) && !shielded) priority -= 9400;
  if (isTelegraphSpikes(endTile) && !shielded) priority -= 9000;
  if (hasMiasma(endTile) && mover.type !== 'CHIMERA' && (mover.miasmaExposure ?? 0) >= 1 && !shielded) {
    priority -= 8200;
  }

  const cx = (state.width - 1) / 2;
  const cy = (state.height - 1) / 2;
  priority += Math.max(0, 40 - Math.round((Math.abs(endPos.x - cx) + Math.abs(endPos.y - cy)) * 5));

  return { priority, isTactical };
}

function scoreAbilityOrdering(
  state: GameState,
  mover: Piece,
  ability: LegalAbility,
  unexploredMask: readonly (readonly boolean[])[],
): { priority: number; isTactical: boolean } {
  if (ability.ability === 'PUSH' && ability.pushPreview !== undefined) {
    const pp = ability.pushPreview;
    if (pp.blocked) return { priority: -500, isTactical: false };
    const victim = getPieceAt(state.pieces, ability.target);
    if (pp.fellInPit) {
      return {
        priority:
          victim?.type === 'KING'
            ? 96000
            : 9500 + (victim !== undefined ? AI_PIECE_VALUES[victim.type] * 9 : 600),
        isTactical: true,
      };
    }
    if (pp.finalPos !== null) {
      const landTile = state.tiles[pp.finalPos.y]?.[pp.finalPos.x];
      if (isTelegraphSpikes(landTile) || isExtendedSpikes(landTile)) {
        return {
          priority:
            victim?.type === 'KING'
              ? 92000
              : 8800 + (victim !== undefined ? AI_PIECE_VALUES[victim.type] * 8 : 500),
          isTactical: true,
        };
      }
      if (landTile?.type === 'BURNING') {
        return {
          priority: victim?.type === 'KING' ? 6800 : 2800,
          isTactical: true,
        };
      }
      if (isPressurePlate(landTile)) {
        return { priority: 3200, isTactical: true };
      }
    }
    if (pp.slid) return { priority: 1400, isTactical: true };
    return { priority: 420, isTactical: false };
  }

  // SIEGE_ENGINEERS BREAK_WALL: inspect corridor behind the wall
  const dx = ability.target.x - mover.pos.x;
  const dy = ability.target.y - mover.pos.y;
  const oppSide = opponentOf(mover.side);
  let corridorBonus = 480;
  for (let step = 1; step <= 4; step++) {
    const cx = ability.target.x + dx * step;
    const cy = ability.target.y + dy * step;
    if (cx < 0 || cx >= state.width || cy < 0 || cy >= state.height) break;
    const occ = getPieceAt(state.pieces, { x: cx, y: cy });
    if (occ !== undefined) {
      if (occ.side === oppSide) {
        corridorBonus += occ.type === 'KING' ? 4200 : 1800;
      }
      break;
    }
    if (unexploredMask[cy]?.[cx] === true) {
      corridorBonus += 650;
      break;
    }
    const t = state.tiles[cy]?.[cx];
    if (t?.type === 'WATCHTOWER') {
      corridorBonus += 500;
    } else if (t?.type === 'WALL') {
      break;
    }
  }
  return { priority: corridorBonus, isTactical: corridorBonus >= 1800 };
}

function generateOrderedActions(
  state: GameState,
  unexploredMask: readonly (readonly boolean[])[],
  pvMove: GameAction | null,
  killerKey: string | null,
  tacticalOnly: boolean,
): OrderedAction[] {
  const side = state.turn;
  const oppSide = opponentOf(side);
  const oppKing = state.pieces.find((p) => p.side === oppSide && p.type === 'KING');
  const activeOnly = state.mode === 'CAMPAIGN' && side === 'ENEMY';
  const result: OrderedAction[] = [];

  for (let i = 0; i < state.pieces.length; i++) {
    const piece = state.pieces[i]!;
    if (piece.side !== side) continue;
    if (piece.frozenTurns > 0) continue;
    if (activeOnly && piece.aggro !== 'ACTIVE') continue;
    if (state.bonusMovePieceId !== null && state.bonusMovePieceId !== piece.id) continue;

    const moves = getLegalMoves(state, piece, state.bonusMovePieceId);
    const pieceActions: OrderedAction[] = [];
    for (let m = 0; m < moves.length; m++) {
      const move = moves[m]!;
      const action: GameAction = {
        type: 'MOVE',
        pieceId: piece.id,
        to: { x: move.to.x, y: move.to.y },
      };
      const scored = scoreMoveOrdering(state, piece, move, oppKing);
      if (tacticalOnly && !scored.isTactical && state.bonusMovePieceId === null) continue;
      const isPv = pvMove !== null && actionsEqual(action, pvMove);
      const isKiller = !isPv && killerKey !== null && actionKey(action) === killerKey;
      pieceActions.push({
        action,
        orderScore: isPv ? 1_000_000 : isKiller ? 500_000 : scored.priority,
        isTactical: scored.isTactical,
      });
    }

    // Branching factor guard (PANIC Depth 4 + Q2): when multi-form CHIMERA reaches 25+ legal moves,
    // keep the top 14 highest-priority tactical/central moves at non-quiescence nodes.
    if (!tacticalOnly && piece.type === 'CHIMERA' && pieceActions.length >= 25) {
      pieceActions.sort((a, b) => b.orderScore - a.orderScore);
      pieceActions.length = 14;
    }

    for (let k = 0; k < pieceActions.length; k++) {
      result.push(pieceActions[k]!);
    }

    const abilities = getLegalAbilities(state, piece, state.bonusMovePieceId);
    for (let a = 0; a < abilities.length; a++) {
      const ab = abilities[a]!;
      // Never break a synthetic WALL standing in for an UNEXPLORED fog square
      if (ab.ability === 'BREAK_WALL' && unexploredMask[ab.target.y]?.[ab.target.x] === true) {
        continue;
      }
      const action: GameAction = {
        type: 'USE_ABILITY',
        pieceId: piece.id,
        ability: ab.ability,
        target: { x: ab.target.x, y: ab.target.y },
      };
      const scored = scoreAbilityOrdering(state, piece, ab, unexploredMask);
      if (tacticalOnly && !scored.isTactical && state.bonusMovePieceId === null) continue;
      const isPv = pvMove !== null && actionsEqual(action, pvMove);
      const isKiller = !isPv && killerKey !== null && actionKey(action) === killerKey;
      result.push({
        action,
        orderScore: isPv ? 1_000_000 : isKiller ? 500_000 : scored.priority,
        isTactical: scored.isTactical,
      });
    }
  }

  result.sort((a, b) => b.orderScore - a.orderScore);

  if (!tacticalOnly && result.length === 0) {
    result.push({ action: { type: 'END_TURN' }, orderScore: 0, isTactical: false });
  }

  return result;
}

function evaluateSucsBeliefState(
  state: GameState,
  aiSide: Side,
  ply: number,
  profile: AiDifficultyProfile,
  rememberedCoords: readonly Coord[],
  silhouetteCoords: readonly Coord[],
  watchtowers: readonly Coord[],
  fogSweepTargets: readonly Coord[],
  unexploredMask: readonly (readonly boolean[])[],
  beliefDangerGrid: readonly (readonly number[])[],
): number {
  const oppSide = opponentOf(aiSide);

  if (state.winner !== null) {
    if (state.winner === aiSide) return 100000 - ply * 25;
    if (state.winner === oppSide) return -100000 + ply * 25;
    return 0;
  }

  let score = 0;
  let visibleOppCount = 0;
  const centerX = (state.width - 1) / 2;
  const centerY = (state.height - 1) / 2;
  const oppBackRowY = oppSide === 'PLAYER' ? state.height - 1 : 0;

  for (let i = 0; i < state.pieces.length; i++) {
    const p = state.pieces[i]!;
    const isMine = p.side === aiSide;
    const sign = isMine ? 1 : -1;
    if (!isMine) visibleOppCount++;

    let pieceScore = AI_PIECE_VALUES[p.type];
    const silenced = isSilenced(p);
    const activeShield = hasActiveShield(p);

    if (silenced) {
      pieceScore -= 90;
    } else {
      if (activeShield) pieceScore += p.type === 'KING' ? 145 : 85;
      if (hasTrait(p, 'FROST_TOUCH', state.factions)) pieceScore += 50;
      if (hasTrait(p, 'EXPLOSIVE', state.factions)) pieceScore += 40;
      if (hasTrait(p, 'PUSHER', state.factions)) pieceScore += 55;
      if (hasTrait(p, 'SCOUT', state.factions)) pieceScore += 40;
      if (hasTrait(p, 'SHADOW_WALKER', state.factions)) pieceScore += 35;
      if (hasTrait(p, 'DASH_ON_REVEAL', state.factions)) {
        pieceScore += 48;
        if (!p.wasVisibleAtTurnStart) pieceScore += 28;
      }
      if (p.berserkReady === true) pieceScore += 260;
    }

    // Aura charge urgency (charge === 2 is 1 turn from massive ultimate!)
    if ((p.faithCharge ?? 0) >= 2) pieceScore += 220;
    else if ((p.faithCharge ?? 0) === 1) pieceScore += 55;
    if ((p.madnessCharge ?? 0) >= 2) pieceScore += 220;
    else if ((p.madnessCharge ?? 0) === 1) pieceScore += 55;

    // SAINT_FAITH positioning bonus scaled by enemy buff density within Chebyshev <= 3 (7x7 silence pulse!)
    if (p.type === 'SAINT_FAITH' && !silenced) {
      let enemyBuffDensity = 0;
      for (let eIdx = 0; eIdx < state.pieces.length; eIdx++) {
        const other = state.pieces[eIdx]!;
        if (other.side === p.side || other.type === 'CHIMERA') continue;
        if (chebyshevDistance(p.pos, other.pos) > 3) continue;
        if (other.shieldActive) enemyBuffDensity += 1;
        enemyBuffDensity += other.traits.length;
        if (other.berserkReady === true) enemyBuffDensity += 2;
        if (other.type === 'SAINT_FAITH' || other.type === 'SAINT_MADNESS') enemyBuffDensity += 2;
      }
      pieceScore += enemyBuffDensity * 45;
    }

    // CHIMERA absorbed forms valuation (especially KNIGHT & ROOK)
    if (p.type === 'CHIMERA' && p.absorbedForms !== undefined) {
      for (let f = 0; f < p.absorbedForms.length; f++) {
        const form = p.absorbedForms[f]!;
        if (form.sourceType === 'KNIGHT') pieceScore += 180;
        else if (form.sourceType === 'ROOK') pieceScore += 170;
        else if (form.sourceType === 'QUEEN') pieceScore += 240;
        else if (form.sourceType === 'BISHOP') pieceScore += 120;
        else if (form.sourceType === 'SAINT_FAITH' || form.sourceType === 'SAINT_MADNESS') {
          pieceScore += 160;
        }
        pieceScore += form.copiedTraits.length * 35;
      }
    }

    if (p.frozenTurns > 0) {
      const freezePenalty =
        p.type === 'KING' || p.type === 'QUEEN' ? 110 : p.type === 'ROOK' ? 85 : 60;
      pieceScore -= freezePenalty * p.frozenTurns;
    }

    const tile = getTile(state, p.pos);
    if (tile?.type === 'WATCHTOWER') pieceScore += 75;
    if (tile?.type === 'BURNING') {
      pieceScore -= activeShield
        ? 45
        : p.type === 'KING'
          ? 3800
          : Math.round(AI_PIECE_VALUES[p.type] * 0.72);
    }
    // TELEGRAPH (phase 1) spikes lethal penalty
    if (isTelegraphSpikes(tile)) {
      pieceScore -= activeShield
        ? 60
        : p.type === 'KING'
          ? 4500
          : Math.round(AI_PIECE_VALUES[p.type] * 0.8);
    }
    // MIASMA suffocation penalty at exposure >= 1
    if (hasMiasma(tile) && p.type !== 'CHIMERA') {
      if ((p.miasmaExposure ?? 0) >= 1) {
        pieceScore -= activeShield
          ? 65
          : p.type === 'KING'
            ? 3600
            : Math.round(AI_PIECE_VALUES[p.type] * 0.7);
      } else {
        pieceScore -= 40;
      }
    }
    // Low composure fragility penalty
    if ((p.composure ?? 3) === 1 && p.type !== 'KING') {
      pieceScore -= 35;
    }

    // Center control & pawn promotion progress
    const centerBonus = Math.max(
      0,
      14 - (Math.abs(p.pos.x - centerX) + Math.abs(p.pos.y - centerY)) * 2,
    );
    pieceScore += centerBonus;

    if (p.type === 'PAWN') {
      const progress = p.side === 'PLAYER' ? state.height - 1 - p.pos.y : p.pos.y;
      pieceScore += progress * 16;
    }

    // S.U.C.S. Belief-State Silhouette & Memory Risk Modeling (100% fair)
    if (profile.useBeliefRisk && isMine) {
      const danger = beliefDangerGrid[p.pos.y]?.[p.pos.x] ?? 0;
      if (danger > 0) {
        if (p.type === 'PAWN' && (p.shieldActive || p.traits.includes('SCOUT'))) {
          // Cheap scouts / shielded pawns are encouraged to probe silhouettes!
          pieceScore += Math.min(28, Math.round(danger * 0.45));
        } else {
          const valScale =
            p.type === 'KING'
              ? 1.6
              : p.type === 'QUEEN'
                ? 1.45
                : p.type === 'ROOK'
                  ? 0.95
                  : p.shieldActive
                    ? 0.2
                    : 0.55;
          pieceScore -= Math.round(danger * valScale);
        }
      }
    }

    // S.U.C.S. Mechanic Combo Heuristics (PUSHER traps, EXPLOSIVE clustering)
    if (profile.useComboSetup) {
      if (p.traits.includes('PUSHER') && p.frozenTurns === 0) {
        for (let d = 0; d < ORTHO_DIRS.length; d++) {
          const dir = ORTHO_DIRS[d]!;
          const adjPos: Coord = { x: p.pos.x + dir.x, y: p.pos.y + dir.y };
          const victim = getPieceAt(state.pieces, adjPos, p.id);
          if (victim === undefined || victim.side === p.side) continue;
          const victimIceImmune =
            victim.type === 'KNIGHT' || state.factions[victim.side] === 'FROST_WARDENS';
          const hazard = previewDirectionalPushHazard(
            state,
            victim.pos,
            dir.x,
            dir.y,
            victimIceImmune,
          );
          if (hazard === 'PIT') {
            pieceScore += victim.type === 'KING' ? 620 : 250;
          } else if (hazard === 'BURNING' && !victim.shieldActive) {
            pieceScore += victim.type === 'KING' ? 230 : 110;
          }
        }
      }

      if (p.traits.includes('EXPLOSIVE')) {
        let adjUnshieldedFoes = 0;
        let adjUnshieldedFoeKing = false;
        for (let d = 0; d < ORTHO_DIRS.length; d++) {
          const dir = ORTHO_DIRS[d]!;
          const adj = getPieceAt(state.pieces, { x: p.pos.x + dir.x, y: p.pos.y + dir.y }, p.id);
          if (adj !== undefined && adj.side !== p.side && !adj.shieldActive) {
            adjUnshieldedFoes++;
            if (adj.type === 'KING') adjUnshieldedFoeKing = true;
          }
        }
        if (adjUnshieldedFoes >= 2) pieceScore += adjUnshieldedFoes * 42;
        if (adjUnshieldedFoeKing) pieceScore += 135;
      }
    }

    score += sign * pieceScore;
  }

  // NECROMANCERS pending spawn control (strictly monotonic: blocking enemy spawn neutralizes its threat, never reward-hackable)
  for (let i = 0; i < state.pendingSpawns.length; i++) {
    const sp = state.pendingSpawns[i]!;
    const occ = getPieceAt(state.pieces, sp.pos);
    const imminentVal = sp.turnsRemaining <= 1 ? 75 : 40;
    if (sp.side === aiSide) {
      // Friendly spawn only pays off if the square is free
      if (occ === undefined) score += imminentVal;
    } else {
      // Enemy spawn is a threat unless currently blocked by a piece
      if (occ === undefined) score -= imminentVal;
    }
  }

  // Active bonus dash state value
  if (state.bonusMovePieceId !== null) {
    score += state.turn === aiSide ? 95 : -95;
  }

  // Vision & fog frontier exploration advantage for aiSide (kept strictly below Pawn material = 100)
  const aiFog = state.fog[aiSide];
  let visibleTiles = 0;
  let exploredTiles = 0;
  for (let y = 0; y < state.height; y++) {
    const row = aiFog[y];
    if (row === undefined) continue;
    for (let x = 0; x < state.width; x++) {
      const v = row[x];
      if (v === 'VISIBLE') visibleTiles++;
      else if (v === 'EXPLORED') exploredTiles++;
    }
  }
  score += Math.round(visibleTiles * 1.2 + exploredTiles * 0.4);

  let frontierCoverage = 0;
  for (let i = 0; i < state.pieces.length; i++) {
    const p = state.pieces[i]!;
    if (p.side !== aiSide) continue;
    const rad = p.traits.includes('SCOUT') ? 4 : 3;
    const minY = Math.max(0, p.pos.y - rad);
    const maxY = Math.min(state.height - 1, p.pos.y + rad);
    const minX = Math.max(0, p.pos.x - rad);
    const maxX = Math.min(state.width - 1, p.pos.x + rad);
    for (let y = minY; y <= maxY; y++) {
      const uRow = unexploredMask[y];
      if (uRow === undefined) continue;
      for (let x = minX; x <= maxX; x++) {
        if (uRow[x] === true) frontierCoverage++;
      }
    }
  }
  score += Math.min(36, Math.round(frontierCoverage * 1.2));

  // Fair pursuit when opponent units are hidden in fog
  if (visibleOppCount === 0) {
    const pursuitTargets =
      rememberedCoords.length > 0
        ? rememberedCoords
        : silhouetteCoords.length > 0
          ? silhouetteCoords
          : watchtowers.length > 0
            ? watchtowers
            : fogSweepTargets;

    const pursuitWeight =
      rememberedCoords.length > 0
        ? 26
        : silhouetteCoords.length > 0
          ? 22
          : watchtowers.length > 0
            ? 18
            : 14;

    if (pursuitTargets.length > 0) {
      for (let i = 0; i < state.pieces.length; i++) {
        const p = state.pieces[i]!;
        if (p.side !== aiSide || p.type === 'KING') continue;
        let minD = Number.POSITIVE_INFINITY;
        for (let t = 0; t < pursuitTargets.length; t++) {
          const d = manhattanDistance(p.pos, pursuitTargets[t]!);
          if (d < minD) minD = d;
        }
        if (Number.isFinite(minD)) {
          score -= minD * pursuitWeight;
        }
      }
    } else {
      for (let i = 0; i < state.pieces.length; i++) {
        const p = state.pieces[i]!;
        if (p.side !== aiSide || p.type === 'KING') continue;
        score -= Math.abs(p.pos.y - oppBackRowY) * 10;
      }
    }
  } else {
    const oppPieces = state.pieces.filter((p) => p.side === oppSide);
    const oppKing = oppPieces.find((p) => p.type === 'KING');
    const primaryTargets = oppKing !== undefined ? [oppKing] : oppPieces;
    const chaseWeight = oppKing !== undefined ? 18 : 11;

    for (let i = 0; i < state.pieces.length; i++) {
      const p = state.pieces[i]!;
      if (p.side !== aiSide || p.type === 'KING') continue;
      let minD = Number.POSITIVE_INFINITY;
      for (let o = 0; o < primaryTargets.length; o++) {
        const d = manhattanDistance(p.pos, primaryTargets[o]!.pos);
        if (d < minD) minD = d;
      }
      if (Number.isFinite(minD)) {
        score -= minD * chaseWeight;
      }
    }

    if (oppKing !== undefined) {
      const kingEdgeDist =
        Math.abs(oppKing.pos.x - centerX) + Math.abs(oppKing.pos.y - centerY);
      score += Math.round(kingEdgeDist * 10);
    }
  }

  return score;
}

function classifyTacticalTag(
  rootState: GameState,
  action: GameAction,
  oppKingVisible: boolean,
  aiSide: Side,
): string | undefined {
  if (action.type === 'USE_ABILITY') {
    if (action.ability === 'BREAK_WALL') return 'Kuşatma duvarını yardı!';
    const step = stepBeliefState(rootState, action, aiSide, oppKingVisible);
    if (step.events.some((e) => e.type === 'PIECE_FELL_IN_PIT')) {
      return 'Buzdan çukura itme kombosu!';
    }
    if (step.events.some((e) => e.type === 'PIECE_SLID')) {
      return 'Buz kaydırmalı itme hamlesi!';
    }
    if (step.events.some((e) => e.type === 'PIECE_SKEWERED')) {
      return 'Kazığa / ok hattına itme kombosu!';
    }
    if (step.events.some((e) => e.type === 'PLATE_TRIGGERED')) {
      return 'Rakibi baskı plakasına itti!';
    }
    return 'Taktiksel itme uyguladı!';
  }
  if (action.type === 'MOVE') {
    const step = stepBeliefState(rootState, action, aiSide, oppKingVisible);
    if (step.events.some((e) => e.type === 'GAS_CHAIN_DETONATED')) {
      return 'Zincirleme Miasma gaz patlaması!';
    }
    if (step.events.some((e) => e.type === 'FAITH_ULTIMATE_TRIGGERED')) {
      return 'Ocaklı 7×7 arınma ve susturma ultisi!';
    }
    if (step.events.some((e) => e.type === 'BERSERK_CHAIN_TRIGGERED')) {
      return 'Kanlı Cinnet zincir hamlesi!';
    }
    if (step.events.some((e) => e.type === 'CHIMERA_EVOLVED')) {
      return 'Gulyabani kılık çalıp evrimleşti!';
    }
    if (step.events.some((e) => e.type === 'PLATE_TRIGGERED')) {
      return 'Baskı plakası ok tuzağını tetikledi!';
    }
    if (step.nextState.bonusMovePieceId !== null) {
      return 'Pusu çift hamlesini tetikledi!';
    }
    if (step.events.some((e) => e.type === 'PIECE_FROZEN')) {
      return 'Buz Dokunuşu ile dondurdu!';
    }
    if (step.events.some((e) => e.type === 'SHIELD_BROKEN')) {
      return 'Kalkanı kırdı!';
    }
    const endTile = rootState.tiles[action.to.y]?.[action.to.x];
    if (endTile?.type === 'WATCHTOWER') {
      return 'Gözetleme kulesini ele geçirdi!';
    }
    const oppSide = opponentOf(aiSide);
    if (
      rootState.pendingSpawns.some(
        (sp) => sp.side === oppSide && sp.turnsRemaining === 1 && coordEquals(sp.pos, action.to),
      )
    ) {
      return 'Nekromanser diriltmesini engelledi!';
    }
  }
  return undefined;
}

/**
 * S.U.C.S. Native Tactical Fog-of-War AI:
 * Belief-state silhouette modeling + Iterative Deepening Alpha-Beta + Transposition Table +
 * Killer Moves + Quiescence Capture Extension + Bonus-Dash Extension + Mechanic Combo Heuristics.
 * Strictly consumes `VisibleState` + `AiMemory` (100% fair, zero fog cheating, zero Math.random).
 */
export function chooseSucsAction(
  visible: VisibleState,
  memory: AiMemory = createAiMemory(),
  options: SucsAiOptions = {},
): SucsAiDecision {
  const difficulty: AiDifficulty = options.difficulty ?? 'TENSE';
  const profile = AI_DIFFICULTY_PROFILES[difficulty];
  const aiSide: Side = options.aiSide ?? visible.turn;
  const budgetMs = Math.max(1, options.timeBudgetMs ?? profile.timeBudgetMs);
  const maxDepth = Math.max(1, options.maxDepth ?? profile.maxDepth);
  const nowMs = options.nowMs ?? defaultNowMs;
  const startMs = nowMs();
  const deadlineMs = startMs + budgetMs;
  const initialRng = options.rngState ?? 1;

  const updatedMemory = updateAiMemory(memory, visible, aiSide);
  const belief = buildBeliefContext(visible, updatedMemory, aiSide, initialRng);

  const rememberedCoords = Object.values(updatedMemory.lastKnownPositions).map((r) => r.pos);
  const silhouetteCoords = visible.silhouettes.map((s) => s.pos);
  const watchtowers: Coord[] = [];
  const unexploredTargets: Coord[] = [];
  const hiddenExploredTargets: Coord[] = [];
  for (let y = 0; y < visible.height; y++) {
    for (let x = 0; x < visible.width; x++) {
      const tile = visible.tiles[y]?.[x] ?? null;
      const fogVal = visible.fog[y]?.[x];
      if (tile?.type === 'WATCHTOWER') {
        const occ = getPieceAt(visible.pieces, { x, y });
        if (occ === undefined || occ.side !== aiSide) {
          watchtowers.push({ x, y });
        }
      }
      if (fogVal === 'UNEXPLORED') {
        unexploredTargets.push({ x, y });
      } else if (fogVal === 'EXPLORED' && tile !== null && tile.type !== 'WALL' && tile.type !== 'PIT') {
        hiddenExploredTargets.push({ x, y });
      }
    }
  }
  const fogSweepTargets =
    unexploredTargets.length > 0 ? unexploredTargets : hiddenExploredTargets;
  const recentMoves = updatedMemory.recentSelfMoves ?? [];

  const rootActions = generateOrderedActions(belief.state, belief.unexploredMask, null, null, false);
  if (rootActions.length === 1) {
    const single = rootActions[0]!.action;
    let finalMemory = updatedMemory;
    if (single.type === 'MOVE') {
      const mover = visible.pieces.find((p) => p.id === single.pieceId);
      if (mover !== undefined) {
        finalMemory = recordAiSelfMove(updatedMemory, single.pieceId, mover.pos, single.to);
      }
    }
    return {
      action: single,
      score: 0,
      completedDepth: 1,
      nodesSearched: 1,
      ttHits: 0,
      elapsedMs: Math.max(0, nowMs() - startMs),
      timedOut: false,
      difficulty,
      memory: finalMemory,
      nextRngState: initialRng,
    };
  }

  let nodesSearched = 0;
  let ttHits = 0;
  let timedOut = false;
  const tt = new Map<string, TTEntry>();
  const killerByPly: Array<string | null> = new Array<string | null>(16).fill(null);

  const checkTimeout = (): boolean => {
    if (timedOut) return true;
    if (nowMs() >= deadlineMs) {
      timedOut = true;
      return true;
    }
    return false;
  };

  const evalLeaf = (state: GameState, ply: number): number =>
    evaluateSucsBeliefState(
      state,
      aiSide,
      ply,
      profile,
      rememberedCoords,
      silhouetteCoords,
      watchtowers,
      fogSweepTargets,
      belief.unexploredMask,
      belief.beliefDangerGrid,
    );

  const quiesce = (
    state: GameState,
    qDepth: number,
    alpha: number,
    beta: number,
    ply: number,
  ): number => {
    nodesSearched++;
    if ((nodesSearched & 15) === 0 && checkTimeout()) return 0;

    const standPat = evalLeaf(state, ply);
    if (qDepth <= 0 || state.winner !== null) {
      return standPat;
    }

    const maximizing = state.turn === aiSide;
    if (maximizing) {
      let best = standPat;
      let a = alpha;
      if (best > a) a = best;
      if (beta <= a) return best;

      const tactical = generateOrderedActions(state, belief.unexploredMask, null, null, true);
      for (let i = 0; i < tactical.length && i < 6; i++) {
        if (checkTimeout()) return 0;
        const step = stepBeliefState(state, tactical[i]!.action, aiSide, belief.oppKingVisibleAtRoot);
        if (step.error !== undefined) continue;
        // Small tempo cost (-22) prevents preferring "let enemy spawn just to capture in quiesce" over denying it now
        const val = quiesce(step.nextState, qDepth - 1, a, beta, ply + 1) - 22;
        if (timedOut) return 0;
        if (val > best) best = val;
        if (best > a) a = best;
        if (beta <= a) break;
      }
      return best;
    }

    let best = standPat;
    let b = beta;
    if (best < b) b = best;
    if (b <= alpha) return best;

    const tactical = generateOrderedActions(state, belief.unexploredMask, null, null, true);
    for (let i = 0; i < tactical.length && i < 6; i++) {
      if (checkTimeout()) return 0;
      const step = stepBeliefState(state, tactical[i]!.action, aiSide, belief.oppKingVisibleAtRoot);
      if (step.error !== undefined) continue;
      const val = quiesce(step.nextState, qDepth - 1, alpha, b, ply + 1);
      if (timedOut) return 0;
      if (val < best) best = val;
      if (best < b) b = best;
      if (b <= alpha) break;
    }
    return best;
  };

  const alphaBeta = (
    state: GameState,
    depth: number,
    alpha: number,
    beta: number,
    ply: number,
    extensionsUsed: number,
  ): number => {
    nodesSearched++;
    if ((nodesSearched & 15) === 0 && checkTimeout()) {
      return 0;
    }

    if (state.winner !== null) {
      return evalLeaf(state, ply);
    }

    if (depth <= 0) {
      if (profile.quiesceDepth > 0) {
        return quiesce(state, profile.quiesceDepth, alpha, beta, ply);
      }
      return evalLeaf(state, ply);
    }

    const origAlpha = alpha;
    const origBeta = beta;
    const stateKey = buildSearchStateKey(state);
    const cached = tt.get(stateKey);
    let ttHint: GameAction | null = null;
    if (cached !== undefined) {
      ttHint = cached.bestAction;
      if (cached.depth >= depth) {
        ttHits++;
        if (cached.flag === 'EXACT') return cached.score;
        if (cached.flag === 'LOWER' && cached.score > alpha) alpha = cached.score;
        else if (cached.flag === 'UPPER' && cached.score < beta) beta = cached.score;
        if (alpha >= beta) return cached.score;
      }
    }

    const killer = killerByPly[ply] ?? null;
    const actions = generateOrderedActions(state, belief.unexploredMask, ttHint, killer, false);
    const maximizing = state.turn === aiSide;
    let bestActionLocal: GameAction | null = null;

    if (maximizing) {
      let best = Number.NEGATIVE_INFINITY;
      let a = alpha;
      for (let i = 0; i < actions.length; i++) {
        if (checkTimeout()) return 0;
        const act = actions[i]!.action;
        const step = stepBeliefState(state, act, aiSide, belief.oppKingVisibleAtRoot);
        if (step.error !== undefined) continue;

        // Extend by 1 ply on active DASH_ON_REVEAL bonus combos (up to 2 extensions)
        const extend = step.nextState.bonusMovePieceId !== null && extensionsUsed < 2 ? 1 : 0;
        const val = alphaBeta(
          step.nextState,
          depth - 1 + extend,
          a,
          beta,
          ply + 1,
          extensionsUsed + extend,
        );
        if (timedOut) return 0;

        if (val > best) {
          best = val;
          bestActionLocal = act;
        }
        if (best > a) a = best;
        if (beta <= a) {
          if (!actions[i]!.isTactical && ply < killerByPly.length) {
            killerByPly[ply] = actionKey(act);
          }
          break;
        }
      }

      const finalScore = Number.isFinite(best) ? best : evalLeaf(state, ply);
      if (tt.size < MAX_TT_ENTRIES) {
        const flag: TTFlag =
          finalScore <= origAlpha ? 'UPPER' : finalScore >= origBeta ? 'LOWER' : 'EXACT';
        tt.set(stateKey, { depth, score: finalScore, flag, bestAction: bestActionLocal });
      }
      return finalScore;
    }

    let best = Number.POSITIVE_INFINITY;
    let b = beta;
    for (let i = 0; i < actions.length; i++) {
      if (checkTimeout()) return 0;
      const act = actions[i]!.action;
      const step = stepBeliefState(state, act, aiSide, belief.oppKingVisibleAtRoot);
      if (step.error !== undefined) continue;

      const extend = step.nextState.bonusMovePieceId !== null && extensionsUsed < 2 ? 1 : 0;
      const val = alphaBeta(
        step.nextState,
        depth - 1 + extend,
        alpha,
        b,
        ply + 1,
        extensionsUsed + extend,
      );
      if (timedOut) return 0;

      if (val < best) {
        best = val;
        bestActionLocal = act;
      }
      if (best < b) b = best;
      if (b <= alpha) {
        if (!actions[i]!.isTactical && ply < killerByPly.length) {
          killerByPly[ply] = actionKey(act);
        }
        break;
      }
    }

    const finalScore = Number.isFinite(best) ? best : evalLeaf(state, ply);
    if (tt.size < MAX_TT_ENTRIES) {
      const flag: TTFlag =
        finalScore <= origAlpha ? 'UPPER' : finalScore >= origBeta ? 'LOWER' : 'EXACT';
      tt.set(stateKey, { depth, score: finalScore, flag, bestAction: bestActionLocal });
    }
    return finalScore;
  };

  let bestAction: GameAction = rootActions[0]!.action;
  let bestScore = Number.NEGATIVE_INFINITY;
  let completedDepth = 0;
  let nextRng = initialRng;

  const computeOscillationPenalty = (candidate: GameAction, hasCapture: boolean): number => {
    if (hasCapture || candidate.type !== 'MOVE' || recentMoves.length === 0) return 0;
    const last = recentMoves[recentMoves.length - 1]!;
    if (last.pieceId === candidate.pieceId && coordEquals(last.from, candidate.to)) {
      return 65;
    }
    let repeatHits = 0;
    for (let r = 0; r < recentMoves.length; r++) {
      const m = recentMoves[r]!;
      if (
        m.pieceId === candidate.pieceId &&
        (coordEquals(m.to, candidate.to) || coordEquals(m.from, candidate.to))
      ) {
        repeatHits++;
      }
    }
    return repeatHits * 24;
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (depth > 1 && checkTimeout()) break;

    const ordered = generateOrderedActions(belief.state, belief.unexploredMask, bestAction, null, false);
    let depthBestScore = Number.NEGATIVE_INFINITY;
    let depthBestActions: GameAction[] = [];
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    let depthAborted = false;
    const band = profile.suboptimalBand;

    for (let i = 0; i < ordered.length; i++) {
      if (depth > 1 && checkTimeout()) {
        depthAborted = true;
        break;
      }
      const candidate = ordered[i]!.action;
      const step = stepBeliefState(belief.state, candidate, aiSide, belief.oppKingVisibleAtRoot);
      if (step.error !== undefined) continue;

      const extend = step.nextState.bonusMovePieceId !== null ? 1 : 0;
      const rawScore = alphaBeta(step.nextState, depth - 1 + extend, alpha, beta, 1, extend);
      if (timedOut) {
        depthAborted = true;
        break;
      }

      const hasCapture = step.events.some(
        (ev) =>
          ev.type === 'PIECE_CAPTURED' ||
          ev.type === 'SHIELD_BROKEN' ||
          ev.type === 'PIECE_FELL_IN_PIT',
      );
      const score = rawScore - computeOscillationPenalty(candidate, hasCapture);

      if (score > depthBestScore + band) {
        depthBestScore = score;
        depthBestActions = [candidate];
      } else if (score >= depthBestScore - band) {
        depthBestActions.push(candidate);
      }

      if (score > alpha) alpha = score;
    }

    if (!depthAborted && depthBestActions.length > 0) {
      if (depthBestActions.length === 1) {
        bestAction = depthBestActions[0]!;
      } else {
        const pick = nextInt(nextRng, 0, depthBestActions.length - 1);
        nextRng = pick.nextState;
        bestAction = depthBestActions[pick.value]!;
      }
      bestScore = depthBestScore;
      completedDepth = depth;

      if (bestScore >= 90000) {
        break;
      }
    } else {
      break;
    }
  }

  let finalMemory = updatedMemory;
  if (bestAction.type === 'MOVE') {
    const mover = visible.pieces.find((p) => p.id === bestAction.pieceId);
    if (mover !== undefined) {
      finalMemory = recordAiSelfMove(updatedMemory, bestAction.pieceId, mover.pos, bestAction.to);
    }
  }

  const tacticalTag = classifyTacticalTag(
    belief.state,
    bestAction,
    belief.oppKingVisibleAtRoot,
    aiSide,
  );

  return {
    action: bestAction,
    score: Number.isFinite(bestScore) ? bestScore : 0,
    completedDepth,
    nodesSearched,
    ttHits,
    elapsedMs: Math.max(0, nowMs() - startMs),
    timedOut,
    difficulty,
    ...(tacticalTag !== undefined ? { tacticalTag } : {}),
    memory: finalMemory,
    nextRngState: nextRng,
  };
}

/**
 * Pure, 100% fair S.U.C.S. Live Stress Meter computed strictly from VisibleState (zero fog leak).
 * Drives the UI heart-rate / stress bar for flavor and tactical situational awareness.
 */
export function computeStressMetrics(
  visible: VisibleState,
  side: Side,
  bossCooldown = 0,
): StressMetrics {
  const oppSide = opponentOf(side);
  const myPieces = visible.pieces.filter((p) => p.side === side);
  const oppPieces = visible.pieces.filter((p) => p.side === oppSide);
  const myKing = myPieces.find((p) => p.type === 'KING');

  let stress = 12;
  const reasons: string[] = [];

  if (myKing !== undefined) {
    const kingTile = getTile(visible, myKing.pos);
    if (kingTile?.type === 'BURNING') {
      stress += 38;
      reasons.push('Şah alevde!');
    }
    if (isTelegraphSpikes(kingTile)) {
      stress += 34;
      reasons.push('Şah kazık tehdidinde!');
    }
    if (hasMiasma(kingTile)) {
      stress += (myKing.miasmaExposure ?? 0) >= 1 ? 36 : 16;
      reasons.push('Şah zehirli siste!');
    }
    if (myKing.frozenTurns > 0) {
      stress += 25;
      reasons.push('Şah donmuş!');
    }

    // Check if any visible opponent can capture or directly threaten our King right now
    let directThreats = 0;
    let closeEnemies = 0;
    for (let i = 0; i < oppPieces.length; i++) {
      const opp = oppPieces[i]!;
      if (opp.frozenTurns > 0) continue;
      const dist = manhattanDistance(myKing.pos, opp.pos);
      if (dist <= 3) closeEnemies++;
      const moves = getLegalMoves(visible, opp, null);
      if (
        moves.some((m) => {
          const hit = m.resolution.hitPos ?? m.resolution.finalPos;
          return hit !== null && coordEquals(hit, myKing.pos);
        })
      ) {
        directThreats++;
      }
    }
    if (directThreats > 0) {
      stress += myKing.shieldActive ? 28 : 48;
      reasons.push('Şah doğrudan tehdit altında!');
    } else if (closeEnemies > 0) {
      stress += Math.min(24, closeEnemies * 10);
      reasons.push('Düşman Şah\'a yaklaştı');
    }

    // Nearby '?' fog silhouettes elevate tension
    const nearSilhouettes = visible.silhouettes.filter(
      (s) => s.side === oppSide && manhattanDistance(s.pos, myKing.pos) <= 4,
    ).length;
    if (nearSilhouettes > 0) {
      stress += Math.min(22, nearSilhouettes * 9);
      reasons.push(`${nearSilhouettes} sis silüeti yakında`);
    }
  }

  // Low unit count pressure
  if (myPieces.length <= 2) {
    stress += 22;
    reasons.push('Ordu kritik seviyede');
  } else if (myPieces.length <= 3) {
    stress += 10;
  }

  // Frozen friendly pieces
  const frozenMine = myPieces.filter((p) => p.frozenTurns > 0).length;
  if (frozenMine > 0) {
    stress += Math.min(18, frozenMine * 9);
    reasons.push(`${frozenMine} taş donmuş`);
  }

  // Boss ring imminent
  if (bossCooldown === 1) {
    stress += 24;
    reasons.push('Boss halkası 1 tur sonra!');
  }

  // Sudden fog uncertainty when total silhouettes >= 3
  if (visible.silhouettes.length >= 3) {
    stress += 10;
  }

  const percent = Math.max(5, Math.min(100, Math.round(stress)));
  if (percent >= 80) {
    return { percent, label: 'PANİK ATAK!', tone: 'panic', reasons };
  }
  if (percent >= 56) {
    return { percent, label: 'TERLİYOR', tone: 'sweat', reasons };
  }
  if (percent >= 30) {
    return { percent, label: 'GERGİN', tone: 'tense', reasons };
  }
  return { percent, label: 'SAKİN', tone: 'calm', reasons };
}

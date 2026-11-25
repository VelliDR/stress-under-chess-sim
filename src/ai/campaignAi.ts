import {
  coordEquals,
  getLegalMoves,
  getPieceAt,
  getTile,
  manhattanDistance,
  opponentOf,
} from '../engine/board';
import { nextInt } from '../engine/prng';
import { getLegalAbilities, hasTrait, LegalAbility } from '../engine/traits';
import {
  Coord,
  GameAction,
  LegalMove,
  Piece,
  PieceType,
  Side,
  VisibleState,
} from '../engine/types';

export interface RememberedUnit {
  pieceId: string;
  pos: Coord;
  type: PieceType;
  lastSeenTurn: number;
}

export interface RecentAiMove {
  pieceId: string;
  from: Coord;
  to: Coord;
}

/**
 * Pure JSON-serializable AI perception memory (no Map/Set/Date).
 * Tracks the last known coordinates of opponent pieces that retreated into fog,
 * plus recent self moves to prevent back-and-forth oscillation in fog endgames.
 */
export interface AiMemory {
  lastKnownPositions: Record<string, RememberedUnit>;
  recentSelfMoves?: RecentAiMove[];
}

export interface CampaignIntent {
  pieceId: string;
  from: Coord;
  to: Coord;
  action: GameAction;
  isAttack: boolean;
  score: number;
}

export interface CampaignAiDecision {
  action: GameAction;
  score: number;
  memory: AiMemory;
  nextRngState: number;
  intents: CampaignIntent[];
}

export const AI_PIECE_VALUES: Readonly<Record<PieceType, number>> = {
  PAWN: 100,
  KNIGHT: 320,
  BISHOP: 330,
  ROOK: 520,
  QUEEN: 950,
  KING: 10000,
  SAINT_FAITH: 600,
  SAINT_MADNESS: 620,
  CHIMERA: 980,
};

const ORTHOGONAL_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export function createAiMemory(): AiMemory {
  return { lastKnownPositions: {}, recentSelfMoves: [] };
}

/**
 * Records a chosen AI move into memory (ring buffer of last 6 moves) to discourage
 * meaningless A <-> B oscillation when hunting in fog.
 */
export function recordAiSelfMove(
  memory: AiMemory,
  pieceId: string,
  from: Coord,
  to: Coord,
): AiMemory {
  const prev = memory.recentSelfMoves ?? [];
  const next = prev.slice(-5).map((m) => ({
    pieceId: m.pieceId,
    from: { x: m.from.x, y: m.from.y },
    to: { x: m.to.x, y: m.to.y },
  }));
  next.push({
    pieceId,
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
  });
  return {
    lastKnownPositions: memory.lastKnownPositions,
    recentSelfMoves: next,
  };
}

/**
 * Purely updates AI memory strictly from `visible: VisibleState`.
 * - Records every currently visible opponent unit.
 * - Clears remembered positions if the AI now has direct VISIBLE sight of that square and the unit is gone.
 */
export function updateAiMemory(
  memory: AiMemory,
  visible: VisibleState,
  aiSide: Side = 'ENEMY',
): AiMemory {
  const next: Record<string, RememberedUnit> = {};
  const existingKeys = Object.keys(memory.lastKnownPositions);
  for (let i = 0; i < existingKeys.length; i++) {
    const key = existingKeys[i]!;
    const item = memory.lastKnownPositions[key]!;
    next[key] = {
      pieceId: item.pieceId,
      pos: { x: item.pos.x, y: item.pos.y },
      type: item.type,
      lastSeenTurn: item.lastSeenTurn,
    };
  }

  const seenNowIds: Record<string, true> = {};
  for (let i = 0; i < visible.pieces.length; i++) {
    const p = visible.pieces[i]!;
    if (p.side === aiSide) continue;
    seenNowIds[p.id] = true;
    next[p.id] = {
      pieceId: p.id,
      pos: { x: p.pos.x, y: p.pos.y },
      type: p.type,
      lastSeenTurn: visible.turnNumber,
    };
  }

  // Prune stale memories whose remembered tile is currently VISIBLE without that unit present
  const nextKeys = Object.keys(next);
  for (let i = 0; i < nextKeys.length; i++) {
    const id = nextKeys[i]!;
    if (seenNowIds[id]) continue;
    const entry = next[id]!;
    if (visible.fog[entry.pos.y]?.[entry.pos.x] === 'VISIBLE') {
      delete next[id];
    }
  }

  return {
    lastKnownPositions: next,
    ...(memory.recentSelfMoves !== undefined
      ? {
          recentSelfMoves: memory.recentSelfMoves.map((m) => ({
            pieceId: m.pieceId,
            from: { x: m.from.x, y: m.from.y },
            to: { x: m.to.x, y: m.to.y },
          })),
        }
      : {}),
  };
}

function collectVisibleThreatCoords(visible: VisibleState, attackerSide: Side): Coord[] {
  const threatened: Coord[] = [];
  for (let i = 0; i < visible.pieces.length; i++) {
    const piece = visible.pieces[i]!;
    if (piece.side !== attackerSide) continue;
    if (piece.frozenTurns > 0) continue;
    const moves = getLegalMoves(visible, piece);
    for (let m = 0; m < moves.length; m++) {
      const move = moves[m]!;
      const end = move.resolution.hitPos ?? move.resolution.finalPos;
      if (end !== null) {
        threatened.push(end);
      }
    }
  }
  return threatened;
}

function isCoordInList(list: readonly Coord[], coord: Coord): boolean {
  for (let i = 0; i < list.length; i++) {
    if (coordEquals(list[i]!, coord)) return true;
  }
  return false;
}

function collectUnoccupiedWatchtowers(visible: VisibleState, aiSide: Side): Coord[] {
  const towers: Coord[] = [];
  for (let y = 0; y < visible.height; y++) {
    const row = visible.tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < visible.width; x++) {
      const tile = row[x];
      if (tile === undefined || tile === null || tile.type !== 'WATCHTOWER') continue;
      const occ = getPieceAt(visible.pieces, { x, y });
      if (occ === undefined || occ.side !== aiSide) {
        towers.push({ x, y });
      }
    }
  }
  return towers;
}

function nearestDistance(from: Coord, targets: readonly Coord[]): number | null {
  if (targets.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < targets.length; i++) {
    const d = manhattanDistance(from, targets[i]!);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

function findNearestUnexplored(visible: VisibleState, from: Coord): number | null {
  let best = Number.POSITIVE_INFINITY;
  for (let y = 0; y < visible.height; y++) {
    const fogRow = visible.fog[y];
    if (fogRow === undefined) continue;
    for (let x = 0; x < visible.width; x++) {
      if (fogRow[x] === 'UNEXPLORED') {
        const d = manhattanDistance(from, { x, y });
        if (d < best) best = d;
      }
    }
  }
  return Number.isFinite(best) ? best : null;
}

interface ScoredCandidate {
  piece: Piece;
  action: GameAction;
  targetCoord: Coord;
  isAttack: boolean;
  score: number;
}

function scoreMoveCandidate(
  visible: VisibleState,
  piece: Piece,
  move: LegalMove,
  memory: AiMemory,
  aiSide: Side,
  visibleEnemies: readonly Piece[],
  threatenedSquares: readonly Coord[],
  watchtowers: readonly Coord[],
): ScoredCandidate {
  const res = move.resolution;
  const moverValue = AI_PIECE_VALUES[piece.type];
  let score = 0;
  let isAttack = false;

  // 1. Self-preservation: never walk into PIT unless somehow capturing King first (not possible in PIT)
  if (res.fellInPit) {
    score = piece.type === 'KING' ? -15000 : -(moverValue * 3 + 500);
    return {
      piece,
      action: { type: 'MOVE', pieceId: piece.id, to: { x: move.to.x, y: move.to.y } },
      targetCoord: { x: move.to.x, y: move.to.y },
      isAttack: false,
      score,
    };
  }

  const finalPos = res.finalPos ?? move.to;

  // 2. Combat outcomes
  if (res.captured && res.hitPieceId !== null) {
    isAttack = true;
    const victim = visible.pieces.find((p) => p.id === res.hitPieceId);
    const victimValue = victim !== undefined ? AI_PIECE_VALUES[victim.type] : 120;
    score += victimValue === AI_PIECE_VALUES.KING ? 12000 : Math.round(victimValue * 1.45);
    if (victim?.traits.includes('EXPLOSIVE') && !piece.shieldActive) {
      // Slightly respect explosive retaliation if our piece is very valuable
      score -= piece.type === 'KING' ? 3500 : Math.round(moverValue * 0.5);
    }
  } else if (res.brokeShield && res.hitPieceId !== null) {
    isAttack = true;
    const victim = visible.pieces.find((p) => p.id === res.hitPieceId);
    score += victim?.type === 'KING' ? 420 : 185;
    if (piece.traits.includes('FROST_TOUCH')) {
      score += 120;
    }
  }

  // 3. Promotion bonus
  if (res.promotes) {
    score += 720;
  }

  // 4. Burning hazard penalty (unless we just killed the King!)
  if (res.endsOnBurning && score < 10000) {
    if (piece.shieldActive) {
      score -= 80;
    } else {
      score -= piece.type === 'KING' ? 9500 : Math.round(moverValue * 1.35 + 140);
    }
  }

  // Reward escaping from a BURNING tile
  const currentTile = getTile(visible, piece.pos);
  if (currentTile?.type === 'BURNING' && !res.endsOnBurning) {
    score += piece.type === 'KING' ? 2000 : 190;
  }

  // 5. FROST_TOUCH orthogonal adjacency freeze bonus
  if (piece.traits.includes('FROST_TOUCH')) {
    for (let d = 0; d < ORTHOGONAL_DIRS.length; d++) {
      const dir = ORTHOGONAL_DIRS[d]!;
      const adj = getPieceAt(visible.pieces, { x: finalPos.x + dir.x, y: finalPos.y + dir.y }, piece.id);
      if (adj !== undefined && adj.side !== aiSide && adj.frozenTurns === 0) {
        score += adj.type === 'KING' || adj.type === 'QUEEN' ? 190 : 115;
        isAttack = true;
        break;
      }
    }
  }

  // 6. Watchtower vantage claim
  const destTile = getTile(visible, finalPos);
  if (destTile?.type === 'WATCHTOWER' && currentTile?.type !== 'WATCHTOWER') {
    score += visibleEnemies.length === 0 ? 155 : 95;
  }

  // 7. Threat avoidance on landing square
  if (isCoordInList(threatenedSquares, finalPos) && score < 10000) {
    const riskFactor = piece.type === 'KING' ? 0.9 : piece.shieldActive ? 0.12 : 0.42;
    score -= Math.round(moverValue * riskFactor);
  }

  // 8. Pursuit / Memory / Watchtower / Frontier exploration navigation
  if (visibleEnemies.length > 0) {
    const enemyCoords = visibleEnemies.map((e) => e.pos);
    const enemyKing = visibleEnemies.find((e) => e.type === 'KING');
    const targetCoords = enemyKing !== undefined ? [enemyKing.pos] : enemyCoords;
    const dBefore = nearestDistance(piece.pos, targetCoords);
    const dAfter = nearestDistance(finalPos, targetCoords);
    if (dBefore !== null && dAfter !== null) {
      const gain = dBefore - dAfter;
      // Kings should be cautious; non-Kings aggressively close distance
      const pursuitWeight = piece.type === 'KING' ? 10 : enemyKing !== undefined ? 42 : 34;
      score += gain * pursuitWeight;
    }
  } else {
    // No enemy currently in sight -> follow fair AI memory, silhouettes, or watchtowers
    const rememberedCoords = Object.values(memory.lastKnownPositions).map((r) => r.pos);
    const silCoords = visible.silhouettes.map((s) => s.pos);

    if (rememberedCoords.length > 0) {
      const dBefore = nearestDistance(piece.pos, rememberedCoords);
      const dAfter = nearestDistance(finalPos, rememberedCoords);
      if (dBefore !== null && dAfter !== null) {
        score += (dBefore - dAfter) * 52;
      }
    }

    if (silCoords.length > 0) {
      const dBefore = nearestDistance(piece.pos, silCoords);
      const dAfter = nearestDistance(finalPos, silCoords);
      if (dBefore !== null && dAfter !== null) {
        score += (dBefore - dAfter) * 40;
      }
    }

    if (watchtowers.length > 0 && currentTile?.type !== 'WATCHTOWER') {
      const dBefore = nearestDistance(piece.pos, watchtowers);
      const dAfter = nearestDistance(finalPos, watchtowers);
      if (dBefore !== null && dAfter !== null) {
        score += (dBefore - dAfter) * 44;
      }
    }

    if (rememberedCoords.length === 0 && silCoords.length === 0) {
      const uBefore = findNearestUnexplored(visible, piece.pos);
      const uAfter = findNearestUnexplored(visible, finalPos);
      if (uBefore !== null && uAfter !== null) {
        score += (uBefore - uAfter) * 20;
      }
    }
  }

  // Slight bonus for RAIDERS / DASH_ON_REVEAL mobility & center presence
  if (hasTrait(piece, 'DASH_ON_REVEAL', visible.factions) && !piece.wasVisibleAtTurnStart) {
    score += 24;
  }

  const centerX = (visible.width - 1) / 2;
  const centerY = (visible.height - 1) / 2;
  const centerDistAfter = Math.abs(finalPos.x - centerX) + Math.abs(finalPos.y - centerY);
  score += Math.max(0, Math.round(14 - centerDistAfter * 2));

  // Discourage meaningless A <-> B oscillation when not attacking
  const recent = memory.recentSelfMoves;
  if (!isAttack && recent !== undefined && recent.length > 0) {
    const last = recent[recent.length - 1]!;
    if (last.pieceId === piece.id && coordEquals(last.from, finalPos)) {
      score -= 48;
    } else {
      for (let r = 0; r < recent.length; r++) {
        const m = recent[r]!;
        if (m.pieceId === piece.id && coordEquals(m.to, finalPos)) {
          score -= 18;
        }
      }
    }
  }

  return {
    piece,
    action: { type: 'MOVE', pieceId: piece.id, to: { x: move.to.x, y: move.to.y } },
    targetCoord: res.hitPos ?? finalPos,
    isAttack,
    score,
  };
}

function scoreAbilityCandidate(
  visible: VisibleState,
  piece: Piece,
  ability: LegalAbility,
  aiSide: Side,
): ScoredCandidate {
  let score = 0;
  let isAttack = false;

  if (ability.ability === 'PUSH' && ability.pushPreview !== undefined) {
    const pp = ability.pushPreview;
    const victim = getPieceAt(visible.pieces, ability.target);
    const victimValue = victim !== undefined ? AI_PIECE_VALUES[victim.type] : 100;
    isAttack = true;

    if (pp.blocked) {
      score = -60;
    } else if (pp.fellInPit) {
      score = victim?.type === 'KING' ? 12000 : Math.round(victimValue * 1.65 + 240);
    } else if (pp.finalPos !== null) {
      const endTile = getTile(visible, pp.finalPos);
      score = 65;
      if (pp.slid) score += 90;
      if (endTile?.type === 'BURNING') {
        score += victim?.type === 'KING' && !victim.shieldActive ? 600 : 190;
      }
    }
  } else if (ability.ability === 'BREAK_WALL') {
    // Reward breaking walls that lie between us and enemies or unexplored space
    const dx = ability.target.x - piece.pos.x;
    const dy = ability.target.y - piece.pos.y;
    const beyond: Coord = { x: ability.target.x + dx, y: ability.target.y + dy };
    const beyondFog = visible.fog[beyond.y]?.[beyond.x];
    const beyondPiece = getPieceAt(visible.pieces, beyond);

    score = 40;
    if (beyondPiece !== undefined && beyondPiece.side !== aiSide) {
      score += 180;
      isAttack = true;
    } else if (beyondFog === 'UNEXPLORED') {
      score += 85;
    }
  }

  return {
    piece,
    action: {
      type: 'USE_ABILITY',
      pieceId: piece.id,
      ability: ability.ability,
      target: { x: ability.target.x, y: ability.target.y },
    },
    targetCoord: { x: ability.target.x, y: ability.target.y },
    isAttack,
    score,
  };
}

function evaluateBestActionForPiece(
  visible: VisibleState,
  piece: Piece,
  memory: AiMemory,
  aiSide: Side,
  visibleEnemies: readonly Piece[],
  threatenedSquares: readonly Coord[],
  watchtowers: readonly Coord[],
): ScoredCandidate | null {
  const moves = getLegalMoves(visible, piece, visible.bonusMovePieceId);
  const abilities = getLegalAbilities(visible, piece, visible.bonusMovePieceId);

  let best: ScoredCandidate | null = null;

  for (let i = 0; i < moves.length; i++) {
    const candidate = scoreMoveCandidate(
      visible,
      piece,
      moves[i]!,
      memory,
      aiSide,
      visibleEnemies,
      threatenedSquares,
      watchtowers,
    );
    if (best === null || candidate.score > best.score) {
      best = candidate;
    }
  }

  for (let i = 0; i < abilities.length; i++) {
    const candidate = scoreAbilityCandidate(visible, piece, abilities[i]!, aiSide);
    if (best === null || candidate.score > best.score) {
      best = candidate;
    }
  }

  return best;
}

/**
 * Computes highest-priority intent previews for every ACTIVE, unfrozen piece of `aiSide`
 * using strictly `enemyVisible: VisibleState` (zero hidden information).
 */
export function computeCampaignIntents(
  enemyVisible: VisibleState,
  memory: AiMemory = createAiMemory(),
  aiSide: Side = 'ENEMY',
): CampaignIntent[] {
  const oppSide = opponentOf(aiSide);
  const visibleEnemies = enemyVisible.pieces.filter((p) => p.side === oppSide);
  const threatenedSquares = collectVisibleThreatCoords(enemyVisible, oppSide);
  const watchtowers = collectUnoccupiedWatchtowers(enemyVisible, aiSide);
  const intents: CampaignIntent[] = [];

  for (let i = 0; i < enemyVisible.pieces.length; i++) {
    const piece = enemyVisible.pieces[i]!;
    if (piece.side !== aiSide) continue;
    if (piece.aggro !== 'ACTIVE') continue;
    if (piece.frozenTurns > 0) continue;
    if (enemyVisible.bonusMovePieceId !== null && enemyVisible.bonusMovePieceId !== piece.id) {
      continue;
    }

    const best = evaluateBestActionForPiece(
      enemyVisible,
      piece,
      memory,
      aiSide,
      visibleEnemies,
      threatenedSquares,
      watchtowers,
    );
    if (best !== null && best.score > -500) {
      intents.push({
        pieceId: piece.id,
        from: { x: piece.pos.x, y: piece.pos.y },
        to: { x: best.targetCoord.x, y: best.targetCoord.y },
        action: best.action,
        isAttack: best.isAttack,
        score: best.score,
      });
    }
  }

  return intents;
}

/**
 * Filters Campaign intents so the player UI only renders intent arrows for enemies
 * currently visible in `viewerVisible` (prevents leaking hidden units through intent arrows).
 */
export function filterVisibleIntents(
  intents: readonly CampaignIntent[],
  viewerVisible: VisibleState,
): CampaignIntent[] {
  const visibleIds: Record<string, true> = {};
  for (let i = 0; i < viewerVisible.pieces.length; i++) {
    visibleIds[viewerVisible.pieces[i]!.id] = true;
  }
  return intents.filter((intent) => visibleIds[intent.pieceId] === true);
}

/**
 * Chooses the best fair Campaign AI action strictly from `visible: VisibleState` + `memory`.
 * - Only ACTIVE, unfrozen units may move (SLEEPING and ALERTED never act).
 * - Falls back to END_TURN when no safe/legal action exists (anti-softlock).
 */
export function chooseCampaignAction(
  visible: VisibleState,
  memory: AiMemory = createAiMemory(),
  rngState = 1,
  aiSide: Side = 'ENEMY',
): CampaignAiDecision {
  const updatedMemory = updateAiMemory(memory, visible, aiSide);
  const intents = computeCampaignIntents(visible, updatedMemory, aiSide);

  if (intents.length === 0) {
    return {
      action: { type: 'END_TURN' },
      score: 0,
      memory: updatedMemory,
      nextRngState: rngState,
      intents: [],
    };
  }

  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < intents.length; i++) {
    if (intents[i]!.score > bestScore) {
      bestScore = intents[i]!.score;
    }
  }

  // Collect near-tied top intents (within 10 points) for deterministic PRNG variety
  const topCandidates = intents.filter((it) => it.score >= bestScore - 10);
  let chosen: CampaignIntent;
  let nextRng = rngState;
  if (topCandidates.length === 1) {
    chosen = topCandidates[0]!;
  } else {
    const roll = nextInt(rngState, 0, topCandidates.length - 1);
    nextRng = roll.nextState;
    chosen = topCandidates[roll.value]!;
  }

  let finalMemory = updatedMemory;
  if (chosen.action.type === 'MOVE') {
    finalMemory = recordAiSelfMove(updatedMemory, chosen.pieceId, chosen.from, chosen.to);
  }

  return {
    action: chosen.action,
    score: chosen.score,
    memory: finalMemory,
    nextRngState: nextRng,
    intents,
  };
}

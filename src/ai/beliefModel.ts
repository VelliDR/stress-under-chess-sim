import { chebyshevDistance, inBounds, opponentOf } from '../engine/board';
import { hasActiveShield } from '../engine/dungeon';
import { canPieceAttackSquare } from '../engine/psychology';
import type { Coord, GameState, Piece, PieceType, Side, VisibleState } from '../engine/types';
import { AI_PIECE_VALUES, type AiMemory } from './campaignAi';

/**
 * Learned / tunable Bayesian Fog-of-War Belief Model parameters.
 * Strictly fair: consumes ONLY `VisibleState` (fog + silhouettes) and `AiMemory` (last-known coords).
 */
export interface BeliefModelWeights {
  /** Base threat weight stamped at a '?' silhouette square */
  silhouetteCenterWeight: number;
  /** Threat weight stamped 1-square around a '?' silhouette */
  silhouetteRing1Weight: number;
  /** Threat weight stamped 2-squares around a '?' silhouette */
  silhouetteRing2Weight: number;
  /** Per-turn exponential decay factor for remembered units that slipped into fog */
  memoryDecayPerTurn: number;
  /** Weight multiplier for exact movement-ray sniper lines from remembered pieces */
  sniperRayWeight: number;
  /** Threat weight for unexplored frontier squares adjacent to enemy back rows */
  unexploredAmbushPrior: number;
  /** Penalty multiplier when a root move steps directly into a fresh fog ghost's capture range */
  ghostAmbushPenaltyRatio: number;
}

export const DEFAULT_BELIEF_WEIGHTS: Readonly<BeliefModelWeights> = {
  silhouetteCenterWeight: 62,
  silhouetteRing1Weight: 44,
  silhouetteRing2Weight: 22,
  memoryDecayPerTurn: 0.78,
  sniperRayWeight: 1.15,
  unexploredAmbushPrior: 8,
  ghostAmbushPenaltyRatio: 0.34,
};

export interface GhostHypothesis {
  pieceId: string;
  type: PieceType;
  pos: Coord;
  confidence: number; // 0..1
  age: number;
  fromSilhouette: boolean;
}

export interface BeliefAnalysis {
  dangerGrid: number[][];
  ghosts: GhostHypothesis[];
}

const ORTHO_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const DIAG_DIRS: readonly Coord[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
];

const ALL_EIGHT_DIRS: readonly Coord[] = [...ORTHO_DIRS, ...DIAG_DIRS];

const KNIGHT_OFFSETS: readonly Coord[] = [
  { x: -2, y: -1 },
  { x: -2, y: 1 },
  { x: -1, y: -2 },
  { x: -1, y: 2 },
  { x: 1, y: -2 },
  { x: 1, y: 2 },
  { x: 2, y: -1 },
  { x: 2, y: 1 },
];

function baseThreatForType(type: PieceType): number {
  switch (type) {
    case 'QUEEN':
    case 'CHIMERA':
      return 64;
    case 'ROOK':
      return 48;
    case 'KNIGHT':
    case 'BISHOP':
    case 'SAINT_MADNESS':
      return 42;
    case 'SAINT_FAITH':
      return 34;
    case 'KING':
      return 32;
    case 'PAWN':
      return 24;
  }
}

function addClamped(grid: number[][], x: number, y: number, delta: number): void {
  const row = grid[y];
  if (row === undefined || x < 0 || x >= row.length) return;
  row[x] = Math.min(240, (row[x] ?? 0) + Math.round(delta));
}

function isKnownWall(visible: VisibleState, x: number, y: number): boolean {
  const t = visible.tiles[y]?.[x];
  return t !== null && t !== undefined && t.type === 'WALL';
}

/**
 * Stamps movement-geometry-aware sniper rays / jump offsets from a fog-hidden remembered unit.
 * Respects known walls and skips squares currently VISIBLE and empty as origin hypotheses.
 */
function stampPieceMovementThreat(
  grid: number[][],
  visible: VisibleState,
  origin: Coord,
  type: PieceType,
  oppSide: Side,
  strength: number,
  rayScale: number,
): void {
  addClamped(grid, origin.x, origin.y, strength * 1.1);

  const stampRays = (dirs: readonly Coord[], maxRange: number): void => {
    for (let d = 0; d < dirs.length; d++) {
      const dir = dirs[d]!;
      for (let step = 1; step <= maxRange; step++) {
        const nx = origin.x + dir.x * step;
        const ny = origin.y + dir.y * step;
        if (nx < 0 || nx >= visible.width || ny < 0 || ny >= visible.height) break;
        if (isKnownWall(visible, nx, ny)) break;
        const falloff = Math.max(0.45, 1 - (step - 1) * 0.1);
        addClamped(grid, nx, ny, strength * rayScale * falloff);
      }
    }
  };

  switch (type) {
    case 'ROOK':
      stampRays(ORTHO_DIRS, Math.max(visible.width, visible.height));
      break;
    case 'BISHOP':
      stampRays(DIAG_DIRS, Math.max(visible.width, visible.height));
      break;
    case 'QUEEN':
      stampRays(ALL_EIGHT_DIRS, Math.max(visible.width, visible.height));
      break;
    case 'CHIMERA':
      stampRays(ALL_EIGHT_DIRS, 4);
      for (let i = 0; i < KNIGHT_OFFSETS.length; i++) {
        const off = KNIGHT_OFFSETS[i]!;
        addClamped(grid, origin.x + off.x, origin.y + off.y, strength * 0.65);
      }
      break;
    case 'SAINT_FAITH':
    case 'SAINT_MADNESS':
      stampRays(ALL_EIGHT_DIRS, 2);
      break;
    case 'KNIGHT':
      for (let i = 0; i < KNIGHT_OFFSETS.length; i++) {
        const off = KNIGHT_OFFSETS[i]!;
        addClamped(grid, origin.x + off.x, origin.y + off.y, strength * rayScale);
      }
      break;
    case 'KING':
      stampRays(ALL_EIGHT_DIRS, 1);
      break;
    case 'PAWN': {
      const fdy = oppSide === 'PLAYER' ? -1 : 1;
      addClamped(grid, origin.x - 1, origin.y + fdy, strength * rayScale);
      addClamped(grid, origin.x + 1, origin.y + fdy, strength * rayScale);
      addClamped(grid, origin.x, origin.y + fdy, strength * 0.45);
      break;
    }
  }
}

/**
 * Builds a 100% fair Bayesian movement-aware fog danger map + ranked GhostHypothesis list
 * strictly from `VisibleState` (fog + silhouettes) and `AiMemory` (last-known positions).
 */
export function buildMovementAwareBelief(
  visible: VisibleState,
  memory: AiMemory,
  aiSide: Side,
  weights: Readonly<BeliefModelWeights> = DEFAULT_BELIEF_WEIGHTS,
): BeliefAnalysis {
  const oppSide = opponentOf(aiSide);
  const grid: number[][] = [];
  for (let y = 0; y < visible.height; y++) {
    grid.push(new Array<number>(visible.width).fill(0));
  }

  const ghosts: GhostHypothesis[] = [];
  const visiblePieceIds = new Set<string>();
  for (let i = 0; i < visible.pieces.length; i++) {
    visiblePieceIds.add(visible.pieces[i]!.id);
  }

  // 1) Remembered enemy pieces that slipped back into fog (piece-geometry sniper rays + diffusion)
  const remembered = Object.values(memory.lastKnownPositions);
  for (let i = 0; i < remembered.length; i++) {
    const rem = remembered[i]!;
    if (visiblePieceIds.has(rem.pieceId)) continue;
    const age = Math.max(0, visible.turnNumber - rem.lastSeenTurn);
    if (age > 6) continue;
    // Skip if that exact square is currently VISIBLE (we already know it's no longer there)
    const squareVisible = visible.fog[rem.pos.y]?.[rem.pos.x] === 'VISIBLE';
    const decay = Math.pow(weights.memoryDecayPerTurn, age);
    const strength = baseThreatForType(rem.type) * decay * (squareVisible ? 0.55 : 1.0);

    stampPieceMovementThreat(
      grid,
      visible,
      rem.pos,
      rem.type,
      oppSide,
      strength,
      weights.sniperRayWeight,
    );

    // Slight diffusion halo for pieces that had 1-2 turns to step away
    if (age >= 1) {
      const halo = strength * 0.42;
      for (let d = 0; d < ALL_EIGHT_DIRS.length; d++) {
        const dir = ALL_EIGHT_DIRS[d]!;
        const nx = rem.pos.x + dir.x;
        const ny = rem.pos.y + dir.y;
        if (nx >= 0 && nx < visible.width && ny >= 0 && ny < visible.height && !isKnownWall(visible, nx, ny)) {
          addClamped(grid, nx, ny, halo);
        }
      }
    }

    if (!squareVisible && age <= 3) {
      ghosts.push({
        pieceId: rem.pieceId,
        type: rem.type,
        pos: { x: rem.pos.x, y: rem.pos.y },
        confidence: Math.max(0.25, decay),
        age,
        fromSilhouette: false,
      });
    }
  }

  // 2) '?' Radar silhouettes (+2 ring outside vision): immediate high-confidence unseen threats
  for (let i = 0; i < visible.silhouettes.length; i++) {
    const sil = visible.silhouettes[i]!;
    if (sil.side === aiSide) continue;

    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = sil.pos.x + dx;
        const ny = sil.pos.y + dy;
        if (nx < 0 || nx >= visible.width || ny < 0 || ny >= visible.height) continue;
        if (isKnownWall(visible, nx, ny)) continue;
        const cheb = Math.max(Math.abs(dx), Math.abs(dy));
        const w =
          cheb === 0
            ? weights.silhouetteCenterWeight
            : cheb === 1
              ? weights.silhouetteRing1Weight
              : weights.silhouetteRing2Weight;
        addClamped(grid, nx, ny, w);
      }
    }

    // Match silhouette to nearest fresh remembered unit if within 2 squares, else assume ROOK/KNIGHT threat
    let matchedType: PieceType = 'ROOK';
    let bestDist = 3;
    for (let r = 0; r < remembered.length; r++) {
      const rem = remembered[r]!;
      if (visiblePieceIds.has(rem.pieceId)) continue;
      const d = chebyshevDistance(rem.pos, sil.pos);
      if (d < bestDist) {
        bestDist = d;
        matchedType = rem.type;
      }
    }

    ghosts.push({
      pieceId: `sil_${i}`,
      type: matchedType,
      pos: { x: sil.pos.x, y: sil.pos.y },
      confidence: 0.85,
      age: 0,
      fromSilhouette: true,
    });
  }

  // 3) Subtle ambush prior on squares bordering UNEXPLORED fog toward enemy side
  if (weights.unexploredAmbushPrior > 0) {
    const oppBackY = oppSide === 'PLAYER' ? visible.height - 1 : 0;
    for (let y = 0; y < visible.height; y++) {
      const distToEnemyHalf = Math.abs(y - oppBackY) <= Math.ceil(visible.height / 2) ? 1 : 0.45;
      for (let x = 0; x < visible.width; x++) {
        if (visible.fog[y]?.[x] === 'UNEXPLORED') continue;
        if (isKnownWall(visible, x, y)) continue;
        let adjUnexplored = 0;
        for (let d = 0; d < ORTHO_DIRS.length; d++) {
          const nx = x + ORTHO_DIRS[d]!.x;
          const ny = y + ORTHO_DIRS[d]!.y;
          if (visible.fog[ny]?.[nx] === 'UNEXPLORED') adjUnexplored++;
        }
        if (adjUnexplored > 0) {
          addClamped(grid, x, y, weights.unexploredAmbushPrior * distToEnemyHalf * Math.min(2, adjUnexplored));
        }
      }
    }
  }

  // Rank ghosts by confidence * value and keep top 4
  ghosts.sort(
    (a, b) =>
      b.confidence * AI_PIECE_VALUES[b.type] - a.confidence * AI_PIECE_VALUES[a.type],
  );
  if (ghosts.length > 4) ghosts.length = 4;

  return { dangerGrid: grid, ghosts };
}

/**
 * Fair PIMC-style root ghost-ambush check:
 * Tests whether our piece's landing square (or exposed King) after a root move is directly
 * sniped in 1 ply by any high-confidence fog GhostHypothesis (strictly derived from VisibleState + AiMemory).
 * Never hallucinates capturing ghosts; strictly models defensive ambush risk.
 */
export function evaluateRootGhostAmbushRisk(
  nextState: GameState,
  movedPieceId: string | null,
  ghosts: readonly GhostHypothesis[],
  aiSide: Side,
  weights: Readonly<BeliefModelWeights> = DEFAULT_BELIEF_WEIGHTS,
): number {
  if (ghosts.length === 0) return 0;

  const oppSide = opponentOf(aiSide);
  const movedPiece =
    movedPieceId !== null ? nextState.pieces.find((p) => p.id === movedPieceId) : undefined;
  const myKing = nextState.pieces.find((p) => p.side === aiSide && p.type === 'KING');

  let penalty = 0;

  for (let g = 0; g < ghosts.length; g++) {
    const ghost = ghosts[g]!;
    if (!inBounds(nextState, ghost.pos)) continue;

    // Skip if a real piece already stands on the ghost's square
    if (nextState.pieces.some((p) => p.pos.x === ghost.pos.x && p.pos.y === ghost.pos.y)) {
      continue;
    }

    const phantom: Piece = {
      id: ghost.pieceId,
      side: oppSide,
      type: ghost.type,
      pos: ghost.pos,
      traits: [],
      shieldActive: false,
      frozenTurns: 0,
      hasMoved: true,
      aggro: 'ACTIVE',
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: false,
    };

    // Check if our moved piece stepped straight into a fog sniper's line of fire
    if (movedPiece !== undefined && movedPiece.side === aiSide) {
      const canHitMoved =
        canPieceAttackSquare(nextState, phantom, movedPiece.pos) ||
        (ghost.fromSilhouette && chebyshevDistance(ghost.pos, movedPiece.pos) <= 2);

      if (canHitMoved) {
        // Cheap scout / shielded pawn probing a silhouette is fine (small penalty only)
        if (movedPiece.type === 'PAWN' && (movedPiece.traits.includes('SCOUT') || hasActiveShield(movedPiece))) {
          penalty += Math.round(12 * ghost.confidence);
        } else {
          const val = movedPiece.type === 'KING' ? 1400 : AI_PIECE_VALUES[movedPiece.type];
          const shieldScale = hasActiveShield(movedPiece) ? 0.35 : 1.0;
          penalty += Math.round(val * weights.ghostAmbushPenaltyRatio * ghost.confidence * shieldScale);
        }
      }
    }

    // Check if our King is exposed to a fresh remembered fog sniper (not already counted if King moved)
    if (myKing !== undefined && myKing.id !== movedPieceId && !ghost.fromSilhouette) {
      if (canPieceAttackSquare(nextState, phantom, myKing.pos)) {
        const shieldScale = hasActiveShield(myKing) ? 0.3 : 0.85;
        penalty += Math.round(480 * weights.ghostAmbushPenaltyRatio * ghost.confidence * shieldScale);
      }
    }
  }

  return Math.min(950, penalty);
}

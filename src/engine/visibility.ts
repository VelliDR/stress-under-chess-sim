import { clonePiece, cloneTile, coordEquals, createEmptyFog, getPieceAt } from './board';
import { compareCoordsCanonical } from './dungeon';
import { computeSilhouettes } from './fog';
import { fnv1a32, shuffle } from './prng';
import {
  Coord,
  FogPerspective,
  GameState,
  Piece,
  Side,
  Silhouette,
  TileState,
  VisibleState,
} from './types';

export const PANIC_STRESS_THRESHOLD = 75;

export interface VisibleStateOptions {
  /** Human player's current UI stress score (0..100). Hallucinations only spawn when >= 75. */
  stressScore?: number;
}

/**
 * Deterministically generates 2–3 phantom '?' hallucination coordinates in the +1..+2 outer
 * ring beyond `side`'s VISIBLE frontier when PANIC stress (>= 75) is active.
 * Strictly visual — never enters engine physics or AI decision pipelines.
 */
export function computeHallucinations(
  state: GameState,
  side: Side,
  stressScore = PANIC_STRESS_THRESHOLD,
  existingSilhouettes?: readonly Silhouette[],
): Coord[] {
  if (stressScore < PANIC_STRESS_THRESHOLD) return [];

  const sideFog = state.fog[side];
  const realSilhouettes = existingSilhouettes ?? computeSilhouettes(state, side, sideFog);

  const visibleCoords: Coord[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (sideFog[y]?.[x] === 'VISIBLE') {
        visibleCoords.push({ x, y });
      }
    }
  }
  if (visibleCoords.length === 0) return [];

  const candidates: Coord[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (sideFog[y]?.[x] === 'VISIBLE') continue;
      const tile = state.tiles[y]?.[x];
      if (tile === undefined || tile.type === 'WALL' || tile.type === 'PIT') continue;
      const pos: Coord = { x, y };
      if (getPieceAt(state.pieces, pos) !== undefined) continue;
      if (realSilhouettes.some((s) => coordEquals(s.pos, pos))) continue;

      let nearVisible = false;
      for (let v = 0; v < visibleCoords.length; v++) {
        const vc = visibleCoords[v]!;
        const d = Math.max(Math.abs(vc.x - x), Math.abs(vc.y - y));
        if (d >= 1 && d <= 2) {
          nearVisible = true;
          break;
        }
      }
      if (nearVisible) {
        candidates.push(pos);
      }
    }
  }

  if (candidates.length === 0) return [];

  const seed = fnv1a32(`${state.rngState}:${state.turnNumber}:${side}:HALLUCINATION`);
  const desiredCount = Math.min(candidates.length, 2 + (seed & 1)); // 2 or 3
  const shuffled = shuffle(seed, candidates).value;
  return shuffled.slice(0, desiredCount).sort(compareCoordsCanonical);
}

/**
 * Produces a strictly isolated, JSON-serializable view of GameState for a single side.
 * Both Canvas Renderer and AI must consume this instead of raw GameState so hidden
 * units, unexplored terrain, and unseen spawns can never leak.
 */
export function getVisibleState(
  state: GameState,
  side: Side,
  options: VisibleStateOptions = {},
): VisibleState {
  const sideFog = state.fog[side];

  const fog = sideFog.map((row) => row.slice());
  const tiles: (TileState | null)[][] = [];

  for (let y = 0; y < state.height; y++) {
    const row: (TileState | null)[] = [];
    for (let x = 0; x < state.width; x++) {
      const level = sideFog[y]?.[x] ?? 'UNEXPLORED';
      if (level === 'UNEXPLORED') {
        row.push(null);
      } else {
        const tile = state.tiles[y]?.[x];
        row.push(tile !== undefined ? cloneTile(tile) : null);
      }
    }
    tiles.push(row);
  }

  const visiblePieces: Piece[] = [];
  for (let i = 0; i < state.pieces.length; i++) {
    const piece = state.pieces[i]!;
    if (piece.side === side) {
      visiblePieces.push(clonePiece(piece));
    } else if (sideFog[piece.pos.y]?.[piece.pos.x] === 'VISIBLE') {
      visiblePieces.push(clonePiece(piece));
    }
  }

  const silhouettes = computeSilhouettes(state, side, sideFog);
  const hallucinationSilhouettes =
    options.stressScore !== undefined && options.stressScore >= PANIC_STRESS_THRESHOLD
      ? computeHallucinations(state, side, options.stressScore, silhouettes)
      : [];

  const visibleSpawns = state.pendingSpawns
    .filter(
      (sp) => sp.side === side || sideFog[sp.pos.y]?.[sp.pos.x] === 'VISIBLE',
    )
    .map((sp) => ({
      pos: { x: sp.pos.x, y: sp.pos.y },
      turnsRemaining: sp.turnsRemaining,
      side: sp.side,
      pieceType: sp.pieceType,
    }));

  return {
    viewer: side,
    width: state.width,
    height: state.height,
    tiles,
    fog,
    pieces: visiblePieces,
    silhouettes,
    hallucinationSilhouettes,
    pendingSpawns: visibleSpawns,
    turn: state.turn,
    turnNumber: state.turnNumber,
    mode: state.mode,
    factions: { PLAYER: state.factions.PLAYER, ENEMY: state.factions.ENEMY },
    bonusMovePieceId: state.bonusMovePieceId,
    winner: state.winner,
  };
}

/**
 * Produces an omniscient VisibleState (all tiles VISIBLE, all pieces & spawns revealed)
 * strictly for Sandbox inspection while keeping the renderer bound to the VisibleState contract.
 */
export function getOmniscientVisibleState(state: GameState): VisibleState {
  const tiles: (TileState | null)[][] = state.tiles.map((row) =>
    row.map((tile) => cloneTile(tile)),
  );
  const fog = createEmptyFog(state.width, state.height, 'VISIBLE');
  const pieces = state.pieces.map(clonePiece);
  const pendingSpawns = state.pendingSpawns.map((sp) => ({
    pos: { x: sp.pos.x, y: sp.pos.y },
    turnsRemaining: sp.turnsRemaining,
    side: sp.side,
    pieceType: sp.pieceType,
  }));

  return {
    viewer: 'OMNISCIENT',
    width: state.width,
    height: state.height,
    tiles,
    fog,
    pieces,
    silhouettes: [],
    hallucinationSilhouettes: [],
    pendingSpawns,
    turn: state.turn,
    turnNumber: state.turnNumber,
    mode: state.mode,
    factions: { PLAYER: state.factions.PLAYER, ENEMY: state.factions.ENEMY },
    bonusMovePieceId: state.bonusMovePieceId,
    winner: state.winner,
  };
}

export function getVisibleStateForPerspective(
  state: GameState,
  perspective: FogPerspective,
  options: VisibleStateOptions = {},
): VisibleState {
  if (perspective === 'OMNISCIENT') {
    return getOmniscientVisibleState(state);
  }
  return getVisibleState(state, perspective, options);
}

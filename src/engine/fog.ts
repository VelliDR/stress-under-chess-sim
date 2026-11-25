import { chebyshevDistance, createEmptyFog, getTile, inBounds } from './board';
import { getEffectiveTraits } from './psychology';
import {
  BASE_VISION_RADIUS,
  BoardView,
  Coord,
  Piece,
  SCOUT_VISION_BONUS,
  SILHOUETTE_RING_EXTENSION,
  Side,
  Silhouette,
  TileState,
  VisibilityLevel,
  WATCHTOWER_VISION_BONUS,
} from './types';

/**
 * Returns true if a tile strictly between `from` and `to` blocks line-of-sight.
 * Both WALL tiles and tiles covered in MIASMA block vision behind them while remaining
 * visible themselves.
 */
export function isLosBlockingTile(tile: TileState | null | undefined): boolean {
  if (tile === undefined || tile === null) return false;
  return tile.type === 'WALL' || tile.gas?.kind === 'MIASMA';
}

/**
 * Computes a piece's Chebyshev vision radius including WATCHTOWER (+2) and SCOUT (+2) bonuses.
 */
export function getPieceVisionRadius(board: BoardView, piece: Piece): number {
  let radius = BASE_VISION_RADIUS[piece.type];

  const tile = getTile(board, piece.pos);
  if (tile !== undefined && tile !== null && tile.type === 'WATCHTOWER') {
    radius += WATCHTOWER_VISION_BONUS;
  }

  if (getEffectiveTraits(piece, board.factions).includes('SCOUT')) {
    radius += SCOUT_VISION_BONUS;
  }

  return radius;
}

/**
 * Directional Bresenham line-of-sight from `from` to `to`.
 * Only WALL tiles and MIASMA-covered tiles strictly between `from` and `to` block vision;
 * pieces and other terrain do not. Destination itself (even if WALL or MIASMA) is visible.
 */
export function hasDirectionalLineOfSight(
  board: BoardView,
  from: Coord,
  to: Coord,
): boolean {
  if (!inBounds(board, from) || !inBounds(board, to)) {
    return false;
  }
  if (from.x === to.x && from.y === to.y) {
    return true;
  }

  let x0 = from.x;
  let y0 = from.y;
  const x1 = to.x;
  const y1 = to.y;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }

    // Reached destination cell: destination itself (even if WALL or MIASMA) is visible.
    if (x0 === x1 && y0 === y1) {
      return true;
    }

    const tile = getTile(board, { x: x0, y: y0 });
    if (isLosBlockingTile(tile)) {
      return false;
    }
  }
}

/**
 * Symmetric line-of-sight: clear if at least one of A->B or B->A is not blocked by a WALL.
 * Mathematically guarantees LOS(A, B) === LOS(B, A).
 */
export function hasSymmetricLineOfSight(board: BoardView, a: Coord, b: Coord): boolean {
  return hasDirectionalLineOfSight(board, a, b) || hasDirectionalLineOfSight(board, b, a);
}

/**
 * Recomputes a side's 3-level Fog of War grid (UNEXPLORED / EXPLORED / VISIBLE).
 * Previously VISIBLE or EXPLORED squares downgrade to EXPLORED unless currently seen.
 */
export function computeFogForSide(
  board: BoardView,
  side: Side,
  previousFog?: readonly (readonly VisibilityLevel[])[],
): VisibilityLevel[][] {
  const fog = createEmptyFog(board.width, board.height, 'UNEXPLORED');

  if (previousFog !== undefined) {
    for (let y = 0; y < board.height; y++) {
      const prevRow = previousFog[y];
      const nextRow = fog[y];
      if (prevRow === undefined || nextRow === undefined) continue;
      for (let x = 0; x < board.width; x++) {
        const prevLevel = prevRow[x];
        if (prevLevel === 'VISIBLE' || prevLevel === 'EXPLORED') {
          nextRow[x] = 'EXPLORED';
        }
      }
    }
  }

  for (let i = 0; i < board.pieces.length; i++) {
    const piece = board.pieces[i]!;
    if (piece.side !== side) continue;
    if (!inBounds(board, piece.pos)) continue;

    const radius = getPieceVisionRadius(board, piece);
    const minX = Math.max(0, piece.pos.x - radius);
    const maxX = Math.min(board.width - 1, piece.pos.x + radius);
    const minY = Math.max(0, piece.pos.y - radius);
    const maxY = Math.min(board.height - 1, piece.pos.y + radius);

    for (let y = minY; y <= maxY; y++) {
      const row = fog[y]!;
      for (let x = minX; x <= maxX; x++) {
        if (row[x] === 'VISIBLE') continue;
        if (hasSymmetricLineOfSight(board, piece.pos, { x, y })) {
          row[x] = 'VISIBLE';
        }
      }
    }
  }

  return fog;
}

/**
 * Recomputes Fog of War for both PLAYER and ENEMY while preserving prior exploration memory.
 */
export function recomputeAllFog(
  board: BoardView,
  previousFog?: Readonly<Record<Side, readonly (readonly VisibilityLevel[])[]>>,
): Record<Side, VisibilityLevel[][]> {
  return {
    PLAYER: computeFogForSide(board, 'PLAYER', previousFog?.PLAYER),
    ENEMY: computeFogForSide(board, 'ENEMY', previousFog?.ENEMY),
  };
}

/**
 * Computes enemy '?' silhouettes within +2 Chebyshev ring beyond any friendly unit's VISIBLE
 * radius, provided line of sight is not completely blocked by WALLs and the enemy lacks SHADOW_WALKER.
 */
export function computeSilhouettes(
  board: BoardView,
  viewer: Side,
  viewerFog: readonly (readonly VisibilityLevel[])[],
): Silhouette[] {
  const silhouettes: Silhouette[] = [];

  for (let eIdx = 0; eIdx < board.pieces.length; eIdx++) {
    const enemy = board.pieces[eIdx]!;
    if (enemy.side === viewer) continue;
    if (!inBounds(board, enemy.pos)) continue;

    // Already fully visible -> not a '?' silhouette
    if (viewerFog[enemy.pos.y]?.[enemy.pos.x] === 'VISIBLE') continue;

    // SHADOW_WALKER units (when not silenced) never leave silhouettes
    if (getEffectiveTraits(enemy, board.factions).includes('SHADOW_WALKER')) continue;

    let detected = false;
    for (let aIdx = 0; aIdx < board.pieces.length; aIdx++) {
      const ally = board.pieces[aIdx]!;
      if (ally.side !== viewer) continue;
      if (!inBounds(board, ally.pos)) continue;

      const maxSilhouetteRadius = getPieceVisionRadius(board, ally) + SILHOUETTE_RING_EXTENSION;
      if (chebyshevDistance(ally.pos, enemy.pos) > maxSilhouetteRadius) continue;

      if (hasSymmetricLineOfSight(board, ally.pos, enemy.pos)) {
        detected = true;
        break;
      }
    }

    if (detected) {
      silhouettes.push({
        pos: { x: enemy.pos.x, y: enemy.pos.y },
        side: enemy.side,
      });
    }
  }

  return silhouettes;
}

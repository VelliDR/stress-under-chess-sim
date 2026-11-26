import { chebyshevDistance, createEmptyFog, inBounds } from './board';
import { isSilenced } from './psychology';
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

function pieceHasEffectiveTrait(piece: Piece, trait: 'SCOUT' | 'SHADOW_WALKER'): boolean {
  if (isSilenced(piece)) return false;
  const traits = piece.traits;
  for (let i = 0; i < traits.length; i++) {
    if (traits[i] === trait) return true;
  }
  if (piece.type === 'CHIMERA' && piece.absorbedForms !== undefined) {
    const forms = piece.absorbedForms;
    for (let i = 0; i < forms.length; i++) {
      const copied = forms[i]!.copiedTraits;
      for (let t = 0; t < copied.length; t++) {
        if (copied[t] === trait) return true;
      }
    }
  }
  return false;
}

/**
 * Computes a piece's Chebyshev vision radius including WATCHTOWER (+2) and SCOUT (+2) bonuses.
 */
export function getPieceVisionRadius(board: BoardView, piece: Piece): number {
  let radius = BASE_VISION_RADIUS[piece.type];

  const tile = board.tiles[piece.pos.y]?.[piece.pos.x];
  if (tile !== undefined && tile !== null && tile.type === 'WATCHTOWER') {
    radius += WATCHTOWER_VISION_BONUS;
  }

  if (pieceHasEffectiveTrait(piece, 'SCOUT')) {
    radius += SCOUT_VISION_BONUS;
  }

  return radius;
}

/**
 * Allocation-free directional Bresenham line-of-sight between primitive coordinates.
 * Only WALL tiles and MIASMA-covered tiles strictly between (x0, y0) and (x1, y1) block vision.
 */
export function hasDirectionalLosXY(
  tiles: readonly (readonly (TileState | null)[])[],
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (x0 < 0 || x0 >= width || y0 < 0 || y0 >= height) return false;
  if (x1 < 0 || x1 >= width || y1 < 0 || y1 >= height) return false;
  if (x0 === x1 && y0 === y1) return true;

  let cx = x0;
  let cy = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }

    // Reached destination cell: destination itself (even if WALL or MIASMA) is visible.
    if (cx === x1 && cy === y1) {
      return true;
    }

    const tile = tiles[cy]?.[cx];
    if (tile !== undefined && tile !== null && (tile.type === 'WALL' || tile.gas?.kind === 'MIASMA')) {
      return false;
    }
  }
}

/**
 * Allocation-free symmetric line-of-sight between primitive coordinates.
 * Skips redundant reverse ray on orthogonal and exact 45° diagonal lines (identical cells).
 */
export function hasSymmetricLosXY(
  tiles: readonly (readonly (TileState | null)[])[],
  width: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  if (hasDirectionalLosXY(tiles, width, height, ax, ay, bx, by)) return true;
  const adx = Math.abs(bx - ax);
  const ady = Math.abs(by - ay);
  if (adx === 0 || ady === 0 || adx === ady) return false;
  return hasDirectionalLosXY(tiles, width, height, bx, by, ax, ay);
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
  return hasDirectionalLosXY(board.tiles, board.width, board.height, from.x, from.y, to.x, to.y);
}

/**
 * Symmetric line-of-sight: clear if at least one of A->B or B->A is not blocked by a WALL.
 * Mathematically guarantees LOS(A, B) === LOS(B, A).
 */
export function hasSymmetricLineOfSight(board: BoardView, a: Coord, b: Coord): boolean {
  return hasSymmetricLosXY(board.tiles, board.width, board.height, a.x, a.y, b.x, b.y);
}

/**
 * Exact point visibility query: returns true iff `target` would be marked `'VISIBLE'` in
 * `computeFogForSide(board, viewerSide)`. Avoids full grid rebuilds during search.
 */
export function isCoordVisibleToSide(
  board: BoardView,
  viewerSide: Side,
  target: Coord,
): boolean {
  if (!inBounds(board, target)) return false;
  const pieces = board.pieces;
  const tx = target.x;
  const ty = target.y;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (piece.side !== viewerSide) continue;
    const px = piece.pos.x;
    const py = piece.pos.y;
    if (px < 0 || px >= board.width || py < 0 || py >= board.height) continue;
    const radius = getPieceVisionRadius(board, piece);
    if (Math.abs(px - tx) > radius || Math.abs(py - ty) > radius) continue;
    if (hasSymmetricLosXY(board.tiles, board.width, board.height, px, py, tx, ty)) {
      return true;
    }
  }
  return false;
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

    const px = piece.pos.x;
    const py = piece.pos.y;
    const radius = getPieceVisionRadius(board, piece);
    const minX = Math.max(0, px - radius);
    const maxX = Math.min(board.width - 1, px + radius);
    const minY = Math.max(0, py - radius);
    const maxY = Math.min(board.height - 1, py + radius);

    for (let y = minY; y <= maxY; y++) {
      const row = fog[y]!;
      for (let x = minX; x <= maxX; x++) {
        if (row[x] === 'VISIBLE') continue;
        if (hasSymmetricLosXY(board.tiles, board.width, board.height, px, py, x, y)) {
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
    if (pieceHasEffectiveTrait(enemy, 'SHADOW_WALKER')) continue;

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

import { describe, expect, it } from 'vitest';
import { createEmptyTiles, createTile } from '../src/engine/board';
import {
  computeFogForSide,
  computeSilhouettes,
  getPieceVisionRadius,
  hasSymmetricLineOfSight,
} from '../src/engine/fog';
import { createGameState, stepGame } from '../src/engine/reducer';
import { Piece, PieceType, Side, TraitId } from '../src/engine/types';
import { getVisibleState } from '../src/engine/visibility';

function makePiece(
  overrides: Partial<Piece> & {
    id: string;
    side: Side;
    type: PieceType;
    pos: { x: number; y: number };
  },
): Piece {
  const traits: TraitId[] = overrides.traits ?? [];
  return {
    id: overrides.id,
    side: overrides.side,
    type: overrides.type,
    pos: { ...overrides.pos },
    traits,
    shieldActive: overrides.shieldActive ?? traits.includes('SHIELDED'),
    frozenTurns: overrides.frozenTurns ?? 0,
    hasMoved: overrides.hasMoved ?? false,
    aggro: overrides.aggro ?? 'ACTIVE',
    usedDashThisTurn: overrides.usedDashThisTurn ?? false,
    wasVisibleAtTurnStart: overrides.wasVisibleAtTurnStart ?? false,
  };
}

describe('Symmetric Line of Sight (LOS)', () => {
  it('guarantees LOS(a, b) === LOS(b, a) across every pair on a map with walls', () => {
    const tiles = createEmptyTiles(7, 7, 'PLAIN');
    tiles[2]![2] = createTile('WALL');
    tiles[2]![3] = createTile('WALL');
    tiles[3]![4] = createTile('WALL');
    tiles[4]![2] = createTile('WALL');
    tiles[1]![5] = createTile('PIT');
    tiles[5]![1] = createTile('ICE');

    const board = {
      width: 7,
      height: 7,
      tiles,
      pieces: [] as Piece[],
      factions: { PLAYER: 'NONE' as const, ENEMY: 'NONE' as const },
    };

    for (let ay = 0; ay < 7; ay++) {
      for (let ax = 0; ax < 7; ax++) {
        for (let by = 0; by < 7; by++) {
          for (let bx = 0; bx < 7; bx++) {
            const ab = hasSymmetricLineOfSight(board, { x: ax, y: ay }, { x: bx, y: by });
            const ba = hasSymmetricLineOfSight(board, { x: bx, y: by }, { x: ax, y: ay });
            expect(ab).toBe(ba);
          }
        }
      }
    }
  });

  it('blocks vision behind WALL tiles while keeping the WALL itself visible and letting pieces/PIT/ICE remain transparent', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[4]![3] = createTile('WALL');
    tiles[4]![5] = createTile('PIT');

    const blockerPiece = makePiece({ id: 'p2', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 2 } });
    const board = {
      width: 8,
      height: 8,
      tiles,
      pieces: [blockerPiece],
      factions: { PLAYER: 'NONE' as const, ENEMY: 'NONE' as const },
    };

    // Viewer at (4,4) -> WALL at (3,4) is visible, square behind WALL at (2,4) is blocked
    expect(hasSymmetricLineOfSight(board, { x: 4, y: 4 }, { x: 3, y: 4 })).toBe(true);
    expect(hasSymmetricLineOfSight(board, { x: 4, y: 4 }, { x: 2, y: 4 })).toBe(false);

    // PIT at (5,4) does not block LOS to (6,4)
    expect(hasSymmetricLineOfSight(board, { x: 4, y: 4 }, { x: 6, y: 4 })).toBe(true);

    // Piece at (4,2) does NOT block LOS from (4,4) to (4,0)
    expect(hasSymmetricLineOfSight(board, { x: 4, y: 4 }, { x: 4, y: 0 })).toBe(true);
  });
});

describe('Vision Radius Bonuses, 3-Level Fog, and Exploration Memory', () => {
  it('calculates base vision radii plus WATCHTOWER (+2) and SCOUT (+2) stacking bonuses', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[4]![4] = createTile('WATCHTOWER');

    const pawnPlain = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 0, y: 0 } });
    const rookPlain = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 1, y: 0 } });
    const scoutPawnOnTower = makePiece({
      id: 'p2',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 4, y: 4 },
      traits: ['SCOUT'],
    });

    const board = {
      width: 8,
      height: 8,
      tiles,
      pieces: [pawnPlain, rookPlain, scoutPawnOnTower],
      factions: { PLAYER: 'NONE' as const, ENEMY: 'NONE' as const },
    };

    expect(getPieceVisionRadius(board, pawnPlain)).toBe(2);
    expect(getPieceVisionRadius(board, rookPlain)).toBe(3);
    // Pawn (2) + WATCHTOWER (2) + SCOUT (2) = 6
    expect(getPieceVisionRadius(board, scoutPawnOnTower)).toBe(6);
  });

  it('transitions tiles from UNEXPLORED -> VISIBLE -> EXPLORED as a piece moves away', () => {
    const king = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const enemyKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const pawn = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 6 } });

    const state0 = createGameState({
      width: 8,
      height: 8,
      pieces: [king, enemyKing, pawn],
      mode: 'SANDBOX',
    });

    // (4, 4) is distance 2 from pawn at (4, 6) -> VISIBLE; (4, 2) is distance 4 -> UNEXPLORED
    expect(state0.fog.PLAYER[4]![4]).toBe('VISIBLE');
    expect(state0.fog.PLAYER[2]![4]).toBe('UNEXPLORED');

    // Move pawn 2 squares up to (4, 4)
    const step1 = stepGame(state0, { type: 'MOVE', pieceId: 'p1', to: { x: 4, y: 4 } });
    expect(step1.error).toBeUndefined();

    // (4, 2) is now VISIBLE; (4, 7) (was distance 1 from (4,6), now distance 3 from (4,4) and 4 from king at (0,7)) becomes EXPLORED
    expect(step1.nextState.fog.PLAYER[2]![4]).toBe('VISIBLE');
    expect(step1.nextState.fog.PLAYER[7]![4]).toBe('EXPLORED');
  });
});

describe('Silhouette Ring, SHADOW_WALKER, and getVisibleState Isolation', () => {
  it('shows enemy silhouettes in the +2 ring beyond VISIBLE, hides them behind walls and for SHADOW_WALKER', () => {
    const tiles = createEmptyTiles(10, 10, 'PLAIN');
    // Put a wall blocking LOS to enemyWall
    tiles[5]![3] = createTile('WALL');
    tiles[4]![3] = createTile('WALL');
    tiles[6]![3] = createTile('WALL');

    // Player Pawn at (5, 5): vision radius 2 -> VISIBLE up to dist 2, silhouette ring dist 3..4
    const playerPawn = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 5, y: 5 } });
    // Enemy visible (dist 2) -> should be in visible pieces, NOT silhouettes
    const enemyVisible = makePiece({ id: 'e_vis', side: 'ENEMY', type: 'PAWN', pos: { x: 5, y: 3 } });
    // Enemy in silhouette ring (dist 4) with clear LOS -> SHOULD appear in silhouettes
    const enemySil = makePiece({ id: 'e_sil', side: 'ENEMY', type: 'ROOK', pos: { x: 5, y: 1 } });
    // Enemy with SHADOW_WALKER at dist 3 -> MUST NOT appear in silhouettes
    const enemyShadow = makePiece({
      id: 'e_shd',
      side: 'ENEMY',
      type: 'KNIGHT',
      pos: { x: 8, y: 5 },
      traits: ['SHADOW_WALKER'],
    });
    // Enemy behind wall at (1, 5) (dist 4, blocked by wall at (3,5)) -> MUST NOT appear in silhouettes
    const enemyWalled = makePiece({ id: 'e_wall', side: 'ENEMY', type: 'BISHOP', pos: { x: 1, y: 5 } });
    // Enemy too far away (dist 5 at (5, 0)) -> MUST NOT appear in silhouettes
    const enemyFar = makePiece({ id: 'e_far', side: 'ENEMY', type: 'KING', pos: { x: 5, y: 0 } });

    const state = createGameState({
      width: 10,
      height: 10,
      tiles,
      pieces: [playerPawn, enemyVisible, enemySil, enemyShadow, enemyWalled, enemyFar],
      mode: 'SANDBOX',
    });

    const fog = computeFogForSide(state, 'PLAYER');
    const silhouettes = computeSilhouettes(state, 'PLAYER', fog);

    expect(silhouettes).toEqual([{ pos: { x: 5, y: 1 }, side: 'ENEMY' }]);

    // Verify strict getVisibleState isolation
    const visible = getVisibleState(state, 'PLAYER');
    const visibleIds = visible.pieces.map((p) => p.id);
    expect(visibleIds).toContain('p1');
    expect(visibleIds).toContain('e_vis');
    expect(visibleIds).not.toContain('e_sil');
    expect(visibleIds).not.toContain('e_shd');
    expect(visibleIds).not.toContain('e_wall');
    expect(visibleIds).not.toContain('e_far');
    expect(visible.silhouettes).toEqual([{ pos: { x: 5, y: 1 }, side: 'ENEMY' }]);

    // Unexplored tiles are strictly null in VisibleState
    expect(visible.tiles[0]![5]).toBeNull();
    // Visible tiles are populated
    expect(visible.tiles[5]![5]?.type).toBe('PLAIN');
  });

  it('reveals SHADOW_WALKER normally once inside VISIBLE range', () => {
    const playerRook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 4, y: 4 } });
    const shadowEnemy = makePiece({
      id: 'e1',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 4, y: 2 },
      traits: ['SHADOW_WALKER'],
    });

    const state = createGameState({
      width: 8,
      height: 8,
      pieces: [playerRook, shadowEnemy],
      mode: 'SANDBOX',
    });

    const visible = getVisibleState(state, 'PLAYER');
    expect(visible.pieces.map((p) => p.id)).toContain('e1');
    expect(visible.silhouettes).toHaveLength(0);
  });
});

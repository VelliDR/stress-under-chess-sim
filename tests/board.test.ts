import { describe, expect, it } from 'vitest';
import {
  coordEquals,
  createEmptyTiles,
  createTile,
  ensureMapConnectivity,
  findLegalMove,
  getAllLegalMovesForSide,
  getLegalMoves,
  promotePiece,
  resolveIceSlide,
  validateMapConnectivity,
} from '../src/engine/board';
import {
  computeStateHash,
  nextInt,
  nextRng,
  pickOne,
  seedToRngState,
  shuffle,
} from '../src/engine/prng';
import {
  BoardView,
  FactionPassive,
  MAX_SLIDE_STEPS,
  Piece,
  PieceType,
  Side,
  TileState,
  TraitId,
} from '../src/engine/types';

function makePiece(
  overrides: Partial<Piece> & { id: string; side: Side; type: PieceType; pos: { x: number; y: number } },
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

function makeBoard(
  width: number,
  height: number,
  pieces: Piece[],
  tileOverrides: Array<{ x: number; y: number; tile: TileState }> = [],
  factions: Record<Side, FactionPassive> = { PLAYER: 'NONE', ENEMY: 'NONE' },
): BoardView {
  const tiles = createEmptyTiles(width, height, 'PLAIN');
  for (const ov of tileOverrides) {
    tiles[ov.y]![ov.x] = ov.tile;
  }
  return { width, height, tiles, pieces, factions };
}

describe('PRNG (mulberry32) and FNV-1a State Hash', () => {
  it('produces identical deterministic sequences from the same seed and diverges on different seeds', () => {
    let s1 = seedToRngState('2026-11-21');
    let s2 = seedToRngState('2026-11-21');
    let s3 = seedToRngState('2026-11-22');

    const seq1: number[] = [];
    const seq2: number[] = [];
    const seq3: number[] = [];

    for (let i = 0; i < 20; i++) {
      const r1 = nextRng(s1);
      const r2 = nextRng(s2);
      const r3 = nextRng(s3);
      s1 = r1.nextState;
      s2 = r2.nextState;
      s3 = r3.nextState;
      expect(r1.value).toBeGreaterThanOrEqual(0);
      expect(r1.value).toBeLessThan(1);
      seq1.push(r1.value);
      seq2.push(r2.value);
      seq3.push(r3.value);
    }

    expect(seq1).toEqual(seq2);
    expect(seq1).not.toEqual(seq3);
  });

  it('supports nextInt, pickOne, and non-mutating deterministic shuffle', () => {
    let state = seedToRngState(42);
    for (let i = 0; i < 50; i++) {
      const res = nextInt(state, 3, 9);
      state = res.nextState;
      expect(res.value).toBeGreaterThanOrEqual(3);
      expect(res.value).toBeLessThan(9);
      expect(Number.isInteger(res.value)).toBe(true);
    }

    const items = ['A', 'B', 'C', 'D', 'E'] as const;
    const shuf1 = shuffle(seedToRngState('deck'), items);
    const shuf2 = shuffle(seedToRngState('deck'), items);
    expect(shuf1.value).toEqual(shuf2.value);
    expect([...shuf1.value].sort()).toEqual([...items]);
    expect(items).toEqual(['A', 'B', 'C', 'D', 'E']);

    const picked = pickOne(seedToRngState('pick'), items);
    expect(items).toContain(picked.value);
  });

  it('computes canonical 8-char hex FNV-1a state hashes independent of object key order', () => {
    const objA = { z: 1, a: 'Şah', nested: { y: 2, x: -0 }, undef: undefined };
    const objB = { nested: { x: 0, y: 2 }, a: 'Şah', z: 1 };
    const objC = { nested: { x: 0, y: 3 }, a: 'Şah', z: 1 };

    const hashA = computeStateHash(objA);
    const hashB = computeStateHash(objB);
    const hashC = computeStateHash(objC);

    expect(hashA).toMatch(/^[0-9a-f]{8}$/);
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);

    // Pure JSON round-trip invariance
    const roundTripped = JSON.parse(JSON.stringify(objA));
    expect(computeStateHash(roundTripped)).toBe(hashA);
  });
});

describe('Piece Movement Rules', () => {
  it('moves PLAYER pawns upward (-y) and ENEMY pawns downward (+y) with 2-step first move and diagonal capture', () => {
    const playerPawn = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 3, y: 6 } });
    const enemyPawn = makePiece({ id: 'e1', side: 'ENEMY', type: 'PAWN', pos: { x: 4, y: 1 } });
    const enemyTarget = makePiece({ id: 'e2', side: 'ENEMY', type: 'PAWN', pos: { x: 2, y: 5 } });
    const friendlyDiag = makePiece({ id: 'p2', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 5 } });

    const board = makeBoard(8, 8, [playerPawn, enemyPawn, enemyTarget, friendlyDiag]);

    const pMoves = getLegalMoves(board, playerPawn).map((m) => m.to);
    expect(pMoves).toEqual([
      { x: 3, y: 5 },
      { x: 3, y: 4 },
      { x: 2, y: 5 },
    ]);

    const eMoves = getLegalMoves(board, enemyPawn).map((m) => m.to);
    expect(eMoves).toEqual([
      { x: 4, y: 2 },
      { x: 4, y: 3 },
    ]);

    // Moved pawn cannot advance 2 squares
    const movedPawn = { ...playerPawn, hasMoved: true };
    const movedTargets = getLegalMoves(board, movedPawn).map((m) => m.to);
    expect(movedTargets).toEqual([
      { x: 3, y: 5 },
      { x: 2, y: 5 },
    ]);
  });

  it('blocks pawn 2-step advance when intermediate square is blocked by piece, WALL, or PIT', () => {
    const pawn = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 3, y: 6 } });

    const boardWithWall = makeBoard(8, 8, [pawn], [{ x: 3, y: 5, tile: createTile('WALL') }]);
    expect(getLegalMoves(boardWithWall, pawn)).toHaveLength(0);

    const boardWithPit = makeBoard(8, 8, [pawn], [{ x: 3, y: 5, tile: createTile('PIT') }]);
    expect(getLegalMoves(boardWithPit, pawn)).toHaveLength(0);

    const blocker = makePiece({ id: 'e1', side: 'ENEMY', type: 'ROOK', pos: { x: 3, y: 5 } });
    const boardWithPiece = makeBoard(8, 8, [pawn, blocker]);
    expect(getLegalMoves(boardWithPiece, pawn)).toHaveLength(0);
  });

  it('detects pawn promotion on back rank and preserves traits on promotePiece', () => {
    const pPawn = makePiece({
      id: 'p1',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 2, y: 1 },
      traits: ['SCOUT', 'SHIELDED'],
      hasMoved: true,
    });
    const ePawn = makePiece({
      id: 'e1',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 5, y: 6 },
      hasMoved: true,
    });

    const board = makeBoard(8, 8, [pPawn, ePawn]);
    const pMove = findLegalMove(board, pPawn, { x: 2, y: 0 });
    expect(pMove?.resolution.promotes).toBe(true);

    const eMove = findLegalMove(board, ePawn, { x: 5, y: 7 });
    expect(eMove?.resolution.promotes).toBe(true);

    const promoted = promotePiece(pPawn, 'QUEEN');
    expect(promoted.type).toBe('QUEEN');
    expect(promoted.traits).toEqual(['SCOUT', 'SHIELDED']);
    expect(promoted.shieldActive).toBe(true);
  });

  it('allows Knight to jump over WALL and PIT but never land on WALL/PIT, and never slide on ICE', () => {
    const knight = makePiece({ id: 'n1', side: 'PLAYER', type: 'KNIGHT', pos: { x: 3, y: 3 } });
    const tiles = [
      // Surround knight completely with WALL and PIT
      { x: 2, y: 2, tile: createTile('WALL') },
      { x: 3, y: 2, tile: createTile('WALL') },
      { x: 4, y: 2, tile: createTile('PIT') },
      { x: 2, y: 3, tile: createTile('PIT') },
      { x: 4, y: 3, tile: createTile('WALL') },
      { x: 2, y: 4, tile: createTile('WALL') },
      { x: 3, y: 4, tile: createTile('PIT') },
      { x: 4, y: 4, tile: createTile('WALL') },
      // Landing tiles: one WALL, one PIT, one ICE
      { x: 1, y: 2, tile: createTile('WALL') },
      { x: 1, y: 4, tile: createTile('PIT') },
      { x: 5, y: 2, tile: createTile('ICE') },
    ];
    const board = makeBoard(8, 8, [knight], tiles);
    const moves = getLegalMoves(board, knight);

    // 8 L-jumps minus 2 blocked landing squares (WALL at 1,2 and PIT at 1,4) = 6
    expect(moves).toHaveLength(6);
    expect(findLegalMove(board, knight, { x: 1, y: 2 })).toBeUndefined();
    expect(findLegalMove(board, knight, { x: 1, y: 4 })).toBeUndefined();

    // Landing on ICE at (5,2) stops immediately without sliding
    const iceMove = findLegalMove(board, knight, { x: 5, y: 2 });
    expect(iceMove).toBeDefined();
    expect(iceMove?.resolution.slid).toBe(false);
    expect(iceMove?.resolution.finalPos).toEqual({ x: 5, y: 2 });
  });

  it('allows King to move into enemy-attacked squares (King Capture rule) and blocks WALL/PIT', () => {
    const king = makePiece({ id: 'k1', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 4 } });
    const enemyRook = makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 0, y: 3 } });
    const board = makeBoard(8, 8, [king, enemyRook], [
      { x: 4, y: 5, tile: createTile('WALL') },
      { x: 3, y: 5, tile: createTile('PIT') },
    ]);

    // (4, 3) is attacked by enemyRook on rank 3, yet legal under King Capture rules
    const riskyMove = findLegalMove(board, king, { x: 4, y: 3 });
    expect(riskyMove).toBeDefined();
    expect(riskyMove?.resolution.finalPos).toEqual({ x: 4, y: 3 });

    // WALL and PIT are blocked
    expect(findLegalMove(board, king, { x: 4, y: 5 })).toBeUndefined();
    expect(findLegalMove(board, king, { x: 3, y: 5 })).toBeUndefined();
    expect(getLegalMoves(board, king)).toHaveLength(6);
  });

  it('computes ROOK, BISHOP, QUEEN rays blocked by WALL, PIT, and pieces', () => {
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 3, y: 3 } });
    const bishop = makePiece({ id: 'b1', side: 'PLAYER', type: 'BISHOP', pos: { x: 1, y: 1 } });
    const queen = makePiece({ id: 'q1', side: 'PLAYER', type: 'QUEEN', pos: { x: 6, y: 6 } });
    const enemy = makePiece({ id: 'e1', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 1 } });

    const board = makeBoard(8, 8, [rook, bishop, queen, enemy], [
      { x: 5, y: 3, tile: createTile('WALL') },
      { x: 3, y: 5, tile: createTile('PIT') },
    ]);

    // Rook: up to (3,1) enemy capture (stops before (3,0)), right stops before (5,3) WALL, down stops before (3,5) PIT, left to (0,3)
    const rookTargets = getLegalMoves(board, rook).map((m) => m.to);
    expect(rookTargets).toContainEqual({ x: 3, y: 1 });
    expect(rookTargets).not.toContainEqual({ x: 3, y: 0 });
    expect(rookTargets).toContainEqual({ x: 4, y: 3 });
    expect(rookTargets).not.toContainEqual({ x: 5, y: 3 });
    expect(rookTargets).not.toContainEqual({ x: 6, y: 3 });
    expect(rookTargets).toContainEqual({ x: 3, y: 4 });
    expect(rookTargets).not.toContainEqual({ x: 3, y: 5 });

    // Bishop at (1,1) blocked by friendly rook at (3,3) along (+1,+1) diagonal
    const bishopTargets = getLegalMoves(board, bishop).map((m) => m.to);
    expect(bishopTargets).toContainEqual({ x: 2, y: 2 });
    expect(bishopTargets).not.toContainEqual({ x: 3, y: 3 });
    expect(bishopTargets).not.toContainEqual({ x: 4, y: 4 });

    // Queen moves orthogonally and diagonally
    const queenTargets = getLegalMoves(board, queen).map((m) => m.to);
    expect(queenTargets).toContainEqual({ x: 6, y: 0 });
    expect(queenTargets).toContainEqual({ x: 4, y: 4 });
  });

  it('prevents frozen pieces from moving and respects bonusMovePieceId restriction', () => {
    const frozenRook = makePiece({
      id: 'r1',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 0, y: 0 },
      frozenTurns: 1,
    });
    const freeKing = makePiece({ id: 'k1', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 4 } });
    const freePawn = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 2, y: 6 } });

    const board = makeBoard(8, 8, [frozenRook, freeKing, freePawn]);
    expect(getLegalMoves(board, frozenRook)).toHaveLength(0);

    const restricted = getAllLegalMovesForSide(board, 'PLAYER', 'p1');
    expect(restricted.length).toBeGreaterThan(0);
    expect(restricted.every((m) => m.pieceId === 'p1')).toBe(true);
  });
});

describe('ICE Slide Physics, PIT Death, BURNING Hazard, and SHIELDED Bounce', () => {
  it('chains slides across multiple ICE tiles and stops on PLAIN, WATCHTOWER, or BURNING', () => {
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 1, y: 4 } });
    const board = makeBoard(8, 8, [rook], [
      { x: 2, y: 4, tile: createTile('ICE') },
      { x: 3, y: 4, tile: createTile('ICE') },
      { x: 4, y: 4, tile: createTile('ICE') },
      { x: 5, y: 4, tile: createTile('BURNING', 2) },
    ]);

    const move = findLegalMove(board, rook, { x: 2, y: 4 });
    expect(move).toBeDefined();
    expect(move?.resolution.slid).toBe(true);
    expect(move?.resolution.finalPos).toEqual({ x: 5, y: 4 });
    expect(move?.resolution.path).toEqual([
      { x: 1, y: 4 },
      { x: 2, y: 4 },
      { x: 3, y: 4 },
      { x: 4, y: 4 },
      { x: 5, y: 4 },
    ]);
    expect(move?.resolution.endsOnBurning).toBe(true);
    expect(move?.isHazardous).toBe(true);
  });

  it('stops ICE slide before board edge, WALL, or friendly piece', () => {
    const king = makePiece({ id: 'k1', side: 'PLAYER', type: 'KING', pos: { x: 1, y: 1 } });
    const ally = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 1, y: 4 } });

    const board = makeBoard(5, 5, [king, ally], [
      // Right: ICE all the way to board edge (x = 4)
      { x: 2, y: 1, tile: createTile('ICE') },
      { x: 3, y: 1, tile: createTile('ICE') },
      { x: 4, y: 1, tile: createTile('ICE') },
      // Down: ICE into friendly ally at (1,4)
      { x: 1, y: 2, tile: createTile('ICE') },
      { x: 1, y: 3, tile: createTile('ICE') },
      // Diagonal down-right: ICE into WALL at (3,3)
      { x: 2, y: 2, tile: createTile('ICE') },
      { x: 3, y: 3, tile: createTile('WALL') },
    ]);

    const rightMove = findLegalMove(board, king, { x: 2, y: 1 });
    expect(rightMove?.resolution.finalPos).toEqual({ x: 4, y: 1 });
    expect(rightMove?.resolution.slid).toBe(true);

    const downMove = findLegalMove(board, king, { x: 1, y: 2 });
    expect(downMove?.resolution.finalPos).toEqual({ x: 1, y: 3 });
    expect(downMove?.resolution.slid).toBe(true);

    const diagMove = findLegalMove(board, king, { x: 2, y: 2 });
    expect(diagMove?.resolution.finalPos).toEqual({ x: 2, y: 2 });
    expect(diagMove?.resolution.slid).toBe(false);
  });

  it('kills sliding piece when ICE slide enters a PIT and flags move as hazardous', () => {
    const pawn = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 3, y: 5 } });
    const board = makeBoard(8, 8, [pawn], [
      { x: 3, y: 4, tile: createTile('ICE') },
      { x: 3, y: 3, tile: createTile('ICE') },
      { x: 3, y: 2, tile: createTile('PIT') },
    ]);

    const move = findLegalMove(board, pawn, { x: 3, y: 4 });
    expect(move).toBeDefined();
    expect(move?.resolution.fellInPit).toBe(true);
    expect(move?.resolution.finalPos).toBeNull();
    expect(move?.resolution.promotes).toBe(false);
    expect(move?.isHazardous).toBe(true);
    expect(move?.resolution.path).toEqual([
      { x: 3, y: 5 },
      { x: 3, y: 4 },
      { x: 3, y: 3 },
      { x: 3, y: 2 },
    ]);
  });

  it('captures unshielded enemy on ICE slide and bounces before SHIELDED enemy on ICE slide', () => {
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 2 } });
    const unshielded = makePiece({ id: 'e1', side: 'ENEMY', type: 'PAWN', pos: { x: 4, y: 2 } });
    const shielded = makePiece({
      id: 'e2',
      side: 'ENEMY',
      type: 'ROOK',
      pos: { x: 0, y: 6 },
      traits: ['SHIELDED'],
    });

    const board = makeBoard(8, 8, [rook, unshielded, shielded], [
      { x: 1, y: 2, tile: createTile('ICE') },
      { x: 2, y: 2, tile: createTile('ICE') },
      { x: 3, y: 2, tile: createTile('ICE') },
      { x: 0, y: 3, tile: createTile('ICE') },
      { x: 0, y: 4, tile: createTile('ICE') },
      { x: 0, y: 5, tile: createTile('ICE') },
    ]);

    // Slide right into unshielded enemy at (4,2) -> capture and stop at (4,2)
    const captureMove = findLegalMove(board, rook, { x: 1, y: 2 });
    expect(captureMove?.resolution.captured).toBe(true);
    expect(captureMove?.resolution.brokeShield).toBe(false);
    expect(captureMove?.resolution.hitPieceId).toBe('e1');
    expect(captureMove?.resolution.finalPos).toEqual({ x: 4, y: 2 });

    // Slide down into shielded enemy at (0,6) -> break shield and stop at (0,5)
    const shieldMove = findLegalMove(board, rook, { x: 0, y: 3 });
    expect(shieldMove?.resolution.brokeShield).toBe(true);
    expect(shieldMove?.resolution.captured).toBe(false);
    expect(shieldMove?.resolution.hitPieceId).toBe('e2');
    expect(shieldMove?.resolution.hitPos).toEqual({ x: 0, y: 6 });
    expect(shieldMove?.resolution.finalPos).toEqual({ x: 0, y: 5 });
  });

  it('promotes a pawn that slides on ICE all the way to the back rank', () => {
    const pawn = makePiece({
      id: 'p1',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 2, y: 3 },
      hasMoved: true,
    });
    const board = makeBoard(8, 8, [pawn], [
      { x: 2, y: 2, tile: createTile('ICE') },
      { x: 2, y: 1, tile: createTile('ICE') },
      { x: 2, y: 0, tile: createTile('PLAIN') },
    ]);

    const move = findLegalMove(board, pawn, { x: 2, y: 2 });
    expect(move?.resolution.finalPos).toEqual({ x: 2, y: 0 });
    expect(move?.resolution.promotes).toBe(true);
  });

  it('enforces MAX_SLIDE_STEPS = 16 safety cap on long ice corridors', () => {
    const width = 25;
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 0 } });
    const iceOverrides: Array<{ x: number; y: number; tile: TileState }> = [];
    for (let x = 1; x < width; x++) {
      iceOverrides.push({ x, y: 0, tile: createTile('ICE') });
    }
    const board = makeBoard(width, 2, [rook], iceOverrides);

    const move = findLegalMove(board, rook, { x: 1, y: 0 });
    expect(move).toBeDefined();
    // Entered ICE at x=1, then slid at most MAX_SLIDE_STEPS (16) -> x = 1 + 16 = 17
    expect(move?.resolution.finalPos).toEqual({ x: 1 + MAX_SLIDE_STEPS, y: 0 });
    expect(move?.resolution.path).toHaveLength(2 + MAX_SLIDE_STEPS);
  });

  it('prevents FROST_WARDENS pieces from sliding on ICE', () => {
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 0 } });
    const board = makeBoard(
      8,
      8,
      [rook],
      [
        { x: 1, y: 0, tile: createTile('ICE') },
        { x: 2, y: 0, tile: createTile('ICE') },
        { x: 3, y: 0, tile: createTile('PIT') },
      ],
      { PLAYER: 'FROST_WARDENS', ENEMY: 'NONE' },
    );

    const move = findLegalMove(board, rook, { x: 1, y: 0 });
    expect(move?.resolution.slid).toBe(false);
    expect(move?.resolution.finalPos).toEqual({ x: 1, y: 0 });
    expect(move?.resolution.fellInPit).toBe(false);
  });

  it('handles direct attacks against SHIELDED targets (ranged bounces to previous tile; Knight & adjacent stay at origin)', () => {
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 0 } });
    const knight = makePiece({ id: 'n1', side: 'PLAYER', type: 'KNIGHT', pos: { x: 2, y: 2 } });
    const king = makePiece({ id: 'k1', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 1 } });
    const shieldedEnemy = makePiece({
      id: 'e1',
      side: 'ENEMY',
      type: 'QUEEN',
      pos: { x: 4, y: 0 },
      traits: ['SHIELDED'],
    });

    const board = makeBoard(8, 8, [rook, knight, king, shieldedEnemy]);

    // Ranged Rook from (0,0) -> (4,0) bounces to (3,0)
    const rookHit = findLegalMove(board, rook, { x: 4, y: 0 });
    expect(rookHit?.resolution.brokeShield).toBe(true);
    expect(rookHit?.resolution.finalPos).toEqual({ x: 3, y: 0 });

    // Knight from (2,2) -> (4,1) is friendly; let's check Knight attacking (4,0) from (2,1)
    const knight2 = { ...knight, pos: { x: 2, y: 1 } };
    const board2 = makeBoard(8, 8, [rook, knight2, king, shieldedEnemy]);
    const knightHit = findLegalMove(board2, knight2, { x: 4, y: 0 });
    expect(knightHit?.resolution.brokeShield).toBe(true);
    expect(knightHit?.resolution.finalPos).toEqual({ x: 2, y: 1 });

    // Adjacent King from (4,1) -> (4,0) stays at (4,1)
    const kingHit = findLegalMove(board, king, { x: 4, y: 0 });
    expect(kingHit?.resolution.brokeShield).toBe(true);
    expect(kingHit?.resolution.finalPos).toEqual({ x: 4, y: 1 });
  });

  it('stops on enemy square when directly capturing an unshielded enemy standing on ICE', () => {
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 0 } });
    const enemyOnIce = makePiece({ id: 'e1', side: 'ENEMY', type: 'KNIGHT', pos: { x: 2, y: 0 } });
    const board = makeBoard(8, 8, [rook, enemyOnIce], [
      { x: 2, y: 0, tile: createTile('ICE') },
      { x: 3, y: 0, tile: createTile('PIT') },
    ]);

    const capture = findLegalMove(board, rook, { x: 2, y: 0 });
    expect(capture?.resolution.captured).toBe(true);
    expect(capture?.resolution.finalPos).toEqual({ x: 2, y: 0 });
    expect(capture?.resolution.fellInPit).toBe(false);
  });

  it('supports pushed-piece ice sliding with allowCapture=false (stops before any piece, falls into PIT)', () => {
    const pushed = makePiece({ id: 'e1', side: 'ENEMY', type: 'PAWN', pos: { x: 1, y: 1 } });
    const blocker = makePiece({ id: 'p1', side: 'PLAYER', type: 'ROOK', pos: { x: 4, y: 1 } });

    const boardBlock = makeBoard(6, 6, [pushed, blocker], [
      { x: 2, y: 1, tile: createTile('ICE') },
      { x: 3, y: 1, tile: createTile('ICE') },
    ]);

    const resBlock = resolveIceSlide(boardBlock, pushed, { x: 2, y: 1 }, { x: 1, y: 0 }, {
      allowCapture: false,
    });
    expect(resBlock.finalPos).toEqual({ x: 3, y: 1 });
    expect(resBlock.captured).toBe(false);

    const boardPit = makeBoard(6, 6, [pushed], [
      { x: 2, y: 1, tile: createTile('ICE') },
      { x: 3, y: 1, tile: createTile('PIT') },
    ]);
    const resPit = resolveIceSlide(boardPit, pushed, { x: 2, y: 1 }, { x: 1, y: 0 }, {
      allowCapture: false,
    });
    expect(resPit.fellInPit).toBe(true);
    expect(resPit.finalPos).toBeNull();
  });
});

describe('Map Connectivity Validator (BFS Softlock Guard)', () => {
  it('validates connected open maps and maps connected through ICE/BURNING/WATCHTOWER', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    // Build a horizontal wall across row 4 except one ICE tile at x=3
    for (let x = 0; x < 8; x++) {
      tiles[4]![x] = x === 3 ? createTile('ICE') : createTile('WALL');
    }

    const res = validateMapConnectivity(tiles, [{ x: 4, y: 7 }], { x: 4, y: 0 });
    expect(res.connected).toBe(true);
    expect(res.path.length).toBeGreaterThan(0);
    expect(coordEquals(res.path[0]!, { x: 4, y: 7 })).toBe(true);
    expect(coordEquals(res.path[res.path.length - 1]!, { x: 4, y: 0 })).toBe(true);
    expect(res.path.some((c) => c.x === 3 && c.y === 4)).toBe(true);
  });

  it('rejects disconnected maps blocked by WALL and PIT barriers (including diagonal-only gaps)', () => {
    const tiles = createEmptyTiles(6, 6, 'PLAIN');
    for (let x = 0; x < 6; x++) {
      tiles[3]![x] = x % 2 === 0 ? createTile('WALL') : createTile('PIT');
    }
    expect(validateMapConnectivity(tiles, [{ x: 2, y: 5 }], { x: 2, y: 0 }).connected).toBe(false);

    // Diagonal-only gap: 4-way BFS must treat this as disconnected
    const diagTiles = createEmptyTiles(4, 4, 'PLAIN');
    diagTiles[0]![1] = createTile('WALL');
    diagTiles[1]![0] = createTile('WALL');
    expect(validateMapConnectivity(diagTiles, [{ x: 3, y: 3 }], { x: 0, y: 0 }).connected).toBe(
      false,
    );
  });

  it('automatically carves a center passage with ensureMapConnectivity without mutating input', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    for (let x = 0; x < 8; x++) {
      tiles[3]![x] = createTile('WALL');
      tiles[4]![x] = createTile('PIT');
    }

    const startZone = [
      { x: 1, y: 7 },
      { x: 4, y: 7 },
    ];
    const enemyKing = { x: 6, y: 0 };

    expect(validateMapConnectivity(tiles, startZone, enemyKing).connected).toBe(false);

    const ensured = ensureMapConnectivity(tiles, startZone, enemyKing);
    expect(ensured.carved).toBe(true);
    expect(validateMapConnectivity(ensured.tiles, startZone, enemyKing).connected).toBe(true);
    expect(ensured.path.length).toBeGreaterThan(0);

    // Original tiles remained untouched (pure function)
    expect(tiles[3]![4]?.type).toBe('WALL');
    expect(tiles[4]![4]?.type).toBe('PIT');
  });
});

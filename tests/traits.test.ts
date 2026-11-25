import { describe, expect, it } from 'vitest';
import { createEmptyTiles, createTile, getPieceById } from '../src/engine/board';
import { createGameState, stepGame } from '../src/engine/reducer';
import { addTraitToPiece, getLegalAbilities } from '../src/engine/traits';
import { Piece, PieceType, Side, TraitId } from '../src/engine/types';

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

describe('Trait Cap and SHIELDED Mechanics', () => {
  it('enforces MAX_TRAITS_PER_PIECE = 3 and prevents duplicate traits', () => {
    let p = makePiece({ id: 'p1', side: 'PLAYER', type: 'PAWN', pos: { x: 0, y: 6 } });
    p = addTraitToPiece(p, 'SCOUT');
    p = addTraitToPiece(p, 'SCOUT'); // duplicate ignored
    p = addTraitToPiece(p, 'SHIELDED');
    p = addTraitToPiece(p, 'FROST_TOUCH');
    p = addTraitToPiece(p, 'PUSHER'); // 4th trait ignored

    expect(p.traits).toEqual(['SCOUT', 'SHIELDED', 'FROST_TOUCH']);
    expect(p.shieldActive).toBe(true);
  });

  it('bounces ranged attacks back 1 tile when breaking SHIELDED and absorbs BURNING damage once', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[4]![1] = createTile('BURNING', 3);

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const rook = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 4, y: 6 } });
    const shieldedEnemy = makePiece({
      id: 'e1',
      side: 'ENEMY',
      type: 'ROOK',
      pos: { x: 4, y: 2 },
      traits: ['SHIELDED'],
    });
    const shieldedBurner = makePiece({
      id: 'p_burn',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 1, y: 4 },
      traits: ['SHIELDED'],
    });

    const s0 = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [pk, ek, rook, shieldedEnemy, shieldedBurner],
      mode: 'SANDBOX',
    });

    // Player Rook attacks shieldedEnemy at (4,2) -> bounces to (4,3), enemy shield breaks
    // Also shieldedBurner stands on BURNING at (1,4) -> absorbs burn at end of Turn 1!
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'r1', to: { x: 4, y: 2 } });
    expect(s1.error).toBeUndefined();
    expect(getPieceById(s1.nextState.pieces, 'r1')?.pos).toEqual({ x: 4, y: 3 });
    expect(getPieceById(s1.nextState.pieces, 'e1')?.shieldActive).toBe(false);
    expect(getPieceById(s1.nextState.pieces, 'p_burn')?.shieldActive).toBe(false);
    expect(s1.events).toContainEqual({
      type: 'SHIELD_BROKEN',
      pieceId: 'e1',
      pos: { x: 4, y: 2 },
      source: 'ATTACK',
    });
    expect(s1.events).toContainEqual({
      type: 'SHIELD_BROKEN',
      pieceId: 'p_burn',
      pos: { x: 1, y: 4 },
      source: 'BURN',
    });

    // Enemy passes turn -> Player passes turn -> p_burn now has NO shield and burns to death!
    const s2 = stepGame(s1.nextState, { type: 'END_TURN' });
    const s3 = stepGame(s2.nextState, { type: 'END_TURN' });
    expect(getPieceById(s3.nextState.pieces, 'p_burn')).toBeUndefined();
    expect(s3.events).toContainEqual({
      type: 'PIECE_BURNED',
      pieceId: 'p_burn',
      pos: { x: 1, y: 4 },
      killed: true,
    });
  });
});

describe('FROST_TOUCH Freezing Mechanics', () => {
  it('freezes a shielded target on shield-break for exactly 1 enemy turn', () => {
    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const frostKnight = makePiece({
      id: 'fn',
      side: 'PLAYER',
      type: 'KNIGHT',
      pos: { x: 2, y: 4 },
      traits: ['FROST_TOUCH'],
    });
    const shieldedEnemy = makePiece({
      id: 'e1',
      side: 'ENEMY',
      type: 'ROOK',
      pos: { x: 3, y: 2 },
      traits: ['SHIELDED'],
    });

    const s0 = createGameState({
      width: 8,
      height: 8,
      pieces: [pk, ek, frostKnight, shieldedEnemy],
      mode: 'SANDBOX',
    });

    // Knight hits shielded enemy -> stays at (2,4), breaks shield AND freezes e1 for 1 turn
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'fn', to: { x: 3, y: 2 } });
    expect(s1.error).toBeUndefined();
    expect(getPieceById(s1.nextState.pieces, 'fn')?.pos).toEqual({ x: 2, y: 4 });
    expect(getPieceById(s1.nextState.pieces, 'e1')?.frozenTurns).toBe(1);
    expect(s1.events).toContainEqual({
      type: 'PIECE_FROZEN',
      pieceId: 'e1',
      pos: { x: 3, y: 2 },
      turns: 1,
    });

    // Enemy tries to move frozen e1 -> rejected!
    const badMove = stepGame(s1.nextState, { type: 'MOVE', pieceId: 'e1', to: { x: 3, y: 3 } });
    expect(badMove.error).toBeDefined();

    // Enemy passes turn -> e1 thaws at end of Enemy turn
    const s2 = stepGame(s1.nextState, { type: 'END_TURN' });
    expect(getPieceById(s2.nextState.pieces, 'e1')?.frozenTurns).toBe(0);

    // Player passes turn -> Enemy can now move e1!
    const s3 = stepGame(s2.nextState, { type: 'END_TURN' });
    const s4 = stepGame(s3.nextState, { type: 'MOVE', pieceId: 'e1', to: { x: 3, y: 3 } });
    expect(s4.error).toBeUndefined();
    expect(getPieceById(s4.nextState.pieces, 'e1')?.pos).toEqual({ x: 3, y: 3 });
  });

  it('freezes an orthogonally adjacent enemy when finishing a move next to them', () => {
    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const frostPawn = makePiece({
      id: 'fp',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 4, y: 5 },
      traits: ['FROST_TOUCH'],
    });
    const enemy = makePiece({ id: 'e1', side: 'ENEMY', type: 'PAWN', pos: { x: 4, y: 3 } });

    const s0 = createGameState({
      width: 8,
      height: 8,
      pieces: [pk, ek, frostPawn, enemy],
      mode: 'SANDBOX',
    });

    // Pawn moves from (4,5) to (4,4), orthogonally adjacent to enemy at (4,3)
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'fp', to: { x: 4, y: 4 } });
    expect(s1.error).toBeUndefined();
    expect(getPieceById(s1.nextState.pieces, 'e1')?.frozenTurns).toBe(1);
    expect(s1.events).toContainEqual({
      type: 'PIECE_FROZEN',
      pieceId: 'e1',
      pos: { x: 4, y: 3 },
      turns: 1,
    });
  });
});

describe('EXPLOSIVE Detonation & Fire Extinguishment', () => {
  it('ignites death square + 4 orthogonal neighbors (excluding WALL/PIT), burns unshielded attacker, and restores WATCHTOWER', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![3] = createTile('WATCHTOWER'); // center where explosive enemy stands
    tiles[2]![3] = createTile('WALL'); // north: excluded
    tiles[3]![2] = createTile('PIT'); // west: excluded
    tiles[3]![4] = createTile('ICE'); // east: ignites and melts to PLAIN when extinguished

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const attacker = makePiece({ id: 'r1', side: 'PLAYER', type: 'ROOK', pos: { x: 3, y: 6 } });
    const bomber = makePiece({
      id: 'eb',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 3, y: 3 },
      traits: ['EXPLOSIVE'],
    });

    const s0 = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [pk, ek, attacker, bomber],
      mode: 'SANDBOX',
    });

    // Rook captures EXPLOSIVE enemy at (3,3) -> ignites (3,3), (4,3), (3,4); skips WALL (3,2) & PIT (2,3)
    // At end of Turn 1, unshielded Rook standing on burning (3,3) burns to death!
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'r1', to: { x: 3, y: 3 } });
    expect(s1.error).toBeUndefined();
    expect(s1.nextState.tiles[3]![3]?.type).toBe('BURNING');
    expect(s1.nextState.tiles[3]![3]?.burnTurns).toBe(1); // 2 -> 1 at end of Turn 1
    expect(s1.nextState.tiles[3]![4]?.type).toBe('BURNING');
    expect(s1.nextState.tiles[4]![3]?.type).toBe('BURNING');
    expect(s1.nextState.tiles[2]![3]?.type).toBe('WALL');
    expect(s1.nextState.tiles[3]![2]?.type).toBe('PIT');
    expect(getPieceById(s1.nextState.pieces, 'r1')).toBeUndefined();

    // After Enemy turn ends, fire extinguishes: (3,3) reverts to WATCHTOWER, (4,3) melted to PLAIN!
    const s2 = stepGame(s1.nextState, { type: 'END_TURN' });
    expect(s2.nextState.tiles[3]![3]?.type).toBe('WATCHTOWER');
    expect(s2.nextState.tiles[3]![4]?.type).toBe('PLAIN');
    expect(s2.nextState.tiles[4]![3]?.type).toBe('PLAIN');
  });

  it('does NOT detonate EXPLOSIVE when the piece is pushed into a PIT', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![4] = createTile('PIT');

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const pusher = makePiece({
      id: 'p1',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 2, y: 3 },
      traits: ['PUSHER'],
    });
    const bomber = makePiece({
      id: 'eb',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 3, y: 3 },
      traits: ['EXPLOSIVE'],
    });

    const s0 = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [pk, ek, pusher, bomber],
      mode: 'SANDBOX',
    });

    const s1 = stepGame(s0, {
      type: 'USE_ABILITY',
      pieceId: 'p1',
      ability: 'PUSH',
      target: { x: 3, y: 3 },
    });
    expect(s1.error).toBeUndefined();
    expect(getPieceById(s1.nextState.pieces, 'eb')).toBeUndefined();
    expect(s1.events.some((e) => e.type === 'TILE_IGNITED')).toBe(false);
    expect(s1.events.some((e) => e.type === 'PIECE_FELL_IN_PIT')).toBe(true);
  });
});

describe('PUSHER -> ICE -> PIT Combo & Blocking', () => {
  it('chains PUSH onto ICE into a PIT to eliminate the Enemy King', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![4] = createTile('ICE');
    tiles[3]![5] = createTile('ICE');
    tiles[3]![6] = createTile('PIT');

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 3, y: 3 } });
    const pusher = makePiece({
      id: 'p1',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 2, y: 3 },
      traits: ['PUSHER'],
    });

    const s0 = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [pk, ek, pusher],
      mode: 'SANDBOX',
    });

    const abilities = getLegalAbilities(s0, pusher);
    expect(abilities).toHaveLength(1);
    expect(abilities[0]?.pushPreview?.fellInPit).toBe(true);

    const s1 = stepGame(s0, {
      type: 'USE_ABILITY',
      pieceId: 'p1',
      ability: 'PUSH',
      target: { x: 3, y: 3 },
    });
    expect(s1.error).toBeUndefined();
    expect(s1.nextState.winner).toBe('PLAYER');
    expect(s1.events.map((e) => e.type)).toEqual([
      'PIECE_PUSHED',
      'PIECE_SLID',
      'PIECE_FELL_IN_PIT',
      'MATCH_ENDED',
    ]);
    expect(s1.events[3]).toEqual({
      type: 'MATCH_ENDED',
      winner: 'PLAYER',
      reason: 'KING_FELL_IN_PIT',
    });
  });

  it('leaves pushed enemy stationary when blocked by WALL or another piece', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![4] = createTile('WALL');

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const pusher = makePiece({
      id: 'p1',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 2, y: 3 },
      traits: ['PUSHER'],
    });
    const target = makePiece({ id: 'e1', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 3 } });

    const s0 = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [pk, ek, pusher, target],
      mode: 'SANDBOX',
    });

    const s1 = stepGame(s0, {
      type: 'USE_ABILITY',
      pieceId: 'p1',
      ability: 'PUSH',
      target: { x: 3, y: 3 },
    });
    expect(s1.error).toBeUndefined();
    expect(getPieceById(s1.nextState.pieces, 'e1')?.pos).toEqual({ x: 3, y: 3 });
  });
});

describe('DASH_ON_REVEAL, RAIDERS, NECROMANCERS, and SIEGE_ENGINEERS', () => {
  it('grants exactly 1 bonus move when moving from fog into opponent VISIBLE area (and works via RAIDERS Knights)', () => {
    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 9 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 5, y: 1 } });
    // RAIDERS Knight at (4, 6): dist 5 from Enemy King (vision 3) -> hidden at turn start!
    const raiderKnight = makePiece({
      id: 'rn',
      side: 'PLAYER',
      type: 'KNIGHT',
      pos: { x: 4, y: 6 },
    });

    const s0 = createGameState({
      width: 10,
      height: 10,
      pieces: [pk, ek, raiderKnight],
      factions: { PLAYER: 'RAIDERS', ENEMY: 'NONE' },
      mode: 'SANDBOX',
    });

    // Jump from (4,6) -> (5,4) (Chebyshev dist 3 from Enemy King at (5,1) -> now VISIBLE!)
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'rn', to: { x: 5, y: 4 } });
    expect(s1.error).toBeUndefined();
    expect(s1.nextState.turn).toBe('PLAYER');
    expect(s1.nextState.bonusMovePieceId).toBe('rn');

    // Another piece cannot move during the bonus move
    const badKingMove = stepGame(s1.nextState, { type: 'MOVE', pieceId: 'pk', to: { x: 1, y: 9 } });
    expect(badKingMove.error).toBeDefined();

    // Raider Knight uses its 1 bonus move -> jumps to (4,2) -> turn ends (max 1 bonus move per turn)
    const s2 = stepGame(s1.nextState, { type: 'MOVE', pieceId: 'rn', to: { x: 4, y: 2 } });
    expect(s2.error).toBeUndefined();
    expect(s2.nextState.turn).toBe('ENEMY');
    expect(s2.nextState.bonusMovePieceId).toBeNull();
  });

  it('spawns a NECROMANCERS skeleton Pawn after 2 turns if square is empty, and cancels if occupied', () => {
    // Case A: empty tile -> spawns
    const tilesA = createEmptyTiles(8, 8, 'PLAIN');
    tilesA[3]![3] = createTile('BURNING', 3);

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const necroPawn = makePiece({ id: 'ep', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 3 } });

    const a0 = createGameState({
      width: 8,
      height: 8,
      tiles: tilesA,
      pieces: [pk, ek, necroPawn],
      factions: { PLAYER: 'NONE', ENEMY: 'NECROMANCERS' },
      mode: 'SANDBOX',
    });

    // Turn 1 (PLAYER) passes -> Turn 2 (ENEMY) passes -> necroPawn burns & queues spawn (2 -> 1)
    const a1 = stepGame(a0, { type: 'END_TURN' });
    const a2 = stepGame(a1.nextState, { type: 'END_TURN' });
    expect(getPieceById(a2.nextState.pieces, 'ep')).toBeUndefined();
    expect(a2.nextState.pendingSpawns).toHaveLength(1);
    expect(a2.nextState.pendingSpawns[0]?.turnsRemaining).toBe(1);

    // Turn 3 (PLAYER) passes -> timer 1 -> 0 -> (3,3) is empty -> skeleton Pawn spawns!
    const a3 = stepGame(a2.nextState, { type: 'END_TURN' });
    expect(a3.nextState.pendingSpawns).toHaveLength(0);
    const spawnEv = a3.events.find((e) => e.type === 'UNIT_SPAWNED');
    expect(spawnEv).toBeDefined();
    expect(a3.nextState.pieces.some((p) => p.side === 'ENEMY' && p.type === 'PAWN' && p.pos.x === 3 && p.pos.y === 3)).toBe(true);

    // Case B: Player Rook captures necroPawn and remains on (3,3) -> spawn is cancelled!
    const playerRook = makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 3, y: 6 } });
    const b0 = createGameState({
      width: 8,
      height: 8,
      pieces: [pk, ek, playerRook, necroPawn],
      factions: { PLAYER: 'NONE', ENEMY: 'NECROMANCERS' },
      mode: 'SANDBOX',
    });

    const b1 = stepGame(b0, { type: 'MOVE', pieceId: 'pr', to: { x: 3, y: 3 } });
    expect(b1.nextState.pendingSpawns).toHaveLength(1);
    const b2 = stepGame(b1.nextState, { type: 'END_TURN' });
    expect(b2.nextState.pendingSpawns).toHaveLength(0);
    expect(b2.events.some((e) => e.type === 'UNIT_SPAWNED')).toBe(false);
  });

  it('allows SIEGE_ENGINEERS Rook to destroy an adjacent WALL and immediately open Line of Sight', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[4]![3] = createTile('WALL');
    tiles[3]![3] = createTile('WALL');
    tiles[5]![3] = createTile('WALL');

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const siegeRook = makePiece({ id: 'sr', side: 'PLAYER', type: 'ROOK', pos: { x: 2, y: 4 } });

    const s0 = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [pk, ek, siegeRook],
      factions: { PLAYER: 'SIEGE_ENGINEERS', ENEMY: 'NONE' },
      mode: 'SANDBOX',
    });

    // (4,4) is behind WALL at (3,4) -> UNEXPLORED initially
    expect(s0.fog.PLAYER[4]![4]).toBe('UNEXPLORED');

    const s1 = stepGame(s0, {
      type: 'USE_ABILITY',
      pieceId: 'sr',
      ability: 'BREAK_WALL',
      target: { x: 3, y: 4 },
    });
    expect(s1.error).toBeUndefined();
    expect(s1.nextState.tiles[4]![3]?.type).toBe('PLAIN');
    expect(s1.events).toContainEqual({
      type: 'WALL_DESTROYED',
      pos: { x: 3, y: 4 },
      byPieceId: 'sr',
    });
    // Fog recomputed immediately -> (4,4) is now VISIBLE!
    expect(s1.nextState.fog.PLAYER[4]![4]).toBe('VISIBLE');
  });
});

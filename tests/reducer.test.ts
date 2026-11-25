import { describe, expect, it } from 'vitest';
import { createEmptyTiles, createTile, getPieceById } from '../src/engine/board';
import { computeStateHash } from '../src/engine/prng';
import { createGameState, replayActions, stepGame } from '../src/engine/reducer';
import { GameAction, GameEvent, GameState, Piece, PieceType, Side, TraitId } from '../src/engine/types';

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

describe('Pure Reducer Contract & Validation', () => {
  it('returns unmodified state reference with error on illegal actions and never mutates input', () => {
    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } });
    const s0 = createGameState({ width: 8, height: 8, pieces: [pk, ek], mode: 'SANDBOX' });
    const hashBefore = computeStateHash(s0);

    // Wrong side tries to move
    const errWrongSide = stepGame(s0, { type: 'MOVE', pieceId: 'ek', to: { x: 4, y: 1 } });
    expect(errWrongSide.error).toBeDefined();
    expect(errWrongSide.nextState).toBe(s0);
    expect(errWrongSide.events).toHaveLength(0);

    // Illegal target square (King moving 3 squares)
    const errIllegal = stepGame(s0, { type: 'MOVE', pieceId: 'pk', to: { x: 4, y: 4 } });
    expect(errIllegal.error).toBeDefined();
    expect(errIllegal.nextState).toBe(s0);

    // Valid move produces new state without mutating s0
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'pk', to: { x: 4, y: 6 } });
    expect(s1.error).toBeUndefined();
    expect(computeStateHash(s0)).toBe(hashBefore);
    expect(getPieceById(s0.pieces, 'pk')?.pos).toEqual({ x: 4, y: 7 });
    expect(getPieceById(s1.nextState.pieces, 'pk')?.pos).toEqual({ x: 4, y: 6 });
  });

  it('supports END_TURN anti-softlock when all pieces are frozen and thaws them at turn end', () => {
    const pk = makePiece({
      id: 'pk',
      side: 'PLAYER',
      type: 'KING',
      pos: { x: 4, y: 7 },
      frozenTurns: 1,
    });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } });
    const s0 = createGameState({ width: 8, height: 8, pieces: [pk, ek], mode: 'SANDBOX' });

    // Frozen King cannot move
    expect(stepGame(s0, { type: 'MOVE', pieceId: 'pk', to: { x: 4, y: 6 } }).error).toBeDefined();

    // END_TURN passes cleanly and decrements frozenTurns 1 -> 0
    const s1 = stepGame(s0, { type: 'END_TURN' });
    expect(s1.error).toBeUndefined();
    expect(s1.nextState.turn).toBe('ENEMY');
    expect(getPieceById(s1.nextState.pieces, 'pk')?.frozenTurns).toBe(0);
    expect(s1.events).toContainEqual({
      type: 'TURN_CHANGED',
      nextTurn: 'ENEMY',
      turnNumber: 2,
    });
  });

  it('promotes a Pawn to QUEEN on back rank while preserving traits and emits PIECE_PROMOTED', () => {
    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 7, y: 0 } });
    const pawn = makePiece({
      id: 'p1',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 3, y: 1 },
      traits: ['SCOUT', 'SHIELDED'],
      hasMoved: true,
    });

    const s0 = createGameState({ width: 8, height: 8, pieces: [pk, ek, pawn], mode: 'SANDBOX' });
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'p1', to: { x: 3, y: 0 } });

    expect(s1.error).toBeUndefined();
    const promoted = getPieceById(s1.nextState.pieces, 'p1');
    expect(promoted?.type).toBe('QUEEN');
    expect(promoted?.traits).toEqual(['SCOUT', 'SHIELDED']);
    expect(promoted?.shieldActive).toBe(true);
    expect(s1.events).toContainEqual({
      type: 'PIECE_PROMOTED',
      pieceId: 'p1',
      pos: { x: 3, y: 0 },
      fromType: 'PAWN',
      toType: 'QUEEN',
    });
  });
});

describe('Campaign Aggro Lifecycle (SLEEPING -> ALERTED -> ACTIVE)', () => {
  it('alerts SLEEPING enemies via LOS or 2-square combat proximity, blocks movement while ALERTED, then activates next turn', () => {
    const tiles = createEmptyTiles(10, 10, 'PLAIN');
    // Wall isolating e_nearby and e_far from Player's direct LOS
    tiles[3]![5] = createTile('WALL');
    tiles[4]![5] = createTile('WALL');
    tiles[5]![5] = createTile('WALL');

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 9 } });
    const pr = makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 4, y: 8 } });
    const ek = makePiece({
      id: 'ek',
      side: 'ENEMY',
      type: 'KING',
      pos: { x: 9, y: 0 },
      aggro: 'SLEEPING',
    });
    const eVictim = makePiece({
      id: 'e_vic',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 4, y: 4 },
      aggro: 'SLEEPING',
    });
    const eSpot = makePiece({
      id: 'e_spot',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 4, y: 1 },
      aggro: 'SLEEPING',
    });
    const eNearby = makePiece({
      id: 'e_near',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 6, y: 4 },
      aggro: 'SLEEPING',
    });
    const eFar = makePiece({
      id: 'e_far',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 8, y: 4 },
      aggro: 'SLEEPING',
    });

    const s0 = createGameState({
      width: 10,
      height: 10,
      tiles,
      pieces: [pk, pr, ek, eVictim, eSpot, eNearby, eFar],
      mode: 'CAMPAIGN',
    });

    // Player Rook captures eVictim at (4,4):
    // - eSpot at (4,1) enters Player VISIBLE fog (dist 3) -> ALERTED
    // - eNearby at (6,4) is behind WALL (not visible) but within 2 squares of combat at (4,4) -> ALERTED
    // - eFar at (8,4) is behind WALL and dist 4 -> remains SLEEPING
    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'pr', to: { x: 4, y: 4 } });
    expect(s1.error).toBeUndefined();
    expect(s1.nextState.fog.PLAYER[4]![6]).not.toBe('VISIBLE');
    expect(getPieceById(s1.nextState.pieces, 'e_spot')?.aggro).toBe('ALERTED');
    expect(getPieceById(s1.nextState.pieces, 'e_near')?.aggro).toBe('ALERTED');
    expect(getPieceById(s1.nextState.pieces, 'e_far')?.aggro).toBe('SLEEPING');
    expect(s1.events).toContainEqual({
      type: 'ENEMY_ALERTED',
      pieceId: 'e_spot',
      pos: { x: 4, y: 1 },
    });
    expect(s1.events).toContainEqual({
      type: 'ENEMY_ALERTED',
      pieceId: 'e_near',
      pos: { x: 6, y: 4 },
    });

    // Turn 2 (ENEMY): ALERTED enemy cannot move yet!
    const blockedAlertMove = stepGame(s1.nextState, {
      type: 'MOVE',
      pieceId: 'e_spot',
      to: { x: 4, y: 2 },
    });
    expect(blockedAlertMove.error).toBeDefined();

    // Enemy finishes Turn 2 -> ALERTED units become ACTIVE!
    const s2 = stepGame(s1.nextState, { type: 'END_TURN' });
    expect(getPieceById(s2.nextState.pieces, 'e_spot')?.aggro).toBe('ACTIVE');
    expect(getPieceById(s2.nextState.pieces, 'e_near')?.aggro).toBe('ACTIVE');
    expect(getPieceById(s2.nextState.pieces, 'e_far')?.aggro).toBe('SLEEPING');

    // Turn 3 (PLAYER) passes -> Turn 4 (ENEMY): e_spot can now move!
    const s3 = stepGame(s2.nextState, { type: 'END_TURN' });
    const s4 = stepGame(s3.nextState, { type: 'MOVE', pieceId: 'e_spot', to: { x: 4, y: 2 } });
    expect(s4.error).toBeUndefined();
    expect(getPieceById(s4.nextState.pieces, 'e_spot')?.pos).toEqual({ x: 4, y: 2 });
  });
});

describe('Win Conditions and Step 5 Pipeline Cutoff', () => {
  it('ends the match at Step 5 on King capture before Step 7 burn damage and blocks subsequent actions', () => {
    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 4 } });
    const ek = makePiece({
      id: 'ek',
      side: 'ENEMY',
      type: 'KING',
      pos: { x: 4, y: 3 },
      traits: ['EXPLOSIVE'],
    });
    const s0 = createGameState({ width: 8, height: 8, pieces: [pk, ek], mode: 'SANDBOX' });

    const s1 = stepGame(s0, { type: 'MOVE', pieceId: 'pk', to: { x: 4, y: 3 } });
    expect(s1.error).toBeUndefined();
    expect(s1.nextState.winner).toBe('PLAYER');
    // Player King survived because Step 5 terminated before Step 7 burn
    expect(getPieceById(s1.nextState.pieces, 'pk')).toBeDefined();
    expect(s1.events.some((e) => e.type === 'PIECE_BURNED')).toBe(false);
    expect(s1.events[s1.events.length - 1]).toEqual({
      type: 'MATCH_ENDED',
      winner: 'PLAYER',
      reason: 'KING_CAPTURED',
    });

    // No actions allowed after match end
    const afterEnd = stepGame(s1.nextState, { type: 'END_TURN' });
    expect(afterEnd.error).toBeDefined();
  });

  it('ends the match with KING_BURNED when a King burns to death in Step 7', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[7]![4] = createTile('BURNING', 2);

    const pk = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 7 } });
    const ek = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } });
    const s0 = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [pk, ek],
      mode: 'SANDBOX',
    });

    const s1 = stepGame(s0, { type: 'END_TURN' });
    expect(s1.nextState.winner).toBe('ENEMY');
    expect(s1.events).toContainEqual({
      type: 'MATCH_ENDED',
      winner: 'ENEMY',
      reason: 'KING_BURNED',
    });
  });
});

describe('Deterministic Replay & State Hash Verification', () => {
  it('replays actionHistory deterministically and reproduces the exact same FNV-1a stateHash and JSON', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[4]![2] = createTile('ICE');
    tiles[3]![2] = createTile('ICE');
    tiles[5]![5] = createTile('WATCHTOWER');
    tiles[2]![4] = createTile('WALL');

    const pieces: Piece[] = [
      makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 7 } }),
      makePiece({
        id: 'pr',
        side: 'PLAYER',
        type: 'ROOK',
        pos: { x: 2, y: 6 },
        traits: ['FROST_TOUCH'],
      }),
      makePiece({
        id: 'pp',
        side: 'PLAYER',
        type: 'PAWN',
        pos: { x: 5, y: 6 },
        traits: ['SCOUT'],
      }),
      makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } }),
      makePiece({
        id: 'er',
        side: 'ENEMY',
        type: 'ROOK',
        pos: { x: 2, y: 2 },
        traits: ['SHIELDED'],
      }),
      makePiece({ id: 'ep', side: 'ENEMY', type: 'PAWN', pos: { x: 5, y: 1 } }),
    ];

    const initialState = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces,
      factions: { PLAYER: 'SIEGE_ENGINEERS', ENEMY: 'NONE' },
      mode: 'SKIRMISH',
      seed: 'replay-test-seed-001',
    });

    const actions: GameAction[] = [
      // Turn 1 (PLAYER): Rook moves to ICE (2,4), slides through (2,3) into shielded Enemy Rook at (2,2) -> bounces to (2,3) & freezes er!
      { type: 'MOVE', pieceId: 'pr', to: { x: 2, y: 4 } },
      // Turn 2 (ENEMY): Pawn advances 2 squares (5,1) -> (5,3)
      { type: 'MOVE', pieceId: 'ep', to: { x: 5, y: 3 } },
      // Turn 3 (PLAYER): Pawn steps onto WATCHTOWER (5,5)
      { type: 'MOVE', pieceId: 'pp', to: { x: 5, y: 5 } },
      // Turn 4 (ENEMY): Now-thawed Enemy Rook captures Player Rook at (2,3)
      { type: 'MOVE', pieceId: 'er', to: { x: 2, y: 3 } },
      // Turn 5 (PLAYER): King advances to (4,6)
      { type: 'MOVE', pieceId: 'pk', to: { x: 4, y: 6 } },
      // Turn 6 (ENEMY): Pass turn
      { type: 'END_TURN' },
    ];

    // Live sequential execution
    let liveState = initialState;
    const liveEvents: GameEvent[] = [];
    for (const act of actions) {
      const res = stepGame(liveState, act);
      expect(res.error).toBeUndefined();
      liveState = res.nextState;
      liveEvents.push(...res.events);
    }

    expect(liveState.actionHistory).toEqual(actions);

    // Replay from a JSON-cloned copy of initialState using recorded actionHistory
    const jsonInitial = JSON.parse(JSON.stringify(initialState)) as GameState;
    const replayed = replayActions(jsonInitial, liveState.actionHistory);
    expect(replayed.error).toBeUndefined();
    expect(replayed.allEvents).toEqual(liveEvents);

    const liveHash = computeStateHash(liveState);
    const replayHash = computeStateHash(replayed.state);
    const jsonRoundTripHash = computeStateHash(JSON.parse(JSON.stringify(liveState)));

    expect(replayHash).toBe(liveHash);
    expect(jsonRoundTripHash).toBe(liveHash);
  });
});

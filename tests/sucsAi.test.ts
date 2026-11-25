import { describe, expect, it } from 'vitest';
import { createAiMemory } from '../src/ai/campaignAi';
import {
  AI_DIFFICULTY_PROFILES,
  chooseSucsAction,
  computeStressMetrics,
} from '../src/ai/sucsAi';
import { createEmptyTiles, createTile, getLegalMoves } from '../src/engine/board';
import {
  createArrowEmitterTrap,
  createMiasmaOverlay,
  createPressurePlateTrap,
  createSpikesTrap,
} from '../src/engine/dungeon';
import { createGameState } from '../src/engine/reducer';
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
    pos: { x: overrides.pos.x, y: overrides.pos.y },
    traits,
    shieldActive: overrides.shieldActive ?? traits.includes('SHIELDED'),
    frozenTurns: overrides.frozenTurns ?? 0,
    hasMoved: overrides.hasMoved ?? false,
    aggro: overrides.aggro ?? 'ACTIVE',
    usedDashThisTurn: overrides.usedDashThisTurn ?? false,
    wasVisibleAtTurnStart: overrides.wasVisibleAtTurnStart ?? false,
    ...(overrides.miasmaExposure !== undefined ? { miasmaExposure: overrides.miasmaExposure } : {}),
    ...(overrides.composure !== undefined ? { composure: overrides.composure } : {}),
    ...(overrides.faithCharge !== undefined ? { faithCharge: overrides.faithCharge } : {}),
    ...(overrides.madnessCharge !== undefined ? { madnessCharge: overrides.madnessCharge } : {}),
    ...(overrides.berserkReady !== undefined ? { berserkReady: overrides.berserkReady } : {}),
    ...(overrides.silencedTurns !== undefined ? { silencedTurns: overrides.silencedTurns } : {}),
    ...(overrides.absorbedForms !== undefined ? { absorbedForms: overrides.absorbedForms } : {}),
  };
}

describe('S.U.C.S. Native Tactical AI — Mechanic Mastery & Fairness', () => {
  it('executes PUSHER -> ICE -> PIT lethal combo on enemy King and emits tacticalTag', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![5] = createTile('ICE');
    tiles[3]![6] = createTile('PIT'); // within distance 3 (strictly visible to ep at (3,3))

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({
          id: 'ep',
          side: 'ENEMY',
          type: 'PAWN',
          pos: { x: 3, y: 3 },
          traits: ['PUSHER', 'SCOUT'], // SCOUT gives vision radius 4 so PIT at (6,3) is visible
        }),
        makePiece({
          id: 'pk',
          side: 'PLAYER',
          type: 'KING',
          pos: { x: 4, y: 3 },
          traits: ['SHIELDED'],
          shieldActive: true,
        }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'sucs-push-pit',
    });

    const view = getVisibleState(state, 'ENEMY');
    const decision = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      rngState: 7,
    });

    expect(decision.action).toEqual({
      type: 'USE_ABILITY',
      pieceId: 'ep',
      ability: 'PUSH',
      target: { x: 4, y: 3 },
    });
    expect(decision.score).toBeGreaterThanOrEqual(90000);
    expect(decision.tacticalTag).toContain('çukura');
  });

  it('uses SIEGE_ENGINEERS BREAK_WALL to breach a wall separating Rook from enemy King', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    // Complete wall belt on row 3 so Rook cannot walk around; breaking (4, 3) opens direct attack on Player King at (4, 4)
    for (let x = 0; x < 8; x++) {
      tiles[3]![x] = createTile('WALL');
    }

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 2 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 5 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      factions: { PLAYER: 'NONE', ENEMY: 'SIEGE_ENGINEERS' },
      seed: 'sucs-siege',
    });

    const view = getVisibleState(state, 'ENEMY');
    const decision = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      rngState: 11,
    });

    expect(decision.action).toEqual({
      type: 'USE_ABILITY',
      pieceId: 'er',
      ability: 'BREAK_WALL',
      target: { x: 4, y: 3 },
    });
    expect(decision.tacticalTag).toContain('duvar');
  });

  it('denies an imminent enemy NECROMANCERS skeleton spawn when safe', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'en', side: 'ENEMY', type: 'KNIGHT', pos: { x: 3, y: 2 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      factions: { PLAYER: 'NECROMANCERS', ENEMY: 'NONE' },
      seed: 'sucs-necro-deny',
    });
    state.pendingSpawns.push({
      pos: { x: 4, y: 4 },
      turnsRemaining: 1,
      side: 'PLAYER',
      pieceType: 'PAWN',
    });

    const view = getVisibleState(state, 'ENEMY');
    const decision = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      rngState: 21,
    });

    expect(decision.action).toEqual({
      type: 'MOVE',
      pieceId: 'en',
      to: { x: 4, y: 4 },
    });
    expect(decision.tacticalTag).toContain('diriltmesini');
  });

  it('preserves strict Zero Fog Cheating across all 3 difficulty profiles and computes fair Stress Meter', () => {
    const tiles = createEmptyTiles(9, 9, 'PLAIN');
    for (let x = 0; x < 9; x++) {
      tiles[4]![x] = createTile('WALL');
    }

    const common = [
      makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } }),
      makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 2, y: 1 } }),
    ];

    const stateA = createGameState({
      width: 9,
      height: 9,
      tiles,
      pieces: [
        ...common,
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 8 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'sucs-fair-a',
    });
    const stateB = createGameState({
      width: 9,
      height: 9,
      tiles,
      pieces: [
        ...common,
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 8, y: 8 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'sucs-fair-b',
    });

    const viewA = getVisibleState(stateA, 'ENEMY');
    const viewB = getVisibleState(stateB, 'ENEMY');
    expect(viewA).toEqual(viewB);

    for (const diff of Object.keys(AI_DIFFICULTY_PROFILES) as Array<keyof typeof AI_DIFFICULTY_PROFILES>) {
      const decA = chooseSucsAction(viewA, createAiMemory(), {
        difficulty: diff,
        aiSide: 'ENEMY',
        rngState: 77,
      });
      const decB = chooseSucsAction(viewB, createAiMemory(), {
        difficulty: diff,
        aiSide: 'ENEMY',
        rngState: 77,
      });
      expect(decA.action).toEqual(decB.action);
    }

    // Stress meter: calm when isolated, PANIC when King is on BURNING tile + threatened directly
    const calmStress = computeStressMetrics(getVisibleState(stateA, 'PLAYER'), 'PLAYER', 0);
    expect(calmStress.percent).toBeLessThan(60);

    const panicTiles = createEmptyTiles(8, 8, 'PLAIN');
    panicTiles[4]![4] = createTile('BURNING', 2);
    const panicState = createGameState({
      width: 8,
      height: 8,
      tiles: panicTiles,
      pieces: [
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 4 } }),
        makePiece({ id: 'eq', side: 'ENEMY', type: 'QUEEN', pos: { x: 4, y: 2 } }),
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
      ],
      turn: 'PLAYER',
      mode: 'CAMPAIGN',
      seed: 'panic-stress',
    });
    const panicStress = computeStressMetrics(getVisibleState(panicState, 'PLAYER'), 'PLAYER', 1);
    expect(panicStress.tone).toBe('panic');
    expect(panicStress.percent).toBeGreaterThanOrEqual(80);
  });
});

describe('S.U.C.S. V3 Tactical AI — Dungeon Traps, Saints, Silence & Chimera Budget Guard', () => {
  it('escapes lethal TELEGRAPH spikes and MIASMA exposure=1 squares', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![3] = createTile('PLAIN');
    tiles[3]![3]!.trap = createSpikesTrap('sp_tel', 1); // TELEGRAPH -> becomes EXTENDED (2) at end of turn!
    tiles[3]![4] = createTile('PLAIN');
    tiles[3]![4]!.gas = createMiasmaOverlay();

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({
          id: 'ek',
          side: 'ENEMY',
          type: 'KING',
          pos: { x: 3, y: 3 },
          miasmaExposure: 1,
        }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'sucs-v3-hazard-escape',
    });

    const view = getVisibleState(state, 'ENEMY');
    const decision = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      rngState: 33,
    });

    expect(decision.action.type).toBe('MOVE');
    if (decision.action.type === 'MOVE') {
      // Must leave TELEGRAPH spike (3,3) and avoid lethal MIASMA (4,3)
      expect(decision.action.to).not.toEqual({ x: 3, y: 3 });
      expect(decision.action.to).not.toEqual({ x: 4, y: 3 });
    }
  });

  it('triggers PRESSURE_PLATE -> ARROW_EMITTER trap to skewer enemy King', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    // Arrow emitter on left wall at (0, 2) shooting east toward Player King at (4, 2)
    tiles[2]![0] = createTile('WALL');
    tiles[2]![0]!.trap = createArrowEmitterTrap('em_kill', { dx: 1, dy: 0 }, { flaming: false });
    // Pressure plate at (2, 4) wired to em_kill; Enemy Pawn at (2, 3) (hasMoved=true) can only step onto (2, 4)
    tiles[4]![2] = createTile('PLAIN');
    tiles[4]![2]!.trap = createPressurePlateTrap('pl_kill', ['em_kill'], 2);

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({
          id: 'ep',
          side: 'ENEMY',
          type: 'PAWN',
          pos: { x: 2, y: 3 },
          hasMoved: true,
          traits: ['SCOUT'],
        }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 2 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'sucs-v3-plate-kill',
    });

    const view = getVisibleState(state, 'ENEMY');
    const decision = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      rngState: 41,
    });

    expect(decision.action).toEqual({
      type: 'MOVE',
      pieceId: 'ep',
      to: { x: 2, y: 4 },
    });
    expect(decision.score).toBeGreaterThanOrEqual(90000);
    expect(decision.tacticalTag).toContain('plakası');
  });

  it('completes PANIC depth-4 search within time budget even with 25+-move multi-form CHIMERA', () => {
    const tiles = createEmptyTiles(9, 9, 'PLAIN');
    const chimera: Piece = {
      ...makePiece({ id: 'ec', side: 'ENEMY', type: 'CHIMERA', pos: { x: 4, y: 4 } }),
      absorbedForms: [
        { sourceType: 'QUEEN', copiedTraits: ['SCOUT'] },
        { sourceType: 'KNIGHT', copiedTraits: [] },
      ],
    };

    const state = createGameState({
      width: 9,
      height: 9,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } }),
        chimera,
        makePiece({ id: 'esf', side: 'ENEMY', type: 'SAINT_FAITH', pos: { x: 2, y: 2 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 8 } }),
        makePiece({
          id: 'psf',
          side: 'PLAYER',
          type: 'SAINT_FAITH',
          pos: { x: 5, y: 6 },
          faithCharge: 2,
        }),
        makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 2, y: 6 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'sucs-v3-chimera-budget',
    });

    // Confirm multi-form Chimera genuinely triggers the >= 25 moves branching guard!
    const chimeraMoves = getLegalMoves(state, chimera, null);
    expect(chimeraMoves.length).toBeGreaterThanOrEqual(25);

    const view = getVisibleState(state, 'ENEMY');
    const decision = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      timeBudgetMs: 850,
      rngState: 99,
    });

    expect(decision.action.type).not.toBe('END_TURN');
    expect(decision.completedDepth).toBeGreaterThanOrEqual(1);
    expect(decision.elapsedMs).toBeLessThan(1500);

    // Determinism check with fixed simulated clock (nowMs)
    let tickA = 0;
    let tickB = 0;
    const detA = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      maxDepth: 2,
      timeBudgetMs: 10000,
      nowMs: () => ++tickA,
      rngState: 99,
    });
    const detB = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      maxDepth: 2,
      timeBudgetMs: 10000,
      nowMs: () => ++tickB,
      rngState: 99,
    });
    expect(detA.action).toEqual(detB.action);
  });
});

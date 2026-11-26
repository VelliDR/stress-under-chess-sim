import { describe, expect, it } from 'vitest';
import { createAiMemory } from '../src/ai/campaignAi';
import {
  AI_DIFFICULTY_PROFILES,
  chooseSucsAction,
  computeStressMetrics,
  evaluateVisiblePositionForTraining,
} from '../src/ai/sucsAi';
import {
  ALL_SKIRMISH_AI_TEMPLATES,
  buildRosterFromTemplate,
  computeSkirmishRosterCost,
  deploySkirmishAiArmy,
  V3_SKIRMISH_AI_TEMPLATES,
} from '../src/ai/skirmishAi';
import { buildMovementAwareBelief } from '../src/ai/beliefModel';
import { clampEvalWeights, EVAL_WEIGHT_BOUNDS, EVAL_WEIGHT_KEYS } from '../src/ai/evalWeights';
import { evaluateTinyMlp, NN_INPUT_DIM } from '../src/ai/nnEval';
import {
  TRAINED_BELIEF_WEIGHTS,
  TRAINED_EVAL_WEIGHTS,
  TRAINED_MLP_MODEL,
} from '../src/ai/trainedModels';
import { computeZobristHash } from '../src/ai/zobrist';
import { createEmptyTiles, createTile, getLegalMoves } from '../src/engine/board';
import {
  createArrowEmitterTrap,
  createMiasmaOverlay,
  createPressurePlateTrap,
  createSpikesTrap,
} from '../src/engine/dungeon';
import { createGameState, stepGame } from '../src/engine/reducer';
import { Piece, PieceType, Side, SKIRMISH_BUDGET, TraitId } from '../src/engine/types';
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

  it('distinguishes all V3 state dimensions in 64-bit Zobrist hash and stays piece-order invariant', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![3] = createTile('PLAIN');
    tiles[3]![3]!.trap = createSpikesTrap('sp1', 0);
    tiles[4]![4] = createTile('PLAIN');
    tiles[4]![4]!.gas = createMiasmaOverlay(2);
    tiles[5]![5] = createTile('PLAIN');
    tiles[5]![5]!.trap = createPressurePlateTrap('pl1', ['em1'], 2, 0);

    const base = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'ec', side: 'ENEMY', type: 'CHIMERA', pos: { x: 2, y: 2 } }),
        makePiece({ id: 'es', side: 'ENEMY', type: 'SAINT_FAITH', pos: { x: 1, y: 2 }, faithCharge: 1 }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 }, composure: 2 }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'zobrist-v3',
    });

    const hBase = computeZobristHash(base);

    // Commutative over piece array ordering
    const reordered = structuredClone(base);
    reordered.pieces.reverse();
    expect(computeZobristHash(reordered)).toEqual(hBase);

    // Distinct SPIKES phase
    const spikePhase1 = structuredClone(base);
    if (spikePhase1.tiles[3]![3]!.trap?.kind === 'SPIKES') spikePhase1.tiles[3]![3]!.trap.phase = 1;
    expect(computeZobristHash(spikePhase1)).not.toEqual(hBase);

    // Distinct MIASMA turnsRemaining
    const miasmaDiff = structuredClone(base);
    miasmaDiff.tiles[4]![4]!.gas = createMiasmaOverlay(1);
    expect(computeZobristHash(miasmaDiff)).not.toEqual(hBase);

    // Distinct PRESSURE_PLATE cooldown
    const plateCd = structuredClone(base);
    if (plateCd.tiles[5]![5]!.trap?.kind === 'PRESSURE_PLATE') plateCd.tiles[5]![5]!.trap.cooldown = 2;
    expect(computeZobristHash(plateCd)).not.toEqual(hBase);

    // Distinct faithCharge / composure / Chimera absorbedForms
    const chargeDiff = structuredClone(base);
    chargeDiff.pieces[2]!.faithCharge = 2;
    expect(computeZobristHash(chargeDiff)).not.toEqual(hBase);

    const compDiff = structuredClone(base);
    compDiff.pieces[3]!.composure = 1;
    expect(computeZobristHash(compDiff)).not.toEqual(hBase);

    const chimeraDiff = structuredClone(base);
    chimeraDiff.pieces[1]!.absorbedForms = [{ sourceType: 'KNIGHT', copiedTraits: ['FROST_TOUCH'] }];
    expect(computeZobristHash(chimeraDiff)).not.toEqual(hBase);
  });

  it('keeps stepGame searchMode strictly pure and rule-identical to normal stepGame on V3 boards', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[2]![0] = createTile('WALL');
    tiles[2]![0]!.trap = createArrowEmitterTrap('em_s', { dx: 1, dy: 0 }, { ammo: 2, flaming: true });
    tiles[4]![2] = createTile('PLAIN');
    tiles[4]![2]!.trap = createPressurePlateTrap('pl_s', ['em_s'], 2, 0);
    tiles[2]![3] = createTile('CRACKED');
    tiles[2]![3]!.gas = createMiasmaOverlay(3);
    tiles[3]![3] = createTile('BURNING', 2);
    tiles[5]![5] = createTile('PLAIN');
    tiles[5]![5]!.trap = createSpikesTrap('sp_s', 1);

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'ep', side: 'ENEMY', type: 'PAWN', pos: { x: 2, y: 3 }, hasMoved: true }),
        makePiece({ id: 'en', side: 'ENEMY', type: 'KNIGHT', pos: { x: 6, y: 1 }, traits: ['DASH_ON_REVEAL'] }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 } }),
        makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 2, y: 2 }, traits: ['SHIELDED'], shieldActive: true }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'search-mode-parity',
    });

    const snapshot = structuredClone(state);
    const legal = getLegalMoves(state, state.pieces[1]!, null);
    const toPlate = legal.find((m) => m.to.x === 2 && m.to.y === 4);
    expect(toPlate).toBeDefined();

    const action = { type: 'MOVE' as const, pieceId: 'ep', to: { x: 2, y: 4 } };
    const normalRes = stepGame(state, action);
    const fastRes = stepGame(state, action, { searchMode: true, precomputedLegalMove: toPlate });

    // Input state must never be mutated by copy-on-write searchMode
    expect(state).toEqual(snapshot);

    // Resulting board physics, pieces (exact wasVisibleAtTurnStart on DASH_ON_REVEAL units), traps, turns, and winner must match
    const normalizeNonDashVis = (ps: readonly Piece[]) =>
      ps.map((p) => (p.traits.includes('DASH_ON_REVEAL') ? p : { ...p, wasVisibleAtTurnStart: false }));
    expect(fastRes.error).toEqual(normalRes.error);
    expect(normalizeNonDashVis(fastRes.nextState.pieces)).toEqual(
      normalizeNonDashVis(normalRes.nextState.pieces),
    );
    expect(fastRes.nextState.tiles).toEqual(normalRes.nextState.tiles);
    expect(fastRes.nextState.pendingSpawns).toEqual(normalRes.nextState.pendingSpawns);
    expect(fastRes.nextState.bonusMovePieceId).toEqual(normalRes.nextState.bonusMovePieceId);
    expect(fastRes.nextState.turn).toEqual(normalRes.nextState.turn);
    expect(fastRes.nextState.turnNumber).toEqual(normalRes.nextState.turnNumber);
    expect(fastRes.nextState.winner).toEqual(normalRes.nextState.winner);
  });
});

describe('S.U.C.S. Step 2 — Kahpelik Tactics, Fair PIMC Fog Paranoia & V3 Skirmish Armies', () => {
  it('executes FROST_TOUCH freeze-lock on an enemy Queen standing on TELEGRAPH spikes', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[4]![4] = createTile('PLAIN');
    tiles[4]![4]!.trap = createSpikesTrap('sp_lock', 1); // TELEGRAPH -> lethal next turn if frozen!

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        // Enemy Knight with FROST_TOUCH can jump to (3,4) adjacent to Player Queen on spikes at (4,4)!
        makePiece({
          id: 'en',
          side: 'ENEMY',
          type: 'KNIGHT',
          pos: { x: 2, y: 2 },
          traits: ['FROST_TOUCH', 'SHIELDED'],
          shieldActive: true,
        }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 } }),
        makePiece({ id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 4, y: 4 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'kahpe-frost-spike-lock',
    });

    const view = getVisibleState(state, 'ENEMY');
    const dec = chooseSucsAction(view, createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      rngState: 7,
    });

    // Knight jumps to (3,4) or (4,3) orthogonally adjacent to (4,4), freezing Queen on telegraph spikes!
    expect(dec.action.type).toBe('MOVE');
    if (dec.action.type === 'MOVE') {
      expect(dec.action.pieceId).toBe('en');
      const isOrthoLock =
        (dec.action.to.x === 3 && dec.action.to.y === 4) ||
        (dec.action.to.x === 4 && dec.action.to.y === 3);
      expect(isOrthoLock).toBe(true);
    }
    expect(dec.tacticalTag).toContain('ölüm tuzağına');
  });

  it('uses fair movement-aware belief rays to keep heavy pieces off a remembered fog Rook sniper file', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'eq', side: 'ENEMY', type: 'QUEEN', pos: { x: 3, y: 2 } }),
        // Hidden Player King & Rook in far fog (y = 7, outside enemy vision radius 3)
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } }),
        makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 4, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'kahpe-fog-sniper',
    });

    const view = getVisibleState(state, 'ENEMY');
    expect(view.pieces.filter((p) => p.side === 'PLAYER')).toHaveLength(0);

    // Fair memory: enemy saw Player Rook at (4, 6) one turn ago (now in fog!)
    const mem = {
      lastKnownPositions: {
        pr: { pieceId: 'pr', pos: { x: 4, y: 6 }, type: 'ROOK' as const, lastSeenTurn: 1 },
      },
      recentSelfMoves: [],
    };
    const belief = buildMovementAwareBelief(view, mem, 'ENEMY');
    // Column x = 4 along the Rook's sniper file must have substantially higher danger than x = 2!
    expect(belief.dangerGrid[2]![4]!).toBeGreaterThan(belief.dangerGrid[2]![2]!);
    expect(belief.ghosts.length).toBeGreaterThanOrEqual(1);
    expect(belief.ghosts[0]!.type).toBe('ROOK');
  });

  it('pushes an enemy King onto TELEGRAPH spikes using expanded PUSHER hazard detection', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![5] = createTile('PLAIN');
    tiles[3]![5]!.trap = createSpikesTrap('sp_push', 1); // TELEGRAPH -> kills King end of turn!

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'ep', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 3 }, traits: ['PUSHER'] }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 3 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'kahpe-push-spikes',
    });

    const dec = chooseSucsAction(getVisibleState(state, 'ENEMY'), createAiMemory(), {
      difficulty: 'PANIC',
      aiSide: 'ENEMY',
      rngState: 5,
    });
    expect(dec.action).toEqual({
      type: 'USE_ABILITY',
      pieceId: 'ep',
      ability: 'PUSH',
      target: { x: 4, y: 3 },
    });
    expect(dec.score).toBeGreaterThanOrEqual(90000);
  });

  it('extracts deterministic 28-dim MLP training features strictly from VisibleState', () => {
    const state = createGameState({
      width: 8,
      height: 8,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 3, y: 2 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 } }),
        makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 3, y: 4 }, composure: 1 }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'feature-extract',
    });

    const res = evaluateVisiblePositionForTraining(
      getVisibleState(state, 'ENEMY'),
      createAiMemory(),
      'ENEMY',
    );
    expect(res.features).toHaveLength(28);
    expect(res.features.every((x) => Number.isFinite(x))).toBe(true);
    // Player Rook has composure === 1 and is isolated -> fragileDiff & isolatedFragileDiff should be negative (good for ENEMY -> positive feature diff)
    expect(res.features[5]).toBeLessThan(0);
    expect(res.features[7]).toBeLessThan(0);
  });

  it('validates all V3 Skirmish AI templates at 20 points and terrain-aware deployment alignment', () => {
    expect(V3_SKIRMISH_AI_TEMPLATES).toHaveLength(4);
    expect(ALL_SKIRMISH_AI_TEMPLATES).toHaveLength(8);

    const tiles = createEmptyTiles(9, 9, 'PLAIN');
    tiles[4]![7] = createTile('WATCHTOWER');
    tiles[4]![2] = createTile('PLAIN');
    tiles[4]![2]!.gas = createMiasmaOverlay();

    for (const tmpl of V3_SKIRMISH_AI_TEMPLATES) {
      const roster = buildRosterFromTemplate(tmpl, tmpl.id);
      expect(computeSkirmishRosterCost(roster)).toBe(SKIRMISH_BUDGET);

      const dep = deploySkirmishAiArmy(tiles, 9, 9, roster, 42, 'ENEMY');
      expect(dep.pieces).toHaveLength(roster.length);
      expect(dep.pieces.every((p) => p.pos.y <= 1)).toBe(true);

      // SCOUT pawn should align toward the WATCHTOWER column x = 7
      const scout = dep.pieces.find((p) => p.traits.includes('SCOUT'));
      if (scout !== undefined) {
        expect(Math.abs(scout.pos.x - 7)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('validates trained weights within bounds and Tiny MLP residual clamping + determinism', () => {
    // All trained eval weights stay strictly inside safe bounds
    const clamped = clampEvalWeights(TRAINED_EVAL_WEIGHTS);
    for (const key of EVAL_WEIGHT_KEYS) {
      const [lo, hi] = EVAL_WEIGHT_BOUNDS[key];
      expect(TRAINED_EVAL_WEIGHTS[key]).toBeGreaterThanOrEqual(lo);
      expect(TRAINED_EVAL_WEIGHTS[key]).toBeLessThanOrEqual(hi);
      expect(clamped[key]).toBe(TRAINED_EVAL_WEIGHTS[key]);
    }
    expect(TRAINED_BELIEF_WEIGHTS.sniperRayWeight).toBeGreaterThan(1.0);
    expect(TRAINED_BELIEF_WEIGHTS.memoryDecayPerTurn).toBeGreaterThan(0.5);

    // Tiny MLP returns exact 0 when disabled, and bounded finite residual when enabled
    const feats = new Float32Array(NN_INPUT_DIM);
    for (let i = 0; i < NN_INPUT_DIM; i++) feats[i] = (i % 2 === 0 ? 0.8 : -0.6);
    expect(evaluateTinyMlp(feats, { ...TRAINED_MLP_MODEL, enabled: false })).toBe(0);

    const enabledResA = evaluateTinyMlp(feats, { ...TRAINED_MLP_MODEL, enabled: true });
    const enabledResB = evaluateTinyMlp(feats, { ...TRAINED_MLP_MODEL, enabled: true });
    expect(enabledResA).toBe(enabledResB);
    expect(Math.abs(enabledResA)).toBeLessThanOrEqual(TRAINED_MLP_MODEL.maxResidualCp);
  });
});

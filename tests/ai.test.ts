import { describe, expect, it } from 'vitest';
import {
  chooseCampaignAction,
  computeCampaignIntents,
  createAiMemory,
  filterVisibleIntents,
  updateAiMemory,
} from '../src/ai/campaignAi';
import {
  buildRosterFromTemplate,
  chooseSkirmishAction,
  computeSkirmishRosterCost,
  deploySkirmishAiArmy,
  selectSkirmishAiTemplate,
  SKIRMISH_AI_TEMPLATES,
  validateSkirmishBudget,
} from '../src/ai/skirmishAi';
import { ALL_FACTIONS, FACTION_DEFINITIONS, PLAYABLE_FACTIONS } from '../src/data/factions';
import { createEmptyTiles, createTile, manhattanDistance } from '../src/engine/board';
import { seedToRngState } from '../src/engine/prng';
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
  };
}

describe('Fair AI — Zero Fog Cheating Invariant', () => {
  it('produces identical Campaign and Skirmish AI actions regardless of hidden player positions in UNEXPLORED fog', () => {
    const tiles = createEmptyTiles(9, 9, 'PLAIN');
    tiles[2]![4] = createTile('WATCHTOWER');
    // Wall belt separating north and south so player units are strictly hidden in fog
    for (let x = 0; x < 9; x++) {
      tiles[4]![x] = createTile('WALL');
    }

    const commonEnemies = [
      makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } }),
      makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 2, y: 1 } }),
      makePiece({ id: 'en', side: 'ENEMY', type: 'KNIGHT', pos: { x: 6, y: 1 } }),
    ];

    const stateA = createGameState({
      width: 9,
      height: 9,
      tiles,
      pieces: [
        ...commonEnemies,
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 8 } }),
        makePiece({ id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 1, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'fair-a',
    });

    const stateB = createGameState({
      width: 9,
      height: 9,
      tiles,
      pieces: [
        ...commonEnemies,
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 8, y: 8 } }),
        makePiece({ id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 7, y: 6 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'fair-b',
    });

    const viewA = getVisibleState(stateA, 'ENEMY');
    const viewB = getVisibleState(stateB, 'ENEMY');

    // Hidden units never leak into VisibleState
    expect(viewA).toEqual(viewB);
    expect(viewA.pieces.filter((p) => p.side === 'PLAYER')).toHaveLength(0);

    const campA = chooseCampaignAction(viewA, createAiMemory(), 42, 'ENEMY');
    const campB = chooseCampaignAction(viewB, createAiMemory(), 42, 'ENEMY');
    expect(campA.action).toEqual(campB.action);

    const skirA = chooseSkirmishAction(viewA, createAiMemory(), {
      timeBudgetMs: 120,
      maxDepth: 2,
      rngState: 42,
      aiSide: 'ENEMY',
    });
    const skirB = chooseSkirmishAction(viewB, createAiMemory(), {
      timeBudgetMs: 120,
      maxDepth: 2,
      rngState: 42,
      aiSide: 'ENEMY',
    });
    expect(skirA.action).toEqual(skirB.action);
  });
});

describe('Campaign AI — Aggro, Fair Memory, Watchtowers, Intents & Tactics', () => {
  it('never moves SLEEPING or ALERTED enemies and passes turn when none are ACTIVE', () => {
    const state = createGameState({
      width: 8,
      height: 8,
      pieces: [
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 4 } }),
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 }, aggro: 'SLEEPING' }),
        // ALERTED rook right next to player king must still NOT act!
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 3 }, aggro: 'ALERTED' }),
      ],
      turn: 'ENEMY',
      mode: 'CAMPAIGN',
    });

    const enemyView = getVisibleState(state, 'ENEMY');
    const decision = chooseCampaignAction(enemyView, createAiMemory(), 1, 'ENEMY');
    expect(decision.action).toEqual({ type: 'END_TURN' });
    expect(decision.intents).toHaveLength(0);
  });

  it('tracks lastKnownPositions in AiMemory, pursues into fog, and prunes stale memory once square is re-checked', () => {
    // Turn 1: Enemy rook at (4, 2) sees Player pawn at (4, 5) (distance 3 -> VISIBLE)
    const state1 = createGameState({
      width: 8,
      height: 8,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 2 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } }),
        makePiece({ id: 'pp', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 5 } }),
      ],
      turn: 'ENEMY',
      mode: 'CAMPAIGN',
    });

    const mem1 = updateAiMemory(createAiMemory(), getVisibleState(state1, 'ENEMY'), 'ENEMY');
    expect(mem1.lastKnownPositions['pp']?.pos).toEqual({ x: 4, y: 5 });

    // Turn 2: Player pawn secretly moved far into fog at (7, 7), and Enemy rook is at (4, 1) (so (4,5) is distance 4 -> EXPLORED, not VISIBLE!)
    const state2 = createGameState({
      width: 8,
      height: 8,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 1 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } }),
        makePiece({ id: 'pp', side: 'PLAYER', type: 'PAWN', pos: { x: 7, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'CAMPAIGN',
    });
    const view2 = getVisibleState(state2, 'ENEMY');
    expect(view2.pieces.filter((p) => p.side === 'PLAYER')).toHaveLength(0);

    const dec2 = chooseCampaignAction(view2, mem1, 7, 'ENEMY');
    expect(dec2.action.type).toBe('MOVE');
    if (dec2.action.type === 'MOVE') {
      const moveAction = dec2.action;
      // Moves closer to remembered position (4, 5)
      const movedPiece = view2.pieces.find((p) => p.id === moveAction.pieceId)!;
      expect(manhattanDistance(moveAction.to, { x: 4, y: 5 })).toBeLessThan(
        manhattanDistance(movedPiece.pos, { x: 4, y: 5 }),
      );
    }

    // Turn 3: Once Enemy rook reaches (4, 3), (4, 5) is VISIBLE (dist 2) and empty while pp at (7, 7) is out of range (dist 4) -> memory pruned!
    const state3 = createGameState({
      width: 8,
      height: 8,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 3 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } }),
        makePiece({ id: 'pp', side: 'PLAYER', type: 'PAWN', pos: { x: 7, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'CAMPAIGN',
    });
    const mem3 = updateAiMemory(dec2.memory, getVisibleState(state3, 'ENEMY'), 'ENEMY');
    expect(mem3.lastKnownPositions['pp']).toBeUndefined();
  });

  it('seeks an unoccupied WATCHTOWER when no enemies or memories are available', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[2]![4] = createTile('WATCHTOWER');

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 1 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'CAMPAIGN',
    });

    const dec = chooseCampaignAction(getVisibleState(state, 'ENEMY'), createAiMemory(), 1, 'ENEMY');
    expect(dec.action).toEqual({ type: 'MOVE', pieceId: 'er', to: { x: 4, y: 2 } });
  });

  it('filters intent arrows to only enemies visible to the player and prioritizes PIT push kills', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[4]![6] = createTile('PIT');

    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 6 } }),
        makePiece({ id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 5, y: 4 } }),
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 }, aggro: 'ACTIVE' }),
        // Visible PUSHER next to Player Queen beside PIT at (6,4)
        makePiece({
          id: 'ep',
          side: 'ENEMY',
          type: 'PAWN',
          pos: { x: 4, y: 4 },
          traits: ['PUSHER'],
          aggro: 'ACTIVE',
        }),
      ],
      turn: 'ENEMY',
      mode: 'CAMPAIGN',
    });

    const enemyView = getVisibleState(state, 'ENEMY');
    const playerView = getVisibleState(state, 'PLAYER');

    const allIntents = computeCampaignIntents(enemyView, createAiMemory(), 'ENEMY');
    const visibleIntents = filterVisibleIntents(allIntents, playerView);

    // Enemy King at (0,0) is hidden in PLAYER fog -> MUST NOT appear in visibleIntents!
    expect(visibleIntents.some((i) => i.pieceId === 'ek')).toBe(false);
    // Visible PUSHER at (4,4) SHOULD appear with PUSH intent into PIT!
    const pusherIntent = visibleIntents.find((i) => i.pieceId === 'ep');
    expect(pusherIntent).toBeDefined();
    expect(pusherIntent!.action).toEqual({
      type: 'USE_ABILITY',
      pieceId: 'ep',
      ability: 'PUSH',
      target: { x: 5, y: 4 },
    });

    const dec = chooseCampaignAction(enemyView, createAiMemory(), 1, 'ENEMY');
    expect(dec.action).toEqual(pusherIntent!.action);
  });
});

describe('Skirmish AI — 120ms Time Budget, Alpha-Beta Minimax & Asymmetric Armies', () => {
  it('respects the 120ms hard time budget on a dense 9x9 board and always returns a valid legal action', () => {
    const tiles = createEmptyTiles(9, 9, 'PLAIN');
    tiles[4]![2] = createTile('WALL');
    tiles[4]![6] = createTile('WALL');
    tiles[4]![4] = createTile('WATCHTOWER');
    tiles[3]![3] = createTile('ICE');
    tiles[5]![5] = createTile('ICE');

    const pieces: Piece[] = [
      makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 8 }, traits: ['SHIELDED'] }),
      makePiece({ id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 3, y: 7 } }),
      makePiece({ id: 'pr1', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 7 } }),
      makePiece({ id: 'pr2', side: 'PLAYER', type: 'ROOK', pos: { x: 8, y: 7 } }),
      makePiece({ id: 'pb1', side: 'PLAYER', type: 'BISHOP', pos: { x: 2, y: 6 } }),
      makePiece({ id: 'pn1', side: 'PLAYER', type: 'KNIGHT', pos: { x: 6, y: 6 } }),
      makePiece({ id: 'pp1', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 6 }, traits: ['SCOUT'] }),
      makePiece({ id: 'pp2', side: 'PLAYER', type: 'PAWN', pos: { x: 5, y: 6 } }),

      makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 }, traits: ['SHIELDED'] }),
      makePiece({ id: 'eq', side: 'ENEMY', type: 'QUEEN', pos: { x: 3, y: 1 } }),
      makePiece({ id: 'er1', side: 'ENEMY', type: 'ROOK', pos: { x: 0, y: 1 } }),
      makePiece({ id: 'er2', side: 'ENEMY', type: 'ROOK', pos: { x: 8, y: 1 } }),
      makePiece({ id: 'eb1', side: 'ENEMY', type: 'BISHOP', pos: { x: 2, y: 2 } }),
      makePiece({ id: 'en1', side: 'ENEMY', type: 'KNIGHT', pos: { x: 6, y: 2 } }),
      makePiece({ id: 'ep1', side: 'ENEMY', type: 'PAWN', pos: { x: 4, y: 2 }, traits: ['SCOUT'] }),
      makePiece({ id: 'ep2', side: 'ENEMY', type: 'PAWN', pos: { x: 5, y: 2 } }),
    ];

    const state = createGameState({
      width: 9,
      height: 9,
      tiles,
      pieces,
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      factions: { PLAYER: 'SIEGE_ENGINEERS', ENEMY: 'SIEGE_ENGINEERS' },
      seed: 'stress-9x9',
    });

    const visible = getVisibleState(state, 'ENEMY');
    const wallStart = performance.now();
    const decision = chooseSkirmishAction(visible, createAiMemory(), {
      timeBudgetMs: 120,
      maxDepth: 3,
      rngState: 99,
      aiSide: 'ENEMY',
    });
    const wallElapsed = performance.now() - wallStart;

    expect(wallElapsed).toBeLessThan(200);
    expect(decision.elapsedMs).toBeLessThan(150);
    expect(decision.completedDepth).toBeGreaterThanOrEqual(1);
    expect(decision.nodesSearched).toBeGreaterThan(0);

    // Returned action MUST be accepted by the real GameState reducer
    const applied = stepGame(state, decision.action);
    expect(applied.error).toBeUndefined();
  });

  it('aborts cleanly on simulated clock expiry and returns the last completed depth best move', () => {
    const state = createGameState({
      width: 8,
      height: 8,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } }),
        makePiece({ id: 'eq', side: 'ENEMY', type: 'QUEEN', pos: { x: 3, y: 2 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 6, y: 2 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } }),
        makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 2, y: 4 } }),
        makePiece({ id: 'pb', side: 'PLAYER', type: 'BISHOP', pos: { x: 5, y: 4 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
    });

    // Deterministic fake clock advancing 3ms per check -> completes depth 1 then hits 120ms budget during deeper search
    let fakeTime = 0;
    const decision = chooseSkirmishAction(getVisibleState(state, 'ENEMY'), createAiMemory(), {
      timeBudgetMs: 120,
      maxDepth: 3,
      rngState: 12,
      aiSide: 'ENEMY',
      nowMs: () => {
        fakeTime += 3;
        return fakeTime;
      },
    });

    expect(decision.timedOut).toBe(true);
    expect(decision.completedDepth).toBeGreaterThanOrEqual(1);
    expect(decision.elapsedMs).toBeLessThanOrEqual(135);
    const applied = stepGame(state, decision.action);
    expect(applied.error).toBeUndefined();
  });

  it('immediately takes a visible winning King capture at depth 1 via move ordering', () => {
    const state = createGameState({
      width: 8,
      height: 8,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 2 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 5 } }),
        makePiece({ id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 2, y: 2 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
    });

    const dec = chooseSkirmishAction(getVisibleState(state, 'ENEMY'), createAiMemory(), {
      timeBudgetMs: 120,
      maxDepth: 3,
      aiSide: 'ENEMY',
    });
    expect(dec.action).toEqual({ type: 'MOVE', pieceId: 'er', to: { x: 4, y: 5 } });
    expect(dec.score).toBeGreaterThan(90000);
  });

  it('defines 4 asymmetric army templates each totaling exactly 20 points and deploys them cleanly', () => {
    expect(SKIRMISH_AI_TEMPLATES).toHaveLength(4);
    const names = SKIRMISH_AI_TEMPLATES.map((t) => t.name);
    expect(names).toEqual(['Ağır Süvari', 'Kale Duvarı', 'Çapraz Pusu', 'Vezir Komandosu']);

    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[0]![0] = createTile('WALL');
    tiles[1]![7] = createTile('PIT');

    let rng = seedToRngState('skirmish-army-test');
    const selected = selectSkirmishAiTemplate(rng);
    rng = selected.nextRngState;
    expect(SKIRMISH_AI_TEMPLATES).toContain(selected.template);

    for (const tmpl of SKIRMISH_AI_TEMPLATES) {
      const roster = buildRosterFromTemplate(tmpl, tmpl.id);
      expect(computeSkirmishRosterCost(roster)).toBe(SKIRMISH_BUDGET);
      expect(validateSkirmishBudget(roster)).toBe(true);

      const deployed = deploySkirmishAiArmy(tiles, 8, 8, roster, rng, 'ENEMY');
      rng = deployed.nextRngState;
      expect(deployed.pieces).toHaveLength(roster.length);

      const occupied = new Set<string>();
      for (const p of deployed.pieces) {
        // Strictly within back 2 rows (y = 0 or 1)
        expect(p.pos.y).toBeGreaterThanOrEqual(0);
        expect(p.pos.y).toBeLessThanOrEqual(1);
        // Never on WALL or PIT
        const t = tiles[p.pos.y]![p.pos.x]!;
        expect(t.type).not.toBe('WALL');
        expect(t.type).not.toBe('PIT');
        // No overlapping spawns
        const key = `${p.pos.x},${p.pos.y}`;
        expect(occupied.has(key)).toBe(false);
        occupied.add(key);
      }
    }
  });

  it('does not falsely short-circuit on hidden opponent King in Fog and captures visible targets instead', () => {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    const state = createGameState({
      width: 8,
      height: 8,
      tiles,
      pieces: [
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } }),
        makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 3, y: 1 } }),
        // Player Queen is visible to Enemy Rook (distance 2), while Player King is hidden in far fog (7, 7)
        makePiece({ id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 3, y: 3 } }),
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 7, y: 7 } }),
      ],
      turn: 'ENEMY',
      mode: 'SKIRMISH',
      seed: 'hidden-king-search',
    });

    const view = getVisibleState(state, 'ENEMY');
    // Confirm Player King is genuinely hidden in fog, while Player Queen is visible
    expect(view.pieces.some((p) => p.id === 'pk')).toBe(false);
    expect(view.pieces.some((p) => p.id === 'pq')).toBe(true);

    const decision = chooseSkirmishAction(view, createAiMemory(), {
      timeBudgetMs: 120,
      maxDepth: 2,
      rngState: 99,
      aiSide: 'ENEMY',
    });

    // Must not falsely score 99975 (fake win) and MUST capture the undefended visible Queen!
    expect(decision.score).toBeLessThan(90000);
    expect(decision.action).toEqual({
      type: 'MOVE',
      pieceId: 'er',
      to: { x: 3, y: 3 },
    });
  });
});

describe('Faction Passives Registry', () => {
  it('provides complete metadata for NONE and all 4 playable faction passives', () => {
    expect(PLAYABLE_FACTIONS).toEqual([
      'FROST_WARDENS',
      'NECROMANCERS',
      'SIEGE_ENGINEERS',
      'RAIDERS',
    ]);
    for (const id of ALL_FACTIONS) {
      const def = FACTION_DEFINITIONS[id];
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(2);
      expect(def.detailedDesc.length).toBeGreaterThan(10);
    }
  });
});

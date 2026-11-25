import { describe, expect, it } from 'vitest';
import { computeSkirmishRosterCost } from '../src/ai/skirmishAi';
import { generateSkirmishMap } from '../src/data/encounters';
import {
  advanceToNextSkirmishRound,
  applySkirmishDraftPick,
  autoDeploySkirmishRoster,
  chooseAndApplyAiSkirmishDraft,
  createDefaultPlayerSkirmishRoster,
  createSkirmishRun,
  generateSkirmishDraftChoices,
  getSkirmishDraftPoolForSide,
  isValidSkirmishDeployCoord,
  resolveSkirmishRoundOutcome,
  SKIRMISH_RARE_CARDS,
  SKIRMISH_STANDARD_CARDS,
  startSkirmishRoundBattle,
} from '../src/data/rewards';
import {
  ALL_SKIRMISH_UNIT_CATALOG,
  SKIRMISH_UNIT_CATALOG,
  V3_SKIRMISH_UNIT_CATALOG,
} from '../src/data/squads';
import { createTile } from '../src/engine/board';
import { SKIRMISH_BUDGET } from '../src/engine/types';
import { getVisibleState } from '../src/engine/visibility';

describe('Mod 2 Skirmish — 20-Point Budget & Secret Deployment', () => {
  it('enforces exact spec unit costs and rejects over-budget or invalid deployments on Round 1', () => {
    expect(SKIRMISH_UNIT_CATALOG.map((u) => [u.label, u.cost])).toEqual([
      ['Piyon', 1],
      ['Gözcü Piyon', 2],
      ['At', 3],
      ['Fil', 3],
      ['Kale', 5],
      ['Vezir', 9],
    ]);

    const defRoster = createDefaultPlayerSkirmishRoster();
    expect(computeSkirmishRosterCost(defRoster)).toBe(SKIRMISH_BUDGET);

    const run = createSkirmishRun('skir-budget-1');
    const map = generateSkirmishMap(0, run.seed);
    const auto = autoDeploySkirmishRoster(
      map.tiles,
      map.width,
      map.height,
      run.playerRoster,
      run.rngState,
      'PLAYER',
    );

    // 1) Over-budget (add extra Queen = 29 pts) must fail on Round 1
    const overBudgetRun = {
      ...run,
      playerRoster: [...run.playerRoster, { id: 'sp_extra', type: 'QUEEN' as const, traits: [] }],
    };
    const overRes = startSkirmishRoundBattle(overBudgetRun, {
      ...auto.placements,
      sp_extra: { x: 0, y: map.height - 2 },
    });
    expect(overRes.error).toBeDefined();

    // 2) Placing a unit outside bottom 2 rows (e.g. y = 3) must fail
    const badPosPlacements = {
      ...auto.placements,
      sp_king: { x: 3, y: 3 },
    };
    const badPosRes = startSkirmishRoundBattle(run, badPosPlacements);
    expect(badPosRes.error).toBeDefined();

    // 3) Placing on WALL or PIT fails isValidSkirmishDeployCoord
    const walledTiles = map.tiles.map((r) => r.slice());
    walledTiles[map.height - 1]![0] = createTile('WALL');
    walledTiles[map.height - 2]![0] = createTile('PIT');
    expect(
      isValidSkirmishDeployCoord(walledTiles, map.width, map.height, { x: 0, y: map.height - 1 }, 'PLAYER'),
    ).toBe(false);
    expect(
      isValidSkirmishDeployCoord(walledTiles, map.width, map.height, { x: 0, y: map.height - 2 }, 'PLAYER'),
    ).toBe(false);

    // 4) Valid placement starts battle with AI secretly deployed in rows 0..1 and hidden in PLAYER fog
    const launched = startSkirmishRoundBattle(run, auto.placements);
    expect(launched.error).toBeUndefined();
    const battle = launched.nextRun.currentBattle!;
    expect(battle.mode).toBe('SKIRMISH');

    const enemyPieces = battle.pieces.filter((p) => p.side === 'ENEMY');
    expect(enemyPieces.length).toBe(run.enemyRoster.length);
    expect(enemyPieces.every((p) => p.pos.y <= 1)).toBe(true);

    // Fog isolation: enemy back-row units are hidden from player on Turn 1!
    const playerView = getVisibleState(battle, 'PLAYER');
    expect(playerView.pieces.filter((p) => p.side === 'ENEMY')).toHaveLength(0);
  });
});

describe('Mod 2 Skirmish — Best-of-3 Progression & Loser-Picks-Better Draft', () => {
  it('awards RARE pool to round loser and STANDARD pool to round winner, evolves both armies, and completes Best-of-3', () => {
    let run = createSkirmishRun('bo3-comeback-test');
    expect(run.aiTemplateName).toBeDefined();

    // Round 1 launch
    const map0 = generateSkirmishMap(0, run.seed);
    const dep0 = autoDeploySkirmishRoster(
      map0.tiles,
      map0.width,
      map0.height,
      run.playerRoster,
      run.rngState,
      'PLAYER',
    );
    const r1 = startSkirmishRoundBattle(run, dep0.placements);
    expect(r1.error).toBeUndefined();
    run = r1.nextRun;

    // Simulate Round 1: PLAYER loses (ENEMY wins 0-1)
    const finished1 = JSON.parse(JSON.stringify(run.currentBattle!));
    finished1.winner = 'ENEMY';
    const out1 = resolveSkirmishRoundOutcome(run, finished1);
    expect(out1.status).toBe('NEXT_DRAFT');
    expect(out1.nextRun.playerWins).toBe(0);
    expect(out1.nextRun.enemyWins).toBe(1);
    run = out1.nextRun;

    // Loser (PLAYER) gets RARE pool; Winner (ENEMY) gets STANDARD pool!
    expect(getSkirmishDraftPoolForSide(run, 'PLAYER')).toBe('RARE');
    expect(getSkirmishDraftPoolForSide(run, 'ENEMY')).toBe('STANDARD');

    const playerDraft = generateSkirmishDraftChoices(run, 'PLAYER');
    expect(playerDraft.pool).toBe('RARE');
    expect(playerDraft.cards).toHaveLength(3);
    expect(playerDraft.cards.every((c) => c.pool === 'RARE')).toBe(true);

    // Player drafts a Faction passive from RARE pool (e.g. RAIDERS)
    const factionCard = SKIRMISH_RARE_CARDS.find((c) => c.grantFaction === 'RAIDERS')!;
    const afterPlayerPick = applySkirmishDraftPick(run, 'PLAYER', factionCard);
    expect(afterPlayerPick.error).toBeUndefined();
    expect(afterPlayerPick.nextRun.playerFaction).toBe('RAIDERS');

    // AI drafts from STANDARD pool
    const aiDraft1 = chooseAndApplyAiSkirmishDraft(afterPlayerPick.nextRun);
    expect(aiDraft1.pool).toBe('STANDARD');

    // Advance to Round 2 (new map, evolved armies — can exceed 20 pts after drafting!)
    run = advanceToNextSkirmishRound(aiDraft1.nextRun);
    expect(run.roundIndex).toBe(1);
    const map1 = generateSkirmishMap(1, run.seed);
    const dep1 = autoDeploySkirmishRoster(
      map1.tiles,
      map1.width,
      map1.height,
      run.playerRoster,
      run.rngState,
      'PLAYER',
    );
    const r2 = startSkirmishRoundBattle(run, dep1.placements);
    expect(r2.error).toBeUndefined();
    expect(r2.nextRun.currentBattle!.factions.PLAYER).toBe('RAIDERS');
    run = r2.nextRun;

    // Simulate Round 2: PLAYER wins -> tied 1-1!
    const finished2 = JSON.parse(JSON.stringify(run.currentBattle!));
    finished2.winner = 'PLAYER';
    const out2 = resolveSkirmishRoundOutcome(run, finished2);
    expect(out2.status).toBe('NEXT_DRAFT');
    expect(out2.nextRun.playerWins).toBe(1);
    expect(out2.nextRun.enemyWins).toBe(1);
    run = out2.nextRun;

    // Now Winner (PLAYER) gets STANDARD pool; Loser (ENEMY) gets RARE pool!
    expect(getSkirmishDraftPoolForSide(run, 'PLAYER')).toBe('STANDARD');
    expect(getSkirmishDraftPoolForSide(run, 'ENEMY')).toBe('RARE');

    const stdUnitCard = SKIRMISH_STANDARD_CARDS.find((c) => c.addUnit !== undefined)!;
    const prevPlayerSize = run.playerRoster.length;
    const afterP2 = applySkirmishDraftPick(run, 'PLAYER', stdUnitCard);
    expect(afterP2.nextRun.playerRoster.length).toBe(prevPlayerSize + 1);

    const aiDraft2 = chooseAndApplyAiSkirmishDraft(afterP2.nextRun);
    expect(aiDraft2.pool).toBe('RARE');
    run = advanceToNextSkirmishRound(aiDraft2.nextRun);
    expect(run.roundIndex).toBe(2);

    // Round 3: PLAYER wins 2-1 -> MATCH_OVER!
    const map2 = generateSkirmishMap(2, run.seed);
    const dep2 = autoDeploySkirmishRoster(
      map2.tiles,
      map2.width,
      map2.height,
      run.playerRoster,
      run.rngState,
      'PLAYER',
    );
    const r3 = startSkirmishRoundBattle(run, dep2.placements);
    expect(r3.error).toBeUndefined();
    const finished3 = JSON.parse(JSON.stringify(r3.nextRun.currentBattle!));
    finished3.winner = 'PLAYER';
    const out3 = resolveSkirmishRoundOutcome(r3.nextRun, finished3);
    expect(out3.status).toBe('MATCH_OVER');
    expect(out3.matchWinner).toBe('PLAYER');
    expect(out3.nextRun.playerWins).toBe(2);
    expect(out3.nextRun.enemyWins).toBe(1);
  });
});

describe('Mod 2 Skirmish V3 — Saint & Chimera 20-Point Budget', () => {
  it('prices Ocaklı (6), Meczup (6) and Gulyabani (10) accurately within the 20-point Skirmish budget', () => {
    expect(V3_SKIRMISH_UNIT_CATALOG.map((u) => [u.type, u.label, u.cost])).toEqual([
      ['SAINT_FAITH', 'Ocaklı', 6],
      ['SAINT_MADNESS', 'Meczup', 6],
      ['CHIMERA', 'Gulyabani', 10],
    ]);
    expect(ALL_SKIRMISH_UNIT_CATALOG).toHaveLength(9);

    const chimeraArmy = [
      { id: 'sp_king', type: 'KING' as const, traits: [] },
      { id: 'sp_ch', type: 'CHIMERA' as const, traits: [] }, // 10
      { id: 'sp_sf', type: 'SAINT_FAITH' as const, traits: [] }, // 6
      { id: 'sp_kn', type: 'KNIGHT' as const, traits: [] }, // 3
      { id: 'sp_pw', type: 'PAWN' as const, traits: [] }, // 1
    ];
    expect(computeSkirmishRosterCost(chimeraArmy)).toBe(SKIRMISH_BUDGET);

    const twinSaintArmy = [
      { id: 'sp_king', type: 'KING' as const, traits: [] },
      { id: 'sp_sf', type: 'SAINT_FAITH' as const, traits: [] }, // 6
      { id: 'sp_sm', type: 'SAINT_MADNESS' as const, traits: [] }, // 6
      { id: 'sp_rk', type: 'ROOK' as const, traits: [] }, // 5
      { id: 'sp_kn', type: 'KNIGHT' as const, traits: [] }, // 3
    ];
    expect(computeSkirmishRosterCost(twinSaintArmy)).toBe(SKIRMISH_BUDGET);

    // Valid 20-point Chimera army starts Round 1 cleanly
    const baseRun = createSkirmishRun('skir-v3-chimera');
    const v3Run = { ...baseRun, playerRoster: chimeraArmy };
    const map = generateSkirmishMap(0, v3Run.seed);
    const auto = autoDeploySkirmishRoster(
      map.tiles,
      map.width,
      map.height,
      v3Run.playerRoster,
      v3Run.rngState,
      'PLAYER',
    );
    const okLaunch = startSkirmishRoundBattle(v3Run, auto.placements);
    expect(okLaunch.error).toBeUndefined();
    expect(okLaunch.nextRun.currentBattle!.pieces.some((p) => p.type === 'CHIMERA')).toBe(true);

    // 21-point army (2x Chimera + 1 Pawn = 21) is rejected on Round 1
    const overRun = {
      ...baseRun,
      playerRoster: [
        { id: 'sp_king', type: 'KING' as const, traits: [] },
        { id: 'sp_ch1', type: 'CHIMERA' as const, traits: [] },
        { id: 'sp_ch2', type: 'CHIMERA' as const, traits: [] },
        { id: 'sp_pw', type: 'PAWN' as const, traits: [] },
      ],
    };
    const overAuto = autoDeploySkirmishRoster(
      map.tiles,
      map.width,
      map.height,
      overRun.playerRoster,
      overRun.rngState,
      'PLAYER',
    );
    expect(startSkirmishRoundBattle(overRun, overAuto.placements).error).toBeDefined();
  });
});

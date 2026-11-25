import { describe, expect, it } from 'vitest';
import {
  ACT2_CAMPAIGN_ROOMS,
  ACT3_CAMPAIGN_ROOMS,
  ALL_CAMPAIGN_ROOMS,
  buildCampaignEncounter,
  buildCampaignEncounterById,
  CAMPAIGN_ROOMS,
  generateSkirmishMap,
  SECRET_ACT4_ROOM,
} from '../src/data/encounters';
import { getRoomIntroQuote } from '../src/data/narrative';
import {
  applyCampaignReward,
  CampaignRewardCard,
  continueCampaignToNextAct,
  createCampaignRun,
  generateCampaignRewards,
  resolveCampaignBattleOutcome,
} from '../src/data/rewards';
import {
  ALL_STARTER_SQUADS,
  buildRosterFromSquad,
  STARTER_SQUADS,
  V3_STARTER_SQUADS,
} from '../src/data/squads';
import { createEmptyTiles, createTile, validateMapConnectivity } from '../src/engine/board';
import { computeStateHash } from '../src/engine/prng';
import { createGameState, stepGame } from '../src/engine/reducer';
import { MAX_TRAITS_PER_PIECE, Piece } from '../src/engine/types';

describe('Campaign Act 1 — Starter Squads & Room Generation', () => {
  it('defines the exact 3 starter squads specified in the design doc', () => {
    expect(STARTER_SQUADS).toHaveLength(3);
    expect(STARTER_SQUADS.map((s) => s.name)).toEqual([
      'Keşif Mangası',
      'Kuşatma Birliği',
      'Suikastçılar',
    ]);

    const recon = buildRosterFromSquad(STARTER_SQUADS[0]!);
    expect(recon.filter((u) => u.type === 'KNIGHT')).toHaveLength(2);
    expect(recon.filter((u) => u.type === 'PAWN' && u.traits.includes('SCOUT'))).toHaveLength(2);

    const siege = buildRosterFromSquad(STARTER_SQUADS[1]!);
    expect(siege.filter((u) => u.type === 'ROOK' && u.traits.includes('SHIELDED'))).toHaveLength(1);
    expect(siege.filter((u) => u.type === 'BISHOP')).toHaveLength(1);
    expect(siege.filter((u) => u.type === 'PAWN')).toHaveLength(3);

    const assassins = buildRosterFromSquad(STARTER_SQUADS[2]!);
    expect(assassins.filter((u) => u.type === 'QUEEN')).toHaveLength(1);
    expect(
      assassins.filter((u) => u.type === 'PAWN' && u.traits.includes('SHADOW_WALKER')),
    ).toHaveLength(1);
  });

  it('generates all 5 Act 1 rooms deterministically with guaranteed BFS connectivity and SLEEPING enemies', () => {
    expect(CAMPAIGN_ROOMS).toHaveLength(5);
    expect(CAMPAIGN_ROOMS.map((r) => [r.width, r.height, r.enemyFaction, r.isBoss])).toEqual([
      [8, 8, 'NONE', false],
      [8, 8, 'FROST_WARDENS', false],
      [9, 8, 'NECROMANCERS', false],
      [9, 9, 'SIEGE_ENGINEERS', false],
      [9, 9, 'FROST_WARDENS', true],
    ]);

    const roster = buildRosterFromSquad(STARTER_SQUADS[1]!);

    for (let s = 0; s < 10; s++) {
      const seed = `act1-seed-${s}`;
      for (let roomIdx = 0; roomIdx < CAMPAIGN_ROOMS.length; roomIdx++) {
        const builtA = buildCampaignEncounter({
          roomIndex: roomIdx,
          seed,
          roster,
          playerFaction: 'NONE',
          shieldAllNextBattle: false,
          activePacts: [],
        });
        const builtB = buildCampaignEncounter({
          roomIndex: roomIdx,
          seed,
          roster,
          playerFaction: 'NONE',
          shieldAllNextBattle: false,
          activePacts: [],
        });

        // Deterministic generation
        expect(computeStateHash(builtA.state)).toBe(computeStateHash(builtB.state));

        // Guaranteed BFS connectivity
        const playerPositions = builtA.state.pieces
          .filter((p) => p.side === 'PLAYER')
          .map((p) => p.pos);
        const enemyKing = builtA.state.pieces.find((p) => p.side === 'ENEMY' && p.type === 'KING');
        expect(enemyKing).toBeDefined();
        expect(validateMapConnectivity(builtA.state.tiles, playerPositions, enemyKing!.pos).connected).toBe(
          true,
        );

        // Enemies start SLEEPING in Campaign mode
        const enemies = builtA.state.pieces.filter((p) => p.side === 'ENEMY');
        expect(enemies.every((e) => e.aggro === 'SLEEPING')).toBe(true);

        // No overlapping pieces
        const seen = new Set<string>();
        for (const p of builtA.state.pieces) {
          const key = `${p.pos.x},${p.pos.y}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }

        if (roomIdx === 4) {
          expect(enemyKing!.isBoss).toBe(true);
          expect(enemyKing!.shieldActive).toBe(true);
          expect(builtA.state.bossCooldown).toBe(3);
        }
      }
    }
  });

  it('triggers the Boss 3-turn Ice/Fire elemental ring cleanly without breaking WALL/PIT tiles', () => {
    const tiles = createEmptyTiles(9, 9, 'PLAIN');
    tiles[2]![3] = createTile('WALL');
    tiles[2]![5] = createTile('PIT');

    const bossKing: Piece = {
      id: 'e_king',
      side: 'ENEMY',
      type: 'KING',
      pos: { x: 4, y: 2 },
      traits: ['SHIELDED'],
      shieldActive: true,
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'SLEEPING',
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: false,
      isBoss: true,
    };
    const playerKing: Piece = {
      id: 'p_king',
      side: 'PLAYER',
      type: 'KING',
      pos: { x: 4, y: 8 },
      traits: [],
      shieldActive: false,
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE',
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: false,
    };

    let state = createGameState({
      width: 9,
      height: 9,
      tiles,
      pieces: [bossKing, playerKing],
      mode: 'CAMPAIGN',
      turn: 'ENEMY',
      bossCooldown: 3,
      seed: 'boss-ring-test',
    });

    // Enemy turn 1 -> cooldown 2
    state = stepGame(state, { type: 'END_TURN' }).nextState;
    expect(state.bossCooldown).toBe(2);
    // Player turn 1
    state = stepGame(state, { type: 'END_TURN' }).nextState;
    // Enemy turn 2 -> cooldown 1
    state = stepGame(state, { type: 'END_TURN' }).nextState;
    expect(state.bossCooldown).toBe(1);
    // Player turn 2
    state = stepGame(state, { type: 'END_TURN' }).nextState;
    // Enemy turn 3 -> triggers ring & resets cooldown to 3!
    const triggerStep = stepGame(state, { type: 'END_TURN' });
    state = triggerStep.nextState;

    expect(state.bossCooldown).toBe(3);
    // Orthogonal open neighbors (4,1) and (4,3) ignited!
    expect(state.tiles[1]![4]!.type).toBe('BURNING');
    expect(state.tiles[3]![4]!.type).toBe('BURNING');
    expect(triggerStep.events.some((e) => e.type === 'TILE_IGNITED')).toBe(true);
    // WALL at (3,2) and PIT at (5,2) untouched!
    expect(state.tiles[2]![3]!.type).toBe('WALL');
    expect(state.tiles[2]![5]!.type).toBe('PIT');
    // Diagonal neighbors turned into ICE!
    expect(state.tiles[1]![3]!.type).toBe('ICE');
    expect(state.tiles[3]![5]!.type).toBe('ICE');
  });
});

describe('Campaign Act 1 — Permadeath, Rewards, Pacts & Victory/Defeat Lifecycle', () => {
  it('tracks permadeath losses, preserves promoted Queens, and applies Reinforce, Mutate, Revive, Shield-All & Pact rewards', () => {
    const run0 = createCampaignRun('siege-corps', 'camp-life-1');
    expect(run0.roomIndex).toBe(0);
    expect(run0.currentBattle).not.toBeNull();

    // Simulate winning Room 1 with 1 pawn lost (permadeath) and 1 pawn promoted to QUEEN
    const battle0 = JSON.parse(JSON.stringify(run0.currentBattle!));
    battle0.winner = 'PLAYER';
    const playerPawns = battle0.pieces.filter(
      (p: Piece) => p.side === 'PLAYER' && p.type === 'PAWN',
    );
    const lostPawnId = playerPawns[0]!.id;
    const promotedPawnId = playerPawns[1]!.id;
    battle0.pieces = battle0.pieces.filter((p: Piece) => p.id !== lostPawnId);
    battle0.pieces.find((p: Piece) => p.id === promotedPawnId)!.type = 'QUEEN';

    const outcome = resolveCampaignBattleOutcome(run0, battle0);
    expect(outcome.status).toBe('ROOM_CLEARED');
    expect(outcome.newlyLost.map((u) => u.id)).toEqual([lostPawnId]);
    expect(outcome.nextRun.lostUnits.map((u) => u.id)).toEqual([lostPawnId]);
    expect(outcome.nextRun.roster.find((u) => u.id === promotedPawnId)?.type).toBe('QUEEN');

    // 1) Test REVIVE reward restores lost unit
    const reviveCard: CampaignRewardCard = {
      id: 'c_rev',
      kind: 'REPAIR_REVIVE',
      title: 'Diriltme',
      subtitle: 'Test',
      description: 'Test',
      rarity: 'RARE',
      allowReviveOrShieldAll: true,
    };
    const afterRevive = applyCampaignReward(outcome.nextRun, reviveCard, {
      repairChoice: 'REVIVE',
      targetUnitId: lostPawnId,
    });
    expect(afterRevive.error).toBeUndefined();
    expect(afterRevive.nextRun.roomIndex).toBe(1);
    expect(afterRevive.nextRun.lostUnits).toHaveLength(0);
    expect(afterRevive.nextRun.roster.some((u) => u.id === lostPawnId)).toBe(true);

    // 2) Test SHIELD_ALL grants active shield to every deployed player piece in next room
    const afterShield = applyCampaignReward(outcome.nextRun, reviveCard, {
      repairChoice: 'SHIELD_ALL',
    });
    expect(afterShield.error).toBeUndefined();
    const deployedPlayers = afterShield.nextRun.currentBattle!.pieces.filter(
      (p) => p.side === 'PLAYER',
    );
    expect(deployedPlayers.every((p) => p.shieldActive)).toBe(true);

    // 3) Test PACT adds Queen + buffs all enemy Pawns in the next room with EXPLOSIVE
    const pactCard: CampaignRewardCard = {
      id: 'c_pact',
      kind: 'PACT',
      title: 'Pazarlık: Vezir',
      subtitle: 'PACT',
      description: 'Test',
      rarity: 'PACT',
      addUnit: { type: 'QUEEN', traits: [] },
      pactPenalty: { trait: 'EXPLOSIVE', roomsRemaining: 2 },
    };
    const afterPact = applyCampaignReward(outcome.nextRun, pactCard);
    expect(afterPact.error).toBeUndefined();
    expect(afterPact.nextRun.activePacts).toEqual([{ trait: 'EXPLOSIVE', roomsRemaining: 2 }]);
    const enemyPawnsInRoom2 = afterPact.nextRun.currentBattle!.pieces.filter(
      (p) => p.side === 'ENEMY' && p.type === 'PAWN',
    );
    expect(enemyPawnsInRoom2.length).toBeGreaterThan(0);
    expect(enemyPawnsInRoom2.every((p) => p.traits.includes('EXPLOSIVE'))).toBe(true);

    // 4) Test MUTATE enforces MAX_TRAITS_PER_PIECE = 3
    const maxedRun = {
      ...outcome.nextRun,
      roster: outcome.nextRun.roster.map((u) =>
        u.id === 'p_king'
          ? { ...u, traits: ['SHIELDED', 'SCOUT', 'FROST_TOUCH'] as Piece['traits'] }
          : u,
      ),
    };
    const mutateCard: CampaignRewardCard = {
      id: 'c_mut',
      kind: 'MUTATE',
      title: 'Mutasyon',
      subtitle: 'Test',
      description: 'Test',
      rarity: 'STANDARD',
      addTraits: ['PUSHER'],
    };
    const rejectMax = applyCampaignReward(maxedRun, mutateCard, { targetUnitId: 'p_king' });
    expect(rejectMax.error).toBeDefined();
    expect(maxedRun.roster.find((u) => u.id === 'p_king')!.traits).toHaveLength(
      MAX_TRAITS_PER_PIECE,
    );

    // 5) Test RUN_VICTORY on clearing Boss (roomIndex 4) and RUN_DEFEAT when enemy wins
    const bossRun = { ...outcome.nextRun, roomIndex: 4 };
    const bossWinState = JSON.parse(JSON.stringify(battle0));
    bossWinState.winner = 'PLAYER';
    expect(resolveCampaignBattleOutcome(bossRun, bossWinState).status).toBe('RUN_VICTORY');

    const defeatState = JSON.parse(JSON.stringify(battle0));
    defeatState.winner = 'ENEMY';
    expect(resolveCampaignBattleOutcome(bossRun, defeatState).status).toBe('RUN_DEFEAT');
  });

  it('generates 3 deterministic reward cards with ~30% Pact frequency across seeds', () => {
    let pactCount = 0;
    const total = 200;

    for (let i = 0; i < total; i++) {
      const run = createCampaignRun('recon-squad', `reward-dist-${i}`);
      const genA = generateCampaignRewards(run);
      const genB = generateCampaignRewards(run);
      expect(genA.cards).toEqual(genB.cards);
      expect(genA.cards).toHaveLength(3);
      expect(genA.cards[0]!.kind).toBe('REINFORCE');
      expect(genA.cards[1]!.kind).toBe('MUTATE');
      if (genA.cards[2]!.kind === 'PACT') pactCount++;
    }

    // Statistically around 60 out of 200 (~30%)
    expect(pactCount).toBeGreaterThan(35);
    expect(pactCount).toBeLessThan(90);
  });

  it('generates point-symmetric BFS-connected Skirmish maps for all 3 rounds', () => {
    for (let round = 0; round < 3; round++) {
      const map = generateSkirmishMap(round, 'skirmish-seed-1');
      const cx = Math.floor(map.width / 2);
      expect(
        validateMapConnectivity(map.tiles, [{ x: cx, y: map.height - 1 }], { x: cx, y: 0 })
          .connected,
      ).toBe(true);
    }
  });
});

describe('Campaign V3 — Cult & Beast Squad, Act 2–3 & Secret Act 4 Rooms', () => {
  it('exposes the 4th V3 starter squad (Kült ve Canavar) without breaking legacy STARTER_SQUADS', () => {
    expect(V3_STARTER_SQUADS).toHaveLength(1);
    expect(V3_STARTER_SQUADS[0]!.id).toBe('cult-and-beast');
    expect(V3_STARTER_SQUADS[0]!.name).toBe('Kült ve Canavar');
    expect(ALL_STARTER_SQUADS).toHaveLength(4);

    const cultRoster = buildRosterFromSquad(V3_STARTER_SQUADS[0]!);
    expect(cultRoster.some((u) => u.type === 'SAINT_FAITH')).toBe(true);
    expect(cultRoster.some((u) => u.type === 'SAINT_MADNESS')).toBe(true);
  });

  it('builds all 11 Act 2, Act 3 & Secret Act 4 rooms deterministically with V3 dungeon chemistry, BFS connectivity & Turkish intro quotes', () => {
    expect(ACT2_CAMPAIGN_ROOMS).toHaveLength(5);
    expect(ACT3_CAMPAIGN_ROOMS).toHaveLength(5);
    expect(SECRET_ACT4_ROOM.id).toBe('act4-core');
    expect(ALL_CAMPAIGN_ROOMS).toHaveLength(16);

    const v3Rooms = [...ACT2_CAMPAIGN_ROOMS, ...ACT3_CAMPAIGN_ROOMS, SECRET_ACT4_ROOM];
    const roster = buildRosterFromSquad(V3_STARTER_SQUADS[0]!);

    for (const room of v3Rooms) {
      const builtA = buildCampaignEncounterById(room.id, {
        seed: 'v3-act-seed-42',
        roster,
        playerFaction: 'NONE',
        shieldAllNextBattle: false,
        activePacts: [],
      });
      const builtB = buildCampaignEncounterById(room.id, {
        seed: 'v3-act-seed-42',
        roster,
        playerFaction: 'NONE',
        shieldAllNextBattle: false,
        activePacts: [],
      });

      // Deterministic hash
      expect(computeStateHash(builtA.state)).toBe(computeStateHash(builtB.state));

      // Guaranteed BFS connectivity
      const playerPositions = builtA.state.pieces
        .filter((p) => p.side === 'PLAYER')
        .map((p) => p.pos);
      const enemyKing = builtA.state.pieces.find((p) => p.side === 'ENEMY' && p.type === 'KING');
      expect(enemyKing).toBeDefined();
      expect(validateMapConnectivity(builtA.state.tiles, playerPositions, enemyKing!.pos).connected).toBe(
        true,
      );

      // All enemies start SLEEPING
      const enemies = builtA.state.pieces.filter((p) => p.side === 'ENEMY');
      expect(enemies.every((e) => e.aggro === 'SLEEPING')).toBe(true);

      // No overlapping pieces
      const seen = new Set<string>();
      for (const p of builtA.state.pieces) {
        const key = `${p.pos.x},${p.pos.y}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }

      // Every Act 2/3/4 room has dual-tone Büyükusta-OS intro quotes
      expect(getRoomIntroQuote(room.id, 'polite', 7).length).toBeGreaterThan(5);
      expect(getRoomIntroQuote(room.id, 'unfiltered', 7).length).toBeGreaterThan(5);

      // Verify V3 dungeon features actually spawned when specified
      const flatTiles = builtA.state.tiles.flat();
      if ((room.miasmaCount ?? 0) > 0) {
        expect(flatTiles.some((t) => t.gas?.kind === 'MIASMA')).toBe(true);
      }
      if ((room.crackedCount ?? 0) > 0) {
        expect(flatTiles.some((t) => t.type === 'CRACKED')).toBe(true);
      }
      if ((room.spikeCount ?? 0) > 0) {
        expect(flatTiles.some((t) => t.trap?.kind === 'SPIKES')).toBe(true);
      }
      if ((room.plateEmitterPairs ?? 0) > 0) {
        expect(flatTiles.some((t) => t.trap?.kind === 'PRESSURE_PLATE')).toBe(true);
        expect(flatTiles.some((t) => t.trap?.kind === 'ARROW_EMITTER')).toBe(true);
      }
    }

    // Act 1 -> Act 2 -> Act 3 multi-act run lifecycle
    const act2Run = createCampaignRun('cult-and-beast', 'v3-multiact', 2);
    expect(act2Run.act).toBe(2);
    expect(act2Run.currentBattle).not.toBeNull();
    const act3Run = continueCampaignToNextAct(act2Run, 3);
    expect(act3Run.act).toBe(3);
    expect(act3Run.roomIndex).toBe(0);
    expect(act3Run.currentBattle).not.toBeNull();
  });
});

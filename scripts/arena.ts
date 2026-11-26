import { createAiMemory, type AiMemory } from '../src/ai/campaignAi';
import {
  buildRosterFromTemplate,
  deploySkirmishAiArmy,
  SKIRMISH_AI_TEMPLATES,
} from '../src/ai/skirmishAi';
import {
  chooseSucsAction,
  type AiDifficulty,
  type SucsAiDecision,
  type SucsAiOptions,
} from '../src/ai/sucsAi';
import {
  buildCampaignEncounterById,
  generateSkirmishMap,
} from '../src/data/encounters';
import { createEmptyTiles, createTile, ensureMapConnectivity } from '../src/engine/board';
import {
  createArrowEmitterTrap,
  createMiasmaOverlay,
  createPressurePlateTrap,
  createSpikesTrap,
} from '../src/engine/dungeon';
import { seedToRngState } from '../src/engine/prng';
import { createGameState, stepGame } from '../src/engine/reducer';
import type {
  FactionPassive,
  GameEvent,
  GameState,
  Piece,
  RosterUnit,
  Side,
  VisibleState,
} from '../src/engine/types';
import { getVisibleState } from '../src/engine/visibility';

export interface ArenaBot {
  name: string;
  choose: (
    visible: VisibleState,
    memory: AiMemory,
    aiSide: Side,
    rngState: number,
  ) => SucsAiDecision;
}

export interface ArenaScenario {
  id: string;
  label: string;
  createInitialState: (seed: string) => GameState;
}

export interface BotStats {
  moves: number;
  totalNodes: number;
  totalTtHits: number;
  totalDepth: number;
  totalMs: number;
  timeouts: number;
}

export interface MatchTelemetry {
  totalGames: number;
  winsA: number;
  winsB: number;
  draws: number;
  totalPlies: number;
  endReasons: Record<string, number>;
  v3Events: Record<string, number>;
  statsA: BotStats;
  statsB: BotStats;
}

export interface EloReport {
  scoreRateA: number;
  eloDiff: number;
  eloError95: number;
  sprtLlr: number;
  sprtDecision: 'ACCEPT_H1' | 'ACCEPT_H0' | 'INCONCLUSIVE';
}

const V3_SKIRMISH_ROSTERS: ReadonlyArray<{
  id: string;
  faction: FactionPassive;
  roster: readonly RosterUnit[];
}> = [
  {
    id: 'ocakli-kalkan',
    faction: 'FROST_WARDENS',
    roster: [
      { id: 'k', type: 'KING', traits: ['SHIELDED'] },
      { id: 'sf', type: 'SAINT_FAITH', traits: [] },
      { id: 'r1', type: 'ROOK', traits: ['FROST_TOUCH'] },
      { id: 'n1', type: 'KNIGHT', traits: ['PUSHER'] },
      { id: 'b1', type: 'BISHOP', traits: [] },
      { id: 'p1', type: 'PAWN', traits: ['SCOUT'] },
      { id: 'p2', type: 'PAWN', traits: ['EXPLOSIVE'] },
    ],
  },
  {
    id: 'meczup-akinci',
    faction: 'RAIDERS',
    roster: [
      { id: 'k', type: 'KING', traits: [] },
      { id: 'sm', type: 'SAINT_MADNESS', traits: [] },
      { id: 'n1', type: 'KNIGHT', traits: ['DASH_ON_REVEAL'] },
      { id: 'n2', type: 'KNIGHT', traits: ['SHADOW_WALKER'] },
      { id: 'r1', type: 'ROOK', traits: ['PUSHER'] },
      { id: 'p1', type: 'PAWN', traits: ['SCOUT'] },
      { id: 'p2', type: 'PAWN', traits: ['EXPLOSIVE'] },
    ],
  },
  {
    id: 'gulyabani-kusatma',
    faction: 'SIEGE_ENGINEERS',
    roster: [
      { id: 'k', type: 'KING', traits: ['SHIELDED'] },
      { id: 'ch', type: 'CHIMERA', traits: [] },
      { id: 'r1', type: 'ROOK', traits: ['PUSHER'] },
      { id: 'b1', type: 'BISHOP', traits: ['FROST_TOUCH'] },
      { id: 'p1', type: 'PAWN', traits: ['SCOUT'] },
      { id: 'p2', type: 'PAWN', traits: ['EXPLOSIVE'] },
    ],
  },
  {
    id: 'nekro-vezir',
    faction: 'NECROMANCERS',
    roster: [
      { id: 'k', type: 'KING', traits: ['SHIELDED'] },
      { id: 'q1', type: 'QUEEN', traits: [] },
      { id: 'n1', type: 'KNIGHT', traits: ['SHADOW_WALKER'] },
      { id: 'b1', type: 'BISHOP', traits: ['EXPLOSIVE'] },
      { id: 'p1', type: 'PAWN', traits: ['SCOUT'] },
      { id: 'p2', type: 'PAWN', traits: ['PUSHER'] },
      { id: 'p3', type: 'PAWN', traits: [] },
    ],
  },
];

function cloneRosterWithPrefix(roster: readonly RosterUnit[], prefix: string): RosterUnit[] {
  return roster.map((u, idx) => ({
    id: `${prefix}_${u.id}_${idx}`,
    type: u.type,
    traits: u.traits.slice(),
  }));
}

/**
 * Builds a symmetric V3 dungeon skirmish map with MIASMA, CRACKED tiles, SPIKES,
 * and wired PRESSURE_PLATE -> ARROW_EMITTER pairs so both sides have identical terrain.
 */
function buildSymmetricV3DungeonState(
  seed: string,
  rosterIdx: number,
  variant: 'chemistry' | 'psychology',
): GameState {
  const width = 9;
  const height = 9;
  const tiles = createEmptyTiles(width, height, 'PLAIN');

  // Symmetric walls & watchtowers
  tiles[3]![2] = createTile('WALL');
  tiles[5]![6] = createTile('WALL');
  tiles[4]![4] = createTile('WATCHTOWER');
  tiles[2]![4] = createTile('ICE');
  tiles[6]![4] = createTile('ICE');
  tiles[3]![6] = createTile('PIT');
  tiles[5]![2] = createTile('PIT');

  if (variant === 'chemistry') {
    // Symmetric flaming arrow emitters on row 4 (left & right) and pressure plates
    tiles[4]![0] = createTile('WALL');
    tiles[4]![0]!.trap = createArrowEmitterTrap('em_L', { dx: 1, dy: 0 }, { flaming: true });
    tiles[4]![8] = createTile('WALL');
    tiles[4]![8]!.trap = createArrowEmitterTrap('em_R', { dx: -1, dy: 0 }, { flaming: true });

    tiles[3]![4] = createTile('PLAIN');
    tiles[3]![4]!.trap = createPressurePlateTrap('pl_N', ['em_L'], 2);
    tiles[5]![4] = createTile('PLAIN');
    tiles[5]![4]!.trap = createPressurePlateTrap('pl_S', ['em_R'], 2);

    // Miasma pockets crossing arrow corridor
    tiles[4]![2]!.gas = createMiasmaOverlay();
    tiles[4]![3]!.gas = createMiasmaOverlay();
    tiles[4]![5]!.gas = createMiasmaOverlay();
    tiles[4]![6]!.gas = createMiasmaOverlay();

    // Cracked & Spikes symmetrically placed
    tiles[3]![3] = createTile('CRACKED');
    tiles[5]![5] = createTile('CRACKED');
    tiles[2]![2]!.trap = createSpikesTrap('sp_1', 0);
    tiles[6]![6]!.trap = createSpikesTrap('sp_2', 0);
    tiles[2]![6]!.trap = createSpikesTrap('sp_3', 1);
    tiles[6]![2]!.trap = createSpikesTrap('sp_4', 1);
  } else {
    // Psychology & bridges arena
    tiles[3]![4] = createTile('CRACKED');
    tiles[5]![4] = createTile('CRACKED');
    tiles[4]![1] = createTile('ICE');
    tiles[4]![7] = createTile('ICE');
    tiles[4]![2]!.gas = createMiasmaOverlay();
    tiles[4]![6]!.gas = createMiasmaOverlay();
    tiles[3]![3]!.trap = createSpikesTrap('sp_a', 1);
    tiles[5]![5]!.trap = createSpikesTrap('sp_b', 1);
  }

  const verified = ensureMapConnectivity(
    tiles,
    [{ x: 4, y: height - 1 }],
    { x: 4, y: 0 },
  );

  const spec = V3_SKIRMISH_ROSTERS[rosterIdx % V3_SKIRMISH_ROSTERS.length]!;
  const baseRng = seedToRngState(`v3-arena::${seed}::${variant}`);
  // Mirror-fair identical rosters for both sides so paired matches isolate AI skill cleanly
  const playerDep = deploySkirmishAiArmy(
    verified.tiles,
    width,
    height,
    cloneRosterWithPrefix(spec.roster, 'p'),
    baseRng,
    'PLAYER',
  );
  const enemyDep = deploySkirmishAiArmy(
    verified.tiles,
    width,
    height,
    cloneRosterWithPrefix(spec.roster, 'e'),
    baseRng,
    'ENEMY',
  );

  return createGameState({
    width,
    height,
    tiles: verified.tiles,
    pieces: [...playerDep.pieces, ...enemyDep.pieces],
    mode: 'SKIRMISH',
    turn: 'PLAYER',
    factions: { PLAYER: spec.faction, ENEMY: spec.faction },
    seed: `v3-game::${seed}`,
  });
}

/**
 * Generates diverse, fair, symmetric scenarios spanning classic Skirmish + V3 Dungeon/Psychology.
 */
export function buildArenaScenarios(): ArenaScenario[] {
  const scenarios: ArenaScenario[] = [];

  // 1) Classic symmetric Skirmish maps (identical army templates for pure AI skill signal)
  for (let i = 0; i < 4; i++) {
    const tmpl = SKIRMISH_AI_TEMPLATES[i]!;
    scenarios.push({
      id: `skirmish-${tmpl.id}`,
      label: `Skirmish (${tmpl.name})`,
      createInitialState: (seed) => {
        const map = generateSkirmishMap(i, seed);
        const rng = seedToRngState(`sk::${seed}::${i}`);
        const pDep = deploySkirmishAiArmy(
          map.tiles,
          map.width,
          map.height,
          buildRosterFromTemplate(tmpl, 'p'),
          rng,
          'PLAYER',
        );
        const eDep = deploySkirmishAiArmy(
          map.tiles,
          map.width,
          map.height,
          buildRosterFromTemplate(tmpl, 'e'),
          rng,
          'ENEMY',
        );
        return createGameState({
          width: map.width,
          height: map.height,
          tiles: map.tiles,
          pieces: [...pDep.pieces, ...eDep.pieces],
          mode: 'SKIRMISH',
          turn: 'PLAYER',
          factions: {
            PLAYER: tmpl.preferredFaction,
            ENEMY: tmpl.preferredFaction,
          },
          seed: `sk-game::${seed}::${i}`,
        });
      },
    });
  }

  // 2) V3 Chemistry & Psychology symmetric arenas (Saints, Chimera, Miasma, Plates, Cracked, Spikes)
  for (let i = 0; i < V3_SKIRMISH_ROSTERS.length; i++) {
    const spec = V3_SKIRMISH_ROSTERS[i]!;
    const variant: 'chemistry' | 'psychology' = i % 2 === 0 ? 'chemistry' : 'psychology';
    scenarios.push({
      id: `v3-${variant}-${spec.id}`,
      label: `V3 ${variant} (${spec.id})`,
      createInitialState: (seed) => buildSymmetricV3DungeonState(seed, i, variant),
    });
  }

  return scenarios;
}

export function makeSucsBot(
  name: string,
  difficulty: AiDifficulty,
  overrides: Partial<SucsAiOptions> = {},
): ArenaBot {
  return {
    name,
    choose: (visible, memory, aiSide, rngState) =>
      chooseSucsAction(visible, memory, {
        difficulty,
        aiSide,
        rngState,
        ...overrides,
      }),
  };
}

function createEmptyBotStats(): BotStats {
  return {
    moves: 0,
    totalNodes: 0,
    totalTtHits: 0,
    totalDepth: 0,
    totalMs: 0,
    timeouts: 0,
  };
}

function recordStats(stats: BotStats, dec: SucsAiDecision): void {
  stats.moves++;
  stats.totalNodes += dec.nodesSearched;
  stats.totalTtHits += dec.ttHits;
  stats.totalDepth += dec.completedDepth;
  stats.totalMs += dec.elapsedMs;
  if (dec.timedOut) stats.timeouts++;
}

const TRACKED_V3_EVENTS = new Set<GameEvent['type']>([
  'GAS_CHAIN_DETONATED',
  'PLATE_TRIGGERED',
  'PIECE_SKEWERED',
  'TILE_COLLAPSED',
  'PIECE_BREAKDOWN',
  'PIECE_DISOBEYED',
  'FAITH_ULTIMATE_TRIGGERED',
  'MADNESS_ULTIMATE_TRIGGERED',
  'BERSERK_CHAIN_TRIGGERED',
  'CHIMERA_EVOLVED',
  'PIECE_FROZEN',
  'PIECE_PUSHED',
  'PIECE_FELL_IN_PIT',
]);

export function playSingleGame(
  initialState: GameState,
  playerBot: ArenaBot,
  enemyBot: ArenaBot,
  maxPlies = 140,
): {
  winner: Side | 'DRAW';
  reason: string;
  plies: number;
  v3Events: Record<string, number>;
  playerStats: BotStats;
  enemyStats: BotStats;
} {
  let state = initialState;
  let memPlayer = createAiMemory();
  let memEnemy = createAiMemory();
  let rngPlayer = seedToRngState(`${initialState.rngState}:P`);
  let rngEnemy = seedToRngState(`${initialState.rngState}:E`);

  const playerStats = createEmptyBotStats();
  const enemyStats = createEmptyBotStats();
  const v3Events: Record<string, number> = {};
  let endReason = 'MAX_PLIES_DRAW';
  let plies = 0;

  while (state.winner === null && plies < maxPlies) {
    const side = state.turn;
    // Strict Zero-Fog-Cheating contract: bots ONLY receive getVisibleState(state, side)
    const visible = getVisibleState(state, side);
    const decision =
      side === 'PLAYER'
        ? playerBot.choose(visible, memPlayer, 'PLAYER', rngPlayer)
        : enemyBot.choose(visible, memEnemy, 'ENEMY', rngEnemy);

    if (side === 'PLAYER') {
      memPlayer = decision.memory;
      rngPlayer = decision.nextRngState;
      recordStats(playerStats, decision);
    } else {
      memEnemy = decision.memory;
      rngEnemy = decision.nextRngState;
      recordStats(enemyStats, decision);
    }

    let step = stepGame(state, decision.action);
    if (
      step.error !== undefined ||
      (step.events.length === 1 && step.events[0]?.type === 'PIECE_DISOBEYED')
    ) {
      if (step.events[0]?.type === 'PIECE_DISOBEYED') {
        v3Events['PIECE_DISOBEYED'] = (v3Events['PIECE_DISOBEYED'] ?? 0) + 1;
      }
      step = stepGame(state, { type: 'END_TURN' });
    }

    for (let i = 0; i < step.events.length; i++) {
      const ev = step.events[i]!;
      if (TRACKED_V3_EVENTS.has(ev.type)) {
        v3Events[ev.type] = (v3Events[ev.type] ?? 0) + 1;
      }
      if (ev.type === 'MATCH_ENDED') {
        endReason = ev.reason;
      }
    }

    state = step.nextState;
    plies++;
  }

  return {
    winner: state.winner ?? 'DRAW',
    reason: endReason,
    plies,
    v3Events,
    playerStats,
    enemyStats,
  };
}

function mergeStats(dst: BotStats, src: BotStats): void {
  dst.moves += src.moves;
  dst.totalNodes += src.totalNodes;
  dst.totalTtHits += src.totalTtHits;
  dst.totalDepth += src.totalDepth;
  dst.totalMs += src.totalMs;
  dst.timeouts += src.timeouts;
}

/**
 * Computes Elo difference, 95% confidence margin, and Pentanomial/Trinomial SPRT LLR
 * (H0: elo0 = 0, H1: elo1 = 35, alpha = beta = 0.05).
 */
export function computeEloReport(
  winsA: number,
  draws: number,
  winsB: number,
  elo0 = 0,
  elo1 = 35,
): EloReport {
  const n = winsA + draws + winsB;
  if (n === 0) {
    return {
      scoreRateA: 0.5,
      eloDiff: 0,
      eloError95: 0,
      sprtLlr: 0,
      sprtDecision: 'INCONCLUSIVE',
    };
  }

  const pW = winsA / n;
  const pD = draws / n;
  const score = pW + 0.5 * pD;
  const clamped = Math.max(0.001, Math.min(0.999, score));
  const eloDiff = -400 * Math.log10(1 / clamped - 1);

  const variance =
    (winsA * Math.pow(1 - score, 2) +
      draws * Math.pow(0.5 - score, 2) +
      winsB * Math.pow(0 - score, 2)) /
    n;
  const stdErr = Math.sqrt(variance / n);
  const lo = Math.max(0.001, Math.min(0.999, score - 1.96 * stdErr));
  const hi = Math.max(0.001, Math.min(0.999, score + 1.96 * stdErr));
  const eloLo = -400 * Math.log10(1 / lo - 1);
  const eloHi = -400 * Math.log10(1 / hi - 1);
  const eloError95 = (eloHi - eloLo) / 2;

  // Normal-approximation SPRT LLR on expected score
  const s0 = 1 / (1 + Math.pow(10, -elo0 / 400));
  const s1 = 1 / (1 + Math.pow(10, -elo1 / 400));
  const safeVar = Math.max(1e-6, variance);
  const sprtLlr = (n * (s1 - s0) * (2 * score - s0 - s1)) / (2 * safeVar);
  const bound = Math.log(0.95 / 0.05); // ~2.944
  const sprtDecision =
    sprtLlr >= bound ? 'ACCEPT_H1' : sprtLlr <= -bound ? 'ACCEPT_H0' : 'INCONCLUSIVE';

  return {
    scoreRateA: score,
    eloDiff,
    eloError95,
    sprtLlr,
    sprtDecision,
  };
}

export function runPairedArenaMatch(
  botA: ArenaBot,
  botB: ArenaBot,
  pairs: number,
  options: { maxPlies?: number; seedPrefix?: string; verbose?: boolean } = {},
): MatchTelemetry {
  const scenarios = buildArenaScenarios();
  const maxPlies = options.maxPlies ?? 140;
  const seedPrefix = options.seedPrefix ?? 'sucs-arena';

  const telemetry: MatchTelemetry = {
    totalGames: 0,
    winsA: 0,
    winsB: 0,
    draws: 0,
    totalPlies: 0,
    endReasons: {},
    v3Events: {},
    statsA: createEmptyBotStats(),
    statsB: createEmptyBotStats(),
  };

  for (let p = 0; p < pairs; p++) {
    const scenario = scenarios[p % scenarios.length]!;
    const seed = `${seedPrefix}::pair-${p}`;

    // Game 1: A = PLAYER, B = ENEMY
    const g1 = playSingleGame(scenario.createInitialState(seed), botA, botB, maxPlies);
    telemetry.totalGames++;
    telemetry.totalPlies += g1.plies;
    if (g1.winner === 'PLAYER') telemetry.winsA++;
    else if (g1.winner === 'ENEMY') telemetry.winsB++;
    else telemetry.draws++;
    telemetry.endReasons[g1.reason] = (telemetry.endReasons[g1.reason] ?? 0) + 1;
    mergeStats(telemetry.statsA, g1.playerStats);
    mergeStats(telemetry.statsB, g1.enemyStats);
    for (const [k, v] of Object.entries(g1.v3Events)) {
      telemetry.v3Events[k] = (telemetry.v3Events[k] ?? 0) + v;
    }

    // Game 2: B = PLAYER, A = ENEMY (swapped colors on exact same map & seed)
    const g2 = playSingleGame(scenario.createInitialState(seed), botB, botA, maxPlies);
    telemetry.totalGames++;
    telemetry.totalPlies += g2.plies;
    if (g2.winner === 'ENEMY') telemetry.winsA++;
    else if (g2.winner === 'PLAYER') telemetry.winsB++;
    else telemetry.draws++;
    telemetry.endReasons[g2.reason] = (telemetry.endReasons[g2.reason] ?? 0) + 1;
    mergeStats(telemetry.statsB, g2.playerStats);
    mergeStats(telemetry.statsA, g2.enemyStats);
    for (const [k, v] of Object.entries(g2.v3Events)) {
      telemetry.v3Events[k] = (telemetry.v3Events[k] ?? 0) + v;
    }

    if (options.verbose) {
      const r1 = g1.winner === 'PLAYER' ? 'A' : g1.winner === 'ENEMY' ? 'B' : 'D';
      const r2 = g2.winner === 'ENEMY' ? 'A' : g2.winner === 'PLAYER' ? 'B' : 'D';
      console.log(
        `  Pair ${String(p + 1).padStart(2, ' ')}/${pairs} [${scenario.id}] -> ${r1}/${r2} (${g1.plies}/${g2.plies} plies) | Score A: +${telemetry.winsA} =${telemetry.draws} -${telemetry.winsB}`,
      );
    }
  }

  return telemetry;
}

export interface BenchmarkPosition {
  id: string;
  state: GameState;
  aiSide: Side;
}

/**
 * Deterministic 6-position suite covering Act 1–4 + V3 Chemistry + Mid-board Tactical Clashes.
 */
export function buildBenchmarkPositions(): BenchmarkPosition[] {
  const positions: BenchmarkPosition[] = [];

  // 1. Act 1 Skirmish mid-clash
  {
    const map = generateSkirmishMap(1, 'bench-sk-1');
    const pPieces: Piece[] = [
      { id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 4, y: 7 }, traits: ['SHIELDED'], shieldActive: true, frozenTurns: 0, hasMoved: false, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'pq', side: 'PLAYER', type: 'QUEEN', pos: { x: 3, y: 5 }, traits: [], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 6, y: 5 }, traits: ['PUSHER'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'pn', side: 'PLAYER', type: 'KNIGHT', pos: { x: 2, y: 4 }, traits: ['FROST_TOUCH'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'pp', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 5 }, traits: ['SCOUT'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
    ];
    const ePieces: Piece[] = [
      { id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 }, traits: ['SHIELDED'], shieldActive: true, frozenTurns: 0, hasMoved: false, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'eq', side: 'ENEMY', type: 'QUEEN', pos: { x: 5, y: 2 }, traits: [], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 2, y: 2 }, traits: ['PUSHER'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'en', side: 'ENEMY', type: 'KNIGHT', pos: { x: 6, y: 3 }, traits: ['DASH_ON_REVEAL'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
      { id: 'ep', side: 'ENEMY', type: 'PAWN', pos: { x: 4, y: 2 }, traits: ['EXPLOSIVE'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
    ];
    // Ensure squares occupied by pieces are walkable
    for (const pc of [...pPieces, ...ePieces]) {
      const t = map.tiles[pc.pos.y]![pc.pos.x]!;
      if (t.type === 'WALL' || t.type === 'PIT') map.tiles[pc.pos.y]![pc.pos.x] = createTile('PLAIN');
    }
    positions.push({
      id: 'skirmish-clash',
      aiSide: 'ENEMY',
      state: createGameState({
        width: map.width,
        height: map.height,
        tiles: map.tiles,
        pieces: [...pPieces, ...ePieces],
        mode: 'SKIRMISH',
        turn: 'ENEMY',
        factions: { PLAYER: 'FROST_WARDENS', ENEMY: 'RAIDERS' },
        seed: 'bench-sk-clash',
      }),
    });
  }

  // 2. V3 Dungeon Chemistry mid-clash (Miasma + Plates + Arrows + Spikes + Cracked)
  {
    const base = buildSymmetricV3DungeonState('bench-chem', 0, 'chemistry');
    const shifted = base.pieces.map((p) => {
      const ny = p.side === 'PLAYER' ? Math.max(5, p.pos.y - 2) : Math.min(3, p.pos.y + 2);
      const t = base.tiles[ny]?.[p.pos.x];
      const ok = t !== undefined && t.type !== 'WALL' && t.type !== 'PIT';
      return ok ? { ...p, pos: { x: p.pos.x, y: ny }, hasMoved: true } : p;
    });
    // Avoid collisions after shifting
    const occupied = new Set<string>();
    const deduped: Piece[] = [];
    for (const p of shifted) {
      const key = `${p.pos.x},${p.pos.y}`;
      if (!occupied.has(key)) {
        occupied.add(key);
        deduped.push(p);
      }
    }
    positions.push({
      id: 'v3-chemistry-clash',
      aiSide: 'ENEMY',
      state: createGameState({
        width: base.width,
        height: base.height,
        tiles: base.tiles,
        pieces: deduped,
        mode: 'SKIRMISH',
        turn: 'ENEMY',
        factions: base.factions,
        seed: 'bench-chem-clash',
      }),
    });
  }

  // 3. Act 3 Boss (Saints + Chimera + Psychology + Spikes + Miasma)
  {
    const enc = buildCampaignEncounterById('act3-boss', {
      seed: 'bench-act3',
      roster: [
        { id: 'p_k', type: 'KING', traits: ['SHIELDED'] },
        { id: 'p_q', type: 'QUEEN', traits: [] },
        { id: 'p_sf', type: 'SAINT_FAITH', traits: [] },
        { id: 'p_r', type: 'ROOK', traits: ['PUSHER'] },
        { id: 'p_n', type: 'KNIGHT', traits: ['FROST_TOUCH'] },
        { id: 'p_p1', type: 'PAWN', traits: ['SCOUT'] },
      ],
      playerFaction: 'RAIDERS',
      shieldAllNextBattle: false,
      activePacts: [],
    });
    for (const p of enc.state.pieces) {
      p.aggro = 'ACTIVE';
      if (p.type === 'CHIMERA') {
        p.absorbedForms = [
          { sourceType: 'KNIGHT', copiedTraits: ['FROST_TOUCH'] },
          { sourceType: 'ROOK', copiedTraits: [] },
        ];
        p.pos = { x: 4, y: 3 };
        const t = enc.state.tiles[3]![4]!;
        if (t.type === 'WALL' || t.type === 'PIT') enc.state.tiles[3]![4] = createTile('PLAIN');
      }
    }
    // Clear any collision on (4,3)
    enc.state.pieces = enc.state.pieces.filter(
      (p) => p.type === 'CHIMERA' || !(p.pos.x === 4 && p.pos.y === 3),
    );
    enc.state.turn = 'ENEMY';
    positions.push({
      id: 'act3-boss-chimera',
      aiSide: 'ENEMY',
      state: createGameState({
        width: enc.state.width,
        height: enc.state.height,
        tiles: enc.state.tiles,
        pieces: enc.state.pieces,
        mode: 'SKIRMISH',
        turn: 'ENEMY',
        factions: enc.state.factions,
        seed: 'bench-act3-boss',
      }),
    });
  }

  // 4. Act 2 Boss (KİMYAGER-OS)
  {
    const enc = buildCampaignEncounterById('act2-boss', {
      seed: 'bench-act2',
      roster: [
        { id: 'p_k', type: 'KING', traits: ['SHIELDED'] },
        { id: 'p_r', type: 'ROOK', traits: ['PUSHER'] },
        { id: 'p_b', type: 'BISHOP', traits: ['EXPLOSIVE'] },
        { id: 'p_n', type: 'KNIGHT', traits: [] },
        { id: 'p_p1', type: 'PAWN', traits: ['SCOUT'] },
        { id: 'p_p2', type: 'PAWN', traits: [] },
      ],
      playerFaction: 'SIEGE_ENGINEERS',
      shieldAllNextBattle: false,
      activePacts: [],
    });
    for (const p of enc.state.pieces) p.aggro = 'ACTIVE';
    positions.push({
      id: 'act2-boss-fog',
      aiSide: 'ENEMY',
      state: createGameState({
        width: enc.state.width,
        height: enc.state.height,
        tiles: enc.state.tiles,
        pieces: enc.state.pieces,
        mode: 'SKIRMISH',
        turn: 'ENEMY',
        factions: enc.state.factions,
        seed: 'bench-act2-boss',
      }),
    });
  }

  // 5. Dense tactical endgame (King + Queen + Chimera + Saints + Composure=1)
  {
    const tiles = createEmptyTiles(8, 8, 'PLAIN');
    tiles[3]![3] = createTile('ICE');
    tiles[3]![4] = createTile('PIT');
    tiles[4]![3] = createTile('CRACKED');
    tiles[4]![4] = createTile('PLAIN');
    tiles[4]![4]!.trap = createSpikesTrap('sp_end', 1);
    tiles[2]![5]!.gas = createMiasmaOverlay();
    tiles[3]![5]!.gas = createMiasmaOverlay();
    positions.push({
      id: 'v3-tactical-endgame',
      aiSide: 'ENEMY',
      state: createGameState({
        width: 8,
        height: 8,
        tiles,
        pieces: [
          { id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 1, y: 1 }, traits: ['SHIELDED'], shieldActive: true, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
          { id: 'ec', side: 'ENEMY', type: 'CHIMERA', pos: { x: 4, y: 2 }, traits: [], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false, absorbedForms: [{ sourceType: 'QUEEN', copiedTraits: ['PUSHER'] }] },
          { id: 'es', side: 'ENEMY', type: 'SAINT_MADNESS', pos: { x: 2, y: 2 }, traits: [], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
          { id: 'ep', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 2 }, traits: ['EXPLOSIVE'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false, madnessCharge: 2 },
          { id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 5, y: 6 }, traits: ['SHIELDED'], shieldActive: true, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
          { id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 4, y: 5 }, traits: ['FROST_TOUCH'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false, composure: 1 },
          { id: 'ps', side: 'PLAYER', type: 'SAINT_FAITH', pos: { x: 6, y: 5 }, traits: [], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false, faithCharge: 2 },
          { id: 'pn', side: 'PLAYER', type: 'KNIGHT', pos: { x: 2, y: 5 }, traits: ['PUSHER'], shieldActive: false, frozenTurns: 0, hasMoved: true, aggro: 'ACTIVE', usedDashThisTurn: false, wasVisibleAtTurnStart: false },
        ],
        mode: 'SKIRMISH',
        turn: 'ENEMY',
        factions: { PLAYER: 'FROST_WARDENS', ENEMY: 'NECROMANCERS' },
        seed: 'bench-endgame',
      }),
    });
  }

  return positions;
}

export function runSpeedBenchmark(
  botFactory: (opts: SucsAiOptions) => (visible: VisibleState, mem: AiMemory) => SucsAiDecision = (
    opts,
  ) => (v, m) => chooseSucsAction(v, m, opts),
  budgetMs = 220,
  fixedDepth = 3,
): void {
  const positions = buildBenchmarkPositions();

  console.log(`\n=== S.U.C.S. Fixed-Depth Benchmark (Depth ${fixedDepth}, PANIC, budget 10s) ===`);
  let totalFixedNodes = 0;
  let totalFixedMs = 0;
  let totalFixedTt = 0;

  for (const pos of positions) {
    const visible = getVisibleState(pos.state, pos.aiSide);
    const fn = botFactory({
      difficulty: 'PANIC',
      aiSide: pos.aiSide,
      maxDepth: fixedDepth,
      timeBudgetMs: 10000,
      rngState: 42,
    });
    const dec = fn(visible, createAiMemory());
    totalFixedNodes += dec.nodesSearched;
    totalFixedMs += dec.elapsedMs;
    totalFixedTt += dec.ttHits;
    const nps = dec.elapsedMs > 0 ? Math.round((dec.nodesSearched / dec.elapsedMs) * 1000) : 0;
    console.log(
      `  ${pos.id.padEnd(22)} | D${dec.completedDepth} | ${String(dec.nodesSearched).padStart(7)} nodes | ${String(dec.ttHits).padStart(5)} TT | ${String(Math.round(dec.elapsedMs)).padStart(5)} ms | ${String(nps).padStart(7)} nps | score=${dec.score}`,
    );
  }
  const avgFixedNps = totalFixedMs > 0 ? Math.round((totalFixedNodes / totalFixedMs) * 1000) : 0;
  console.log(
    `  TOTAL (D${fixedDepth})             |    | ${String(totalFixedNodes).padStart(7)} nodes | ${String(totalFixedTt).padStart(5)} TT | ${String(Math.round(totalFixedMs)).padStart(5)} ms | ${String(avgFixedNps).padStart(7)} nps`,
  );

  console.log(`\n=== S.U.C.S. Real-Time Budget Benchmark (${budgetMs}ms, PANIC, maxDepth 8) ===`);
  let sumDepth = 0;
  let sumNodes = 0;
  let sumMs = 0;
  let sumTt = 0;
  for (const pos of positions) {
    const visible = getVisibleState(pos.state, pos.aiSide);
    const fn = botFactory({
      difficulty: 'PANIC',
      aiSide: pos.aiSide,
      maxDepth: 8,
      timeBudgetMs: budgetMs,
      rngState: 42,
    });
    const dec = fn(visible, createAiMemory());
    sumDepth += dec.completedDepth;
    sumNodes += dec.nodesSearched;
    sumMs += dec.elapsedMs;
    sumTt += dec.ttHits;
    const nps = dec.elapsedMs > 0 ? Math.round((dec.nodesSearched / dec.elapsedMs) * 1000) : 0;
    console.log(
      `  ${pos.id.padEnd(22)} | D${dec.completedDepth} | ${String(dec.nodesSearched).padStart(7)} nodes | ${String(dec.ttHits).padStart(5)} TT | ${String(Math.round(dec.elapsedMs)).padStart(5)} ms | ${String(nps).padStart(7)} nps | ${dec.tacticalTag ?? ''}`,
    );
  }
  const avgNps = sumMs > 0 ? Math.round((sumNodes / sumMs) * 1000) : 0;
  console.log(
    `  AVERAGE (${budgetMs}ms)        | D${(sumDepth / positions.length).toFixed(2)} | ${String(Math.round(sumNodes / positions.length)).padStart(7)} nodes | ${String(Math.round(sumTt / positions.length)).padStart(5)} TT | ${String(Math.round(sumMs / positions.length)).padStart(5)} ms | ${String(avgNps).padStart(7)} nps`,
  );
}

export function printMatchSummary(botAName: string, botBName: string, t: MatchTelemetry): void {
  const elo = computeEloReport(t.winsA, t.draws, t.winsB);
  const avgPlies = t.totalGames > 0 ? (t.totalPlies / t.totalGames).toFixed(1) : '0';
  const fmtBot = (name: string, s: BotStats): string => {
    const avgD = s.moves > 0 ? (s.totalDepth / s.moves).toFixed(2) : '0';
    const avgMs = s.moves > 0 ? (s.totalMs / s.moves).toFixed(1) : '0';
    const nps = s.totalMs > 0 ? Math.round((s.totalNodes / s.totalMs) * 1000) : 0;
    const ttPct = s.totalNodes > 0 ? ((s.totalTtHits / s.totalNodes) * 100).toFixed(1) : '0';
    return `  ${name.padEnd(18)} | moves=${s.moves} | avgD=${avgD} | ${nps} nps | TT=${ttPct}% | avg=${avgMs}ms`;
  };

  console.log(`\n=== Match Result: ${botAName} vs ${botBName} (${t.totalGames} games) ===`);
  console.log(
    `  Score (${botAName}): +${t.winsA} =${t.draws} -${t.winsB} (${(elo.scoreRateA * 100).toFixed(1)}%) | avg plies=${avgPlies}`,
  );
  console.log(
    `  Elo diff: ${elo.eloDiff >= 0 ? '+' : ''}${elo.eloDiff.toFixed(1)} ± ${elo.eloError95.toFixed(1)} (95% CI) | SPRT LLR=${elo.sprtLlr.toFixed(2)} [${elo.sprtDecision}]`,
  );
  console.log(fmtBot(botAName, t.statsA));
  console.log(fmtBot(botBName, t.statsB));
  console.log('  End reasons:', t.endReasons);
  console.log('  V3 mechanics triggered:', t.v3Events);
}

function parseArg(args: readonly string[], key: string, fallback: string): string {
  const prefix = `--${key}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

function parseDifficulty(raw: string): AiDifficulty {
  const up = raw.toUpperCase();
  if (up === 'CALM' || up === 'TENSE' || up === 'PANIC') return up;
  return 'PANIC';
}

// CLI entrypoint (works under vite-node, tsx, or node)
const arenaArgIdx =
  typeof process !== 'undefined'
    ? process.argv.findIndex((a) => a.endsWith('arena.ts') || a.endsWith('arena.js'))
    : -1;
const isMain = arenaArgIdx !== -1 && (process.argv[arenaArgIdx + 1] !== '__imported__');

if (isMain) {
  const args = process.argv.slice(arenaArgIdx + 1);
  const cmd = args[0] ?? 'bench';

  if (cmd === 'bench') {
    const budget = Number(parseArg(args, 'budget', '220'));
    const depth = Number(parseArg(args, 'depth', '3'));
    runSpeedBenchmark(undefined, budget, depth);
  } else if (cmd === 'match') {
    const diffA = parseDifficulty(parseArg(args, 'a', 'PANIC'));
    const diffB = parseDifficulty(parseArg(args, 'b', 'TENSE'));
    const pairs = Math.max(1, Number(parseArg(args, 'pairs', '6')));
    const budgetA = Number(parseArg(args, 'budgetA', '120'));
    const budgetB = Number(parseArg(args, 'budgetB', '120'));
    const maxPlies = Number(parseArg(args, 'maxPlies', '120'));

    const botA = makeSucsBot(`${diffA}@${budgetA}ms`, diffA, { timeBudgetMs: budgetA });
    const botB = makeSucsBot(`${diffB}@${budgetB}ms`, diffB, { timeBudgetMs: budgetB });

    console.log(
      `Running ${pairs} paired games (${pairs * 2} total) — ${botA.name} vs ${botB.name} (strict VisibleState)...`,
    );
    const res = runPairedArenaMatch(botA, botB, pairs, { maxPlies, verbose: true });
    printMatchSummary(botA.name, botB.name, res);
  } else {
    console.log('Usage:');
    console.log('  npx vite-node scripts/arena.ts bench [--budget=220] [--depth=3]');
    console.log(
      '  npx vite-node scripts/arena.ts match [--a=PANIC] [--b=TENSE] [--pairs=8] [--budgetA=120] [--budgetB=120]',
    );
  }
}

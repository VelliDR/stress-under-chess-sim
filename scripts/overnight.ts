import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  buildMovementAwareBelief,
  type BeliefModelWeights,
} from '../src/ai/beliefModel';
import { createAiMemory, type AiMemory } from '../src/ai/campaignAi';
import {
  clampEvalWeights,
  type SucsEvalWeights,
} from '../src/ai/evalWeights';
import {
  evaluateTinyMlp,
  NN_HIDDEN_DIM,
  NN_INPUT_DIM,
  type TinyMlpModel,
} from '../src/ai/nnEval';
import {
  ALL_SKIRMISH_AI_TEMPLATES,
  buildRosterFromTemplate,
  deploySkirmishAiArmy,
} from '../src/ai/skirmishAi';
import { evaluateVisiblePositionForTraining } from '../src/ai/sucsAi';
import {
  TRAINED_BELIEF_WEIGHTS,
  TRAINED_EVAL_WEIGHTS,
  TRAINED_MLP_MODEL,
} from '../src/ai/trainedModels';
import {
  buildCampaignEncounterById,
  generateSkirmishMap,
} from '../src/data/encounters';
import { opponentOf } from '../src/engine/board';
import { nextRng, seedToRngState } from '../src/engine/prng';
import { canPieceAttackSquare } from '../src/engine/psychology';
import { createGameState, stepGame } from '../src/engine/reducer';
import type {
  Coord,
  GameEvent,
  GameState,
  Side,
  VisibleState,
} from '../src/engine/types';
import { getVisibleState } from '../src/engine/visibility';
import {
  buildArenaScenarios,
  computeEloReport,
  makeSucsBot,
  playSingleGame,
  type ArenaBot,
} from './arena';

interface EvalRecord {
  g: number;
  sc: string;
  f: number[];
  l: number;
  s: number;
  o: number;
}

interface BeliefRecord {
  g: number;
  vis: VisibleState;
  mem: AiMemory;
  side: Side;
  threats: Coord[];
}

interface BatchTelemetry {
  games: number;
  plies: number;
  playerWins: number;
  enemyWins: number;
  draws: number;
  endReasons: Record<string, number>;
  v3Events: Record<string, number>;
}

interface SelfPlayShardOutput {
  workerId: number;
  batchIndex: number;
  telemetry: BatchTelemetry;
  evalRecords: EvalRecord[];
  beliefRecords: BeliefRecord[];
}

interface MatchWorkerConfig {
  botA: {
    name: string;
    difficulty: 'CALM' | 'TENSE' | 'PANIC';
    budgetMs: number;
    maxDepth: number;
    weights: SucsEvalWeights;
    beliefWeights: BeliefModelWeights;
    mlpModel: TinyMlpModel;
  };
  botB: {
    name: string;
    difficulty: 'CALM' | 'TENSE' | 'PANIC';
    budgetMs: number;
    maxDepth: number;
    weights: SucsEvalWeights;
    beliefWeights: BeliefModelWeights;
    mlpModel: TinyMlpModel;
  };
  pairIndices: number[];
  maxPlies: number;
  seedPrefix: string;
}

interface MatchWorkerResult {
  winsA: number;
  winsB: number;
  draws: number;
  totalGames: number;
  totalPlies: number;
  endReasons: Record<string, number>;
  v3Events: Record<string, number>;
  movesA: number;
  nodesA: number;
  depthA: number;
  msA: number;
  ttA: number;
  movesB: number;
  nodesB: number;
  depthB: number;
  msB: number;
  ttB: number;
}

const TRACKED_EVENTS = new Set<GameEvent['type']>([
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

const CAMPAIGN_TRAINING_ROOMS = [
  'glacial-pass',
  'bone-plains',
  'siege-wall',
  'act2-2',
  'act2-3',
  'act2-4',
  'act2-boss',
  'act3-2',
  'act3-3',
  'act3-4',
  'act3-boss',
  'act4-core',
] as const;

function sigmoid(x: number): number {
  if (x >= 20) return 1 - 1e-9;
  if (x <= -20) return 1e-9;
  return 1 / (1 + Math.exp(-x));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function cloneMemory(m: AiMemory): AiMemory {
  const copy: AiMemory = {
    lastKnownPositions: {},
    recentSelfMoves: m.recentSelfMoves?.map((mv) => ({
      pieceId: mv.pieceId,
      from: { x: mv.from.x, y: mv.from.y },
      to: { x: mv.to.x, y: mv.to.y },
    })),
  };
  for (const [k, v] of Object.entries(m.lastKnownPositions)) {
    copy.lastKnownPositions[k] = {
      pieceId: v.pieceId,
      pos: { x: v.pos.x, y: v.pos.y },
      type: v.type,
      lastSeenTurn: v.lastSeenTurn,
    };
  }
  return copy;
}

function computeGroundTruthHiddenThreats(
  fullState: GameState,
  visible: VisibleState,
  aiSide: Side,
): Coord[] {
  const oppSide = opponentOf(aiSide);
  const visibleIds = new Set(visible.pieces.map((p) => p.id));
  const hiddenEnemies = fullState.pieces.filter(
    (p) => p.side === oppSide && !visibleIds.has(p.id),
  );
  if (hiddenEnemies.length === 0) return [];

  const coords: Coord[] = [];
  const seen = new Set<number>();
  for (let y = 0; y < fullState.height; y++) {
    for (let x = 0; x < fullState.width; x++) {
      const c: Coord = { x, y };
      for (let e = 0; e < hiddenEnemies.length; e++) {
        const enemy = hiddenEnemies[e]!;
        if (
          (enemy.pos.x === x && enemy.pos.y === y) ||
          canPieceAttackSquare(fullState, enemy, c)
        ) {
          const key = y * fullState.width + x;
          if (!seen.has(key)) {
            seen.add(key);
            coords.push(c);
          }
          break;
        }
      }
    }
  }
  return coords;
}

/**
 * Builds an ultra-diverse initial state spanning symmetric Classic/V3 arenas,
 * asymmetric V3 Skirmish template clashes, and active V3 Campaign Act 2–4 rooms.
 */
function buildDiverseTrainingState(gameIndex: number, seed: string): {
  scenarioId: string;
  state: GameState;
} {
  const baseScenarios = buildArenaScenarios();
  const modeRoll = gameIndex % 10;

  // 50% symmetric Classic + V3 arenas (8 templates)
  if (modeRoll < 5) {
    const sc = baseScenarios[gameIndex % baseScenarios.length]!;
    return { scenarioId: sc.id, state: sc.createInitialState(seed) };
  }

  // 30% asymmetric 20-point Skirmish clashes across ALL 8 Classic + V3 templates
  if (modeRoll < 8) {
    const tA = ALL_SKIRMISH_AI_TEMPLATES[gameIndex % ALL_SKIRMISH_AI_TEMPLATES.length]!;
    const tB = ALL_SKIRMISH_AI_TEMPLATES[(gameIndex * 3 + 5) % ALL_SKIRMISH_AI_TEMPLATES.length]!;
    const map = generateSkirmishMap(gameIndex % 3, seed);
    const rngA = seedToRngState(`${seed}::asymA`);
    const rngB = seedToRngState(`${seed}::asymB`);
    const depA = deploySkirmishAiArmy(
      map.tiles,
      map.width,
      map.height,
      buildRosterFromTemplate(tA, 'p'),
      rngA,
      'PLAYER',
    );
    const depB = deploySkirmishAiArmy(
      map.tiles,
      map.width,
      map.height,
      buildRosterFromTemplate(tB, 'e'),
      rngB,
      'ENEMY',
    );
    return {
      scenarioId: `asym-${tA.id}-vs-${tB.id}`,
      state: createGameState({
        width: map.width,
        height: map.height,
        tiles: map.tiles,
        pieces: [...depA.pieces, ...depB.pieces],
        mode: 'SKIRMISH',
        turn: 'PLAYER',
        factions: { PLAYER: tA.preferredFaction, ENEMY: tB.preferredFaction },
        seed: `${seed}::asym`,
      }),
    };
  }

  // 20% V3 Campaign dungeon rooms (Act 1-4) activated for rich trap/boss/chemistry training
  const roomId = CAMPAIGN_TRAINING_ROOMS[gameIndex % CAMPAIGN_TRAINING_ROOMS.length]!;
  const pTmpl = ALL_SKIRMISH_AI_TEMPLATES[(gameIndex + 4) % ALL_SKIRMISH_AI_TEMPLATES.length]!;
  const enc = buildCampaignEncounterById(roomId, {
    seed,
    roster: buildRosterFromTemplate(pTmpl, 'p'),
    playerFaction: pTmpl.preferredFaction,
    shieldAllNextBattle: false,
    activePacts: [],
  });
  for (let i = 0; i < enc.state.pieces.length; i++) {
    enc.state.pieces[i]!.aggro = 'ACTIVE';
  }
  enc.state.mode = 'SKIRMISH';
  return { scenarioId: `dungeon-${roomId}`, state: enc.state };
}

/**
 * WORKER MODE 1: Plays a batch of diverse mixed-league self-play games and writes compact shard JSON.
 */
function runSelfPlayWorker(
  workerId: number,
  batchIndex: number,
  startGameId: number,
  games: number,
  budgetMs: number,
  outFile: string,
): void {
  const telemetry: BatchTelemetry = {
    games: 0,
    plies: 0,
    playerWins: 0,
    enemyWins: 0,
    draws: 0,
    endReasons: {},
    v3Events: {},
  };
  const evalRecords: EvalRecord[] = [];
  const beliefRecords: BeliefRecord[] = [];

  for (let i = 0; i < games; i++) {
    const gameId = startGameId + i;
    const seed = `overnight-20261126::w${workerId}::b${batchIndex}::g${gameId}`;
    const { scenarioId, state: initialState } = buildDiverseTrainingState(gameId, seed);

    // Mixed League: 70% strong PANIC vs PANIC, 30% PANIC vs TENSE/CALM human-proxy opponents
    const isProxy = gameId % 10 >= 7;
    const proxyOnPlayer = isProxy && gameId % 2 === 0;
    const proxyDiff = gameId % 3 === 0 ? 'CALM' : 'TENSE';

    const botPlayer = makeSucsBot(
      proxyOnPlayer ? proxyDiff : 'PANIC',
      proxyOnPlayer ? proxyDiff : 'PANIC',
      {
        timeBudgetMs: proxyOnPlayer ? Math.round(budgetMs * 0.65) : budgetMs,
        maxDepth: proxyOnPlayer ? 3 : 5,
      },
    );
    const botEnemy = makeSucsBot(
      isProxy && !proxyOnPlayer ? proxyDiff : 'PANIC',
      isProxy && !proxyOnPlayer ? proxyDiff : 'PANIC',
      {
        timeBudgetMs: isProxy && !proxyOnPlayer ? Math.round(budgetMs * 0.65) : budgetMs,
        maxDepth: isProxy && !proxyOnPlayer ? 3 : 5,
      },
    );

    let state = initialState;
    let memP = createAiMemory();
    let memE = createAiMemory();
    let rngP = seedToRngState(`${seed}:P`);
    let rngE = seedToRngState(`${seed}:E`);

    const pendingEval: Array<{
      side: Side;
      f: number[];
      l: number;
      s: number;
    }> = [];

    let plies = 0;
    const maxPlies = 115;
    let endReason = 'MAX_PLIES_DRAW';

    while (state.winner === null && plies < maxPlies) {
      const side = state.turn;
      const visible = getVisibleState(state, side);
      const memBefore = side === 'PLAYER' ? memP : memE;

      const dec =
        side === 'PLAYER'
          ? botPlayer.choose(visible, memP, 'PLAYER', rngP)
          : botEnemy.choose(visible, memE, 'ENEMY', rngE);

      if (side === 'PLAYER') {
        memP = dec.memory;
        rngP = dec.nextRngState;
      } else {
        memE = dec.memory;
        rngE = dec.nextRngState;
      }

      // Sample every 2nd ply (ply >= 4) to maximize cross-game diversity & decorrelation
      if (plies >= 4 && plies % 2 === (gameId & 1) && Math.abs(dec.score) < 50_000) {
        const evalData = evaluateVisiblePositionForTraining(visible, memBefore, side);
        const oppKingVis = visible.pieces.some(
          (p) => p.side === opponentOf(side) && p.type === 'KING',
        );
        const normLinear = oppKingVis ? evalData.score : evalData.score - 10_000;
        const normSearch = oppKingVis ? dec.score : dec.score - 10_000;
        pendingEval.push({
          side,
          f: evalData.features.map(round3),
          l: Math.round(normLinear),
          s: Math.round(Math.max(-2500, Math.min(2500, normSearch))),
        });
      }

      // Sample compact ground-truth fog snapshots (~1-2 per game)
      if (
        plies >= 4 &&
        plies % 12 === (gameId % 12) &&
        (visible.silhouettes.length > 0 || Object.keys(memBefore.lastKnownPositions).length > 0)
      ) {
        const threats = computeGroundTruthHiddenThreats(state, visible, side);
        if (threats.length > 0) {
          beliefRecords.push({
            g: gameId,
            vis: visible,
            mem: cloneMemory(memBefore),
            side,
            threats,
          });
        }
      }

      let step = stepGame(state, dec.action);
      if (
        step.error !== undefined ||
        (step.events.length === 1 && step.events[0]?.type === 'PIECE_DISOBEYED')
      ) {
        if (step.events[0]?.type === 'PIECE_DISOBEYED') {
          telemetry.v3Events['PIECE_DISOBEYED'] = (telemetry.v3Events['PIECE_DISOBEYED'] ?? 0) + 1;
        }
        step = stepGame(state, { type: 'END_TURN' });
      }

      for (let eIdx = 0; eIdx < step.events.length; eIdx++) {
        const ev = step.events[eIdx]!;
        if (TRACKED_EVENTS.has(ev.type)) {
          telemetry.v3Events[ev.type] = (telemetry.v3Events[ev.type] ?? 0) + 1;
        }
        if (ev.type === 'MATCH_ENDED') {
          endReason = ev.reason;
        }
      }

      state = step.nextState;
      plies++;
    }

    const winner = state.winner ?? 'DRAW';
    telemetry.games++;
    telemetry.plies += plies;
    if (winner === 'PLAYER') telemetry.playerWins++;
    else if (winner === 'ENEMY') telemetry.enemyWins++;
    else telemetry.draws++;
    telemetry.endReasons[endReason] = (telemetry.endReasons[endReason] ?? 0) + 1;

    for (let k = 0; k < pendingEval.length; k++) {
      const rec = pendingEval[k]!;
      const outcome = winner === 'DRAW' ? 0.5 : winner === rec.side ? 1 : 0;
      evalRecords.push({
        g: gameId,
        sc: scenarioId,
        f: rec.f,
        l: rec.l,
        s: rec.s,
        o: outcome,
      });
    }
  }

  const out: SelfPlayShardOutput = {
    workerId,
    batchIndex,
    telemetry,
    evalRecords,
    beliefRecords,
  };
  fs.writeFileSync(outFile, JSON.stringify(out), 'utf8');
}

/**
 * WORKER MODE 2: Runs a slice of paired swapped-side Arena games for parallel SPSA & Elo gates.
 */
function runMatchWorker(configFile: string, outFile: string): void {
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')) as MatchWorkerConfig;
  const scenarios = buildArenaScenarios();

  const botA: ArenaBot = makeSucsBot(cfg.botA.name, cfg.botA.difficulty, {
    timeBudgetMs: cfg.botA.budgetMs,
    maxDepth: cfg.botA.maxDepth,
    weights: cfg.botA.weights,
    beliefWeights: cfg.botA.beliefWeights,
    mlpModel: cfg.botA.mlpModel,
  });
  const botB: ArenaBot = makeSucsBot(cfg.botB.name, cfg.botB.difficulty, {
    timeBudgetMs: cfg.botB.budgetMs,
    maxDepth: cfg.botB.maxDepth,
    weights: cfg.botB.weights,
    beliefWeights: cfg.botB.beliefWeights,
    mlpModel: cfg.botB.mlpModel,
  });

  const res: MatchWorkerResult = {
    winsA: 0,
    winsB: 0,
    draws: 0,
    totalGames: 0,
    totalPlies: 0,
    endReasons: {},
    v3Events: {},
    movesA: 0,
    nodesA: 0,
    depthA: 0,
    msA: 0,
    ttA: 0,
    movesB: 0,
    nodesB: 0,
    depthB: 0,
    msB: 0,
    ttB: 0,
  };

  for (const p of cfg.pairIndices) {
    const scenario = scenarios[p % scenarios.length]!;
    const seed = `${cfg.seedPrefix}::pair-${p}`;

    // Game 1: A=PLAYER, B=ENEMY
    const g1 = playSingleGame(scenario.createInitialState(seed), botA, botB, cfg.maxPlies);
    res.totalGames++;
    res.totalPlies += g1.plies;
    if (g1.winner === 'PLAYER') res.winsA++;
    else if (g1.winner === 'ENEMY') res.winsB++;
    else res.draws++;
    res.endReasons[g1.reason] = (res.endReasons[g1.reason] ?? 0) + 1;
    res.movesA += g1.playerStats.moves;
    res.nodesA += g1.playerStats.totalNodes;
    res.depthA += g1.playerStats.totalDepth;
    res.msA += g1.playerStats.totalMs;
    res.ttA += g1.playerStats.totalTtHits;
    res.movesB += g1.enemyStats.moves;
    res.nodesB += g1.enemyStats.totalNodes;
    res.depthB += g1.enemyStats.totalDepth;
    res.msB += g1.enemyStats.totalMs;
    res.ttB += g1.enemyStats.totalTtHits;
    for (const [k, v] of Object.entries(g1.v3Events)) {
      res.v3Events[k] = (res.v3Events[k] ?? 0) + v;
    }

    // Game 2: B=PLAYER, A=ENEMY
    const g2 = playSingleGame(scenario.createInitialState(seed), botB, botA, cfg.maxPlies);
    res.totalGames++;
    res.totalPlies += g2.plies;
    if (g2.winner === 'ENEMY') res.winsA++;
    else if (g2.winner === 'PLAYER') res.winsB++;
    else res.draws++;
    res.endReasons[g2.reason] = (res.endReasons[g2.reason] ?? 0) + 1;
    res.movesB += g2.playerStats.moves;
    res.nodesB += g2.playerStats.totalNodes;
    res.depthB += g2.playerStats.totalDepth;
    res.msB += g2.playerStats.totalMs;
    res.ttB += g2.playerStats.totalTtHits;
    res.movesA += g2.enemyStats.moves;
    res.nodesA += g2.enemyStats.totalNodes;
    res.depthA += g2.enemyStats.totalDepth;
    res.msA += g2.enemyStats.totalMs;
    res.ttA += g2.enemyStats.totalTtHits;
    for (const [k, v] of Object.entries(g2.v3Events)) {
      res.v3Events[k] = (res.v3Events[k] ?? 0) + v;
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(res), 'utf8');
}

function spawnChildScript(scriptPath: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const isTs = scriptPath.endsWith('.ts');
    const cmd = isTs ? path.resolve(process.cwd(), 'node_modules/.bin/vite-node') : process.execPath;
    const cmdArgs = isTs ? ['--script', scriptPath, ...args] : [scriptPath, ...args];
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      reject(new Error(`Worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Worker exited with code ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

async function runParallelPairedMatch(
  scriptPath: string,
  tmpDir: string,
  tag: string,
  workers: number,
  botA: MatchWorkerConfig['botA'],
  botB: MatchWorkerConfig['botB'],
  totalPairs: number,
  maxPlies: number,
  seedPrefix: string,
): Promise<MatchWorkerResult> {
  const numWorkers = Math.max(1, Math.min(workers, totalPairs));
  const buckets: number[][] = Array.from({ length: numWorkers }, () => []);
  for (let p = 0; p < totalPairs; p++) {
    buckets[p % numWorkers]!.push(p);
  }

  const jobs = buckets.map(async (pairIndices, idx) => {
    const cfgFile = path.join(tmpDir, `${tag}_cfg_${idx}.json`);
    const outFile = path.join(tmpDir, `${tag}_out_${idx}.json`);
    const cfg: MatchWorkerConfig = {
      botA,
      botB,
      pairIndices,
      maxPlies,
      seedPrefix,
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8');
    await spawnChildScript(
      scriptPath,
      ['worker-match', `--cfg=${cfgFile}`, `--out=${outFile}`],
      600_000,
    );
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8')) as MatchWorkerResult;
    try {
      fs.unlinkSync(cfgFile);
      fs.unlinkSync(outFile);
    } catch {
      // ignore
    }
    return data;
  });

  const parts = await Promise.all(jobs);
  const merged: MatchWorkerResult = {
    winsA: 0,
    winsB: 0,
    draws: 0,
    totalGames: 0,
    totalPlies: 0,
    endReasons: {},
    v3Events: {},
    movesA: 0,
    nodesA: 0,
    depthA: 0,
    msA: 0,
    ttA: 0,
    movesB: 0,
    nodesB: 0,
    depthB: 0,
    msB: 0,
    ttB: 0,
  };
  for (const p of parts) {
    merged.winsA += p.winsA;
    merged.winsB += p.winsB;
    merged.draws += p.draws;
    merged.totalGames += p.totalGames;
    merged.totalPlies += p.totalPlies;
    merged.movesA += p.movesA;
    merged.nodesA += p.nodesA;
    merged.depthA += p.depthA;
    merged.msA += p.msA;
    merged.ttA += p.ttA;
    merged.movesB += p.movesB;
    merged.nodesB += p.nodesB;
    merged.depthB += p.depthB;
    merged.msB += p.msB;
    merged.ttB += p.ttB;
    for (const [k, v] of Object.entries(p.endReasons)) {
      merged.endReasons[k] = (merged.endReasons[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(p.v3Events)) {
      merged.v3Events[k] = (merged.v3Events[k] ?? 0) + v;
    }
  }
  return merged;
}

function trainBeliefModelLarge(
  samples: readonly BeliefRecord[],
  initial: Readonly<BeliefModelWeights>,
  hardDeadlineMs: number,
): { bestWeights: BeliefModelWeights; baseScore: number; trainedScore: number } {
  if (samples.length < 20) {
    return { bestWeights: { ...initial }, baseScore: 0, trainedScore: 0 };
  }

  const scoreWeights = (w: BeliefModelWeights, subset: readonly BeliefRecord[]): number => {
    let totalLift = 0;
    let count = 0;
    for (let i = 0; i < subset.length; i++) {
      const s = subset[i]!;
      const { dangerGrid } = buildMovementAwareBelief(s.vis, s.mem, s.side, w);
      const threatSet = new Set<number>();
      for (let t = 0; t < s.threats.length; t++) {
        const c = s.threats[t]!;
        threatSet.add(c.y * s.vis.width + c.x);
      }
      let sumT = 0;
      let nT = 0;
      let sumS = 0;
      let nS = 0;
      for (let y = 0; y < s.vis.height; y++) {
        for (let x = 0; x < s.vis.width; x++) {
          const val = (dangerGrid[y]?.[x] ?? 0) / 240;
          if (threatSet.has(y * s.vis.width + x)) {
            sumT += val;
            nT++;
          } else {
            sumS += val;
            nS++;
          }
        }
      }
      if (nT > 0 && nS > 0) {
        const meanT = sumT / nT;
        const meanS = sumS / nS;
        // Scale-invariant normalized contrast prevents coordinate ascent from inflating all weights upward
        const denom = Math.max(0.05, meanT + meanS);
        totalLift += (meanT - meanS) / denom;
        count++;
      }
    }
    return count > 0 ? totalLift / count : 0;
  };

  const split = Math.floor(samples.length * 0.8);
  const trainSet = samples.slice(0, split);
  const valSet = samples.slice(split);

  const bounds: Record<keyof BeliefModelWeights, [number, number, number]> = {
    silhouetteCenterWeight: [35, 110, 8],
    silhouetteRing1Weight: [20, 80, 6],
    silhouetteRing2Weight: [6, 45, 5],
    memoryDecayPerTurn: [0.55, 0.94, 0.04],
    sniperRayWeight: [0.7, 2.0, 0.14],
    unexploredAmbushPrior: [1, 24, 3],
    ghostAmbushPenaltyRatio: [0.2, 0.5, 0.04],
  };

  let best: BeliefModelWeights = { ...initial };
  const baseVal = scoreWeights(best, valSet);
  let bestTrain = scoreWeights(best, trainSet);

  const keys: Array<keyof BeliefModelWeights> = [
    'silhouetteRing1Weight',
    'silhouetteRing2Weight',
    'memoryDecayPerTurn',
    'sniperRayWeight',
    'unexploredAmbushPrior',
  ];

  for (let pass = 0; pass < 3; pass++) {
    if (Date.now() >= hardDeadlineMs - 120_000) break;
    const scale = pass === 0 ? 1 : pass === 1 ? 0.5 : 0.25;
    for (const k of keys) {
      const [lo, hi, step] = bounds[k];
      const d = step * scale;
      for (const dir of [-1, 1]) {
        const cand: BeliefModelWeights = {
          ...best,
          [k]: Math.max(lo, Math.min(hi, Number((best[k] + dir * d).toFixed(3)))),
        };
        const sc = scoreWeights(cand, trainSet);
        if (sc > bestTrain + 1e-5) {
          best = cand;
          bestTrain = sc;
        }
      }
    }
  }

  const finalVal = scoreWeights(best, valSet);
  if (finalVal < baseVal) {
    return { bestWeights: { ...initial }, baseScore: baseVal, trainedScore: baseVal };
  }
  return { bestWeights: best, baseScore: baseVal, trainedScore: finalVal };
}

/**
 * Mini-batch Adam trainer for the 28 -> 20 (ClippedReLU) -> 1 Tiny MLP residual
 * over 100k+ self-play positions with strict game-grouped 85/15 train/val split.
 */
function trainTinyMlpMiniBatch(
  samples: readonly EvalRecord[],
  epochs: number,
  maxResidualCp: number,
  hardDeadlineMs: number,
): { model: TinyMlpModel; baseValLoss: number; bestValLoss: number; trainCount: number; valCount: number } {
  const scaleK = 420;
  // Deterministic game-grouped split: gameId % 20 >= 17 -> 15% validation
  const trainSet: EvalRecord[] = [];
  const valSet: EvalRecord[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    if (s.g % 20 >= 17) valSet.push(s);
    else trainSet.push(s);
  }
  if (valSet.length === 0 && trainSet.length > 10) {
    valSet.push(...trainSet.splice(Math.floor(trainSet.length * 0.85)));
  }

  const evalLoss = (ds: readonly EvalRecord[], model: TinyMlpModel): number => {
    if (ds.length === 0) return 0;
    const buf = new Float32Array(NN_INPUT_DIM);
    let loss = 0;
    for (let i = 0; i < ds.length; i++) {
      const s = ds[i]!;
      for (let f = 0; f < NN_INPUT_DIM; f++) buf[f] = s.f[f]!;
      const resCp = evaluateTinyMlp(buf, model);
      const pred = sigmoid((s.l + resCp) / scaleK);
      const target = 0.55 * s.o + 0.45 * sigmoid(s.s / scaleK);
      loss -= target * Math.log(pred) + (1 - target) * Math.log(1 - pred);
    }
    return loss / ds.length;
  };

  const zeroModel: TinyMlpModel = {
    enabled: false,
    maxResidualCp,
    w1: new Array<number>(NN_HIDDEN_DIM * NN_INPUT_DIM).fill(0),
    b1: new Array<number>(NN_HIDDEN_DIM).fill(0),
    w2: new Array<number>(NN_HIDDEN_DIM).fill(0),
    b2: 0,
  };
  const baseValLoss = evalLoss(valSet, zeroModel);

  let rng = seedToRngState('sucs-overnight-mlp-v2');
  const randU = (amp: number): number => {
    const r = nextRng(rng);
    rng = r.nextState;
    return (r.value * 2 - 1) * amp;
  };

  const w1 = new Float64Array(NN_HIDDEN_DIM * NN_INPUT_DIM);
  const b1 = new Float64Array(NN_HIDDEN_DIM);
  const w2 = new Float64Array(NN_HIDDEN_DIM);
  let b2 = 0;

  const init1 = Math.sqrt(2 / NN_INPUT_DIM) * 0.3;
  const init2 = Math.sqrt(1 / NN_HIDDEN_DIM) * 0.12;
  for (let i = 0; i < w1.length; i++) w1[i] = randU(init1);
  for (let h = 0; h < NN_HIDDEN_DIM; h++) w2[h] = randU(init2);

  const mW1 = new Float64Array(w1.length);
  const vW1 = new Float64Array(w1.length);
  const mB1 = new Float64Array(b1.length);
  const vB1 = new Float64Array(b1.length);
  const mW2 = new Float64Array(w2.length);
  const vW2 = new Float64Array(w2.length);
  let mB2 = 0;
  let vB2 = 0;

  const gW1 = new Float64Array(w1.length);
  const gB1 = new Float64Array(b1.length);
  const gW2 = new Float64Array(w2.length);
  const hPre = new Float64Array(NN_HIDDEN_DIM);
  const hAct = new Float64Array(NN_HIDDEN_DIM);

  const order = new Int32Array(trainSet.length);
  for (let i = 0; i < order.length; i++) order[i] = i;

  const batchSize = Math.min(512, Math.max(64, Math.floor(trainSet.length / 40)));
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const weightDecay = 0.0015;

  let stepCount = 0;
  let bestValLoss = baseValLoss;
  let bestModel: TinyMlpModel = zeroModel;
  let noImproveEpochs = 0;

  const snapshot = (): TinyMlpModel => ({
    enabled: true,
    maxResidualCp,
    w1: Array.from(w1, (x) => Number(x.toFixed(4))),
    b1: Array.from(b1, (x) => Number(x.toFixed(4))),
    w2: Array.from(w2, (x) => Number(x.toFixed(4))),
    b2: Number(b2.toFixed(4)),
  });

  for (let epoch = 1; epoch <= epochs; epoch++) {
    if (Date.now() >= hardDeadlineMs - 120_000) break;

    // Deterministic Fisher-Yates shuffle of indices
    for (let i = order.length - 1; i > 0; i--) {
      const r = nextRng(rng);
      rng = r.nextState;
      const j = Math.floor(r.value * (i + 1));
      const tmp = order[i]!;
      order[i] = order[j]!;
      order[j] = tmp;
    }

    const lr = 0.004 * (0.5 * (1 + Math.cos((Math.PI * epoch) / epochs)));

    for (let start = 0; start < order.length; start += batchSize) {
      const end = Math.min(order.length, start + batchSize);
      const invB = 1 / (end - start);

      gW1.fill(0);
      gB1.fill(0);
      gW2.fill(0);
      let gB2 = 0;

      for (let idx = start; idx < end; idx++) {
        const s = trainSet[order[idx]!]!;
        const x = s.f;
        let rawOut = b2;
        for (let h = 0; h < NN_HIDDEN_DIM; h++) {
          const off = h * NN_INPUT_DIM;
          let sum = b1[h]!;
          for (let i = 0; i < NN_INPUT_DIM; i++) {
            sum += w1[off + i]! * x[i]!;
          }
          hPre[h] = sum;
          const act = sum <= 0 ? 0 : sum >= 2 ? 2 : sum;
          hAct[h] = act;
          rawOut += w2[h]! * act;
        }

        const th = Math.tanh(rawOut);
        const resCp = th * maxResidualCp;
        const pred = sigmoid((s.l + resCp) / scaleK);
        const target = 0.55 * s.o + 0.45 * sigmoid(s.s / scaleK);

        const dRaw = (pred - target) * invB * (maxResidualCp / scaleK) * (1 - th * th);
        gB2 += dRaw;
        for (let h = 0; h < NN_HIDDEN_DIM; h++) {
          gW2[h] = gW2[h]! + dRaw * hAct[h]!;
          const pre = hPre[h]!;
          if (pre > 0 && pre < 2) {
            const dH = dRaw * w2[h]!;
            gB1[h] = gB1[h]! + dH;
            const off = h * NN_INPUT_DIM;
            for (let i = 0; i < NN_INPUT_DIM; i++) {
              gW1[off + i] = gW1[off + i]! + dH * x[i]!;
            }
          }
        }
      }

      stepCount++;
      const b1Pow = 1 - Math.pow(beta1, stepCount);
      const b2Pow = 1 - Math.pow(beta2, stepCount);

      for (let i = 0; i < w1.length; i++) {
        const g = gW1[i]! + weightDecay * w1[i]!;
        mW1[i] = beta1 * mW1[i]! + (1 - beta1) * g;
        vW1[i] = beta2 * vW1[i]! + (1 - beta2) * g * g;
        w1[i] = w1[i]! - (lr * (mW1[i]! / b1Pow)) / (Math.sqrt(vW1[i]! / b2Pow) + eps);
      }
      for (let h = 0; h < NN_HIDDEN_DIM; h++) {
        const gb = gB1[h]!;
        mB1[h] = beta1 * mB1[h]! + (1 - beta1) * gb;
        vB1[h] = beta2 * vB1[h]! + (1 - beta2) * gb * gb;
        b1[h] = b1[h]! - (lr * (mB1[h]! / b1Pow)) / (Math.sqrt(vB1[h]! / b2Pow) + eps);

        const gw = gW2[h]! + weightDecay * w2[h]!;
        mW2[h] = beta1 * mW2[h]! + (1 - beta1) * gw;
        vW2[h] = beta2 * vW2[h]! + (1 - beta2) * gw * gw;
        w2[h] = w2[h]! - (lr * (mW2[h]! / b1Pow)) / (Math.sqrt(vW2[h]! / b2Pow) + eps);
      }
      mB2 = beta1 * mB2 + (1 - beta1) * gB2;
      vB2 = beta2 * vB2 + (1 - beta2) * gB2 * gB2;
      b2 -= (lr * (mB2 / b1Pow)) / (Math.sqrt(vB2 / b2Pow) + eps);
    }

    if (epoch % 3 === 0 || epoch === epochs) {
      const cand = snapshot();
      const vl = evalLoss(valSet, cand);
      if (vl < bestValLoss - 1e-5) {
        bestValLoss = vl;
        bestModel = cand;
        noImproveEpochs = 0;
      } else {
        noImproveEpochs += 3;
        if (noImproveEpochs >= 18) break;
      }
    }
  }

  return {
    model: bestModel,
    baseValLoss,
    bestValLoss,
    trainCount: trainSet.length,
    valCount: valSet.length,
  };
}

function writeTrainedModelsFile(
  outPath: string,
  evalWeights: SucsEvalWeights,
  beliefWeights: BeliefModelWeights,
  mlpModel: TinyMlpModel,
  metaLines: readonly string[],
): void {
  const fmtRec = (obj: Record<string, number>): string =>
    `{\n${Object.entries(obj)
      .map(([k, v]) => `  ${k}: ${Number(v.toFixed(4))},`)
      .join('\n')}\n}`;

  const fmtArr = (arr: readonly number[], cols = 14): string => {
    const rows: string[] = [];
    for (let i = 0; i < arr.length; i += cols) {
      rows.push('    ' + arr.slice(i, i + cols).map((v) => Number(v.toFixed(4))).join(', ') + ',');
    }
    return `[\n${rows.join('\n')}\n  ]`;
  };

  const doc = metaLines.map((l) => ` * ${l}`).join('\n');
  const content = `import type { BeliefModelWeights } from './beliefModel';
import type { SucsEvalWeights } from './evalWeights';
import type { TinyMlpModel } from './nnEval';

/**
 * Active production AI parameters generated by overnight parallel Self-Play + Belief + Mini-Batch MLP + SPSA training
 * (\`scripts/overnight.ts\`). Zero runtime dependencies, 100% deterministic.
${doc}
 */
export const TRAINED_EVAL_WEIGHTS: Readonly<SucsEvalWeights> = ${fmtRec(evalWeights as unknown as Record<string, number>)};

export const TRAINED_BELIEF_WEIGHTS: Readonly<BeliefModelWeights> = ${fmtRec(beliefWeights as unknown as Record<string, number>)};

export const TRAINED_MLP_MODEL: Readonly<TinyMlpModel> = {
  enabled: ${mlpModel.enabled},
  maxResidualCp: ${mlpModel.maxResidualCp},
  w1: ${fmtArr(mlpModel.w1, 14)},
  b1: ${fmtArr(mlpModel.b1, 10)},
  w2: ${fmtArr(mlpModel.w2, 10)},
  b2: ${Number(mlpModel.b2.toFixed(4))},
};
`;
  fs.writeFileSync(outPath, content, 'utf8');
}

function gzipJsonlFile(lines: readonly string[], gzOutPath: string): number {
  const payload = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: 9 });
  const tmpPath = `${gzOutPath}.tmp`;
  fs.writeFileSync(tmpPath, gz);
  fs.renameSync(tmpPath, gzOutPath);
  return gz.length;
}

function serializeCompactBelief(b: BeliefRecord): string {
  return JSON.stringify({
    g: b.g,
    side: b.side,
    w: b.vis.width,
    h: b.vis.height,
    turn: b.vis.turnNumber,
    sils: b.vis.silhouettes.map((s) => [s.pos.x, s.pos.y]),
    mem: Object.values(b.mem.lastKnownPositions).map((m) => [
      m.type,
      m.pos.x,
      m.pos.y,
      m.lastSeenTurn,
    ]),
    threats: b.threats.map((c) => [c.x, c.y]),
  });
}

function parseArg(args: readonly string[], key: string, fallback: string): string {
  const prefix = `--${key}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

async function runCoordinator(scriptPath: string, args: readonly string[]): Promise<void> {
  const selfplayUntilStr = parseArg(args, 'selfplayUntil', '2026-11-26T04:20:00+03:00');
  const hardDeadlineStr = parseArg(args, 'hardDeadline', '2026-11-26T05:00:00+03:00');
  const selfplayUntilMs = Date.parse(selfplayUntilStr);
  const hardDeadlineMs = Date.parse(hardDeadlineStr);
  const workers = Math.max(1, Number(parseArg(args, 'workers', '6')));
  const batchGames = Math.max(2, Number(parseArg(args, 'batchGames', '24')));
  const budgetMs = Math.max(15, Number(parseArg(args, 'budget', '50')));
  const maxEvalSamples = Math.max(500, Number(parseArg(args, 'maxEvalSamples', '150000')));
  const maxBeliefSamples = Math.max(100, Number(parseArg(args, 'maxBeliefSamples', '6000')));
  const spsaIters = Math.max(0, Number(parseArg(args, 'spsaIters', '24')));
  const spsaPairs = Math.max(2, Number(parseArg(args, 'spsaPairs', '12')));
  const gatePairs = Math.max(2, Number(parseArg(args, 'gatePairs', '48')));
  const dryRun = args.includes('--dryRun');

  const dataDir = path.resolve(process.cwd(), 'training_data');
  const tmpDir = path.join(dataDir, 'tmp_shards');
  fs.mkdirSync(tmpDir, { recursive: true });

  const startedAtIso = new Date().toISOString();
  console.log(`\n==================================================================`);
  console.log(` S.U.C.S. OVERNIGHT PARALLEL SELF-PLAY & TRAINING COORDINATOR`);
  console.log(` Started:        ${startedAtIso}`);
  console.log(` SelfPlay Until: ${selfplayUntilStr}`);
  console.log(` Hard Deadline:  ${hardDeadlineStr}`);
  console.log(` Config:         workers=${workers}, batch=${batchGames}g, budget=${budgetMs}ms, spsa=${spsaIters}x${spsaPairs}p, gate=${gatePairs}p, dryRun=${dryRun}`);
  console.log(`==================================================================\n`);

  const aggTelemetry: BatchTelemetry = {
    games: 0,
    plies: 0,
    playerWins: 0,
    enemyWins: 0,
    draws: 0,
    endReasons: {},
    v3Events: {},
  };

  // Reservoir-sampled in-memory pools (bounded strictly -> constant RAM over 5+ hours!)
  const evalReservoir: EvalRecord[] = [];
  let evalSeen = 0;
  const beliefReservoir: BeliefRecord[] = [];
  let beliefSeen = 0;
  let reservoirRng = seedToRngState('overnight-reservoir-20261126');

  const pushEvalReservoir = (rec: EvalRecord): void => {
    evalSeen++;
    if (evalReservoir.length < maxEvalSamples) {
      evalReservoir.push(rec);
    } else {
      const r = nextRng(reservoirRng);
      reservoirRng = r.nextState;
      const idx = Math.floor(r.value * evalSeen);
      if (idx < maxEvalSamples) evalReservoir[idx] = rec;
    }
  };

  const pushBeliefReservoir = (rec: BeliefRecord): void => {
    beliefSeen++;
    if (beliefReservoir.length < maxBeliefSamples) {
      beliefReservoir.push(rec);
    } else {
      const r = nextRng(reservoirRng);
      reservoirRng = r.nextState;
      const idx = Math.floor(r.value * beliefSeen);
      if (idx < maxBeliefSamples) beliefReservoir[idx] = rec;
    }
  };

  // PHASE 1: Continuous Parallel Self-Play Generation until selfplayUntilMs
  let nextGameId = 0;
  let round = 0;
  let workerErrors = 0;

  console.log(`[Phase 1] Starting ${workers}-worker continuous Fog-of-War self-play...`);
  while (Date.now() < selfplayUntilMs) {
    round++;
    const roundStart = Date.now();
    const batchJobs = Array.from({ length: workers }, (_, wIdx) => {
      const startG = nextGameId;
      nextGameId += batchGames;
      const outFile = path.join(tmpDir, `sp_r${round}_w${wIdx}.json`);
      return spawnChildScript(
        scriptPath,
        [
          'worker-selfplay',
          `--workerId=${wIdx}`,
          `--batch=${round}`,
          `--startGameId=${startG}`,
          `--games=${batchGames}`,
          `--budget=${budgetMs}`,
          `--out=${outFile}`,
        ],
        300_000,
      )
        .then(() => {
          const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')) as SelfPlayShardOutput;
          try {
            fs.unlinkSync(outFile);
          } catch {
            // ignore
          }
          return parsed;
        })
        .catch((err: unknown) => {
          workerErrors++;
          console.error(`  [WARN] Round ${round} worker ${wIdx} failed: ${String(err)}`);
          return null;
        });
    });

    const shards = await Promise.all(batchJobs);
    for (const sh of shards) {
      if (sh === null) continue;
      aggTelemetry.games += sh.telemetry.games;
      aggTelemetry.plies += sh.telemetry.plies;
      aggTelemetry.playerWins += sh.telemetry.playerWins;
      aggTelemetry.enemyWins += sh.telemetry.enemyWins;
      aggTelemetry.draws += sh.telemetry.draws;
      for (const [k, v] of Object.entries(sh.telemetry.endReasons)) {
        aggTelemetry.endReasons[k] = (aggTelemetry.endReasons[k] ?? 0) + v;
      }
      for (const [k, v] of Object.entries(sh.telemetry.v3Events)) {
        aggTelemetry.v3Events[k] = (aggTelemetry.v3Events[k] ?? 0) + v;
      }
      for (let i = 0; i < sh.evalRecords.length; i++) pushEvalReservoir(sh.evalRecords[i]!);
      for (let i = 0; i < sh.beliefRecords.length; i++) pushBeliefReservoir(sh.beliefRecords[i]!);
    }

    const roundSec = ((Date.now() - roundStart) / 1000).toFixed(1);
    const remainMin = Math.max(0, (selfplayUntilMs - Date.now()) / 60_000).toFixed(1);
    const progress = {
      phase: 'PHASE_1_SELFPLAY',
      updatedAt: new Date().toISOString(),
      round,
      totalGames: aggTelemetry.games,
      totalPlies: aggTelemetry.plies,
      evalSeen,
      evalKept: evalReservoir.length,
      beliefSeen,
      beliefKept: beliefReservoir.length,
      workerErrors,
      remainingSelfPlayMin: Number(remainMin),
      endReasons: aggTelemetry.endReasons,
      v3Events: aggTelemetry.v3Events,
    };
    fs.writeFileSync(path.join(dataDir, 'progress.json'), JSON.stringify(progress, null, 2), 'utf8');

    if (round <= 3 || round % 5 === 0 || Date.now() >= selfplayUntilMs) {
      console.log(
        `  Round ${String(round).padStart(3, ' ')} (${roundSec}s) | games=${aggTelemetry.games} | eval=${evalSeen} (kept ${evalReservoir.length}) | belief=${beliefSeen} (kept ${beliefReservoir.length}) | rem=${remainMin}m`,
      );
    }

    // Periodic atomic dataset checkpoint every 25 rounds (~15 min) so progress is never lost
    if (round % 25 === 0 && Date.now() < selfplayUntilMs) {
      const ckEvalBytes = gzipJsonlFile(
        evalReservoir.map((r) => JSON.stringify(r)),
        path.join(dataDir, 'eval_dataset.jsonl.gz'),
      );
      const ckBeliefBytes = gzipJsonlFile(
        beliefReservoir.map(serializeCompactBelief),
        path.join(dataDir, 'belief_dataset.jsonl.gz'),
      );
      console.log(
        `  [Checkpoint R${round}] Saved eval_dataset.jsonl.gz (${(ckEvalBytes / 1024 / 1024).toFixed(2)} MB) & belief_dataset.jsonl.gz (${(ckBeliefBytes / 1024 / 1024).toFixed(2)} MB)`,
      );
    }
  }

  console.log(
    `\n[Phase 1 Complete] ${aggTelemetry.games} games, ${evalSeen} eval positions (kept ${evalReservoir.length}), ${beliefSeen} fog snapshots (kept ${beliefReservoir.length}).`,
  );

  // Save compressed datasets immediately so training data is safely persisted even before Phase 2 finishes!
  console.log(`[Dataset Export] Compressing curated datasets to training_data/*.jsonl.gz...`);
  const evalGzPath = path.join(dataDir, 'eval_dataset.jsonl.gz');
  const beliefGzPath = path.join(dataDir, 'belief_dataset.jsonl.gz');
  const evalGzBytes = gzipJsonlFile(
    evalReservoir.map((r) => JSON.stringify(r)),
    evalGzPath,
  );
  // Store compact belief summaries (positions, silhouettes, memory, ground-truth threats) to keep gz sleek
  const beliefGzBytes = gzipJsonlFile(
    beliefReservoir.map(serializeCompactBelief),
    beliefGzPath,
  );
  console.log(
    `  Saved eval_dataset.jsonl.gz (${(evalGzBytes / 1024 / 1024).toFixed(2)} MB) & belief_dataset.jsonl.gz (${(beliefGzBytes / 1024 / 1024).toFixed(2)} MB)`,
  );

  // PHASE 2A: Train Bayesian Fog Belief Model
  console.log(`\n[Phase 2A] Training Bayesian Fog Belief Model on ${beliefReservoir.length} fog snapshots...`);
  const beliefRes = trainBeliefModelLarge(beliefReservoir, TRAINED_BELIEF_WEIGHTS, hardDeadlineMs);
  console.log(
    `  Belief val contrast lift: ${beliefRes.baseScore.toFixed(4)} -> ${beliefRes.trainedScore.toFixed(4)}`,
  );

  // PHASE 2B: Train Tiny MLP Residual (Mini-Batch Adam on up to 150k positions)
  console.log(
    `\n[Phase 2B] Training Tiny MLP Residual (28->20->1) via Mini-Batch Adam on ${evalReservoir.length} positions...`,
  );
  const mlpRes = trainTinyMlpMiniBatch(evalReservoir, 75, 140, hardDeadlineMs);
  console.log(
    `  MLP val BCE (train=${mlpRes.trainCount}, val=${mlpRes.valCount}): ${mlpRes.baseValLoss.toFixed(5)} -> ${mlpRes.bestValLoss.toFixed(5)}`,
  );

  // PHASE 2C: Gate A — Verify Belief + MLP out-of-sample across parallel workers
  let acceptedBeliefWeights: BeliefModelWeights = { ...TRAINED_BELIEF_WEIGHTS };
  let acceptedMlp: TinyMlpModel = { ...mlpRes.model, enabled: false };
  let gateAReport = { winsA: 0, draws: 0, winsB: 0, eloDiff: 0, eloError95: 0, sprtLlr: 0 };

  if (Date.now() < hardDeadlineMs - 180_000 && mlpRes.bestValLoss < mlpRes.baseValLoss - 0.0005) {
    console.log(`\n[Gate A] Parallel OOS verification: Trained Belief + MLP vs Baseline (${gatePairs * 2} games)...`);
    const gA = await runParallelPairedMatch(
      scriptPath,
      tmpDir,
      'gateA',
      workers,
      {
        name: 'CAND-BELIEF+MLP',
        difficulty: 'PANIC',
        budgetMs: 85,
        maxDepth: 6,
        weights: { ...TRAINED_EVAL_WEIGHTS },
        beliefWeights: beliefRes.bestWeights,
        mlpModel: mlpRes.model,
      },
      {
        name: 'BASE-BELIEF-NOMLP',
        difficulty: 'PANIC',
        budgetMs: 85,
        maxDepth: 6,
        weights: { ...TRAINED_EVAL_WEIGHTS },
        beliefWeights: { ...TRAINED_BELIEF_WEIGHTS },
        mlpModel: { ...TRAINED_MLP_MODEL, enabled: false },
      },
      gatePairs,
      120,
      'overnight-gate-A',
    );
    const eloA = computeEloReport(gA.winsA, gA.draws, gA.winsB);
    gateAReport = {
      winsA: gA.winsA,
      draws: gA.draws,
      winsB: gA.winsB,
      eloDiff: Number(eloA.eloDiff.toFixed(1)),
      eloError95: Number(eloA.eloError95.toFixed(1)),
      sprtLlr: Number(eloA.sprtLlr.toFixed(2)),
    };
    console.log(
      `  Gate A: +${gA.winsA} =${gA.draws} -${gA.winsB} (${(eloA.scoreRateA * 100).toFixed(1)}%, Elo ${eloA.eloDiff >= 0 ? '+' : ''}${eloA.eloDiff.toFixed(1)} ± ${eloA.eloError95.toFixed(1)}, LLR=${eloA.sprtLlr.toFixed(2)})`,
    );
    if (eloA.eloDiff >= 10) {
      acceptedBeliefWeights = beliefRes.bestWeights;
      acceptedMlp = mlpRes.model;
      console.log(`  -> ACCEPTED Trained Belief + Tiny MLP Residual!`);
    } else {
      console.log(`  -> KEPT prior Belief & Tiny MLP disabled (OOS Elo ${eloA.eloDiff.toFixed(1)} < +10 threshold).`);
    }
  }

  // PHASE 2D: Parallel Multi-Worker SPSA Self-Play Weight Refinement
  let currentWeights: SucsEvalWeights = { ...TRAINED_EVAL_WEIGHTS };
  const spsaHistory: Array<{ iter: number; winsPlus: number; draws: number; winsMinus: number }> = [];
  const spsaKeys: ReadonlyArray<{ key: keyof SucsEvalWeights; scale: number }> = [
    { key: 'frozenOnLethalTileRatio', scale: 0.14 },
    { key: 'composureFragilePenalty', scale: 14 },
    { key: 'disobedienceIsolatedPenalty', scale: 16 },
    { key: 'allyDeathCascadeSetupBonus', scale: 12 },
    { key: 'dashAmbushStagingBonus', scale: 14 },
    { key: 'shadowWalkerFlankBonus', scale: 10 },
    { key: 'chimeraMiasmaCoverBonus', scale: 12 },
    { key: 'chimeraSynergyCombo', scale: 26 },
    { key: 'pusherPitUnitBonus', scale: 45 },
    { key: 'pusherSpikeUnitBonus', scale: 40 },
    { key: 'explosiveMiasmaBombBonus', scale: 32 },
    { key: 'plateCorridorZoneBonus', scale: 35 },
    { key: 'enemyKingBoxSqueezeBonus', scale: 10 },
    { key: 'ownKingBoxDangerPenalty', scale: 12 },
    { key: 'beliefRiskScale', scale: 0.2 },
    { key: 'ghostAmbushCheckScale', scale: 0.22 },
    { key: 'trapComplexityTieBreak', scale: 6 },
    { key: 'pursuitKingChase', scale: 4 },
    { key: 'kingEdgePushScale', scale: 3 },
  ];

  let spsaRng = seedToRngState('overnight-spsa-20261126');
  console.log(`\n[Phase 2D] Running Parallel SPSA (${spsaIters} iters × ${spsaPairs * 2} games across ${workers} workers)...`);
  for (let k = 0; k < spsaIters; k++) {
    // Reserve at least 5 minutes before hardDeadline for Gate B + cleanup
    if (Date.now() >= hardDeadlineMs - 300_000) {
      console.log(`  Stopping SPSA early at iter ${k} to preserve deadline margin for final Elo gate.`);
      break;
    }
    const ck = 1.0 / Math.pow(k + 1, 0.16);
    const ak = 0.5 / Math.pow(k + 2, 0.6);

    const delta: number[] = [];
    const plusRaw: Partial<SucsEvalWeights> = { ...currentWeights };
    const minusRaw: Partial<SucsEvalWeights> = { ...currentWeights };
    for (let i = 0; i < spsaKeys.length; i++) {
      const r = nextRng(spsaRng);
      spsaRng = r.nextState;
      const d = r.value < 0.5 ? -1 : 1;
      delta.push(d);
      const spec = spsaKeys[i]!;
      plusRaw[spec.key] = currentWeights[spec.key] + d * spec.scale * ck;
      minusRaw[spec.key] = currentWeights[spec.key] - d * spec.scale * ck;
    }

    const wPlus = clampEvalWeights(plusRaw);
    const wMinus = clampEvalWeights(minusRaw);

    const m = await runParallelPairedMatch(
      scriptPath,
      tmpDir,
      `spsa_${k}`,
      workers,
      {
        name: 'SPSA+',
        difficulty: 'PANIC',
        budgetMs: 55,
        maxDepth: 5,
        weights: wPlus,
        beliefWeights: acceptedBeliefWeights,
        mlpModel: acceptedMlp,
      },
      {
        name: 'SPSA-',
        difficulty: 'PANIC',
        budgetMs: 55,
        maxDepth: 5,
        weights: wMinus,
        beliefWeights: acceptedBeliefWeights,
        mlpModel: acceptedMlp,
      },
      spsaPairs,
      105,
      `overnight-spsa-${k}`,
    );

    spsaHistory.push({ iter: k + 1, winsPlus: m.winsA, draws: m.draws, winsMinus: m.winsB });
    const diff = (m.winsA - m.winsB) / Math.max(1, m.totalGames);
    console.log(
      `  SPSA ${String(k + 1).padStart(2, ' ')}/${spsaIters} | +${m.winsA} =${m.draws} -${m.winsB} (diff=${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}%)`,
    );

    if (Math.abs(diff) > 0.01) {
      const nextRaw: Partial<SucsEvalWeights> = { ...currentWeights };
      for (let i = 0; i < spsaKeys.length; i++) {
        const spec = spsaKeys[i]!;
        nextRaw[spec.key] = Number((currentWeights[spec.key] + ak * diff * delta[i]! * spec.scale).toFixed(3));
      }
      currentWeights = clampEvalWeights(nextRaw);
    }
  }

  // PHASE 2E: Gate B — Verify SPSA Weights out-of-sample
  let acceptedEvalWeights: SucsEvalWeights = { ...TRAINED_EVAL_WEIGHTS };
  let gateBReport = { winsA: 0, draws: 0, winsB: 0, eloDiff: 0, eloError95: 0, sprtLlr: 0 };

  if (spsaHistory.length > 0 && Date.now() < hardDeadlineMs - 45_000) {
    console.log(`\n[Gate B] Parallel OOS verification: SPSA Weights vs Pre-SPSA (${gatePairs * 2} games)...`);
    const gB = await runParallelPairedMatch(
      scriptPath,
      tmpDir,
      'gateB',
      workers,
      {
        name: 'SPSA-FINAL',
        difficulty: 'PANIC',
        budgetMs: 85,
        maxDepth: 6,
        weights: currentWeights,
        beliefWeights: acceptedBeliefWeights,
        mlpModel: acceptedMlp,
      },
      {
        name: 'PRE-SPSA',
        difficulty: 'PANIC',
        budgetMs: 85,
        maxDepth: 6,
        weights: { ...TRAINED_EVAL_WEIGHTS },
        beliefWeights: acceptedBeliefWeights,
        mlpModel: acceptedMlp,
      },
      gatePairs,
      120,
      'overnight-gate-B',
    );
    const eloB = computeEloReport(gB.winsA, gB.draws, gB.winsB);
    gateBReport = {
      winsA: gB.winsA,
      draws: gB.draws,
      winsB: gB.winsB,
      eloDiff: Number(eloB.eloDiff.toFixed(1)),
      eloError95: Number(eloB.eloError95.toFixed(1)),
      sprtLlr: Number(eloB.sprtLlr.toFixed(2)),
    };
    console.log(
      `  Gate B: +${gB.winsA} =${gB.draws} -${gB.winsB} (${(eloB.scoreRateA * 100).toFixed(1)}%, Elo ${eloB.eloDiff >= 0 ? '+' : ''}${eloB.eloDiff.toFixed(1)} ± ${eloB.eloError95.toFixed(1)}, LLR=${eloB.sprtLlr.toFixed(2)})`,
    );
    if (eloB.eloDiff >= 12) {
      acceptedEvalWeights = currentWeights;
      console.log(`  -> ACCEPTED SPSA Eval Weights!`);
    } else {
      console.log(`  -> KEPT prior Eval Weights (SPSA OOS Elo ${eloB.eloDiff.toFixed(1)} < +12 threshold).`);
    }
  }

  // Final cleanup of temporary shard directory
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  const finishedAtIso = new Date().toISOString();
  const summary = {
    startedAt: startedAtIso,
    finishedAt: finishedAtIso,
    dryRun,
    config: {
      selfplayUntil: selfplayUntilStr,
      hardDeadline: hardDeadlineStr,
      workers,
      batchGames,
      budgetMs,
      maxEvalSamples,
      maxBeliefSamples,
      spsaItersRequested: spsaIters,
      spsaItersCompleted: spsaHistory.length,
      gatePairs,
    },
    selfPlay: {
      totalGames: aggTelemetry.games,
      totalPlies: aggTelemetry.plies,
      avgPlies: aggTelemetry.games > 0 ? Number((aggTelemetry.plies / aggTelemetry.games).toFixed(1)) : 0,
      playerWins: aggTelemetry.playerWins,
      enemyWins: aggTelemetry.enemyWins,
      draws: aggTelemetry.draws,
      workerErrors,
      evalPositionsSeen: evalSeen,
      evalPositionsSaved: evalReservoir.length,
      beliefSnapshotsSeen: beliefSeen,
      beliefSnapshotsSaved: beliefReservoir.length,
      evalDatasetGzBytes: evalGzBytes,
      beliefDatasetGzBytes: beliefGzBytes,
      endReasons: aggTelemetry.endReasons,
      v3Events: aggTelemetry.v3Events,
    },
    beliefTraining: {
      baseValLift: Number(beliefRes.baseScore.toFixed(4)),
      trainedValLift: Number(beliefRes.trainedScore.toFixed(4)),
      acceptedWeights: beliefRes.bestWeights,
    },
    mlpTraining: {
      trainPositions: mlpRes.trainCount,
      valPositions: mlpRes.valCount,
      baseValBce: Number(mlpRes.baseValLoss.toFixed(5)),
      bestValBce: Number(mlpRes.bestValLoss.toFixed(5)),
      gateA: gateAReport,
      acceptedEnabled: acceptedMlp.enabled,
    },
    spsaTraining: {
      iterationsCompleted: spsaHistory.length,
      history: spsaHistory,
      gateB: gateBReport,
      acceptedSpsaWeights: acceptedEvalWeights !== TRAINED_EVAL_WEIGHTS && JSON.stringify(acceptedEvalWeights) !== JSON.stringify(TRAINED_EVAL_WEIGHTS),
    },
  };

  fs.writeFileSync(path.join(dataDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'progress.json'),
    JSON.stringify({ phase: 'COMPLETED', updatedAt: finishedAtIso, totalGames: aggTelemetry.games }, null, 2),
    'utf8',
  );

  if (!dryRun) {
    const outModelsPath = path.resolve(process.cwd(), 'src/ai/trainedModels.ts');
    const metaLines = [
      `Overnight run (${startedAtIso} -> ${finishedAtIso}): ${aggTelemetry.games} Fog-of-War games, ${evalSeen} positions (curated ${evalReservoir.length}), ${beliefSeen} fog snapshots.`,
      `Belief val lift: ${beliefRes.baseScore.toFixed(4)} -> ${beliefRes.trainedScore.toFixed(4)}.`,
      `MLP val BCE: ${mlpRes.baseValLoss.toFixed(5)} -> ${mlpRes.bestValLoss.toFixed(5)} (Gate A: +${gateAReport.winsA}=${gateAReport.draws}-${gateAReport.winsB}, ${gateAReport.eloDiff >= 0 ? '+' : ''}${gateAReport.eloDiff} Elo, enabled=${acceptedMlp.enabled}).`,
      `SPSA (${spsaHistory.length} iters): Gate B +${gateBReport.winsA}=${gateBReport.draws}-${gateBReport.winsB} (${gateBReport.eloDiff >= 0 ? '+' : ''}${gateBReport.eloDiff} Elo).`,
    ];
    writeTrainedModelsFile(
      outModelsPath,
      acceptedEvalWeights,
      acceptedBeliefWeights,
      acceptedMlp,
      metaLines,
    );
    console.log(`\nWrote verified production models to ${outModelsPath}`);
  } else {
    console.log(`\n[DryRun] Skipped overwriting src/ai/trainedModels.ts.`);
  }

  console.log(`\n=== OVERNIGHT TRAINING FINISHED CLEANLY AT ${finishedAtIso} ===`);
}

// CLI Entrypoint
const entryIdx =
  typeof process !== 'undefined'
    ? process.argv.findIndex(
        (a) => a.endsWith('overnight.ts') || a.endsWith('overnight.js') || a.endsWith('overnight.mjs'),
      )
    : -1;

if (entryIdx !== -1) {
  const scriptPath = path.resolve(process.argv[entryIdx]!);
  const args = process.argv.slice(entryIdx + 1);
  const mode = args[0] ?? 'coordinator';

  if (mode === 'worker-selfplay') {
    const workerId = Number(parseArg(args, 'workerId', '0'));
    const batch = Number(parseArg(args, 'batch', '0'));
    const startGameId = Number(parseArg(args, 'startGameId', '0'));
    const games = Number(parseArg(args, 'games', '8'));
    const budget = Number(parseArg(args, 'budget', '45'));
    const out = parseArg(args, 'out', 'shard.json');
    runSelfPlayWorker(workerId, batch, startGameId, games, budget, out);
  } else if (mode === 'worker-match') {
    const cfg = parseArg(args, 'cfg', 'match_cfg.json');
    const out = parseArg(args, 'out', 'match_out.json');
    runMatchWorker(cfg, out);
  } else {
    void runCoordinator(scriptPath, args).catch((err) => {
      console.error('Overnight coordinator fatal error:', err);
      process.exit(1);
    });
  }
}

import fs from 'node:fs';
import path from 'node:path';
import {
  buildMovementAwareBelief,
  DEFAULT_BELIEF_WEIGHTS,
  type BeliefModelWeights,
} from '../src/ai/beliefModel';
import { createAiMemory, type AiMemory } from '../src/ai/campaignAi';
import {
  clampEvalWeights,
  DEFAULT_EVAL_WEIGHTS,
  type SucsEvalWeights,
} from '../src/ai/evalWeights';
import {
  evaluateTinyMlp,
  NN_HIDDEN_DIM,
  NN_INPUT_DIM,
  type TinyMlpModel,
} from '../src/ai/nnEval';
import {
  chooseSucsAction,
  evaluateVisiblePositionForTraining,
} from '../src/ai/sucsAi';
import { opponentOf } from '../src/engine/board';
import { nextRng, seedToRngState } from '../src/engine/prng';
import { canPieceAttackSquare } from '../src/engine/psychology';
import { stepGame } from '../src/engine/reducer';
import type { Coord, GameState, Side, VisibleState } from '../src/engine/types';
import { getVisibleState } from '../src/engine/visibility';
import {
  buildArenaScenarios,
  computeEloReport,
  makeSucsBot,
  printMatchSummary,
  runPairedArenaMatch,
  type ArenaBot,
} from './arena';

interface EvalSample {
  gameId: number;
  features: number[];
  linearScore: number;
  searchScore: number;
  outcome: number; // 1 = win, 0.5 = draw, 0 = loss for perspective side
}

interface BeliefSample {
  gameId: number;
  visible: VisibleState;
  memory: AiMemory;
  aiSide: Side;
  /** Ground-truth squares attacked in 1 ply by hidden enemy pieces (offline training label only!) */
  trueHiddenThreatSquares: Coord[];
}

function sigmoid(x: number): number {
  if (x >= 20) return 1 - 1e-9;
  if (x <= -20) return 1e-9;
  return 1 / (1 + Math.exp(-x));
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

/**
 * Computes ground-truth squares threatened by enemy pieces currently hidden in fog.
 * Used ONLY offline as supervised labels to train `BeliefModelWeights` (never used during play!).
 */
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
 * Stage 1: Mixed-League Self-Play Data Collection (70% strong PANIC vs PANIC + 30% PANIC vs TENSE/CALM human proxies).
 */
function collectMixedLeagueDataset(
  numGames: number,
  budgetMs: number,
  seedBase = 'sucs-train-v1',
): { evalSamples: EvalSample[]; beliefSamples: BeliefSample[] } {
  const scenarios = buildArenaScenarios();
  const evalSamples: EvalSample[] = [];
  const beliefSamples: BeliefSample[] = [];

  for (let g = 0; g < numGames; g++) {
    const scenario = scenarios[g % scenarios.length]!;
    const initialState = scenario.createInitialState(`${seedBase}::g-${g}`);

    // 70% strong self-play (PANIC vs PANIC), 30% mixed league (PANIC vs greedy/noisy CALM/TENSE)
    const isLeagueGame = g % 10 >= 7;
    const oppDiff = g % 2 === 0 ? 'CALM' : 'TENSE';
    const playerBot: ArenaBot = makeSucsBot('P', 'PANIC', {
      timeBudgetMs: budgetMs,
      maxDepth: 5,
    });
    const enemyBot: ArenaBot = isLeagueGame
      ? makeSucsBot('E-Proxy', oppDiff, { timeBudgetMs: Math.round(budgetMs * 0.6) })
      : makeSucsBot('E', 'PANIC', { timeBudgetMs: budgetMs, maxDepth: 5 });

    let state = initialState;
    let memP = createAiMemory();
    let memE = createAiMemory();
    let rngP = seedToRngState(`${seedBase}:P:${g}`);
    let rngE = seedToRngState(`${seedBase}:E:${g}`);

    const gamePendingEval: Array<{
      side: Side;
      features: number[];
      linearScore: number;
      searchScore: number;
    }> = [];

    let plies = 0;
    const maxPlies = 110;
    while (state.winner === null && plies < maxPlies) {
      const side = state.turn;
      const visible = getVisibleState(state, side);
      const memBefore = side === 'PLAYER' ? memP : memE;

      const dec =
        side === 'PLAYER'
          ? playerBot.choose(visible, memP, 'PLAYER', rngP)
          : enemyBot.choose(visible, memE, 'ENEMY', rngE);

      if (side === 'PLAYER') {
        memP = dec.memory;
        rngP = dec.nextRngState;
      } else {
        memE = dec.memory;
        rngE = dec.nextRngState;
      }

      // Record non-mate midgame/endgame samples for Texel/MLP training
      if (plies >= 4 && Math.abs(dec.score) < 50_000) {
        const evalData = evaluateVisiblePositionForTraining(visible, memBefore, side);
        // Normalize out constant hidden-king +10000 offset so score centers cleanly near 0
        const oppKingVis = visible.pieces.some(
          (p) => p.side === opponentOf(side) && p.type === 'KING',
        );
        const normLinear = oppKingVis ? evalData.score : evalData.score - 10_000;
        const normSearch = oppKingVis ? dec.score : dec.score - 10_000;
        gamePendingEval.push({
          side,
          features: evalData.features,
          linearScore: normLinear,
          searchScore: Math.max(-2500, Math.min(2500, normSearch)),
        });
      }

      // Record fog belief samples whenever silhouettes or remembered unseen pieces exist
      if (
        plies >= 2 &&
        plies % 2 === 0 &&
        (visible.silhouettes.length > 0 || Object.keys(memBefore.lastKnownPositions).length > 0)
      ) {
        const trueThreats = computeGroundTruthHiddenThreats(state, visible, side);
        if (trueThreats.length > 0) {
          beliefSamples.push({
            gameId: g,
            visible,
            memory: cloneMemory(memBefore),
            aiSide: side,
            trueHiddenThreatSquares: trueThreats,
          });
        }
      }

      let step = stepGame(state, dec.action);
      if (
        step.error !== undefined ||
        (step.events.length === 1 && step.events[0]?.type === 'PIECE_DISOBEYED')
      ) {
        step = stepGame(state, { type: 'END_TURN' });
      }
      state = step.nextState;
      plies++;
    }

    const winner = state.winner ?? 'DRAW';
    for (let i = 0; i < gamePendingEval.length; i++) {
      const rec = gamePendingEval[i]!;
      const outcome = winner === 'DRAW' ? 0.5 : winner === rec.side ? 1.0 : 0.0;
      evalSamples.push({
        gameId: g,
        features: rec.features,
        linearScore: rec.linearScore,
        searchScore: rec.searchScore,
        outcome,
      });
    }
  }

  return { evalSamples, beliefSamples };
}

/**
 * Stage 2: Supervised Fog Belief Model Optimizer (maximizes threat-map separation between true hidden
 * enemy attack squares and safe squares on real Fog-of-War replays).
 */
function trainBeliefModel(samples: readonly BeliefSample[]): {
  bestWeights: BeliefModelWeights;
  baseScore: number;
  trainedScore: number;
} {
  if (samples.length < 10) {
    return { bestWeights: { ...DEFAULT_BELIEF_WEIGHTS }, baseScore: 0, trainedScore: 0 };
  }

  const scoreWeights = (w: BeliefModelWeights, subset: readonly BeliefSample[]): number => {
    let totalLift = 0;
    let count = 0;
    for (let i = 0; i < subset.length; i++) {
      const s = subset[i]!;
      const { dangerGrid } = buildMovementAwareBelief(s.visible, s.memory, s.aiSide, w);
      const threatSet = new Set<number>();
      for (let t = 0; t < s.trueHiddenThreatSquares.length; t++) {
        const c = s.trueHiddenThreatSquares[t]!;
        threatSet.add(c.y * s.visible.width + c.x);
      }
      let sumThreat = 0;
      let nThreat = 0;
      let sumSafe = 0;
      let nSafe = 0;
      for (let y = 0; y < s.visible.height; y++) {
        for (let x = 0; x < s.visible.width; x++) {
          const val = (dangerGrid[y]?.[x] ?? 0) / 240;
          if (threatSet.has(y * s.visible.width + x)) {
            sumThreat += val;
            nThreat++;
          } else {
            sumSafe += val;
            nSafe++;
          }
        }
      }
      if (nThreat > 0 && nSafe > 0) {
        // Contrastive lift + mild calibration penalty against extreme saturation
        const meanT = sumThreat / nThreat;
        const meanS = sumSafe / nSafe;
        totalLift += meanT - 1.25 * meanS;
        count++;
      }
    }
    return count > 0 ? totalLift / count : 0;
  };

  const split = Math.floor(samples.length * 0.8);
  const trainSet = samples.slice(0, split);
  const valSet = samples.slice(split);

  const bounds: Record<keyof BeliefModelWeights, [number, number, number]> = {
    silhouetteCenterWeight: [35, 95, 8],
    silhouetteRing1Weight: [22, 68, 6],
    silhouetteRing2Weight: [8, 38, 5],
    memoryDecayPerTurn: [0.55, 0.92, 0.05],
    sniperRayWeight: [0.7, 1.8, 0.15],
    unexploredAmbushPrior: [2, 20, 3],
    ghostAmbushPenaltyRatio: [0.2, 0.5, 0.04],
  };

  let best: BeliefModelWeights = { ...DEFAULT_BELIEF_WEIGHTS };
  const baseVal = scoreWeights(best, valSet.length > 0 ? valSet : trainSet);
  let bestTrain = scoreWeights(best, trainSet);

  // Coordinate ascent (3 passes over tunable parameters)
  const tunableKeys: Array<keyof BeliefModelWeights> = [
    'silhouetteCenterWeight',
    'silhouetteRing1Weight',
    'silhouetteRing2Weight',
    'memoryDecayPerTurn',
    'sniperRayWeight',
    'unexploredAmbushPrior',
  ];

  for (let pass = 0; pass < 3; pass++) {
    const scale = pass === 0 ? 1 : pass === 1 ? 0.5 : 0.25;
    for (const k of tunableKeys) {
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

  const finalVal = scoreWeights(best, valSet.length > 0 ? valSet : trainSet);
  if (finalVal < baseVal) {
    return { bestWeights: { ...DEFAULT_BELIEF_WEIGHTS }, baseScore: baseVal, trainedScore: baseVal };
  }
  return { bestWeights: best, baseScore: baseVal, trainedScore: finalVal };
}

/**
 * Stage 3: Trains the 28 -> 20 (ClippedReLU) -> 1 Tiny MLP Residual Evaluator via Adam + L2
 * on Texel/Self-Play outcomes with strict game-grouped train/val split and early stopping.
 */
function trainTinyMlpResidual(
  samples: readonly EvalSample[],
  epochs = 75,
  maxResidualCp = 140,
): {
  model: TinyMlpModel;
  baseValLoss: number;
  bestValLoss: number;
} {
  const scaleK = 420;
  // Split strictly by gameId (last 20% of games held out for validation)
  const maxGameId = samples.reduce((m, s) => Math.max(m, s.gameId), 0);
  const valCutoff = Math.max(1, Math.floor((maxGameId + 1) * 0.8));
  const trainSet = samples.filter((s) => s.gameId < valCutoff);
  const valSet = samples.filter((s) => s.gameId >= valCutoff);

  const evalDatasetLoss = (ds: readonly EvalSample[], model: TinyMlpModel): number => {
    if (ds.length === 0) return 0;
    const featBuf = new Float32Array(NN_INPUT_DIM);
    let loss = 0;
    for (let i = 0; i < ds.length; i++) {
      const s = ds[i]!;
      for (let f = 0; f < NN_INPUT_DIM; f++) featBuf[f] = s.features[f]!;
      const resCp = evaluateTinyMlp(featBuf, model);
      const pred = sigmoid((s.linearScore + resCp) / scaleK);
      const target = 0.55 * s.outcome + 0.45 * sigmoid(s.searchScore / scaleK);
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
  const baseValLoss = evalDatasetLoss(valSet.length > 0 ? valSet : trainSet, zeroModel);

  // Deterministic weight initialization (small Xavier scale so residual starts near 0)
  let rng = seedToRngState('sucs-mlp-init-v1');
  const randUniform = (amp: number): number => {
    const r = nextRng(rng);
    rng = r.nextState;
    return (r.value * 2 - 1) * amp;
  };

  const w1 = new Float64Array(NN_HIDDEN_DIM * NN_INPUT_DIM);
  const b1 = new Float64Array(NN_HIDDEN_DIM);
  const w2 = new Float64Array(NN_HIDDEN_DIM);
  let b2 = 0;

  const initScale1 = Math.sqrt(2 / NN_INPUT_DIM) * 0.35;
  const initScale2 = Math.sqrt(1 / NN_HIDDEN_DIM) * 0.15;
  for (let i = 0; i < w1.length; i++) w1[i] = randUniform(initScale1);
  for (let h = 0; h < NN_HIDDEN_DIM; h++) w2[h] = randUniform(initScale2);

  // Adam moment buffers
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

  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const weightDecay = 0.0025;

  let bestValLoss = baseValLoss;
  let bestSnapshot: TinyMlpModel = zeroModel;

  const buildModelFromCurrent = (): TinyMlpModel => ({
    enabled: true,
    maxResidualCp,
    w1: Array.from(w1, (x) => Number(x.toFixed(4))),
    b1: Array.from(b1, (x) => Number(x.toFixed(4))),
    w2: Array.from(w2, (x) => Number(x.toFixed(4))),
    b2: Number(b2.toFixed(4)),
  });

  for (let epoch = 1; epoch <= epochs; epoch++) {
    gW1.fill(0);
    gB1.fill(0);
    gW2.fill(0);
    let gB2 = 0;

    const invN = 1 / Math.max(1, trainSet.length);
    for (let sIdx = 0; sIdx < trainSet.length; sIdx++) {
      const s = trainSet[sIdx]!;
      const x = s.features;
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
      const pred = sigmoid((s.linearScore + resCp) / scaleK);
      const target = 0.55 * s.outcome + 0.45 * sigmoid(s.searchScore / scaleK);

      // dLoss / dRawOut
      const dLogit = (pred - target) * invN;
      const dRawOut = dLogit * (maxResidualCp / scaleK) * (1 - th * th);

      gB2 += dRawOut;
      for (let h = 0; h < NN_HIDDEN_DIM; h++) {
        gW2[h] = gW2[h]! + dRawOut * hAct[h]!;
        const pre = hPre[h]!;
        if (pre > 0 && pre < 2) {
          const dH = dRawOut * w2[h]!;
          gB1[h] = gB1[h]! + dH;
          const off = h * NN_INPUT_DIM;
          for (let i = 0; i < NN_INPUT_DIM; i++) {
            gW1[off + i] = gW1[off + i]! + dH * x[i]!;
          }
        }
      }
    }

    const lr = 0.012 * (0.5 * (1 + Math.cos((Math.PI * epoch) / epochs)));
    const b1Pow = 1 - Math.pow(beta1, epoch);
    const b2Pow = 1 - Math.pow(beta2, epoch);

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

    if (epoch % 5 === 0 || epoch === epochs) {
      const cand = buildModelFromCurrent();
      const valLoss = evalDatasetLoss(valSet.length > 0 ? valSet : trainSet, cand);
      if (valLoss < bestValLoss - 1e-5) {
        bestValLoss = valLoss;
        bestSnapshot = cand;
      }
    }
  }

  return { model: bestSnapshot, baseValLoss, bestValLoss };
}

/**
 * Stage 4: SPSA Self-Play Optimization on high-impact S.U.C.S. tactical & Kahpelik weights.
 */
function runSpsaSelfPlay(
  initialWeights: Readonly<SucsEvalWeights>,
  beliefWeights: Readonly<BeliefModelWeights>,
  mlpModel: Readonly<TinyMlpModel>,
  iterations: number,
  pairsPerIter: number,
  budgetMs: number,
): SucsEvalWeights {
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

  let current: SucsEvalWeights = { ...initialWeights };
  let rng = seedToRngState('sucs-spsa-v1');

  for (let k = 0; k < iterations; k++) {
    const ck = 1.0 / Math.pow(k + 1, 0.16);
    const ak = 0.55 / Math.pow(k + 1.5, 0.6);

    const delta: number[] = [];
    const plusRaw: Partial<SucsEvalWeights> = { ...current };
    const minusRaw: Partial<SucsEvalWeights> = { ...current };

    for (let i = 0; i < spsaKeys.length; i++) {
      const r = nextRng(rng);
      rng = r.nextState;
      const d = r.value < 0.5 ? -1 : 1;
      delta.push(d);
      const spec = spsaKeys[i]!;
      plusRaw[spec.key] = current[spec.key] + d * spec.scale * ck;
      minusRaw[spec.key] = current[spec.key] - d * spec.scale * ck;
    }

    const wPlus = clampEvalWeights(plusRaw);
    const wMinus = clampEvalWeights(minusRaw);

    const botPlus = makeSucsBot('SPSA+', 'PANIC', {
      timeBudgetMs: budgetMs,
      maxDepth: 5,
      weights: wPlus,
      beliefWeights,
      mlpModel,
    });
    const botMinus = makeSucsBot('SPSA-', 'PANIC', {
      timeBudgetMs: budgetMs,
      maxDepth: 5,
      weights: wMinus,
      beliefWeights,
      mlpModel,
    });

    const match = runPairedArenaMatch(botPlus, botMinus, pairsPerIter, {
      maxPlies: 100,
      seedPrefix: `spsa-iter-${k}`,
      verbose: false,
    });

    const n = Math.max(1, match.totalGames);
    const scoreDiff = (match.winsA - match.winsB) / n; // in [-1, +1]
    console.log(
      `  SPSA iter ${String(k + 1).padStart(2, ' ')}/${iterations} | w+ vs w-: +${match.winsA} =${match.draws} -${match.winsB} (diff=${scoreDiff >= 0 ? '+' : ''}${(scoreDiff * 100).toFixed(1)}%)`,
    );

    if (Math.abs(scoreDiff) > 0.01) {
      const nextRaw: Partial<SucsEvalWeights> = { ...current };
      for (let i = 0; i < spsaKeys.length; i++) {
        const spec = spsaKeys[i]!;
        const step = ak * scoreDiff * delta[i]! * spec.scale;
        nextRaw[spec.key] = Number((current[spec.key] + step).toFixed(3));
      }
      current = clampEvalWeights(nextRaw);
    }
  }

  return current;
}

function writeTrainedModelsFile(
  outPath: string,
  evalWeights: SucsEvalWeights,
  beliefWeights: BeliefModelWeights,
  mlpModel: TinyMlpModel,
  metaComment: string,
): void {
  const formatNumRecord = (obj: Record<string, number>): string => {
    const lines = Object.entries(obj).map(
      ([k, v]) => `  ${k}: ${Number(v.toFixed(4))},`,
    );
    return `{\n${lines.join('\n')}\n}`;
  };

  const formatNumArray = (arr: readonly number[], cols = 14): string => {
    const rows: string[] = [];
    for (let i = 0; i < arr.length; i += cols) {
      rows.push('    ' + arr.slice(i, i + cols).map((v) => Number(v.toFixed(4))).join(', ') + ',');
    }
    return `[\n${rows.join('\n')}\n  ]`;
  };

  const content = `import type { BeliefModelWeights } from './beliefModel';
import type { SucsEvalWeights } from './evalWeights';
import type { TinyMlpModel } from './nnEval';

/**
 * Active production AI parameters generated by offline Self-Play + Texel + Tiny-MLP + SPSA training
 * (\`scripts/train.ts\`). Zero runtime dependencies, 100% deterministic.
 * ${metaComment}
 */
export const TRAINED_EVAL_WEIGHTS: Readonly<SucsEvalWeights> = ${formatNumRecord(evalWeights as unknown as Record<string, number>)};

export const TRAINED_BELIEF_WEIGHTS: Readonly<BeliefModelWeights> = ${formatNumRecord(beliefWeights as unknown as Record<string, number>)};

export const TRAINED_MLP_MODEL: Readonly<TinyMlpModel> = {
  enabled: ${mlpModel.enabled},
  maxResidualCp: ${mlpModel.maxResidualCp},
  w1: ${formatNumArray(mlpModel.w1, 14)},
  b1: ${formatNumArray(mlpModel.b1, 10)},
  w2: ${formatNumArray(mlpModel.w2, 10)},
  b2: ${Number(mlpModel.b2.toFixed(4))},
};
`;

  fs.writeFileSync(outPath, content, 'utf8');
}

function parseArg(args: readonly string[], key: string, fallback: string): string {
  const prefix = `--${key}=`;
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return fallback;
}

const trainArgIdx =
  typeof process !== 'undefined'
    ? process.argv.findIndex((a) => a.endsWith('train.ts') || a.endsWith('train.js') || a.endsWith('train.mjs'))
    : -1;

if (trainArgIdx !== -1) {
  const args = process.argv.slice(trainArgIdx + 1);
  const games = Math.max(8, Number(parseArg(args, 'games', '32')));
  const budgetMs = Math.max(25, Number(parseArg(args, 'budget', '55')));
  const spsaIters = Math.max(0, Number(parseArg(args, 'spsa', '8')));
  const spsaPairs = Math.max(2, Number(parseArg(args, 'spsaPairs', '4')));
  const evalPairs = Math.max(4, Number(parseArg(args, 'evalPairs', '12')));
  const shouldWrite = args.includes('--write');

  console.log(`\n===========================================================`);
  console.log(` S.U.C.S. Offline Self-Play Trainer (Mixed League + Belief + MLP + SPSA)`);
  console.log(` games=${games}, budget=${budgetMs}ms, spsaIters=${spsaIters}x${spsaPairs} pairs, write=${shouldWrite}`);
  console.log(`===========================================================\n`);

  const t0 = performance.now();
  console.log(`[1/4] Collecting mixed-league Fog-of-War self-play dataset (${games} games)...`);
  const { evalSamples, beliefSamples } = collectMixedLeagueDataset(games, budgetMs);
  console.log(
    `  Collected ${evalSamples.length} eval positions & ${beliefSamples.length} ground-truth fog belief snapshots in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );

  console.log(`\n[2/4] Optimizing Bayesian Fog Belief Model on real hidden-enemy attack maps...`);
  const beliefRes = trainBeliefModel(beliefSamples);
  console.log(
    `  Belief contrast lift (held-out val): ${beliefRes.baseScore.toFixed(4)} -> ${beliefRes.trainedScore.toFixed(4)}`,
  );
  console.log(`  Trained belief weights:`, beliefRes.bestWeights);

  console.log(`\n[3/4] Training Tiny MLP Residual (28 -> 20 ClippedReLU -> 1) via Adam...`);
  const mlpRes = trainTinyMlpResidual(evalSamples, 80, 140);
  console.log(
    `  MLP Validation BCE Loss: ${mlpRes.baseValLoss.toFixed(5)} -> ${mlpRes.bestValLoss.toFixed(5)} (enabled=${mlpRes.model.enabled})`,
  );

  console.log(`\n[4/4] Running SPSA Self-Play refinement (${spsaIters} iterations)...`);
  const tunedWeights =
    spsaIters > 0
      ? runSpsaSelfPlay(
          DEFAULT_EVAL_WEIGHTS,
          beliefRes.bestWeights,
          mlpRes.model,
          spsaIters,
          spsaPairs,
          budgetMs,
        )
      : { ...DEFAULT_EVAL_WEIGHTS };

  console.log(`\n[Gate A] Verifying Trained Belief + Tiny MLP vs Step-2 Defaults (${evalPairs} pairs = ${evalPairs * 2} games)...`);
  const mlpBeliefBot = makeSucsBot('BELIEF+MLP', 'PANIC', {
    timeBudgetMs: 90,
    weights: DEFAULT_EVAL_WEIGHTS,
    beliefWeights: beliefRes.bestWeights,
    mlpModel: mlpRes.model,
  });
  const defaultBot = makeSucsBot('DEFAULT-PANIC', 'PANIC', {
    timeBudgetMs: 90,
    weights: DEFAULT_EVAL_WEIGHTS,
    beliefWeights: DEFAULT_BELIEF_WEIGHTS,
    mlpModel: { ...mlpRes.model, enabled: false },
  });

  const gateA = runPairedArenaMatch(mlpBeliefBot, defaultBot, evalPairs, {
    maxPlies: 120,
    seedPrefix: 'oos-gate-mlp-belief',
    verbose: true,
  });
  printMatchSummary(mlpBeliefBot.name, defaultBot.name, gateA);
  const eloA = computeEloReport(gateA.winsA, gateA.draws, gateA.winsB);

  const acceptMlp = mlpRes.bestValLoss < mlpRes.baseValLoss && eloA.eloDiff >= 0;
  const acceptedMlpModel = acceptMlp ? mlpRes.model : { ...mlpRes.model, enabled: false };

  let finalEvalW: SucsEvalWeights = { ...DEFAULT_EVAL_WEIGHTS };
  let gateSummary = `Belief+MLP gate +${gateA.winsA}=${gateA.draws}-${gateA.winsB} (${eloA.eloDiff >= 0 ? '+' : ''}${eloA.eloDiff.toFixed(1)} Elo)`;

  if (spsaIters > 0) {
    console.log(`\n[Gate B] Verifying SPSA weights vs pre-SPSA candidate (${evalPairs} pairs = ${evalPairs * 2} games)...`);
    const spsaBot = makeSucsBot('SPSA-CAND', 'PANIC', {
      timeBudgetMs: 90,
      weights: tunedWeights,
      beliefWeights: beliefRes.bestWeights,
      mlpModel: acceptedMlpModel,
    });
    const preSpsaBot = makeSucsBot('PRE-SPSA', 'PANIC', {
      timeBudgetMs: 90,
      weights: DEFAULT_EVAL_WEIGHTS,
      beliefWeights: beliefRes.bestWeights,
      mlpModel: acceptedMlpModel,
    });
    const gateB = runPairedArenaMatch(spsaBot, preSpsaBot, evalPairs, {
      maxPlies: 120,
      seedPrefix: 'oos-gate-spsa',
      verbose: true,
    });
    printMatchSummary(spsaBot.name, preSpsaBot.name, gateB);
    const eloB = computeEloReport(gateB.winsA, gateB.draws, gateB.winsB);
    if (eloB.eloDiff > 15) {
      finalEvalW = tunedWeights;
    }
    gateSummary += `, SPSA gate +${gateB.winsA}=${gateB.draws}-${gateB.winsB} (${eloB.eloDiff >= 0 ? '+' : ''}${eloB.eloDiff.toFixed(1)} Elo)`;
  }

  if (shouldWrite) {
    const targetPath = path.resolve(process.cwd(), 'src/ai/trainedModels.ts');
    const meta = `Trained on ${games} mixed-league games (${evalSamples.length} pos, ${beliefSamples.length} fog snapshots), belief val lift ${beliefRes.baseScore.toFixed(4)}->${beliefRes.trainedScore.toFixed(4)}, MLP val BCE ${mlpRes.baseValLoss.toFixed(4)}->${mlpRes.bestValLoss.toFixed(4)}, ${gateSummary}.`;
    writeTrainedModelsFile(targetPath, finalEvalW, beliefRes.bestWeights, acceptedMlpModel, meta);
    console.log(`\nWrote verified production models to ${targetPath} (MLP enabled=${acceptedMlpModel.enabled})`);
  }
}

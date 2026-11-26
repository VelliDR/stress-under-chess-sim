import {
  chebyshevDistance,
  clonePiece,
  cloneTile,
  cloneTiles,
  coordEquals,
  createTile,
  getLegalMoves,
  getPieceAt,
  getTile,
  inBounds,
  isTileWalkable,
  manhattanDistance,
  opponentOf,
} from '../engine/board';
import {
  findMiasmaIgnitionOrigins,
  hasActiveShield,
  hasMiasma,
  isExtendedSpikes,
  isPressurePlate,
  isTelegraphSpikes,
} from '../engine/dungeon';
import {
  computeFogForSide,
  getPieceVisionRadius,
  hasSymmetricLosXY,
  isCoordVisibleToSide,
} from '../engine/fog';
import { fnv1a32, nextInt, seedToRngState } from '../engine/prng';
import { hasMoralProtection, isSilenced } from '../engine/psychology';
import { stepGame } from '../engine/reducer';
import { getLegalAbilities, hasTrait, LegalAbility } from '../engine/traits';
import {
  Coord,
  GameAction,
  GameState,
  LegalMove,
  Piece,
  Side,
  TileState,
  VisibleState,
} from '../engine/types';
import {
  buildMovementAwareBelief,
  evaluateRootGhostAmbushRisk,
  type BeliefModelWeights,
  type GhostHypothesis,
} from './beliefModel';
import {
  AiMemory,
  AI_PIECE_VALUES,
  createAiMemory,
  recordAiSelfMove,
  updateAiMemory,
} from './campaignAi';
import { clampEvalWeights, type SucsEvalWeights } from './evalWeights';
import { evaluateTinyMlp, NN_INPUT_DIM, type TinyMlpModel } from './nnEval';
import {
  TRAINED_BELIEF_WEIGHTS,
  TRAINED_EVAL_WEIGHTS,
  TRAINED_MLP_MODEL,
} from './trainedModels';
import { computeZobristHashInto, type ZobristHashOut } from './zobrist';

export type AiDifficulty = 'CALM' | 'TENSE' | 'PANIC';

export interface AiDifficultyProfile {
  id: AiDifficulty;
  name: string;
  badge: string;
  subtitle: string;
  timeBudgetMs: number;
  maxDepth: number;
  quiesceDepth: number;
  useBeliefRisk: boolean;
  useComboSetup: boolean;
  suboptimalBand: number;
}

export const AI_DIFFICULTY_PROFILES: Readonly<Record<AiDifficulty, AiDifficultyProfile>> = {
  CALM: {
    id: 'CALM',
    name: 'Stajyer',
    badge: 'SAKİN',
    subtitle: 'Temel hamleler yapar, tuzakları bazen gözden kaçırır.',
    timeBudgetMs: 45,
    maxDepth: 2,
    quiesceDepth: 0,
    useBeliefRisk: false,
    useComboSetup: false,
    suboptimalBand: 55,
  },
  TENSE: {
    id: 'TENSE',
    name: 'Taktisyen',
    badge: 'GERGİN',
    subtitle: 'Sis hafızası, gözetleme kuleleri ve taktiksel kombolar kullanır.',
    timeBudgetMs: 120,
    maxDepth: 4,
    quiesceDepth: 1,
    useBeliefRisk: true,
    useComboSetup: true,
    suboptimalBand: 2,
  },
  PANIC: {
    id: 'PANIC',
    name: 'S.U.C.S. Bot',
    badge: 'KABUS',
    subtitle:
      'Silüet inanç modeli, 2 hamleli İtme→Buz→Çukur tuzakları, Pusu zincirleri ve derin PVS+Zobrist araması.',
    timeBudgetMs: 220,
    maxDepth: 6,
    quiesceDepth: 2,
    useBeliefRisk: true,
    useComboSetup: true,
    suboptimalBand: 1,
  },
};

export const ALL_AI_DIFFICULTIES: readonly AiDifficulty[] = ['CALM', 'TENSE', 'PANIC'];

export interface SucsAiOptions {
  difficulty?: AiDifficulty;
  timeBudgetMs?: number;
  maxDepth?: number;
  rngState?: number;
  aiSide?: Side;
  nowMs?: () => number;
  weights?: Partial<SucsEvalWeights>;
  beliefWeights?: Partial<BeliefModelWeights>;
  mlpModel?: Readonly<TinyMlpModel>;
}

export interface SucsAiDecision {
  action: GameAction;
  score: number;
  completedDepth: number;
  nodesSearched: number;
  ttHits: number;
  elapsedMs: number;
  timedOut: boolean;
  difficulty: AiDifficulty;
  tacticalTag?: string;
  memory: AiMemory;
  nextRngState: number;
}

export interface StressMetrics {
  percent: number;
  label: string;
  tone: 'calm' | 'tense' | 'sweat' | 'panic';
  reasons: string[];
}

const ORTHO_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const INF = 1_000_000;
const MATE_THRESHOLD = 90_000;
const MAX_SEARCH_PLY = 32;

// Pre-allocated flat 64-bit Zobrist Transposition Table (32768 entries, O(1) generation clear).
// Reused across searches with instant generation bump for zero GC pressure & 100% determinism.
const TT_SIZE = 1 << 15;
const TT_MASK = TT_SIZE - 1;
const TT_EXACT = 1;
const TT_LOWER = 2;
const TT_UPPER = 3;

const ttKeyHi = new Uint32Array(TT_SIZE);
const ttKeyLo = new Uint32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttScore = new Int32Array(TT_SIZE);
const ttFlag = new Uint8Array(TT_SIZE);
const ttGen = new Uint16Array(TT_SIZE);
const ttBestCode = new Int32Array(TT_SIZE);
let currentTtGen = 0;

function resetTranspositionTable(): number {
  currentTtGen = (currentTtGen + 1) & 0xffff;
  if (currentTtGen === 0) {
    ttGen.fill(0);
    currentTtGen = 1;
  }
  return currentTtGen;
}

// Reusable scratch buffers for zero-allocation search heuristics & leaf vision counts
const historyTable = new Int32Array(2 * 64 * 256);
const killer1ByPly = new Int32Array(MAX_SEARCH_PLY);
const killer2ByPly = new Int32Array(MAX_SEARCH_PLY);
const pathHashHi = new Uint32Array(MAX_SEARCH_PLY);
const pathHashLo = new Uint32Array(MAX_SEARCH_PLY);
const visionStamps = new Uint32Array(256);
let visionEpoch = 0;
const nnFeatureBuf = new Float32Array(NN_INPUT_DIM);

interface VisionScratch {
  baseKnownCount: number;
}

interface PlateWiring {
  platePos: Coord;
  emitters: Array<{
    pos: Coord;
    dx: number;
    dy: number;
    flaming: boolean;
    piercing: boolean;
  }>;
}

interface BeliefContext {
  state: GameState;
  unexploredMask: boolean[][];
  oppKingVisibleAtRoot: boolean;
  beliefDangerGrid: number[][];
  ghosts: GhostHypothesis[];
  plateWirings: PlateWiring[];
}

interface OrderedAction {
  action: GameAction;
  code: number;
  orderScore: number;
  isTactical: boolean;
  isKiller: boolean;
  legalMove?: LegalMove;
}

function defaultNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function encodeActionCode(
  action: GameAction,
  width: number,
  getPieceSlot: (pieceId: string) => number,
): number {
  if (action.type === 'END_TURN') return 0;
  const slot = getPieceSlot(action.pieceId) & 63;
  if (action.type === 'MOVE') {
    const sq = (action.to.y * width + action.to.x) & 255;
    return (1 << 14) | (slot << 8) | sq;
  }
  const kind = action.ability === 'PUSH' ? 2 : 3;
  const sq = (action.target.y * width + action.target.x) & 255;
  return (kind << 14) | (slot << 8) | sq;
}

function historyIndexForCode(side: Side, code: number): number {
  const sideOffset = side === 'ENEMY' ? 64 * 256 : 0;
  return sideOffset + (code & 0x3fff);
}

function scoreToTT(score: number, ply: number): number {
  if (score >= MATE_THRESHOLD) return score + ply * 25;
  if (score <= -MATE_THRESHOLD) return score - ply * 25;
  return score;
}

function scoreFromTT(score: number, ply: number): number {
  if (score >= MATE_THRESHOLD) return score - ply * 25;
  if (score <= -MATE_THRESHOLD) return score + ply * 25;
  return score;
}

function countLeafAiVision(
  state: GameState,
  aiSide: Side,
  unexploredMask: readonly (readonly boolean[])[],
): { visibleTiles: number; visibleKnown: number } {
  visionEpoch = (visionEpoch + 1) >>> 0;
  if (visionEpoch === 0) {
    visionStamps.fill(0);
    visionEpoch = 1;
  }
  const epoch = visionEpoch;
  const width = state.width;
  const height = state.height;
  const tiles = state.tiles;
  const pieces = state.pieces;

  let visibleTiles = 0;
  let visibleKnown = 0;

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (piece.side !== aiSide) continue;
    const px = piece.pos.x;
    const py = piece.pos.y;
    if (px < 0 || px >= width || py < 0 || py >= height) continue;

    const radius = getPieceVisionRadius(state, piece);
    const minX = Math.max(0, px - radius);
    const maxX = Math.min(width - 1, px + radius);
    const minY = Math.max(0, py - radius);
    const maxY = Math.min(height - 1, py + radius);

    for (let y = minY; y <= maxY; y++) {
      const rowBase = y * width;
      const uRow = unexploredMask[y];
      for (let x = minX; x <= maxX; x++) {
        const idx = rowBase + x;
        if (visionStamps[idx] === epoch) continue;
        if (hasSymmetricLosXY(tiles, width, height, px, py, x, y)) {
          visionStamps[idx] = epoch;
          visibleTiles++;
          if (uRow !== undefined && uRow[x] === false) {
            visibleKnown++;
          }
        }
      }
    }
  }

  return { visibleTiles, visibleKnown };
}

/**
 * Simulates a potential 1-tile push along (dx, dy) including ICE slide chain (pure & read-only).
 * Detects PIT, SPIKES (telegraph/extended), BURNING, PRESSURE_PLATE, and MIASMA choke traps.
 */
function previewDirectionalPushHazard(
  state: GameState,
  victim: Piece,
  dx: number,
  dy: number,
  victimImmuneToIce: boolean,
): 'PIT' | 'SPIKES' | 'BURNING' | 'PLATE' | 'MIASMA_CHOKE' | 'SAFE' | 'BLOCKED' {
  const first: Coord = { x: victim.pos.x + dx, y: victim.pos.y + dy };
  if (!inBounds(state, first)) return 'BLOCKED';
  const firstTile = getTile(state, first);
  if (firstTile === undefined || firstTile === null || firstTile.type === 'WALL') return 'BLOCKED';
  if (getPieceAt(state.pieces, first) !== undefined) return 'BLOCKED';
  if (firstTile.type === 'PIT') return 'PIT';

  const classifyLanding = (
    tile: TileState,
  ): 'SPIKES' | 'BURNING' | 'PLATE' | 'MIASMA_CHOKE' | 'SAFE' => {
    if (isExtendedSpikes(tile) || isTelegraphSpikes(tile)) return 'SPIKES';
    if (tile.type === 'BURNING') return 'BURNING';
    if (isPressurePlate(tile) && tile.trap?.kind === 'PRESSURE_PLATE' && tile.trap.cooldown <= 0) {
      return 'PLATE';
    }
    if (hasMiasma(tile) && (victim.type === 'PAWN' || victim.type === 'KING')) {
      return 'MIASMA_CHOKE';
    }
    return 'SAFE';
  };

  if (firstTile.type !== 'ICE' || victimImmuneToIce) {
    return classifyLanding(firstTile);
  }

  // Trace ice slide inertia chain
  let cur = first;
  let curTile = firstTile;
  let hitPlate = false;
  for (let steps = 0; steps < 12; steps++) {
    if (
      isPressurePlate(curTile) &&
      curTile.trap?.kind === 'PRESSURE_PLATE' &&
      curTile.trap.cooldown <= 0
    ) {
      hitPlate = true;
    }
    const next: Coord = { x: cur.x + dx, y: cur.y + dy };
    if (!inBounds(state, next)) break;
    const nextTile = getTile(state, next);
    if (nextTile === undefined || nextTile === null || nextTile.type === 'WALL') break;
    if (getPieceAt(state.pieces, next) !== undefined) break;
    if (nextTile.type === 'PIT') return 'PIT';
    cur = next;
    curTile = nextTile;
    if (nextTile.type !== 'ICE') break;
  }
  const landHazard = classifyLanding(curTile);
  if (landHazard !== 'SAFE') return landHazard;
  return hitPlate ? 'PLATE' : 'SAFE';
}

function indexPlateWirings(tiles: readonly (readonly TileState[])[], width: number, height: number): PlateWiring[] {
  const emittersById = new Map<
    string,
    { pos: Coord; dx: number; dy: number; flaming: boolean; piercing: boolean }
  >();
  for (let y = 0; y < height; y++) {
    const row = tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x++) {
      const t = row[x];
      if (t?.trap?.kind === 'ARROW_EMITTER') {
        emittersById.set(t.trap.id, {
          pos: { x, y },
          dx: t.trap.dir.dx,
          dy: t.trap.dir.dy,
          flaming: t.trap.flaming,
          piercing: t.trap.piercing,
        });
      }
    }
  }
  if (emittersById.size === 0) return [];

  const wirings: PlateWiring[] = [];
  for (let y = 0; y < height; y++) {
    const row = tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x++) {
      const t = row[x];
      if (t?.trap?.kind !== 'PRESSURE_PLATE') continue;
      const linked: PlateWiring['emitters'] = [];
      for (let i = 0; i < t.trap.targetIds.length; i++) {
        const em = emittersById.get(t.trap.targetIds[i]!);
        if (em !== undefined) linked.push(em);
      }
      if (linked.length > 0) {
        wirings.push({ platePos: { x, y }, emitters: linked });
      }
    }
  }
  return wirings;
}

function buildBeliefContext(
  visible: VisibleState,
  memory: AiMemory,
  aiSide: Side,
  rngState: number,
  beliefWeights: Readonly<BeliefModelWeights>,
): BeliefContext {
  const tiles: TileState[][] = [];
  const unexploredMask: boolean[][] = [];

  for (let y = 0; y < visible.height; y++) {
    const tRow: TileState[] = [];
    const uRow: boolean[] = [];
    for (let x = 0; x < visible.width; x++) {
      const tile = visible.tiles[y]?.[x] ?? null;
      if (tile === null) {
        tRow.push(createTile('WALL'));
        uRow.push(true);
      } else {
        tRow.push(cloneTile(tile));
        uRow.push(false);
      }
    }
    tiles.push(tRow);
    unexploredMask.push(uRow);
  }

  const pieces: Piece[] = visible.pieces.map(clonePiece);

  const oppSide = opponentOf(aiSide);
  const oppKingVisibleAtRoot = pieces.some((p) => p.side === oppSide && p.type === 'KING');
  const aiFog = visible.fog.map((row) => row.slice());
  const oppFog = computeFogForSide(
    {
      width: visible.width,
      height: visible.height,
      tiles,
      pieces,
      factions: visible.factions,
    },
    oppSide,
  );

  const fog =
    aiSide === 'ENEMY'
      ? { PLAYER: oppFog, ENEMY: aiFog }
      : { PLAYER: aiFog, ENEMY: oppFog };

  const state: GameState = {
    width: visible.width,
    height: visible.height,
    tiles: cloneTiles(tiles),
    pieces,
    turn: visible.turn,
    turnNumber: visible.turnNumber,
    mode: visible.mode === 'CAMPAIGN' ? 'CAMPAIGN' : 'SKIRMISH',
    factions: { PLAYER: visible.factions.PLAYER, ENEMY: visible.factions.ENEMY },
    fog,
    pendingSpawns: visible.pendingSpawns.map((sp) => ({
      pos: { x: sp.pos.x, y: sp.pos.y },
      turnsRemaining: sp.turnsRemaining,
      side: sp.side,
      pieceType: sp.pieceType,
    })),
    bonusMovePieceId: visible.bonusMovePieceId,
    rngState: rngState || seedToRngState('sucs-belief'),
    actionHistory: [],
    winner: visible.winner,
    nextEntityId: 1000,
    bossCooldown: 0,
  };

  const analysis = buildMovementAwareBelief(visible, memory, aiSide, beliefWeights);
  const plateWirings = indexPlateWirings(state.tiles, state.width, state.height);
  return {
    state,
    unexploredMask,
    oppKingVisibleAtRoot,
    beliefDangerGrid: analysis.dangerGrid,
    ghosts: analysis.ghosts,
    plateWirings,
  };
}

function stepBeliefState(
  state: GameState,
  action: GameAction,
  aiSide: Side,
  oppKingVisibleAtRoot: boolean,
  precomputedLegalMove?: LegalMove,
): ReturnType<typeof stepGame> {
  const step = stepGame(state, action, {
    searchMode: true,
    precomputedLegalMove,
  });
  if (step.error !== undefined) return step;
  if (step.events.length === 1 && step.events[0]?.type === 'PIECE_DISOBEYED') {
    return { nextState: state, events: step.events, error: 'DISOBEYED' };
  }
  if (!oppKingVisibleAtRoot && step.nextState.winner === aiSide) {
    return {
      ...step,
      nextState: {
        ...step.nextState,
        winner: null,
      },
    };
  }
  return step;
}

function threatensKingSquare(mover: Piece, landing: Coord, oppKing: Piece | undefined): boolean {
  if (oppKing === undefined) return false;
  const dx = Math.abs(oppKing.pos.x - landing.x);
  const dy = Math.abs(oppKing.pos.y - landing.y);
  switch (mover.type) {
    case 'PAWN':
      return dx === 1 && oppKing.pos.y - landing.y === (mover.side === 'PLAYER' ? -1 : 1);
    case 'KNIGHT':
      return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
    case 'KING':
      return dx <= 1 && dy <= 1 && dx + dy > 0;
    case 'ROOK':
      return (dx === 0 || dy === 0) && dx + dy > 0;
    case 'BISHOP':
      return dx === dy && dx > 0;
    case 'QUEEN':
      return (dx === 0 || dy === 0 || dx === dy) && dx + dy > 0;
    case 'SAINT_FAITH':
    case 'SAINT_MADNESS':
      return (dx === 0 || dy === 0 || dx === dy) && Math.max(dx, dy) > 0 && Math.max(dx, dy) <= 2;
    case 'CHIMERA': {
      const dist = Math.max(dx, dy);
      if ((dx === 0 || dy === 0 || dx === dy) && dist > 0 && dist <= 3) return true;
      const forms = mover.absorbedForms ?? [];
      for (let i = 0; i < forms.length; i++) {
        const src = forms[i]!.sourceType;
        if ((src === 'ROOK' || src === 'QUEEN') && (dx === 0 || dy === 0) && dx + dy > 0) return true;
        if ((src === 'BISHOP' || src === 'QUEEN') && dx === dy && dx > 0) return true;
        if (src === 'KNIGHT' && ((dx === 1 && dy === 2) || (dx === 2 && dy === 1))) return true;
      }
      return false;
    }
  }
}

function scoreMoveOrdering(
  state: GameState,
  mover: Piece,
  move: LegalMove,
  oppKing: Piece | undefined,
): { priority: number; isTactical: boolean } {
  const res = move.resolution;
  if (res.fellInPit) return { priority: -50000, isTactical: false };

  let priority = 0;
  let isTactical = false;

  if (res.captured && res.hitPieceId !== null) {
    isTactical = true;
    const victim = state.pieces.find((p) => p.id === res.hitPieceId);
    const vVal = victim !== undefined ? AI_PIECE_VALUES[victim.type] : 100;
    if (victim?.type === 'KING') return { priority: 100000, isTactical: true };
    priority += 10000 + vVal * 10 - AI_PIECE_VALUES[mover.type];

    // High cut priority on enemies about to pop 3-turn Faith/Madness ultimates
    if (victim !== undefined) {
      if ((victim.faithCharge ?? 0) >= 2 || (victim.madnessCharge ?? 0) >= 2) {
        priority += 3600;
      }
      if (victim.berserkReady === true && !isSilenced(victim)) {
        priority += 2400;
      }
      // Capturing an EXPLOSIVE enemy next to MIASMA triggers GAS_CHAIN_DETONATED
      if (
        hasTrait(victim, 'EXPLOSIVE', state.factions) &&
        findMiasmaIgnitionOrigins(state.tiles, state.width, state.height, victim.pos).length > 0
      ) {
        priority += 2600;
      }
      // CHIMERA DNA diet: prize KNIGHT / QUEEN / ROOK / SAINT_MADNESS, avoid overwriting 2 elite forms with a trait-pawn
      if (mover.type === 'CHIMERA') {
        if (victim.type === 'QUEEN') priority += 2400;
        else if (victim.type === 'KNIGHT' || victim.type === 'ROOK') priority += 1900;
        else if (victim.type === 'SAINT_MADNESS') priority += 2000;
        else if (victim.type === 'SAINT_FAITH') priority += 1500;
        else if (
          victim.type === 'PAWN' &&
          victim.traits.length > 0 &&
          (mover.absorbedForms?.length ?? 0) >= 2
        ) {
          priority -= 1100;
        }
      }
      // Psychological cascade priority: killing a piece within Chebyshev <= 2 of a fragile enemy triggers ALLY_DEATH breakdown!
      for (let cIdx = 0; cIdx < state.pieces.length; cIdx++) {
        const nearby = state.pieces[cIdx]!;
        if (
          nearby.side !== victim.side ||
          nearby.id === victim.id ||
          nearby.type === 'KING' ||
          nearby.type === 'CHIMERA'
        ) {
          continue;
        }
        if ((nearby.composure ?? 3) <= 2 && chebyshevDistance(nearby.pos, victim.pos) <= 2) {
          priority += (nearby.composure ?? 3) === 1 ? 1500 : 700;
          break;
        }
      }
    }
  } else if (res.brokeShield) {
    isTactical = true;
    const victim =
      res.hitPieceId !== null ? state.pieces.find((p) => p.id === res.hitPieceId) : undefined;
    priority += victim?.type === 'KING' ? 5400 : 3400;
    if (victim !== undefined && (victim.composure ?? 3) <= 2) {
      priority += 1100;
    }
    if (hasTrait(mover, 'FROST_TOUCH', state.factions)) priority += 1200;
  }

  if (res.promotes) {
    isTactical = true;
    priority += 6500;
  }

  const endPos = res.finalPos ?? move.to;
  if (threatensKingSquare(mover, endPos, oppKing)) {
    priority += 2600;
  }

  // Quiescence tactical triggers: PRESSURE_PLATE activation along path, or 3rd-turn FAITH_ULTIMATE positioning
  for (let pIdx = 1; pIdx < res.path.length; pIdx++) {
    const pt = res.path[pIdx]!;
    const t = state.tiles[pt.y]?.[pt.x];
    if (isPressurePlate(t) && t?.trap?.kind === 'PRESSURE_PLATE' && t.trap.cooldown <= 0) {
      priority += 2800;
      isTactical = true;
      break;
    }
  }

  if ((mover.faithCharge ?? 0) >= 2) {
    const friendlyFaith = state.pieces.find(
      (p) =>
        p.side === mover.side &&
        p.type === 'SAINT_FAITH' &&
        !isSilenced(p) &&
        chebyshevDistance(p.pos, endPos) <= 2,
    );
    if (friendlyFaith !== undefined) {
      priority += 2400;
      isTactical = true;
    }
  }

  // Reward stepping onto a soon-to-hatch enemy Necromancer spawn marker to deny it
  const oppSide = opponentOf(mover.side);
  if (
    state.pendingSpawns.some(
      (sp) => sp.side === oppSide && sp.turnsRemaining === 1 && coordEquals(sp.pos, endPos),
    )
  ) {
    priority += 1500;
  }

  // Reward FROST_TOUCH moving next to unfrozen high-value enemies (HUGE boost if enemy stands on lethal tile!)
  if (hasTrait(mover, 'FROST_TOUCH', state.factions)) {
    for (let d = 0; d < ORTHO_DIRS.length; d++) {
      const dir = ORTHO_DIRS[d]!;
      const adj = getPieceAt(state.pieces, { x: endPos.x + dir.x, y: endPos.y + dir.y }, mover.id);
      if (adj !== undefined && adj.side === oppSide && adj.frozenTurns === 0 && adj.type !== 'CHIMERA') {
        const adjTile = state.tiles[adj.pos.y]?.[adj.pos.x];
        const adjOnLethal =
          !hasActiveShield(adj) &&
          (adjTile?.type === 'BURNING' ||
            isTelegraphSpikes(adjTile) ||
            (hasMiasma(adjTile) && (adj.miasmaExposure ?? 0) >= 1));
        if (adjOnLethal) {
          priority += adj.type === 'KING' ? 9000 : 4600;
        } else {
          priority += adj.type === 'KING' || adj.type === 'QUEEN' ? 2200 : 1200;
        }
        isTactical = true;
        break;
      }
    }
  }

  // Reward placing a cheap EXPLOSIVE unit adjacent to a MIASMA pocket as a live chain-bomb threat
  if (
    mover.type !== 'KING' &&
    AI_PIECE_VALUES[mover.type] <= 340 &&
    hasTrait(mover, 'EXPLOSIVE', state.factions) &&
    findMiasmaIgnitionOrigins(state.tiles, state.width, state.height, endPos).length > 0
  ) {
    priority += 1900;
    isTactical = true;
  }

  const endTile = state.tiles[endPos.y]?.[endPos.x];
  if (endTile?.type === 'WATCHTOWER') priority += 1300;
  const shielded = hasActiveShield(mover);
  if (res.endsOnBurning && !shielded) priority -= 8500;
  if (isExtendedSpikes(endTile) && !shielded) priority -= 9400;
  if (isTelegraphSpikes(endTile) && !shielded) priority -= 9000;
  if (hasMiasma(endTile) && mover.type !== 'CHIMERA' && (mover.miasmaExposure ?? 0) >= 1 && !shielded) {
    priority -= 8200;
  }

  const cx = (state.width - 1) / 2;
  const cy = (state.height - 1) / 2;
  priority += Math.max(0, 40 - Math.round((Math.abs(endPos.x - cx) + Math.abs(endPos.y - cy)) * 5));

  return { priority, isTactical };
}

function scoreAbilityOrdering(
  state: GameState,
  mover: Piece,
  ability: LegalAbility,
  unexploredMask: readonly (readonly boolean[])[],
): { priority: number; isTactical: boolean } {
  if (ability.ability === 'PUSH' && ability.pushPreview !== undefined) {
    const pp = ability.pushPreview;
    if (pp.blocked) return { priority: -500, isTactical: false };
    const victim = getPieceAt(state.pieces, ability.target);
    if (pp.fellInPit) {
      return {
        priority:
          victim?.type === 'KING'
            ? 96000
            : 9500 + (victim !== undefined ? AI_PIECE_VALUES[victim.type] * 9 : 600),
        isTactical: true,
      };
    }
    if (pp.finalPos !== null) {
      const landTile = state.tiles[pp.finalPos.y]?.[pp.finalPos.x];
      if (isTelegraphSpikes(landTile) || isExtendedSpikes(landTile)) {
        return {
          priority:
            victim?.type === 'KING'
              ? 92000
              : 8800 + (victim !== undefined ? AI_PIECE_VALUES[victim.type] * 8 : 500),
          isTactical: true,
        };
      }
      if (landTile?.type === 'BURNING') {
        return {
          priority: victim?.type === 'KING' ? 6800 : 2800,
          isTactical: true,
        };
      }
      if (isPressurePlate(landTile)) {
        return { priority: 3200, isTactical: true };
      }
    }
    if (pp.slid) return { priority: 1400, isTactical: true };
    return { priority: 420, isTactical: false };
  }

  // SIEGE_ENGINEERS BREAK_WALL: inspect corridor behind the wall
  const dx = ability.target.x - mover.pos.x;
  const dy = ability.target.y - mover.pos.y;
  const oppSide = opponentOf(mover.side);
  let corridorBonus = 480;
  for (let step = 1; step <= 4; step++) {
    const cx = ability.target.x + dx * step;
    const cy = ability.target.y + dy * step;
    if (cx < 0 || cx >= state.width || cy < 0 || cy >= state.height) break;
    const occ = getPieceAt(state.pieces, { x: cx, y: cy });
    if (occ !== undefined) {
      if (occ.side === oppSide) {
        corridorBonus += occ.type === 'KING' ? 4200 : 1800;
      }
      break;
    }
    if (unexploredMask[cy]?.[cx] === true) {
      corridorBonus += 650;
      break;
    }
    const t = state.tiles[cy]?.[cx];
    if (t?.type === 'WATCHTOWER') {
      corridorBonus += 500;
    } else if (t?.type === 'WALL') {
      break;
    }
  }
  return { priority: corridorBonus, isTactical: corridorBonus >= 1800 };
}

function generateOrderedActions(
  state: GameState,
  unexploredMask: readonly (readonly boolean[])[],
  pvCode: number,
  killer1Code: number,
  killer2Code: number,
  getPieceSlot: (pieceId: string) => number,
  tacticalOnly: boolean,
): OrderedAction[] {
  const side = state.turn;
  const oppSide = opponentOf(side);
  const oppKing = state.pieces.find((p) => p.side === oppSide && p.type === 'KING');
  const activeOnly = state.mode === 'CAMPAIGN' && side === 'ENEMY';
  const width = state.width;
  const result: OrderedAction[] = [];

  for (let i = 0; i < state.pieces.length; i++) {
    const piece = state.pieces[i]!;
    if (piece.side !== side) continue;
    if (piece.frozenTurns > 0) continue;
    if (activeOnly && piece.aggro !== 'ACTIVE') continue;
    if (state.bonusMovePieceId !== null && state.bonusMovePieceId !== piece.id) continue;

    const moves = getLegalMoves(state, piece, state.bonusMovePieceId);
    const pieceActions: OrderedAction[] = [];
    for (let m = 0; m < moves.length; m++) {
      const move = moves[m]!;
      const scored = scoreMoveOrdering(state, piece, move, oppKing);
      if (tacticalOnly && !scored.isTactical && state.bonusMovePieceId === null) continue;
      const action: GameAction = {
        type: 'MOVE',
        pieceId: piece.id,
        to: { x: move.to.x, y: move.to.y },
      };
      const code = encodeActionCode(action, width, getPieceSlot);
      const isPv = pvCode !== -1 && code === pvCode;
      const isK1 = !isPv && killer1Code !== -1 && code === killer1Code;
      const isK2 = !isPv && !isK1 && killer2Code !== -1 && code === killer2Code;
      const isKiller = isK1 || isK2;
      let orderScore: number;
      if (isPv) {
        orderScore = 2_000_000;
      } else if (scored.priority >= 90_000) {
        orderScore = 1_500_000 + scored.priority;
      } else if (scored.isTactical) {
        orderScore = 600_000 + scored.priority;
      } else if (isK1) {
        orderScore = 520_000;
      } else if (isK2) {
        orderScore = 510_000;
      } else {
        orderScore = scored.priority + (historyTable[historyIndexForCode(side, code)] ?? 0);
      }
      pieceActions.push({
        action,
        code,
        orderScore,
        isTactical: scored.isTactical,
        isKiller,
        legalMove: move,
      });
    }

    // Branching factor guard (PANIC Depth 6 + Q2): when multi-form CHIMERA reaches 25+ legal moves,
    // keep the top 14 highest-priority tactical/central moves at non-quiescence nodes.
    if (!tacticalOnly && piece.type === 'CHIMERA' && pieceActions.length >= 25) {
      pieceActions.sort((a, b) => b.orderScore - a.orderScore);
      pieceActions.length = 14;
    }

    for (let k = 0; k < pieceActions.length; k++) {
      result.push(pieceActions[k]!);
    }

    const abilities = getLegalAbilities(state, piece, state.bonusMovePieceId);
    for (let a = 0; a < abilities.length; a++) {
      const ab = abilities[a]!;
      // Never break a synthetic WALL standing in for an UNEXPLORED fog square
      if (ab.ability === 'BREAK_WALL' && unexploredMask[ab.target.y]?.[ab.target.x] === true) {
        continue;
      }
      const scored = scoreAbilityOrdering(state, piece, ab, unexploredMask);
      if (tacticalOnly && !scored.isTactical && state.bonusMovePieceId === null) continue;
      const action: GameAction = {
        type: 'USE_ABILITY',
        pieceId: piece.id,
        ability: ab.ability,
        target: { x: ab.target.x, y: ab.target.y },
      };
      const code = encodeActionCode(action, width, getPieceSlot);
      const isPv = pvCode !== -1 && code === pvCode;
      const isK1 = !isPv && killer1Code !== -1 && code === killer1Code;
      const isK2 = !isPv && !isK1 && killer2Code !== -1 && code === killer2Code;
      const isKiller = isK1 || isK2;
      let orderScore: number;
      if (isPv) {
        orderScore = 2_000_000;
      } else if (scored.priority >= 90_000) {
        orderScore = 1_500_000 + scored.priority;
      } else if (scored.isTactical) {
        orderScore = 600_000 + scored.priority;
      } else if (isK1) {
        orderScore = 520_000;
      } else if (isK2) {
        orderScore = 510_000;
      } else {
        orderScore = scored.priority + (historyTable[historyIndexForCode(side, code)] ?? 0);
      }
      result.push({
        action,
        code,
        orderScore,
        isTactical: scored.isTactical,
        isKiller,
      });
    }
  }

  result.sort((a, b) => b.orderScore - a.orderScore);

  if (!tacticalOnly && result.length === 0) {
    result.push({
      action: { type: 'END_TURN' },
      code: 0,
      orderScore: 0,
      isTactical: false,
      isKiller: false,
    });
  }

  return result;
}

function countKingSafeEscapes(state: GameState, king: Piece): number {
  const kx = king.pos.x;
  const ky = king.pos.y;
  let safe = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = kx + dx;
      const ny = ky + dy;
      if (nx < 0 || nx >= state.width || ny < 0 || ny >= state.height) continue;
      const tile = state.tiles[ny]?.[nx];
      if (!isTileWalkable(tile)) continue;
      if (tile?.type === 'BURNING' || isExtendedSpikes(tile) || isTelegraphSpikes(tile)) continue;
      const occ = getPieceAt(state.pieces, { x: nx, y: ny }, king.id);
      if (occ !== undefined && occ.side === king.side) continue;
      safe++;
    }
  }
  return safe;
}

function evaluateSucsBeliefState(
  state: GameState,
  aiSide: Side,
  ply: number,
  profile: AiDifficultyProfile,
  rememberedCoords: readonly Coord[],
  silhouetteCoords: readonly Coord[],
  watchtowers: readonly Coord[],
  fogSweepTargets: readonly Coord[],
  unexploredMask: readonly (readonly boolean[])[],
  beliefDangerGrid: readonly (readonly number[])[],
  plateWirings: readonly PlateWiring[],
  visionScratch: VisionScratch,
  w: Readonly<SucsEvalWeights>,
  mlpModel: Readonly<TinyMlpModel>,
  fillNnFeatures = mlpModel.enabled,
): number {
  const oppSide = opponentOf(aiSide);

  if (state.winner !== null) {
    if (state.winner === aiSide) return 100000 - ply * 25;
    if (state.winner === oppSide) return -100000 + ply * 25;
    return 0;
  }

  let score = 0;
  let visibleOppCount = 0;
  const centerX = (state.width - 1) / 2;
  const centerY = (state.height - 1) / 2;
  const oppBackRowY = oppSide === 'PLAYER' ? state.height - 1 : 0;

  let myKing: Piece | undefined;
  let oppKing: Piece | undefined;
  let myCount = 0;
  let myNonKingMat = 0;
  let oppNonKingMat = 0;

  // Counters for the 28-dim tiny MLP residual feature vector (zero allocations)
  let shieldDiff = 0;
  let frozenDiff = 0;
  let frozenLethalDiff = 0;
  let fragileDiff = 0;
  let shakenDiff = 0;
  let isolatedFragileDiff = 0;
  let auraNearUltDiff = 0;
  let berserkDiff = 0;
  let silencedDiff = 0;
  let chimeraFormDiff = 0;
  let stealthAmbushDiff = 0;
  let kingHazardDiff = 0;
  let pusherSetupDiff = 0;
  let explosiveBombDiff = 0;
  let plateZoneDiff = 0;
  let crackedVulnDiff = 0;
  let watchCenterDiff = 0;
  let pawnProgDiff = 0;
  let spawnCtrlDiff = 0;
  let beliefDangerSum = 0;

  const pieces = state.pieces;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.side === aiSide) {
      myCount++;
      if (p.type === 'KING') myKing = p;
      else myNonKingMat += AI_PIECE_VALUES[p.type];
    } else {
      visibleOppCount++;
      if (p.type === 'KING') oppKing = p;
      else oppNonKingMat += AI_PIECE_VALUES[p.type];
    }
  }

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    const isMine = p.side === aiSide;
    const sign = isMine ? 1 : -1;

    let pieceScore = AI_PIECE_VALUES[p.type];
    const silenced = isSilenced(p);
    const activeShield = hasActiveShield(p);
    let traitMask = 0;

    if (silenced) {
      pieceScore -= w.silencePenalty;
      silencedDiff += sign;
    } else {
      if (activeShield) {
        pieceScore += p.type === 'KING' ? w.kingShieldBonus : w.unitShieldBonus;
        shieldDiff += sign;
      }
      // Single-pass effective trait mask
      const pTraits = p.traits;
      for (let ti = 0; ti < pTraits.length; ti++) {
        switch (pTraits[ti]) {
          case 'FROST_TOUCH': traitMask |= 1; break;
          case 'EXPLOSIVE': traitMask |= 2; break;
          case 'PUSHER': traitMask |= 4; break;
          case 'SCOUT': traitMask |= 8; break;
          case 'SHADOW_WALKER': traitMask |= 16; break;
          case 'DASH_ON_REVEAL': traitMask |= 32; break;
        }
      }
      if (p.type === 'KNIGHT' && state.factions[p.side] === 'RAIDERS') {
        traitMask |= 32;
      }
      if (p.type === 'CHIMERA' && p.absorbedForms !== undefined) {
        const forms = p.absorbedForms;
        for (let fi = 0; fi < forms.length; fi++) {
          const copied = forms[fi]!.copiedTraits;
          for (let ci = 0; ci < copied.length; ci++) {
            switch (copied[ci]) {
              case 'FROST_TOUCH': traitMask |= 1; break;
              case 'EXPLOSIVE': traitMask |= 2; break;
              case 'PUSHER': traitMask |= 4; break;
              case 'SCOUT': traitMask |= 8; break;
              case 'SHADOW_WALKER': traitMask |= 16; break;
              case 'DASH_ON_REVEAL': traitMask |= 32; break;
            }
          }
        }
      }
      if ((traitMask & 1) !== 0) pieceScore += w.frostTouchTrait;
      if ((traitMask & 2) !== 0) pieceScore += w.explosiveTrait;
      if ((traitMask & 4) !== 0) pieceScore += w.pusherTrait;
      if ((traitMask & 8) !== 0) pieceScore += w.scoutTrait;
      if ((traitMask & 16) !== 0) pieceScore += w.shadowWalkerTrait;
      if ((traitMask & 32) !== 0) {
        pieceScore += w.dashOnRevealTrait;
        if (!p.wasVisibleAtTurnStart) pieceScore += w.dashHiddenReadyBonus;
      }
      if (p.berserkReady === true) {
        pieceScore += w.berserkReadyBonus;
        berserkDiff += sign;
      }
    }

    // Aura charge urgency (charge === 2 is 1 turn from massive ultimate!)
    if ((p.faithCharge ?? 0) >= 2) {
      pieceScore += w.auraCharge2Bonus;
      auraNearUltDiff += sign;
    } else if ((p.faithCharge ?? 0) === 1) {
      pieceScore += w.auraCharge1Bonus;
    }
    if ((p.madnessCharge ?? 0) >= 2) {
      pieceScore += w.auraCharge2Bonus;
      auraNearUltDiff += sign;
    } else if ((p.madnessCharge ?? 0) === 1) {
      pieceScore += w.auraCharge1Bonus;
    }

    // SAINT_FAITH positioning bonus scaled by enemy buff density within Chebyshev <= 3 (7x7 silence pulse!)
    if (p.type === 'SAINT_FAITH' && !silenced) {
      let enemyBuffDensity = 0;
      for (let eIdx = 0; eIdx < pieces.length; eIdx++) {
        const other = pieces[eIdx]!;
        if (other.side === p.side || other.type === 'CHIMERA') continue;
        if (chebyshevDistance(p.pos, other.pos) > 3) continue;
        if (other.shieldActive) enemyBuffDensity += 1;
        enemyBuffDensity += other.traits.length;
        if (other.berserkReady === true) enemyBuffDensity += 2;
        if (other.type === 'SAINT_FAITH' || other.type === 'SAINT_MADNESS') enemyBuffDensity += 2;
      }
      pieceScore += enemyBuffDensity * w.saintFaithBuffDensityScale;
    }

    // CHIMERA absorbed forms & synergy diet valuation
    if (p.type === 'CHIMERA' && p.absorbedForms !== undefined && p.absorbedForms.length > 0) {
      let hasKnight = false;
      let hasSlider = false;
      let hasMadnessPierce = false;
      for (let f = 0; f < p.absorbedForms.length; f++) {
        const form = p.absorbedForms[f]!;
        if (form.sourceType === 'KNIGHT') {
          pieceScore += w.chimeraKnightForm;
          hasKnight = true;
          chimeraFormDiff += sign;
        } else if (form.sourceType === 'ROOK') {
          pieceScore += w.chimeraRookForm;
          hasSlider = true;
          chimeraFormDiff += sign;
        } else if (form.sourceType === 'QUEEN') {
          pieceScore += w.chimeraQueenForm;
          hasSlider = true;
          chimeraFormDiff += sign * 1.5;
        } else if (form.sourceType === 'BISHOP') {
          pieceScore += w.chimeraBishopForm;
          hasSlider = true;
          chimeraFormDiff += sign * 0.7;
        } else if (form.sourceType === 'SAINT_FAITH' || form.sourceType === 'SAINT_MADNESS') {
          pieceScore += w.chimeraSaintForm;
          chimeraFormDiff += sign;
        }
        if (form.saintEcho === 'MADNESS_PIERCE') {
          pieceScore += 110;
          hasMadnessPierce = true;
        } else if (form.saintEcho === 'FAITH_WARD') {
          pieceScore += 80;
        }
        pieceScore += form.copiedTraits.length * 35;
      }
      if ((hasKnight && hasSlider) || (hasMadnessPierce && (hasKnight || hasSlider))) {
        pieceScore += w.chimeraSynergyCombo;
      }
    }

    const tile = getTile(state, p.pos);
    const onBurning = tile?.type === 'BURNING';
    const onTelegraphSpike = isTelegraphSpikes(tile);
    const onLethalMiasma = hasMiasma(tile) && p.type !== 'CHIMERA' && (p.miasmaExposure ?? 0) >= 1;
    const onAnyLethalNextTurn = onBurning || onTelegraphSpike || onLethalMiasma;

    if (p.frozenTurns > 0) {
      frozenDiff += sign;
      const baseFreeze =
        p.type === 'KING' || p.type === 'QUEEN' ? 110 : p.type === 'ROOK' ? 85 : 60;
      pieceScore -= Math.round(baseFreeze * p.frozenTurns * w.frozenBaseScale);

      // Kahpelik #1: FROZEN × LETHAL TILE = guaranteed death next turn!
      if (onAnyLethalNextTurn && !activeShield) {
        frozenLethalDiff += sign;
        pieceScore -=
          p.type === 'KING'
            ? w.frozenKingOnLethalPenalty
            : Math.round(AI_PIECE_VALUES[p.type] * w.frozenOnLethalTileRatio);
      }
    }

    if (tile?.type === 'WATCHTOWER') {
      pieceScore += w.watchtowerBonus;
      watchCenterDiff += sign * 2;
    }
    if (onBurning) {
      if (p.type === 'KING') kingHazardDiff += sign;
      pieceScore -= activeShield
        ? 45
        : p.type === 'KING'
          ? 3800
          : Math.round(AI_PIECE_VALUES[p.type] * 0.72);
    }
    if (onTelegraphSpike) {
      if (p.type === 'KING') kingHazardDiff += sign;
      pieceScore -= activeShield
        ? 60
        : p.type === 'KING'
          ? 4500
          : Math.round(AI_PIECE_VALUES[p.type] * 0.8);
    }
    if (hasMiasma(tile)) {
      if (p.type === 'CHIMERA') {
        // Kahpelik #2: Chimera uses Miasma as immune smoke-screen cover!
        pieceScore += w.chimeraMiasmaCoverBonus;
        stealthAmbushDiff += sign * 0.6;
      } else if ((p.miasmaExposure ?? 0) >= 1) {
        if (p.type === 'KING') kingHazardDiff += sign;
        pieceScore -= activeShield
          ? 65
          : p.type === 'KING'
            ? 3600
            : Math.round(AI_PIECE_VALUES[p.type] * 0.7);
      } else {
        pieceScore -= 40;
      }
    }

    // Kahpelik #3: CRACKED tile blast vulnerability (collapses to PIT even through SHIELDED!)
    if (tile?.type === 'CRACKED' && profile.useComboSetup) {
      const miasmaNear =
        hasMiasma(tile) ||
        findMiasmaIgnitionOrigins(state.tiles, state.width, state.height, p.pos).length > 0;
      let adjEnemyExplosive = false;
      for (let d = 0; d < ORTHO_DIRS.length; d++) {
        const adj = getPieceAt(
          pieces,
          { x: p.pos.x + ORTHO_DIRS[d]!.x, y: p.pos.y + ORTHO_DIRS[d]!.y },
          p.id,
        );
        if (adj !== undefined && adj.side !== p.side && hasTrait(adj, 'EXPLOSIVE', state.factions)) {
          adjEnemyExplosive = true;
          break;
        }
      }
      if (miasmaNear || adjEnemyExplosive) {
        pieceScore -= p.type === 'KING' ? w.crackedUnderBlastPenalty * 3 : w.crackedUnderBlastPenalty;
        crackedVulnDiff += sign;
      }
    }

    // Kahpelik #4: Psychological Warfare (Composure 2/1/0, Disobedience isolation lock, ALLY_DEATH cascade)
    if (
      p.type !== 'KING' &&
      p.type !== 'CHIMERA' &&
      p.type !== 'SAINT_FAITH' &&
      p.type !== 'SAINT_MADNESS'
    ) {
      const comp = p.composure ?? 3;
      if (comp === 2) {
        pieceScore -= w.composureShakenPenalty;
        shakenDiff += sign;
      } else if (comp === 1) {
        pieceScore -= w.composureFragilePenalty;
        fragileDiff += sign;
        if (!(p.berserkReady === true && !silenced) && !hasMoralProtection(state, p)) {
          pieceScore -= w.disobedienceIsolatedPenalty;
          isolatedFragileDiff += sign;
          // Extra lock penalty if an opponent piece is close enough to threaten its escape squares
          for (let oIdx = 0; oIdx < pieces.length; oIdx++) {
            const foe = pieces[oIdx]!;
            if (foe.side !== p.side && foe.frozenTurns === 0 && chebyshevDistance(foe.pos, p.pos) <= 3) {
              pieceScore -= w.disobedienceThreatenedLockBonus;
              break;
            }
          }
        }
      } else if (comp === 0) {
        pieceScore -= w.composureBreakdownPenalty;
        fragileDiff += sign * 1.5;
      }
    }

    // Center control & pawn promotion progress
    const centerBonus = Math.max(
      0,
      Math.round((14 - (Math.abs(p.pos.x - centerX) + Math.abs(p.pos.y - centerY)) * 2) * w.centerBonusScale),
    );
    pieceScore += centerBonus;
    watchCenterDiff += sign * (centerBonus * 0.05);

    if (p.type === 'PAWN') {
      const progress = p.side === 'PLAYER' ? state.height - 1 - p.pos.y : p.pos.y;
      pieceScore += progress * w.pawnProgressScale;
      pawnProgDiff += sign * progress;
    }

    // Kahpelik #5: Fair Fog-of-War Stealth Ambush Staging (DASH_ON_REVEAL & SHADOW_WALKER)
    if (profile.useComboSetup && visibleOppCount > 0 && ((traitMask & 48) !== 0)) {
      const enemySide = opponentOf(p.side);
      const hiddenFromFoe = !isCoordVisibleToSide(state, enemySide, p.pos);
      if (hiddenFromFoe) {
        // Check proximity to an enemy target (striking distance)
        let nearFoe = false;
        for (let oIdx = 0; oIdx < pieces.length; oIdx++) {
          const foe = pieces[oIdx]!;
          if (foe.side === enemySide && chebyshevDistance(p.pos, foe.pos) <= 4) {
            nearFoe = true;
            break;
          }
        }
        if (nearFoe) {
          if ((traitMask & 32) !== 0 && !p.wasVisibleAtTurnStart) {
            pieceScore += w.dashAmbushStagingBonus;
            stealthAmbushDiff += sign;
          }
          if ((traitMask & 16) !== 0) {
            pieceScore += w.shadowWalkerFlankBonus;
            stealthAmbushDiff += sign * 0.8;
          }
        }
      }
    }

    // S.U.C.S. Movement-Aware Bayesian Fog Belief Risk Modeling (100% fair)
    if (profile.useBeliefRisk && isMine) {
      const danger = beliefDangerGrid[p.pos.y]?.[p.pos.x] ?? 0;
      if (danger > 0) {
        if (p.type === 'PAWN' && (activeShield || (traitMask & 8) !== 0)) {
          // Cheap scouts / shielded pawns are encouraged to probe silhouettes!
          pieceScore += Math.min(30, Math.round(danger * 0.42 * w.beliefRiskScale));
        } else {
          const valScale =
            p.type === 'KING'
              ? 1.65
              : p.type === 'QUEEN' || p.type === 'CHIMERA'
                ? 1.45
                : p.type === 'ROOK' || p.type === 'SAINT_FAITH' || p.type === 'SAINT_MADNESS'
                  ? 0.95
                  : activeShield
                    ? 0.22
                    : 0.55;
          const pen = Math.round(danger * valScale * w.beliefRiskScale);
          pieceScore -= pen;
          beliefDangerSum += pen;
        }
      }
    }

    // S.U.C.S. Mechanic Combo Heuristics (Expanded PUSHER traps, EXPLOSIVE × MIASMA bombs, ALLY_DEATH cascade)
    if (profile.useComboSetup && !silenced) {
      if ((traitMask & 4) !== 0 && p.frozenTurns === 0) {
        for (let d = 0; d < ORTHO_DIRS.length; d++) {
          const dir = ORTHO_DIRS[d]!;
          const adjPos: Coord = { x: p.pos.x + dir.x, y: p.pos.y + dir.y };
          const victim = getPieceAt(pieces, adjPos, p.id);
          if (victim === undefined || victim.side === p.side) continue;
          const victimIceImmune =
            victim.type === 'KNIGHT' || state.factions[victim.side] === 'FROST_WARDENS';
          const hazard = previewDirectionalPushHazard(
            state,
            victim,
            dir.x,
            dir.y,
            victimIceImmune,
          );
          if (hazard === 'PIT') {
            pieceScore += victim.type === 'KING' ? w.pusherPitKingBonus : w.pusherPitUnitBonus;
            pusherSetupDiff += sign * (victim.type === 'KING' ? 2.5 : 1.2);
          } else if (hazard === 'SPIKES' && !hasActiveShield(victim)) {
            pieceScore += victim.type === 'KING' ? w.pusherSpikeKingBonus : w.pusherSpikeUnitBonus;
            pusherSetupDiff += sign * (victim.type === 'KING' ? 2.2 : 1.0);
          } else if (hazard === 'BURNING' && !hasActiveShield(victim)) {
            pieceScore += victim.type === 'KING' ? w.pusherBurnKingBonus : w.pusherBurnUnitBonus;
            pusherSetupDiff += sign * 0.8;
          } else if (hazard === 'PLATE') {
            pieceScore += w.pusherPlateBonus;
            pusherSetupDiff += sign * 0.7;
          } else if (hazard === 'MIASMA_CHOKE') {
            pieceScore += w.pusherMiasmaChokeBonus;
            pusherSetupDiff += sign * 0.7;
          }
        }
      }

      if ((traitMask & 2) !== 0) {
        let adjUnshieldedFoes = 0;
        let adjUnshieldedFoeKing = false;
        for (let d = 0; d < ORTHO_DIRS.length; d++) {
          const dir = ORTHO_DIRS[d]!;
          const adj = getPieceAt(pieces, { x: p.pos.x + dir.x, y: p.pos.y + dir.y }, p.id);
          if (adj !== undefined && adj.side !== p.side && !hasActiveShield(adj)) {
            adjUnshieldedFoes++;
            if (adj.type === 'KING') adjUnshieldedFoeKing = true;
          }
        }
        if (adjUnshieldedFoes >= 2) {
          pieceScore += adjUnshieldedFoes * w.explosiveClusterBonus;
          explosiveBombDiff += sign * 0.8;
        }
        if (adjUnshieldedFoeKing) {
          pieceScore += w.explosiveKingAdjBonus;
          explosiveBombDiff += sign * 1.2;
        }
        // Live MIASMA bomb setup: cheap EXPLOSIVE adjacent to MIASMA while enemies are near/in MIASMA
        if (
          p.type !== 'KING' &&
          AI_PIECE_VALUES[p.type] <= 340 &&
          findMiasmaIgnitionOrigins(state.tiles, state.width, state.height, p.pos).length > 0
        ) {
          let foesInMiasma = 0;
          for (let oIdx = 0; oIdx < pieces.length; oIdx++) {
            const foe = pieces[oIdx]!;
            if (foe.side === p.side || foe.type === 'CHIMERA') continue;
            if (hasMiasma(getTile(state, foe.pos))) foesInMiasma++;
          }
          if (foesInMiasma > 0) {
            pieceScore += w.explosiveMiasmaBombBonus * Math.min(2, foesInMiasma);
            explosiveBombDiff += sign * foesInMiasma;
          }
        }
      }
    }

    score += sign * pieceScore;
  }

  // Kahpelik #6: ALLY_DEATH Composure Cascade setup & King Box Escape Squeeze
  let oppKingSafe = 5;
  let myKingSafe = 4;
  if (oppKing !== undefined) {
    oppKingSafe = countKingSafeEscapes(state, oppKing);
    if (oppKingSafe < 5) {
      score += (5 - oppKingSafe) * w.enemyKingBoxSqueezeBonus;
    }
    // Reward CRACKED / PIT tiles bordering visible enemy King (bridge-cut trap)
    if (profile.useComboSetup) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nt = state.tiles[oppKing.pos.y + dy]?.[oppKing.pos.x + dx];
          if (nt?.type === 'CRACKED' || nt?.type === 'PIT') {
            score += w.crackedNearEnemyKingBonus;
          }
        }
      }
    }
  }
  if (myKing !== undefined) {
    myKingSafe = countKingSafeEscapes(state, myKing);
    if (myKingSafe < 4) {
      score -= (4 - myKingSafe) * w.ownKingBoxDangerPenalty;
    }
  }

  // Cascade setup: threaten unshielded foe next to a shaken/fragile high-value foe
  if (profile.useComboSetup && visibleOppCount >= 2) {
    for (let i = 0; i < pieces.length; i++) {
      const f = pieces[i]!;
      if (f.side !== oppSide || (f.composure ?? 3) > 2 || AI_PIECE_VALUES[f.type] < 300) continue;
      if (f.type === 'KING' || f.type === 'CHIMERA') continue;
      let cascadeThreat = false;
      for (let j = 0; j < pieces.length; j++) {
        const allyFoe = pieces[j]!;
        if (allyFoe.side !== oppSide || allyFoe.id === f.id || hasActiveShield(allyFoe)) continue;
        if (chebyshevDistance(allyFoe.pos, f.pos) <= 2) {
          for (let k = 0; k < pieces.length; k++) {
            const mine = pieces[k]!;
            if (mine.side === aiSide && mine.frozenTurns === 0 && chebyshevDistance(mine.pos, allyFoe.pos) <= 2) {
              cascadeThreat = true;
              break;
            }
          }
        }
        if (cascadeThreat) break;
      }
      if (cascadeThreat) score += w.allyDeathCascadeSetupBonus;
    }
  }

  // Kahpelik #7: PRESSURE_PLATE -> ARROW_EMITTER corridor zoning (only runs when board has wired plates)
  if (profile.useComboSetup && plateWirings.length > 0 && visibleOppCount > 0) {
    for (let pw = 0; pw < plateWirings.length; pw++) {
      const wiring = plateWirings[pw]!;
      const pTile = state.tiles[wiring.platePos.y]?.[wiring.platePos.x];
      if (pTile?.trap?.kind !== 'PRESSURE_PLATE' || pTile.trap.cooldown > 0) continue;

      let myNearPlate = false;
      let oppNearPlate = false;
      for (let i = 0; i < pieces.length; i++) {
        const pc = pieces[i]!;
        if (pc.frozenTurns > 0) continue;
        if (chebyshevDistance(pc.pos, wiring.platePos) <= 2) {
          if (pc.side === aiSide) myNearPlate = true;
          else oppNearPlate = true;
        }
      }
      if (!myNearPlate && !oppNearPlate) continue;

      let enemyHitVal = 0;
      let friendlyHitVal = 0;
      for (let eIdx = 0; eIdx < wiring.emitters.length; eIdx++) {
        const em = wiring.emitters[eIdx]!;
        let cx = em.pos.x + em.dx;
        let cy = em.pos.y + em.dy;
        while (cx >= 0 && cx < state.width && cy >= 0 && cy < state.height) {
          const t = state.tiles[cy]?.[cx];
          if (t === undefined || t.type === 'WALL') break;
          const occ = getPieceAt(pieces, { x: cx, y: cy });
          if (occ !== undefined) {
            const v = occ.type === 'KING' ? 2.5 : hasActiveShield(occ) ? 0.5 : 1.0;
            if (occ.side === oppSide) enemyHitVal += v;
            else friendlyHitVal += v;
            if (!em.piercing) break;
          }
          cx += em.dx;
          cy += em.dy;
        }
      }
      if (myNearPlate && enemyHitVal > friendlyHitVal) {
        const delta = enemyHitVal - friendlyHitVal;
        score += Math.round(delta * w.plateCorridorZoneBonus);
        plateZoneDiff += delta;
      } else if (oppNearPlate && friendlyHitVal > enemyHitVal) {
        const delta = friendlyHitVal - enemyHitVal;
        score -= Math.round(delta * w.plateCorridorZoneBonus);
        plateZoneDiff -= delta;
      }
    }
  }

  // NECROMANCERS pending spawn control (strictly monotonic)
  for (let i = 0; i < state.pendingSpawns.length; i++) {
    const sp = state.pendingSpawns[i]!;
    const occ = getPieceAt(pieces, sp.pos);
    const imminentVal = sp.turnsRemaining <= 1 ? 75 : 40;
    if (sp.side === aiSide) {
      if (occ === undefined) {
        score += imminentVal;
        spawnCtrlDiff += 1;
      }
    } else {
      if (occ === undefined) {
        score -= imminentVal;
        spawnCtrlDiff -= 1;
      }
    }
  }

  // Active bonus dash state value
  if (state.bonusMovePieceId !== null) {
    score += state.turn === aiSide ? w.bonusMoveTempo : -w.bonusMoveTempo;
  }

  // Vision & fog frontier exploration advantage for aiSide (computed lazily at leaves only)
  const { visibleTiles, visibleKnown } = countLeafAiVision(state, aiSide, unexploredMask);
  const exploredTiles = Math.max(0, visionScratch.baseKnownCount - visibleKnown);
  score += Math.round(visibleTiles * w.visionTileScale + exploredTiles * (w.visionTileScale * 0.33));

  let frontierCoverage = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.side !== aiSide) continue;
    const rad = p.traits.includes('SCOUT') ? 4 : 3;
    const minY = Math.max(0, p.pos.y - rad);
    const maxY = Math.min(state.height - 1, p.pos.y + rad);
    const minX = Math.max(0, p.pos.x - rad);
    const maxX = Math.min(state.width - 1, p.pos.x + rad);
    for (let y = minY; y <= maxY; y++) {
      const uRow = unexploredMask[y];
      if (uRow === undefined) continue;
      for (let x = minX; x <= maxX; x++) {
        if (uRow[x] === true) frontierCoverage++;
      }
    }
  }
  score += Math.min(36, Math.round(frontierCoverage * w.frontierScale));

  // Fair pursuit when opponent units are hidden in fog
  if (visibleOppCount === 0) {
    const pursuitTargets =
      rememberedCoords.length > 0
        ? rememberedCoords
        : silhouetteCoords.length > 0
          ? silhouetteCoords
          : watchtowers.length > 0
            ? watchtowers
            : fogSweepTargets;

    const pursuitWeight =
      rememberedCoords.length > 0
        ? 26
        : silhouetteCoords.length > 0
          ? 22
          : watchtowers.length > 0
            ? 18
            : 14;

    if (pursuitTargets.length > 0) {
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]!;
        if (p.side !== aiSide || p.type === 'KING') continue;
        let minD = Number.POSITIVE_INFINITY;
        for (let t = 0; t < pursuitTargets.length; t++) {
          const d = manhattanDistance(p.pos, pursuitTargets[t]!);
          if (d < minD) minD = d;
        }
        if (Number.isFinite(minD)) {
          score -= minD * pursuitWeight;
        }
      }
    } else {
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]!;
        if (p.side !== aiSide || p.type === 'KING') continue;
        score -= Math.abs(p.pos.y - oppBackRowY) * 10;
      }
    }
  } else {
    const primaryTargets =
      oppKing !== undefined ? [oppKing] : pieces.filter((p) => p.side === oppSide);
    const chaseWeight = oppKing !== undefined ? w.pursuitKingChase : w.pursuitUnitChase;

    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (p.side !== aiSide || p.type === 'KING') continue;
      let minD = Number.POSITIVE_INFINITY;
      for (let o = 0; o < primaryTargets.length; o++) {
        const d = manhattanDistance(p.pos, primaryTargets[o]!.pos);
        if (d < minD) minD = d;
      }
      if (Number.isFinite(minD)) {
        score -= minD * chaseWeight;
      }
    }

    if (oppKing !== undefined) {
      const kingEdgeDist =
        Math.abs(oppKing.pos.x - centerX) + Math.abs(oppKing.pos.y - centerY);
      score += Math.round(kingEdgeDist * w.kingEdgePushScale);
    }
  }

  // Tiny quantized MLP non-linear cross-feature residual (zero allocations)
  if (fillNnFeatures) {
    const boardArea = Math.max(1, state.width * state.height);
    nnFeatureBuf[0] = Math.max(-3, Math.min(3, (myNonKingMat - oppNonKingMat) / 1000));
    nnFeatureBuf[1] = Math.max(-2, Math.min(2, (myCount - visibleOppCount) / 4));
    nnFeatureBuf[2] = Math.max(-2, Math.min(2, shieldDiff / 3));
    nnFeatureBuf[3] = Math.max(-2, Math.min(2, frozenDiff / 2));
    nnFeatureBuf[4] = Math.max(-2, Math.min(2, frozenLethalDiff));
    nnFeatureBuf[5] = Math.max(-2, Math.min(2, fragileDiff / 2));
    nnFeatureBuf[6] = Math.max(-2, Math.min(2, shakenDiff / 3));
    nnFeatureBuf[7] = Math.max(-2, Math.min(2, isolatedFragileDiff / 2));
    nnFeatureBuf[8] = Math.max(-2, Math.min(2, auraNearUltDiff / 2));
    nnFeatureBuf[9] = Math.max(-2, Math.min(2, berserkDiff));
    nnFeatureBuf[10] = Math.max(-2, Math.min(2, silencedDiff / 2));
    nnFeatureBuf[11] = Math.max(-2, Math.min(2, chimeraFormDiff / 2));
    nnFeatureBuf[12] = Math.max(-2, Math.min(2, stealthAmbushDiff / 2));
    nnFeatureBuf[13] = oppKing !== undefined ? (5 - Math.min(5, oppKingSafe)) / 5 : 0;
    nnFeatureBuf[14] = myKing !== undefined ? (4 - Math.min(4, myKingSafe)) / 4 : 0;
    nnFeatureBuf[15] = Math.max(-2, Math.min(2, kingHazardDiff));
    nnFeatureBuf[16] = Math.max(-2, Math.min(2, pusherSetupDiff / 2));
    nnFeatureBuf[17] = Math.max(-2, Math.min(2, explosiveBombDiff / 2));
    nnFeatureBuf[18] = Math.max(-2, Math.min(2, plateZoneDiff / 2));
    nnFeatureBuf[19] = Math.max(-2, Math.min(2, crackedVulnDiff / 2));
    nnFeatureBuf[20] = Math.max(-2, Math.min(2, watchCenterDiff / 4));
    nnFeatureBuf[21] = Math.max(-2, Math.min(2, pawnProgDiff / 8));
    nnFeatureBuf[22] = Math.max(-2, Math.min(2, spawnCtrlDiff / 2));
    nnFeatureBuf[23] = Math.min(1, visibleTiles / boardArea);
    nnFeatureBuf[24] = Math.min(2, beliefDangerSum / 300);
    nnFeatureBuf[25] = Math.min(1, (myNonKingMat + oppNonKingMat) / 3600);
    nnFeatureBuf[26] = state.turn === aiSide ? 1 : -1;
    nnFeatureBuf[27] = state.bonusMovePieceId !== null ? (state.turn === aiSide ? 1 : -1) : 0;

    if (mlpModel.enabled) {
      score += evaluateTinyMlp(nnFeatureBuf, mlpModel);
    }
  }

  return score;
}

/**
 * Extracts exact evaluation score and 28-dim MLP feature vector for offline self-play training.
 */
export function evaluateVisiblePositionForTraining(
  visible: VisibleState,
  memory: AiMemory,
  aiSide: Side,
  weights?: Partial<SucsEvalWeights>,
  beliefWeights?: Partial<BeliefModelWeights>,
): { score: number; features: number[] } {
  const w: Readonly<SucsEvalWeights> =
    weights !== undefined ? clampEvalWeights({ ...TRAINED_EVAL_WEIGHTS, ...weights }) : TRAINED_EVAL_WEIGHTS;
  const bw: Readonly<BeliefModelWeights> =
    beliefWeights !== undefined ? { ...TRAINED_BELIEF_WEIGHTS, ...beliefWeights } : TRAINED_BELIEF_WEIGHTS;
  const updatedMemory = updateAiMemory(memory, visible, aiSide);
  const belief = buildBeliefContext(visible, updatedMemory, aiSide, 1, bw);

  const rememberedCoords = Object.values(updatedMemory.lastKnownPositions).map((r) => r.pos);
  const silhouetteCoords = visible.silhouettes.map((s) => s.pos);
  const watchtowers: Coord[] = [];
  const unexploredTargets: Coord[] = [];
  const hiddenExploredTargets: Coord[] = [];
  let baseKnownCount = 0;
  for (let y = 0; y < visible.height; y++) {
    for (let x = 0; x < visible.width; x++) {
      const tile = visible.tiles[y]?.[x] ?? null;
      const fogVal = visible.fog[y]?.[x];
      if (fogVal !== 'UNEXPLORED') baseKnownCount++;
      if (tile?.type === 'WATCHTOWER') {
        const occ = getPieceAt(visible.pieces, { x, y });
        if (occ === undefined || occ.side !== aiSide) watchtowers.push({ x, y });
      }
      if (fogVal === 'UNEXPLORED') unexploredTargets.push({ x, y });
      else if (fogVal === 'EXPLORED' && tile !== null && tile.type !== 'WALL' && tile.type !== 'PIT') {
        hiddenExploredTargets.push({ x, y });
      }
    }
  }
  const fogSweepTargets = unexploredTargets.length > 0 ? unexploredTargets : hiddenExploredTargets;
  const score = evaluateSucsBeliefState(
    belief.state,
    aiSide,
    0,
    AI_DIFFICULTY_PROFILES.PANIC,
    rememberedCoords,
    silhouetteCoords,
    watchtowers,
    fogSweepTargets,
    belief.unexploredMask,
    belief.beliefDangerGrid,
    belief.plateWirings,
    { baseKnownCount },
    w,
    { ...TRAINED_MLP_MODEL, enabled: false },
    true,
  );
  return { score, features: Array.from(nnFeatureBuf) };
}

function classifyTacticalTag(
  rootState: GameState,
  action: GameAction,
  oppKingVisible: boolean,
  aiSide: Side,
): string | undefined {
  if (action.type === 'USE_ABILITY') {
    if (action.ability === 'BREAK_WALL') return 'Kuşatma duvarını yardı!';
    const step = stepBeliefState(rootState, action, aiSide, oppKingVisible);
    if (step.events.some((e) => e.type === 'PIECE_FELL_IN_PIT')) {
      return 'Buzdan çukura itme kombosu!';
    }
    if (step.events.some((e) => e.type === 'PIECE_SLID')) {
      return 'Buz kaydırmalı itme hamlesi!';
    }
    if (step.events.some((e) => e.type === 'PIECE_SKEWERED')) {
      return 'Kazığa / ok hattına itme kombosu!';
    }
    if (step.events.some((e) => e.type === 'PLATE_TRIGGERED')) {
      return 'Rakibi baskı plakasına itti!';
    }
    return 'Taktiksel itme uyguladı!';
  }
  if (action.type === 'MOVE') {
    const step = stepBeliefState(rootState, action, aiSide, oppKingVisible);
    if (step.events.some((e) => e.type === 'GAS_CHAIN_DETONATED')) {
      return 'Zincirleme Miasma gaz patlaması!';
    }
    if (step.events.some((e) => e.type === 'FAITH_ULTIMATE_TRIGGERED')) {
      return 'Ocaklı 7×7 arınma ve susturma ultisi!';
    }
    if (step.events.some((e) => e.type === 'BERSERK_CHAIN_TRIGGERED')) {
      return 'Kanlı Cinnet zincir hamlesi!';
    }
    if (step.events.some((e) => e.type === 'CHIMERA_EVOLVED')) {
      return 'Gulyabani kılık çalıp evrimleşti!';
    }
    if (step.events.some((e) => e.type === 'PLATE_TRIGGERED')) {
      return 'Baskı plakası ok tuzağını tetikledi!';
    }
    if (step.nextState.bonusMovePieceId !== null) {
      return 'Pusu çift hamlesini tetikledi!';
    }
    if (step.events.some((e) => e.type === 'PIECE_BREAKDOWN')) {
      return 'Rakip taşın sinirini çökertti!';
    }
    if (step.events.some((e) => e.type === 'PIECE_FROZEN')) {
      const frozenEv = step.events.find((e) => e.type === 'PIECE_FROZEN');
      if (frozenEv !== undefined && frozenEv.type === 'PIECE_FROZEN') {
        const ftBefore = rootState.tiles[frozenEv.pos.y]?.[frozenEv.pos.x];
        const ftAfter = step.nextState.tiles[frozenEv.pos.y]?.[frozenEv.pos.x];
        if (
          ftBefore?.type === 'BURNING' ||
          isTelegraphSpikes(ftBefore) ||
          isExtendedSpikes(ftAfter) ||
          ftAfter?.type === 'BURNING' ||
          hasMiasma(ftAfter)
        ) {
          return 'Dondurup ölüm tuzağına kilitledi!';
        }
      }
      return 'Buz Dokunuşu ile dondurdu!';
    }
    if (step.events.some((e) => e.type === 'TILE_COLLAPSED')) {
      return 'Çatlak köprüyü çökertti!';
    }
    if (step.events.some((e) => e.type === 'SHIELD_BROKEN')) {
      return 'Kalkanı kırdı!';
    }
    const endTile = rootState.tiles[action.to.y]?.[action.to.x];
    if (endTile?.type === 'WATCHTOWER') {
      return 'Gözetleme kulesini ele geçirdi!';
    }
    const oppSide = opponentOf(aiSide);
    if (
      rootState.pendingSpawns.some(
        (sp) => sp.side === oppSide && sp.turnsRemaining === 1 && coordEquals(sp.pos, action.to),
      )
    ) {
      return 'Nekromanser diriltmesini engelledi!';
    }
  }
  return undefined;
}

/**
 * S.U.C.S. Native Tactical Fog-of-War AI:
 * Belief-state silhouette modeling + Iterative Deepening Alpha-Beta + Transposition Table +
 * Killer Moves + Quiescence Capture Extension + Bonus-Dash Extension + Mechanic Combo Heuristics.
 * Strictly consumes `VisibleState` + `AiMemory` (100% fair, zero fog cheating, zero Math.random).
 */
export function chooseSucsAction(
  visible: VisibleState,
  memory: AiMemory = createAiMemory(),
  options: SucsAiOptions = {},
): SucsAiDecision {
  const difficulty: AiDifficulty = options.difficulty ?? 'TENSE';
  const profile = AI_DIFFICULTY_PROFILES[difficulty];
  const aiSide: Side = options.aiSide ?? visible.turn;
  const budgetMs = Math.max(1, options.timeBudgetMs ?? profile.timeBudgetMs);
  const maxDepth = Math.max(1, options.maxDepth ?? profile.maxDepth);
  const nowMs = options.nowMs ?? defaultNowMs;
  const startMs = nowMs();
  const deadlineMs = startMs + budgetMs;
  const initialRng = options.rngState ?? 1;

  const evalWeights: Readonly<SucsEvalWeights> =
    options.weights !== undefined
      ? clampEvalWeights({ ...TRAINED_EVAL_WEIGHTS, ...options.weights })
      : TRAINED_EVAL_WEIGHTS;
  const beliefWeights: Readonly<BeliefModelWeights> =
    options.beliefWeights !== undefined
      ? { ...TRAINED_BELIEF_WEIGHTS, ...options.beliefWeights }
      : TRAINED_BELIEF_WEIGHTS;
  const mlpModel: Readonly<TinyMlpModel> = options.mlpModel ?? TRAINED_MLP_MODEL;

  const updatedMemory = updateAiMemory(memory, visible, aiSide);
  const belief = buildBeliefContext(visible, updatedMemory, aiSide, initialRng, beliefWeights);

  const rememberedCoords = Object.values(updatedMemory.lastKnownPositions).map((r) => r.pos);
  const silhouetteCoords = visible.silhouettes.map((s) => s.pos);
  const watchtowers: Coord[] = [];
  const unexploredTargets: Coord[] = [];
  const hiddenExploredTargets: Coord[] = [];
  let baseKnownCount = 0;
  for (let y = 0; y < visible.height; y++) {
    for (let x = 0; x < visible.width; x++) {
      const tile = visible.tiles[y]?.[x] ?? null;
      const fogVal = visible.fog[y]?.[x];
      if (fogVal !== 'UNEXPLORED') {
        baseKnownCount++;
      }
      if (tile?.type === 'WATCHTOWER') {
        const occ = getPieceAt(visible.pieces, { x, y });
        if (occ === undefined || occ.side !== aiSide) {
          watchtowers.push({ x, y });
        }
      }
      if (fogVal === 'UNEXPLORED') {
        unexploredTargets.push({ x, y });
      } else if (fogVal === 'EXPLORED' && tile !== null && tile.type !== 'WALL' && tile.type !== 'PIT') {
        hiddenExploredTargets.push({ x, y });
      }
    }
  }
  const visionScratch: VisionScratch = { baseKnownCount };
  const fogSweepTargets =
    unexploredTargets.length > 0 ? unexploredTargets : hiddenExploredTargets;
  const recentMoves = updatedMemory.recentSelfMoves ?? [];

  // Map root piece IDs to compact integer slots (0..63) for allocation-free killer/history/TT move codes
  const pieceSlotMap = new Map<string, number>();
  for (let i = 0; i < belief.state.pieces.length; i++) {
    pieceSlotMap.set(belief.state.pieces[i]!.id, i & 63);
  }
  const getPieceSlot = (pieceId: string): number => {
    const existing = pieceSlotMap.get(pieceId);
    if (existing !== undefined) return existing;
    const hashed = 32 + (fnv1a32(pieceId) & 31);
    pieceSlotMap.set(pieceId, hashed);
    return hashed;
  };

  historyTable.fill(0);
  killer1ByPly.fill(-1);
  killer2ByPly.fill(-1);

  const rootActions = generateOrderedActions(
    belief.state,
    belief.unexploredMask,
    -1,
    -1,
    -1,
    getPieceSlot,
    false,
  );
  if (rootActions.length === 1) {
    const single = rootActions[0]!.action;
    let finalMemory = updatedMemory;
    if (single.type === 'MOVE') {
      const mover = visible.pieces.find((p) => p.id === single.pieceId);
      if (mover !== undefined) {
        finalMemory = recordAiSelfMove(updatedMemory, single.pieceId, mover.pos, single.to);
      }
    }
    return {
      action: single,
      score: 0,
      completedDepth: 1,
      nodesSearched: 1,
      ttHits: 0,
      elapsedMs: Math.max(0, nowMs() - startMs),
      timedOut: false,
      difficulty,
      memory: finalMemory,
      nextRngState: initialRng,
    };
  }

  let nodesSearched = 0;
  let ttHits = 0;
  let timedOut = false;
  const gen = resetTranspositionTable();
  const hashTmp: ZobristHashOut = { hi: 0, lo: 0 };

  const checkTimeout = (): boolean => {
    if (timedOut) return true;
    if (nowMs() >= deadlineMs) {
      timedOut = true;
      return true;
    }
    return false;
  };

  const evalLeaf = (state: GameState, ply: number): number =>
    evaluateSucsBeliefState(
      state,
      aiSide,
      ply,
      profile,
      rememberedCoords,
      silhouetteCoords,
      watchtowers,
      fogSweepTargets,
      belief.unexploredMask,
      belief.beliefDangerGrid,
      belief.plateWirings,
      visionScratch,
      evalWeights,
      mlpModel,
    );

  const recordQuietCutoff = (side: Side, ply: number, depth: number, code: number): void => {
    if (ply < MAX_SEARCH_PLY && code !== killer1ByPly[ply]) {
      killer2ByPly[ply] = killer1ByPly[ply]!;
      killer1ByPly[ply] = code;
    }
    const hIdx = historyIndexForCode(side, code);
    const bonus = depth * depth * 32;
    const prev = historyTable[hIdx] ?? 0;
    historyTable[hIdx] = prev + bonus > 200_000 ? 200_000 : prev + bonus;
  };

  const quiesce = (
    state: GameState,
    qDepth: number,
    alpha: number,
    beta: number,
    ply: number,
  ): number => {
    nodesSearched++;
    if ((nodesSearched & 63) === 0 && checkTimeout()) return 0;

    const standPat = evalLeaf(state, ply);
    if (qDepth <= 0 || state.winner !== null) {
      return standPat;
    }

    const maximizing = state.turn === aiSide;
    if (maximizing) {
      let best = standPat;
      let a = alpha;
      if (best > a) a = best;
      if (beta <= a) return best;

      const tactical = generateOrderedActions(
        state,
        belief.unexploredMask,
        -1,
        -1,
        -1,
        getPieceSlot,
        true,
      );
      for (let i = 0; i < tactical.length && i < 8; i++) {
        if ((nodesSearched & 63) === 0 && checkTimeout()) return 0;
        const oa = tactical[i]!;
        const step = stepBeliefState(
          state,
          oa.action,
          aiSide,
          belief.oppKingVisibleAtRoot,
          oa.legalMove,
        );
        if (step.error !== undefined) continue;
        // Symmetric small horizon tempo discount prevents delaying captures/spawn-denials into quiesce
        const val = quiesce(step.nextState, qDepth - 1, a, beta, ply + 1) - 14;
        if (timedOut) return 0;
        if (val > best) best = val;
        if (best > a) a = best;
        if (beta <= a) break;
      }
      return best;
    }

    let best = standPat;
    let b = beta;
    if (best < b) b = best;
    if (b <= alpha) return best;

    const tactical = generateOrderedActions(
      state,
      belief.unexploredMask,
      -1,
      -1,
      -1,
      getPieceSlot,
      true,
    );
    for (let i = 0; i < tactical.length && i < 8; i++) {
      if ((nodesSearched & 63) === 0 && checkTimeout()) return 0;
      const oa = tactical[i]!;
      const step = stepBeliefState(
        state,
        oa.action,
        aiSide,
        belief.oppKingVisibleAtRoot,
        oa.legalMove,
      );
      if (step.error !== undefined) continue;
      const val = quiesce(step.nextState, qDepth - 1, alpha, b, ply + 1) + 14;
      if (timedOut) return 0;
      if (val < best) best = val;
      if (best < b) b = best;
      if (b <= alpha) break;
    }
    return best;
  };

  const alphaBeta = (
    state: GameState,
    depth: number,
    alpha: number,
    beta: number,
    ply: number,
    extensionsUsed: number,
  ): number => {
    nodesSearched++;
    if ((nodesSearched & 63) === 0 && checkTimeout()) {
      return 0;
    }

    if (state.winner !== null) {
      return evalLeaf(state, ply);
    }

    if (depth <= 0) {
      if (profile.quiesceDepth > 0) {
        return quiesce(state, profile.quiesceDepth, alpha, beta, ply);
      }
      return evalLeaf(state, ply);
    }

    const origAlpha = alpha;
    const origBeta = beta;
    const isPvNode = beta - alpha > 1;

    computeZobristHashInto(state, hashTmp);
    const hi = hashTmp.hi;
    const lo = hashTmp.lo;

    // Detect in-tree position repetition cycles to prevent TT cycle grafting / pointless shuffling
    for (let p = ply - 2; p >= 0; p -= 2) {
      if (pathHashHi[p] === hi && pathHashLo[p] === lo) {
        return evalLeaf(state, ply);
      }
    }
    if (ply < MAX_SEARCH_PLY) {
      pathHashHi[ply] = hi;
      pathHashLo[ply] = lo;
    }

    const slot = lo & TT_MASK;

    let ttHintCode = -1;
    if (ttGen[slot] === gen && ttKeyHi[slot] === hi && ttKeyLo[slot] === lo) {
      ttHintCode = ttBestCode[slot]!;
      if (ttDepth[slot]! >= depth) {
        const flag = ttFlag[slot]!;
        const cachedScore = scoreFromTT(ttScore[slot]!, ply);
        if (flag === TT_EXACT) {
          ttHits++;
          return cachedScore;
        }
        if (!isPvNode) {
          if (flag === TT_LOWER && cachedScore > alpha) alpha = cachedScore;
          else if (flag === TT_UPPER && cachedScore < beta) beta = cachedScore;
          if (alpha >= beta) {
            ttHits++;
            return cachedScore;
          }
        }
      }
    }

    const k1 = ply < MAX_SEARCH_PLY ? killer1ByPly[ply]! : -1;
    const k2 = ply < MAX_SEARCH_PLY ? killer2ByPly[ply]! : -1;
    const actions = generateOrderedActions(
      state,
      belief.unexploredMask,
      ttHintCode,
      k1,
      k2,
      getPieceSlot,
      false,
    );
    const maximizing = state.turn === aiSide;
    let bestCodeLocal = -1;

    if (maximizing) {
      let best = -INF;
      let a = alpha;
      for (let i = 0; i < actions.length; i++) {
        if ((nodesSearched & 63) === 0 && checkTimeout()) return 0;
        const oa = actions[i]!;
        const step = stepBeliefState(
          state,
          oa.action,
          aiSide,
          belief.oppKingVisibleAtRoot,
          oa.legalMove,
        );
        if (step.error !== undefined) continue;

        // Extend by 1 ply on active DASH_ON_REVEAL / BERSERK_CHAIN bonus combos (up to 2 extensions)
        const extend = step.nextState.bonusMovePieceId !== null && extensionsUsed < 2 ? 1 : 0;
        const nextDepth = depth - 1 + extend;
        let val: number;

        if (i === 0) {
          val = alphaBeta(step.nextState, nextDepth, a, beta, ply + 1, extensionsUsed + extend);
        } else {
          // LMR on quiet late moves + PVS zero-window scout
          const canReduce =
            depth >= 3 &&
            i >= 4 &&
            !oa.isTactical &&
            !oa.isKiller &&
            extend === 0 &&
            state.bonusMovePieceId === null;
          const reduction = canReduce ? (i >= 10 && depth >= 4 ? 2 : 1) : 0;

          val = alphaBeta(
            step.nextState,
            nextDepth - reduction,
            a,
            a + 1,
            ply + 1,
            extensionsUsed + extend,
          );
          if (!timedOut && val > a && reduction > 0) {
            val = alphaBeta(step.nextState, nextDepth, a, a + 1, ply + 1, extensionsUsed + extend);
          }
          if (!timedOut && val > a && val < beta) {
            val = alphaBeta(step.nextState, nextDepth, a, beta, ply + 1, extensionsUsed + extend);
          }
        }
        if (timedOut) return 0;

        if (val > best) {
          best = val;
          bestCodeLocal = oa.code;
        }
        if (best > a) a = best;
        if (beta <= a) {
          if (!oa.isTactical) {
            recordQuietCutoff(state.turn, ply, depth, oa.code);
          }
          break;
        }
      }

      const finalScore = best > -INF ? best : evalLeaf(state, ply);
      if (ttGen[slot] !== gen || (ttKeyHi[slot] === hi && ttKeyLo[slot] === lo) || depth >= ttDepth[slot]!) {
        ttGen[slot] = gen;
        ttKeyHi[slot] = hi;
        ttKeyLo[slot] = lo;
        ttDepth[slot] = depth;
        ttScore[slot] = scoreToTT(finalScore, ply);
        ttFlag[slot] =
          finalScore <= origAlpha ? TT_UPPER : finalScore >= origBeta ? TT_LOWER : TT_EXACT;
        ttBestCode[slot] = bestCodeLocal;
      }
      return finalScore;
    }

    let best = INF;
    let b = beta;
    for (let i = 0; i < actions.length; i++) {
      if ((nodesSearched & 63) === 0 && checkTimeout()) return 0;
      const oa = actions[i]!;
      const step = stepBeliefState(
        state,
        oa.action,
        aiSide,
        belief.oppKingVisibleAtRoot,
        oa.legalMove,
      );
      if (step.error !== undefined) continue;

      const extend = step.nextState.bonusMovePieceId !== null && extensionsUsed < 2 ? 1 : 0;
      const nextDepth = depth - 1 + extend;
      let val: number;

      if (i === 0) {
        val = alphaBeta(step.nextState, nextDepth, alpha, b, ply + 1, extensionsUsed + extend);
      } else {
        const canReduce =
          depth >= 3 &&
          i >= 4 &&
          !oa.isTactical &&
          !oa.isKiller &&
          extend === 0 &&
          state.bonusMovePieceId === null;
        const reduction = canReduce ? (i >= 10 && depth >= 4 ? 2 : 1) : 0;

        val = alphaBeta(
          step.nextState,
          nextDepth - reduction,
          b - 1,
          b,
          ply + 1,
          extensionsUsed + extend,
        );
        if (!timedOut && val < b && reduction > 0) {
          val = alphaBeta(step.nextState, nextDepth, b - 1, b, ply + 1, extensionsUsed + extend);
        }
        if (!timedOut && val < b && val > alpha) {
          val = alphaBeta(step.nextState, nextDepth, alpha, b, ply + 1, extensionsUsed + extend);
        }
      }
      if (timedOut) return 0;

      if (val < best) {
        best = val;
        bestCodeLocal = oa.code;
      }
      if (best < b) b = best;
      if (b <= alpha) {
        if (!oa.isTactical) {
          recordQuietCutoff(state.turn, ply, depth, oa.code);
        }
        break;
      }
    }

    const finalScore = best < INF ? best : evalLeaf(state, ply);
    if (ttGen[slot] !== gen || (ttKeyHi[slot] === hi && ttKeyLo[slot] === lo) || depth >= ttDepth[slot]!) {
      ttGen[slot] = gen;
      ttKeyHi[slot] = hi;
      ttKeyLo[slot] = lo;
      ttDepth[slot] = depth;
      ttScore[slot] = scoreToTT(finalScore, ply);
      ttFlag[slot] =
        finalScore <= origAlpha ? TT_UPPER : finalScore >= origBeta ? TT_LOWER : TT_EXACT;
      ttBestCode[slot] = bestCodeLocal;
    }
    return finalScore;
  };

  let bestAction: GameAction = rootActions[0]!.action;
  let bestActionCode = rootActions[0]!.code;
  let bestScore = -INF;
  let completedDepth = 0;
  let nextRng = initialRng;

  const computeOscillationPenalty = (candidate: GameAction, hasCapture: boolean): number => {
    if (hasCapture || candidate.type !== 'MOVE' || recentMoves.length === 0) return 0;
    const last = recentMoves[recentMoves.length - 1]!;
    if (last.pieceId === candidate.pieceId && coordEquals(last.from, candidate.to)) {
      return 65;
    }
    let repeatHits = 0;
    for (let r = 0; r < recentMoves.length; r++) {
      const m = recentMoves[r]!;
      if (
        m.pieceId === candidate.pieceId &&
        (coordEquals(m.to, candidate.to) || coordEquals(m.from, candidate.to))
      ) {
        repeatHits++;
      }
    }
    return repeatHits * 24;
  };

  const searchRootWithWindow = (
    ordered: readonly OrderedAction[],
    depth: number,
    winAlpha: number,
    winBeta: number,
    band: number,
  ): { bestScore: number; bestActions: GameAction[]; bestCodes: number[]; aborted: boolean } => {
    computeZobristHashInto(belief.state, hashTmp);
    pathHashHi[0] = hashTmp.hi;
    pathHashLo[0] = hashTmp.lo;

    let depthBestScore = -INF;
    let depthBestActions: GameAction[] = [];
    let depthBestCodes: number[] = [];
    let alpha = winAlpha;

    for (let i = 0; i < ordered.length; i++) {
      if (depth > 1 && checkTimeout()) {
        return { bestScore: depthBestScore, bestActions: depthBestActions, bestCodes: depthBestCodes, aborted: true };
      }
      const oa = ordered[i]!;
      const candidate = oa.action;
      const step = stepBeliefState(
        belief.state,
        candidate,
        aiSide,
        belief.oppKingVisibleAtRoot,
        oa.legalMove,
      );
      if (step.error !== undefined) continue;

      const hasCapture = step.events.some(
        (ev) =>
          ev.type === 'PIECE_CAPTURED' ||
          ev.type === 'SHIELD_BROKEN' ||
          ev.type === 'PIECE_FELL_IN_PIT',
      );
      // Small immediate-information & "Kahpelik" trap/complexity tie-breaker at root
      let urgencyBonus = 0;
      if (candidate.type === 'USE_ABILITY' && candidate.ability === 'BREAK_WALL') {
        urgencyBonus = 6;
      } else if (
        candidate.type === 'MOVE' &&
        belief.state.tiles[candidate.to.y]?.[candidate.to.x]?.type === 'WATCHTOWER'
      ) {
        urgencyBonus = 4;
      }

      let trapBonus = 0;
      if (profile.useComboSetup && evalWeights.trapComplexityTieBreak > 0) {
        for (let evIdx = 0; evIdx < step.events.length; evIdx++) {
          const ev = step.events[evIdx]!;
          if (ev.type === 'PIECE_BREAKDOWN' || ev.type === 'GAS_CHAIN_DETONATED') {
            trapBonus += evalWeights.trapComplexityTieBreak;
          } else if (
            ev.type === 'PLATE_TRIGGERED' ||
            ev.type === 'PIECE_FROZEN' ||
            ev.type === 'TILE_COLLAPSED'
          ) {
            trapBonus += Math.round(evalWeights.trapComplexityTieBreak * 0.65);
          } else if (ev.type === 'COMPOSURE_CHANGED' && ev.to < ev.from) {
            const targetPiece = step.nextState.pieces.find((p) => p.id === ev.pieceId);
            if (targetPiece !== undefined && targetPiece.side !== aiSide) {
              trapBonus += Math.round(evalWeights.trapComplexityTieBreak * 0.55);
            }
          }
        }
        if (trapBonus > evalWeights.trapComplexityTieBreak) {
          trapBonus = evalWeights.trapComplexityTieBreak;
        }
      }

      // Fair PIMC root ghost-ambush check (guards against blindly walking heavy pieces into fog snipers)
      let ghostAmbushPen = 0;
      if (profile.useBeliefRisk && belief.ghosts.length > 0 && candidate.type !== 'END_TURN') {
        ghostAmbushPen = Math.round(
          evaluateRootGhostAmbushRisk(
            step.nextState,
            candidate.pieceId,
            belief.ghosts,
            aiSide,
            beliefWeights,
          ) * evalWeights.ghostAmbushCheckScale,
        );
      }

      const rootAdjust =
        urgencyBonus + trapBonus - ghostAmbushPen - computeOscillationPenalty(candidate, hasCapture);
      const extend = step.nextState.bonusMovePieceId !== null ? 1 : 0;
      const nextDepth = depth - 1 + extend;
      // Preserve band candidates by lowering search threshold by band - rootAdjust
      const childAlpha = Math.max(-INF, alpha - band - 1 - rootAdjust);
      const childBeta = Math.min(INF, winBeta - rootAdjust);

      let rawScore: number;
      if (i === 0 || childAlpha >= childBeta - 1) {
        rawScore = alphaBeta(step.nextState, nextDepth, childAlpha, childBeta, 1, extend);
      } else {
        rawScore = alphaBeta(step.nextState, nextDepth, childAlpha, childAlpha + 1, 1, extend);
        if (!timedOut && rawScore > childAlpha && rawScore < childBeta) {
          rawScore = alphaBeta(step.nextState, nextDepth, childAlpha, childBeta, 1, extend);
        }
      }
      if (timedOut) {
        return { bestScore: depthBestScore, bestActions: depthBestActions, bestCodes: depthBestCodes, aborted: true };
      }

      const score = rawScore + rootAdjust;
      if (score > depthBestScore + band) {
        depthBestScore = score;
        depthBestActions = [candidate];
        depthBestCodes = [oa.code];
      } else if (score >= depthBestScore - band) {
        depthBestActions.push(candidate);
        depthBestCodes.push(oa.code);
      }

      if (score > alpha) alpha = score;
      if (alpha >= winBeta) break;
    }

    return {
      bestScore: depthBestScore,
      bestActions: depthBestActions,
      bestCodes: depthBestCodes,
      aborted: false,
    };
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (depth > 1 && checkTimeout()) break;

    const ordered = generateOrderedActions(
      belief.state,
      belief.unexploredMask,
      bestActionCode,
      -1,
      -1,
      getPieceSlot,
      false,
    );
    const band = profile.suboptimalBand;

    // Aspiration windows for depth >= 3 when score is non-mate
    let winAlpha = -INF;
    let winBeta = INF;
    let delta = 90;
    if (depth >= 3 && Math.abs(bestScore) < 80_000) {
      winAlpha = Math.max(-INF, bestScore - delta);
      winBeta = Math.min(INF, bestScore + delta);
    }

    let rootRes = searchRootWithWindow(ordered, depth, winAlpha, winBeta, band);
    while (
      !rootRes.aborted &&
      (rootRes.bestScore <= winAlpha || rootRes.bestScore >= winBeta) &&
      (winAlpha > -INF || winBeta < INF)
    ) {
      delta = delta < 300 ? 320 : INF;
      if (delta >= INF) {
        winAlpha = -INF;
        winBeta = INF;
      } else {
        if (rootRes.bestScore <= winAlpha) winAlpha = Math.max(-INF, rootRes.bestScore - delta);
        if (rootRes.bestScore >= winBeta) winBeta = Math.min(INF, rootRes.bestScore + delta);
      }
      rootRes = searchRootWithWindow(ordered, depth, winAlpha, winBeta, band);
    }

    if (!rootRes.aborted && rootRes.bestActions.length > 0) {
      if (rootRes.bestActions.length === 1) {
        bestAction = rootRes.bestActions[0]!;
        bestActionCode = rootRes.bestCodes[0]!;
      } else {
        const pick = nextInt(nextRng, 0, rootRes.bestActions.length - 1);
        nextRng = pick.nextState;
        bestAction = rootRes.bestActions[pick.value]!;
        bestActionCode = rootRes.bestCodes[pick.value]!;
      }
      bestScore = rootRes.bestScore;
      completedDepth = depth;

      if (bestScore >= MATE_THRESHOLD) {
        break;
      }
    } else {
      break;
    }
  }

  let finalMemory = updatedMemory;
  if (bestAction.type === 'MOVE') {
    const mover = visible.pieces.find((p) => p.id === bestAction.pieceId);
    if (mover !== undefined) {
      finalMemory = recordAiSelfMove(updatedMemory, bestAction.pieceId, mover.pos, bestAction.to);
    }
  }

  const tacticalTag = classifyTacticalTag(
    belief.state,
    bestAction,
    belief.oppKingVisibleAtRoot,
    aiSide,
  );

  return {
    action: bestAction,
    score: Number.isFinite(bestScore) ? bestScore : 0,
    completedDepth,
    nodesSearched,
    ttHits,
    elapsedMs: Math.max(0, nowMs() - startMs),
    timedOut,
    difficulty,
    ...(tacticalTag !== undefined ? { tacticalTag } : {}),
    memory: finalMemory,
    nextRngState: nextRng,
  };
}

/**
 * Pure, 100% fair S.U.C.S. Live Stress Meter computed strictly from VisibleState (zero fog leak).
 * Drives the UI heart-rate / stress bar for flavor and tactical situational awareness.
 */
export function computeStressMetrics(
  visible: VisibleState,
  side: Side,
  bossCooldown = 0,
): StressMetrics {
  const oppSide = opponentOf(side);
  const myPieces = visible.pieces.filter((p) => p.side === side);
  const oppPieces = visible.pieces.filter((p) => p.side === oppSide);
  const myKing = myPieces.find((p) => p.type === 'KING');

  let stress = 12;
  const reasons: string[] = [];

  if (myKing !== undefined) {
    const kingTile = getTile(visible, myKing.pos);
    if (kingTile?.type === 'BURNING') {
      stress += 38;
      reasons.push('Şah alevde!');
    }
    if (isTelegraphSpikes(kingTile)) {
      stress += 34;
      reasons.push('Şah kazık tehdidinde!');
    }
    if (hasMiasma(kingTile)) {
      stress += (myKing.miasmaExposure ?? 0) >= 1 ? 36 : 16;
      reasons.push('Şah zehirli siste!');
    }
    if (myKing.frozenTurns > 0) {
      stress += 25;
      reasons.push('Şah donmuş!');
    }

    // Check if any visible opponent can capture or directly threaten our King right now
    let directThreats = 0;
    let closeEnemies = 0;
    for (let i = 0; i < oppPieces.length; i++) {
      const opp = oppPieces[i]!;
      if (opp.frozenTurns > 0) continue;
      const dist = manhattanDistance(myKing.pos, opp.pos);
      if (dist <= 3) closeEnemies++;
      const moves = getLegalMoves(visible, opp, null);
      if (
        moves.some((m) => {
          const hit = m.resolution.hitPos ?? m.resolution.finalPos;
          return hit !== null && coordEquals(hit, myKing.pos);
        })
      ) {
        directThreats++;
      }
    }
    if (directThreats > 0) {
      stress += myKing.shieldActive ? 28 : 48;
      reasons.push('Şah doğrudan tehdit altında!');
    } else if (closeEnemies > 0) {
      stress += Math.min(24, closeEnemies * 10);
      reasons.push('Düşman Şah\'a yaklaştı');
    }

    // Nearby '?' fog silhouettes elevate tension
    const nearSilhouettes = visible.silhouettes.filter(
      (s) => s.side === oppSide && manhattanDistance(s.pos, myKing.pos) <= 4,
    ).length;
    if (nearSilhouettes > 0) {
      stress += Math.min(22, nearSilhouettes * 9);
      reasons.push(`${nearSilhouettes} sis silüeti yakında`);
    }
  }

  // Low unit count pressure
  if (myPieces.length <= 2) {
    stress += 22;
    reasons.push('Ordu kritik seviyede');
  } else if (myPieces.length <= 3) {
    stress += 10;
  }

  // Frozen friendly pieces
  const frozenMine = myPieces.filter((p) => p.frozenTurns > 0).length;
  if (frozenMine > 0) {
    stress += Math.min(18, frozenMine * 9);
    reasons.push(`${frozenMine} taş donmuş`);
  }

  // Boss ring imminent
  if (bossCooldown === 1) {
    stress += 24;
    reasons.push('Boss halkası 1 tur sonra!');
  }

  // Sudden fog uncertainty when total silhouettes >= 3
  if (visible.silhouettes.length >= 3) {
    stress += 10;
  }

  const percent = Math.max(5, Math.min(100, Math.round(stress)));
  if (percent >= 80) {
    return { percent, label: 'PANİK ATAK!', tone: 'panic', reasons };
  }
  if (percent >= 56) {
    return { percent, label: 'TERLİYOR', tone: 'sweat', reasons };
  }
  if (percent >= 30) {
    return { percent, label: 'GERGİN', tone: 'tense', reasons };
  }
  return { percent, label: 'SAKİN', tone: 'calm', reasons };
}

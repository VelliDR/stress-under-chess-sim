import {
  clonePiece,
  cloneTile,
  cloneTiles,
  coordEquals,
  createTile,
  getLegalMoves,
  getPieceAt,
  getTile,
  manhattanDistance,
  opponentOf,
} from '../engine/board';
import { computeFogForSide } from '../engine/fog';
import { nextInt, pickOne, seedToRngState, shuffle } from '../engine/prng';
import { stepGame } from '../engine/reducer';
import { getLegalAbilities, LegalAbility } from '../engine/traits';
import {
  Coord,
  FactionPassive,
  GameAction,
  GameState,
  LegalMove,
  Piece,
  PieceType,
  RosterUnit,
  SCOUT_PAWN_COST,
  Side,
  SKIRMISH_BUDGET,
  TileState,
  TraitId,
  UNIT_COSTS,
  VisibleState,
} from '../engine/types';
import {
  AiMemory,
  AI_PIECE_VALUES,
  createAiMemory,
  recordAiSelfMove,
  updateAiMemory,
} from './campaignAi';

export const DEFAULT_SKIRMISH_AI_BUDGET_MS = 120;
export const DEFAULT_SKIRMISH_MAX_DEPTH = 3;

export interface SkirmishAiOptions {
  timeBudgetMs?: number;
  maxDepth?: number;
  rngState?: number;
  aiSide?: Side;
  nowMs?: () => number;
}

export interface SkirmishAiDecision {
  action: GameAction;
  score: number;
  completedDepth: number;
  nodesSearched: number;
  elapsedMs: number;
  timedOut: boolean;
  memory: AiMemory;
  nextRngState: number;
}

export interface SkirmishTemplateUnit {
  type: Exclude<PieceType, 'KING'>;
  traits: TraitId[];
}

export interface SkirmishArmyTemplate {
  id: string;
  name: string;
  description: string;
  preferredFaction: FactionPassive;
  units: readonly SkirmishTemplateUnit[];
}

export const SKIRMISH_AI_TEMPLATES: readonly SkirmishArmyTemplate[] = [
  {
    id: 'heavy-cavalry',
    name: 'Ağır Süvari',
    description: '4 At, 1 Kale, 1 Gözcü Piyon ve 1 Piyon ile yüksek hareketlilik ve kanat baskısı.',
    preferredFaction: 'RAIDERS',
    units: [
      { type: 'KNIGHT', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'ROOK', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'] },
      { type: 'PAWN', traits: [] },
    ],
  },
  {
    id: 'fortress-wall',
    name: 'Kale Duvarı',
    description: '3 Kale, 1 Gözcü Piyon ve 3 Piyon ile hat kontrolü ve kuşatma baskısı.',
    preferredFaction: 'SIEGE_ENGINEERS',
    units: [
      { type: 'ROOK', traits: [] },
      { type: 'ROOK', traits: [] },
      { type: 'ROOK', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: [] },
    ],
  },
  {
    id: 'cross-ambush',
    name: 'Çapraz Pusu',
    description: '3 Fil, 2 At, 2 Gözcü Piyon ve 1 Piyon ile geniş görüş ve çapraz pusu.',
    preferredFaction: 'FROST_WARDENS',
    units: [
      { type: 'BISHOP', traits: [] },
      { type: 'BISHOP', traits: [] },
      { type: 'BISHOP', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'] },
      { type: 'PAWN', traits: ['SCOUT'] },
      { type: 'PAWN', traits: [] },
    ],
  },
  {
    id: 'queen-commando',
    name: 'Vezir Komandosu',
    description: '1 Vezir, 1 Kale, 1 At, 1 Gözcü Piyon ve 1 Piyon ile elit suikast gücü.',
    preferredFaction: 'NECROMANCERS',
    units: [
      { type: 'QUEEN', traits: [] },
      { type: 'ROOK', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'] },
      { type: 'PAWN', traits: [] },
    ],
  },
];

/**
 * Calculates exact Skirmish point cost of a unit list (King is free, Scout Pawn costs 2).
 */
export function getUnitSkirmishCost(type: PieceType, traits: readonly TraitId[]): number {
  if (type === 'KING') return 0;
  if (type === 'PAWN' && traits.includes('SCOUT')) return SCOUT_PAWN_COST;
  return UNIT_COSTS[type];
}

export function computeSkirmishRosterCost(
  units: readonly { type: PieceType; traits: readonly TraitId[] }[],
): number {
  let total = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    total += getUnitSkirmishCost(u.type, u.traits);
  }
  return total;
}

export function selectSkirmishAiTemplate(rngState: number): {
  template: SkirmishArmyTemplate;
  nextRngState: number;
} {
  const picked = pickOne(rngState, SKIRMISH_AI_TEMPLATES);
  return {
    template: picked.value ?? SKIRMISH_AI_TEMPLATES[0]!,
    nextRngState: picked.nextState,
  };
}

/**
 * Converts a SkirmishArmyTemplate into a RosterUnit list (including the free King).
 */
export function buildRosterFromTemplate(
  template: SkirmishArmyTemplate,
  idPrefix = 'ai',
): RosterUnit[] {
  const roster: RosterUnit[] = [{ id: `${idPrefix}_king`, type: 'KING', traits: [] }];
  for (let i = 0; i < template.units.length; i++) {
    const u = template.units[i]!;
    roster.push({
      id: `${idPrefix}_${i + 1}`,
      type: u.type,
      traits: u.traits.slice(),
    });
  }
  return roster;
}

/**
 * Deterministically deploys an AI roster on walkable tiles within the top 2 rows (y = 0, 1).
 * Places the King on the back row closest to center and heavier pieces behind pawns.
 */
export function deploySkirmishAiArmy(
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  roster: readonly RosterUnit[],
  rngState: number,
  side: Side = 'ENEMY',
): { pieces: Piece[]; nextRngState: number } {
  const backRowY = side === 'ENEMY' ? 0 : Math.max(0, height - 1);
  const frontRowY = side === 'ENEMY' ? Math.min(1, height - 1) : Math.max(0, height - 2);

  const backSlots: Coord[] = [];
  const frontSlots: Coord[] = [];

  for (let x = 0; x < width; x++) {
    const bt = tiles[backRowY]?.[x];
    if (bt !== undefined && bt.type !== 'WALL' && bt.type !== 'PIT') {
      backSlots.push({ x, y: backRowY });
    }
    if (frontRowY !== backRowY) {
      const ft = tiles[frontRowY]?.[x];
      if (ft !== undefined && ft.type !== 'WALL' && ft.type !== 'PIT') {
        frontSlots.push({ x, y: frontRowY });
      }
    }
  }

  let rng = rngState;
  const shuffledBack = shuffle(rng, backSlots);
  rng = shuffledBack.nextState;
  const shuffledFront = shuffle(rng, frontSlots);
  rng = shuffledFront.nextState;

  const remainingBack = shuffledBack.value.slice();
  const remainingFront = shuffledFront.value.slice();

  const pieces: Piece[] = [];

  // Place King first on back row closest to board center
  const kingUnit = roster.find((u) => u.type === 'KING');
  const centerX = (width - 1) / 2;

  const takeSlot = (preferFront: boolean, centerBias = false): Coord | null => {
    const primary = preferFront ? remainingFront : remainingBack;
    const secondary = preferFront ? remainingBack : remainingFront;
    const pool = primary.length > 0 ? primary : secondary;
    if (pool.length === 0) return null;

    if (centerBias) {
      let bestIdx = 0;
      let bestDist = Math.abs(pool[0]!.x - centerX);
      for (let i = 1; i < pool.length; i++) {
        const d = Math.abs(pool[i]!.x - centerX);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return pool.splice(bestIdx, 1)[0]!;
    }

    return pool.shift()!;
  };

  const pushUnit = (unit: RosterUnit, pos: Coord): void => {
    pieces.push({
      id: unit.id,
      side,
      type: unit.type,
      pos: { x: pos.x, y: pos.y },
      traits: unit.traits.slice(),
      shieldActive: unit.traits.includes('SHIELDED'),
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE',
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: false,
    });
  };

  if (kingUnit !== undefined) {
    const slot = takeSlot(false, true);
    if (slot !== null) pushUnit(kingUnit, slot);
  }

  // Place non-King units: Pawns prefer front row, heavy pieces prefer back row
  for (let i = 0; i < roster.length; i++) {
    const unit = roster[i]!;
    if (unit.type === 'KING') continue;
    const slot = takeSlot(unit.type === 'PAWN', false);
    if (slot !== null) pushUnit(unit, slot);
  }

  return { pieces, nextRngState: rng };
}

function defaultNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface BeliefContext {
  state: GameState;
  unexploredMask: boolean[][];
  oppKingVisibleAtRoot: boolean;
}

/**
 * Builds a strictly fair hypothetical GameState from `visible: VisibleState`.
 * Unexplored squares (`null`) are sealed as impassable barriers and tracked in `unexploredMask`
 * so simulation never hallucinates hidden units or breaks unexplored walls.
 */
function buildBeliefContext(visible: VisibleState, aiSide: Side, rngState: number): BeliefContext {
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
    rngState: rngState || seedToRngState('skirmish-belief'),
    actionHistory: [],
    winner: visible.winner,
    nextEntityId: 1000,
    bossCooldown: 0,
  };

  return { state, unexploredMask, oppKingVisibleAtRoot };
}

/**
 * Steps a belief state while preventing false instant-wins when the opponent's King
 * is simply hidden in Fog of War at the search root (never cheats, strictly fair).
 */
function stepBeliefState(
  state: GameState,
  action: GameAction,
  aiSide: Side,
  oppKingVisibleAtRoot: boolean,
): ReturnType<typeof stepGame> {
  const step = stepGame(state, action);
  if (step.error !== undefined) return step;
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

interface OrderedAction {
  action: GameAction;
  orderScore: number;
}

function actionsEqual(a: GameAction, b: GameAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'END_TURN' && b.type === 'END_TURN') return true;
  if (a.type === 'MOVE' && b.type === 'MOVE') {
    return a.pieceId === b.pieceId && coordEquals(a.to, b.to);
  }
  if (a.type === 'USE_ABILITY' && b.type === 'USE_ABILITY') {
    return (
      a.pieceId === b.pieceId &&
      a.ability === b.ability &&
      coordEquals(a.target, b.target)
    );
  }
  return false;
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
  board: {
    width: number;
    height: number;
    tiles: readonly (readonly (TileState | null)[])[];
    pieces: readonly Piece[];
  },
  mover: Piece,
  move: LegalMove,
  oppKing: Piece | undefined,
): number {
  const res = move.resolution;
  if (res.fellInPit) return -50000;

  let priority = 0;
  if (res.captured && res.hitPieceId !== null) {
    const victim = board.pieces.find((p) => p.id === res.hitPieceId);
    const vVal = victim !== undefined ? AI_PIECE_VALUES[victim.type] : 100;
    if (victim?.type === 'KING') return 100000;
    priority += 10000 + vVal * 10 - AI_PIECE_VALUES[mover.type];
  } else if (res.brokeShield) {
    const victim =
      res.hitPieceId !== null ? board.pieces.find((p) => p.id === res.hitPieceId) : undefined;
    priority += victim?.type === 'KING' ? 5000 : 3200;
    if (mover.traits.includes('FROST_TOUCH')) priority += 900;
  }

  if (res.promotes) priority += 6000;

  const endPos = res.finalPos ?? move.to;
  if (threatensKingSquare(mover, endPos, oppKing)) {
    priority += 2500;
  }

  const endTile = board.tiles[endPos.y]?.[endPos.x];
  if (endTile?.type === 'WATCHTOWER') priority += 1200;
  if (res.endsOnBurning && !mover.shieldActive) priority -= 8000;

  const cx = (board.width - 1) / 2;
  const cy = (board.height - 1) / 2;
  priority += Math.max(0, 40 - Math.round((Math.abs(endPos.x - cx) + Math.abs(endPos.y - cy)) * 5));

  return priority;
}

function scoreAbilityOrdering(
  board: { pieces: readonly Piece[]; tiles: readonly (readonly (TileState | null)[])[] },
  ability: LegalAbility,
): number {
  if (ability.ability === 'PUSH' && ability.pushPreview !== undefined) {
    const pp = ability.pushPreview;
    if (pp.blocked) return -500;
    const victim = getPieceAt(board.pieces, ability.target);
    if (pp.fellInPit) {
      return victim?.type === 'KING' ? 95000 : 9000 + (victim !== undefined ? AI_PIECE_VALUES[victim.type] * 8 : 500);
    }
    if (pp.slid) return 1100;
    if (pp.finalPos !== null && board.tiles[pp.finalPos.y]?.[pp.finalPos.x]?.type === 'BURNING') {
      return 1400;
    }
    return 350;
  }
  return 450; // BREAK_WALL
}

function generateOrderedActions(
  state: GameState,
  unexploredMask: readonly (readonly boolean[])[],
  pvMove: GameAction | null = null,
): OrderedAction[] {
  const side = state.turn;
  const oppSide = opponentOf(side);
  const oppKing = state.pieces.find((p) => p.side === oppSide && p.type === 'KING');
  const activeOnly = state.mode === 'CAMPAIGN' && side === 'ENEMY';
  const result: OrderedAction[] = [];

  for (let i = 0; i < state.pieces.length; i++) {
    const piece = state.pieces[i]!;
    if (piece.side !== side) continue;
    if (piece.frozenTurns > 0) continue;
    if (activeOnly && piece.aggro !== 'ACTIVE') continue;
    if (state.bonusMovePieceId !== null && state.bonusMovePieceId !== piece.id) continue;

    const moves = getLegalMoves(state, piece, state.bonusMovePieceId);
    for (let m = 0; m < moves.length; m++) {
      const move = moves[m]!;
      const action: GameAction = {
        type: 'MOVE',
        pieceId: piece.id,
        to: { x: move.to.x, y: move.to.y },
      };
      const isPv = pvMove !== null && actionsEqual(action, pvMove);
      result.push({
        action,
        orderScore: isPv ? 1_000_000 : scoreMoveOrdering(state, piece, move, oppKing),
      });
    }

    const abilities = getLegalAbilities(state, piece, state.bonusMovePieceId);
    for (let a = 0; a < abilities.length; a++) {
      const ab = abilities[a]!;
      // Never break a synthetic WALL standing in for an UNEXPLORED fog square
      if (ab.ability === 'BREAK_WALL' && unexploredMask[ab.target.y]?.[ab.target.x] === true) {
        continue;
      }
      const action: GameAction = {
        type: 'USE_ABILITY',
        pieceId: piece.id,
        ability: ab.ability,
        target: { x: ab.target.x, y: ab.target.y },
      };
      const isPv = pvMove !== null && actionsEqual(action, pvMove);
      result.push({
        action,
        orderScore: isPv ? 1_000_000 : scoreAbilityOrdering(state, ab),
      });
    }
  }

  result.sort((a, b) => b.orderScore - a.orderScore);

  if (result.length === 0) {
    result.push({ action: { type: 'END_TURN' }, orderScore: 0 });
  }

  return result;
}

function evaluateBeliefState(
  state: GameState,
  aiSide: Side,
  ply: number,
  rememberedCoords: readonly Coord[],
  silhouetteCoords: readonly Coord[],
  watchtowers: readonly Coord[],
  fogSweepTargets: readonly Coord[],
  unexploredMask: readonly (readonly boolean[])[],
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

  for (let i = 0; i < state.pieces.length; i++) {
    const p = state.pieces[i]!;
    const sign = p.side === aiSide ? 1 : -1;
    if (p.side === oppSide) visibleOppCount++;

    let pieceScore = AI_PIECE_VALUES[p.type];
    if (p.shieldActive) pieceScore += 75;
    if (p.traits.includes('FROST_TOUCH')) pieceScore += 45;
    if (p.traits.includes('EXPLOSIVE')) pieceScore += 35;
    if (p.traits.includes('PUSHER')) pieceScore += 45;
    if (p.traits.includes('SCOUT')) pieceScore += 35;
    if (p.traits.includes('SHADOW_WALKER')) pieceScore += 30;
    if (p.traits.includes('DASH_ON_REVEAL')) pieceScore += 45;
    if (p.frozenTurns > 0) pieceScore -= 55 * p.frozenTurns;

    const tile = getTile(state, p.pos);
    if (tile?.type === 'WATCHTOWER') pieceScore += 65;
    if (tile?.type === 'BURNING') {
      pieceScore -= p.shieldActive ? 40 : p.type === 'KING' ? 3500 : Math.round(AI_PIECE_VALUES[p.type] * 0.7);
    }

    // Center & pawn progression
    const centerBonus = Math.max(0, 14 - (Math.abs(p.pos.x - centerX) + Math.abs(p.pos.y - centerY)) * 2);
    pieceScore += centerBonus;

    if (p.type === 'PAWN') {
      const progress = p.side === 'PLAYER' ? state.height - 1 - p.pos.y : p.pos.y;
      pieceScore += progress * 16;
    }

    score += sign * pieceScore;
  }

  // Vision & fog exploration advantage for aiSide
  const aiFog = state.fog[aiSide];
  let visibleTiles = 0;
  let exploredTiles = 0;
  for (let y = 0; y < state.height; y++) {
    const row = aiFog[y];
    if (row === undefined) continue;
    for (let x = 0; x < state.width; x++) {
      const v = row[x];
      if (v === 'VISIBLE') visibleTiles++;
      else if (v === 'EXPLORED') exploredTiles++;
    }
  }
  score += visibleTiles * 5 + exploredTiles * 1.5;

  // Reward advancing pieces to uncover UNEXPLORED fog frontier squares
  let frontierCoverage = 0;
  for (let i = 0; i < state.pieces.length; i++) {
    const p = state.pieces[i]!;
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
  score += Math.min(90, frontierCoverage * 3);

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
      for (let i = 0; i < state.pieces.length; i++) {
        const p = state.pieces[i]!;
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
      // Ultimate fallback: push forward toward opponent's back rank
      for (let i = 0; i < state.pieces.length; i++) {
        const p = state.pieces[i]!;
        if (p.side !== aiSide || p.type === 'KING') continue;
        score -= Math.abs(p.pos.y - oppBackRowY) * 10;
      }
    }
  } else {
    // Pull non-King AI pieces decisively toward visible enemy King (or nearest visible enemy)
    const oppPieces = state.pieces.filter((p) => p.side === oppSide);
    const oppKing = oppPieces.find((p) => p.type === 'KING');
    const primaryTargets = oppKing !== undefined ? [oppKing] : oppPieces;
    const chaseWeight = oppKing !== undefined ? 18 : 11;

    for (let i = 0; i < state.pieces.length; i++) {
      const p = state.pieces[i]!;
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

    // Drive visible enemy King toward corners/edges for cleaner checkmates
    if (oppKing !== undefined) {
      const kingEdgeDist =
        Math.abs(oppKing.pos.x - centerX) + Math.abs(oppKing.pos.y - centerY);
      score += Math.round(kingEdgeDist * 10);
    }
  }

  return score;
}

/**
 * 120ms-budgeted Iterative Deepening Alpha-Beta Minimax (depth 1 -> 2 -> 3) with Move Ordering.
 * Strictly consumes `VisibleState` + `AiMemory` (never sees hidden units or unexplored terrain).
 */
export function chooseSkirmishAction(
  visible: VisibleState,
  memory: AiMemory = createAiMemory(),
  options: SkirmishAiOptions = {},
): SkirmishAiDecision {
  const aiSide: Side = options.aiSide ?? visible.turn;
  const budgetMs = Math.max(1, options.timeBudgetMs ?? DEFAULT_SKIRMISH_AI_BUDGET_MS);
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_SKIRMISH_MAX_DEPTH);
  const nowMs = options.nowMs ?? defaultNowMs;
  const startMs = nowMs();
  const deadlineMs = startMs + budgetMs;
  const initialRng = options.rngState ?? 1;

  const updatedMemory = updateAiMemory(memory, visible, aiSide);
  const belief = buildBeliefContext(visible, aiSide, initialRng);

  const rememberedCoords = Object.values(updatedMemory.lastKnownPositions).map((r) => r.pos);
  const silhouetteCoords = visible.silhouettes.map((s) => s.pos);
  const watchtowers: Coord[] = [];
  const unexploredTargets: Coord[] = [];
  const hiddenExploredTargets: Coord[] = [];
  for (let y = 0; y < visible.height; y++) {
    for (let x = 0; x < visible.width; x++) {
      const tile = visible.tiles[y]?.[x] ?? null;
      const fogVal = visible.fog[y]?.[x];
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
  const fogSweepTargets =
    unexploredTargets.length > 0 ? unexploredTargets : hiddenExploredTargets;
  const recentMoves = updatedMemory.recentSelfMoves ?? [];

  const rootActions = generateOrderedActions(belief.state, belief.unexploredMask, null);
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
      elapsedMs: Math.max(0, nowMs() - startMs),
      timedOut: false,
      memory: finalMemory,
      nextRngState: initialRng,
    };
  }

  let nodesSearched = 0;
  let timedOut = false;

  const checkTimeout = (): boolean => {
    if (timedOut) return true;
    if (nowMs() >= deadlineMs) {
      timedOut = true;
      return true;
    }
    return false;
  };

  const alphaBeta = (
    state: GameState,
    depth: number,
    alpha: number,
    beta: number,
    ply: number,
  ): number => {
    nodesSearched++;
    if ((nodesSearched & 15) === 0 && checkTimeout()) {
      return 0;
    }

    if (depth <= 0 || state.winner !== null) {
      return evaluateBeliefState(
        state,
        aiSide,
        ply,
        rememberedCoords,
        silhouetteCoords,
        watchtowers,
        fogSweepTargets,
        belief.unexploredMask,
      );
    }

    const actions = generateOrderedActions(state, belief.unexploredMask, null);
    const maximizing = state.turn === aiSide;

    if (maximizing) {
      let best = Number.NEGATIVE_INFINITY;
      let a = alpha;
      for (let i = 0; i < actions.length; i++) {
        if (checkTimeout()) return 0;
        const step = stepBeliefState(
          state,
          actions[i]!.action,
          aiSide,
          belief.oppKingVisibleAtRoot,
        );
        if (step.error !== undefined) continue;
        const val = alphaBeta(step.nextState, depth - 1, a, beta, ply + 1);
        if (timedOut) return 0;
        if (val > best) best = val;
        if (best > a) a = best;
        if (beta <= a) break;
      }
      return Number.isFinite(best)
        ? best
        : evaluateBeliefState(
            state,
            aiSide,
            ply,
            rememberedCoords,
            silhouetteCoords,
            watchtowers,
            fogSweepTargets,
            belief.unexploredMask,
          );
    }

    let best = Number.POSITIVE_INFINITY;
    let b = beta;
    for (let i = 0; i < actions.length; i++) {
      if (checkTimeout()) return 0;
      const step = stepBeliefState(
        state,
        actions[i]!.action,
        aiSide,
        belief.oppKingVisibleAtRoot,
      );
      if (step.error !== undefined) continue;
      const val = alphaBeta(step.nextState, depth - 1, alpha, b, ply + 1);
      if (timedOut) return 0;
      if (val < best) best = val;
      if (best < b) b = best;
      if (b <= alpha) break;
    }
    return Number.isFinite(best)
      ? best
      : evaluateBeliefState(
          state,
          aiSide,
          ply,
          rememberedCoords,
          silhouetteCoords,
          watchtowers,
          fogSweepTargets,
          belief.unexploredMask,
        );
  };

  // Safe immediate fallback in case budget expires before depth 1 finishes
  let bestAction: GameAction = rootActions[0]!.action;
  let bestScore = Number.NEGATIVE_INFINITY;
  let completedDepth = 0;
  let nextRng = initialRng;

  const computeOscillationPenalty = (candidate: GameAction, hasCapture: boolean): number => {
    if (hasCapture || candidate.type !== 'MOVE' || recentMoves.length === 0) return 0;
    const last = recentMoves[recentMoves.length - 1]!;
    // Penalize immediately bouncing the same piece back to where it just came from
    if (last.pieceId === candidate.pieceId && coordEquals(last.from, candidate.to)) {
      return 65;
    }
    let repeatHits = 0;
    for (let r = 0; r < recentMoves.length; r++) {
      const m = recentMoves[r]!;
      if (m.pieceId === candidate.pieceId && (coordEquals(m.to, candidate.to) || coordEquals(m.from, candidate.to))) {
        repeatHits++;
      }
    }
    return repeatHits * 24;
  };

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (depth > 1 && checkTimeout()) break;

    const ordered = generateOrderedActions(belief.state, belief.unexploredMask, bestAction);
    let depthBestScore = Number.NEGATIVE_INFINITY;
    let depthBestActions: GameAction[] = [];
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    let depthAborted = false;

    for (let i = 0; i < ordered.length; i++) {
      if (depth > 1 && checkTimeout()) {
        depthAborted = true;
        break;
      }
      const candidate = ordered[i]!.action;
      const step = stepBeliefState(
        belief.state,
        candidate,
        aiSide,
        belief.oppKingVisibleAtRoot,
      );
      if (step.error !== undefined) continue;

      const rawScore = alphaBeta(step.nextState, depth - 1, alpha, beta, 1);
      if (timedOut) {
        depthAborted = true;
        break;
      }

      const hasCapture = step.events.some(
        (ev) => ev.type === 'PIECE_CAPTURED' || ev.type === 'SHIELD_BROKEN' || ev.type === 'PIECE_FELL_IN_PIT',
      );
      const score = rawScore - computeOscillationPenalty(candidate, hasCapture);

      if (score > depthBestScore + 1) {
        depthBestScore = score;
        depthBestActions = [candidate];
      } else if (score >= depthBestScore - 1) {
        depthBestActions.push(candidate);
      }

      if (score > alpha) alpha = score;
    }

    if (!depthAborted && depthBestActions.length > 0) {
      if (depthBestActions.length === 1) {
        bestAction = depthBestActions[0]!;
      } else {
        const pick = nextInt(nextRng, 0, depthBestActions.length - 1);
        nextRng = pick.nextState;
        bestAction = depthBestActions[pick.value]!;
      }
      bestScore = depthBestScore;
      completedDepth = depth;

      // Forced King win found -> stop deepening immediately
      if (bestScore >= 90000) {
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

  return {
    action: bestAction,
    score: Number.isFinite(bestScore) ? bestScore : 0,
    completedDepth,
    nodesSearched,
    elapsedMs: Math.max(0, nowMs() - startMs),
    timedOut,
    memory: finalMemory,
    nextRngState: nextRng,
  };
}

export function validateSkirmishBudget(
  units: readonly { type: PieceType; traits: readonly TraitId[] }[],
): boolean {
  return computeSkirmishRosterCost(units) <= SKIRMISH_BUDGET;
}

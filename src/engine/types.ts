/**
 * Pure JSON-serializable domain types for Tactical Fog Chess.
 * Architectural invariant: zero DOM/Canvas/window/performance references and
 * zero non-JSON runtime containers (no Map, Set, Date, class instances, or functions).
 */

export type Side = 'PLAYER' | 'ENEMY';

export type FogPerspective = Side | 'OMNISCIENT';

export type PieceType =
  | 'KING'
  | 'QUEEN'
  | 'ROOK'
  | 'BISHOP'
  | 'KNIGHT'
  | 'PAWN'
  | 'SAINT_FAITH'
  | 'SAINT_MADNESS'
  | 'CHIMERA';

export type TileType =
  | 'PLAIN'
  | 'WALL'
  | 'PIT'
  | 'ICE'
  | 'WATCHTOWER'
  | 'BURNING'
  | 'CRACKED';

export interface GasOverlay {
  kind: 'MIASMA';
  /** null = permanent dungeon gas; positive integer = remaining half-turns */
  turnsRemaining: number | null;
}

export type CardinalDir =
  | { dx: 1; dy: 0 }
  | { dx: -1; dy: 0 }
  | { dx: 0; dy: 1 }
  | { dx: 0; dy: -1 };

/** 0: Retracted (safe), 1: Telegraph (extends next half-turn), 2: Extended (lethal) */
export type SpikePhase = 0 | 1 | 2;

export type TileTrap =
  | {
      kind: 'PRESSURE_PLATE';
      id: string;
      /** Arrow emitter IDs fired in canonical order when triggered */
      targetIds: string[];
      cooldown: number;
      maxCooldown: number;
    }
  | {
      kind: 'ARROW_EMITTER';
      id: string;
      dir: CardinalDir;
      /** null = unlimited ammo; 0 = depleted */
      ammo: number | null;
      /** true = ignites MIASMA tiles along arrow path */
      flaming: boolean;
      /** true = does not stop after first hit, pierces until wall/edge */
      piercing: boolean;
    }
  | {
      kind: 'SPIKES';
      id: string;
      phase: SpikePhase;
    };

export interface TileV3Fields {
  gas?: GasOverlay;
  trap?: TileTrap;
  /** Preserves underlying structural tile type while a tile is BURNING */
  underlyingType?: Exclude<TileType, 'BURNING'>;
}

export type ComposureLevel = 0 | 1 | 2 | 3;

export interface ChimeraForm {
  sourceType: Exclude<PieceType, 'CHIMERA'>;
  copiedTraits: TraitId[];
  saintEcho?: 'FAITH_WARD' | 'MADNESS_PIERCE';
}

export interface PieceV3Fields {
  /** Consecutive active turn-ends spent on MIASMA (2 triggers suffocation damage) */
  miasmaExposure?: number;
  /** 3: Calm, 2: Shaken, 1: Fragile (Drift + Disobedience), 0: Breakdown */
  composure?: ComposureLevel;
  /** 45° curved drift direction (+1 CW, -1 CCW). Seeded from piece.id hash, flips each drifted move */
  driftSign?: 1 | -1;
  /** Full own turns accumulated in SAINT_FAITH aura (0..3) */
  faithCharge?: number;
  /** Full own turns accumulated in SAINT_MADNESS aura (0..3) */
  madnessCharge?: number;
  /** Active Berserk status granted by SAINT_MADNESS ultimate */
  berserkReady?: boolean;
  /** Remaining full turns where enemy buffs/traits/auras are silenced (0..2) */
  silencedTurns?: number;
  /** CHIMERA only: up to 2 absorbed forms (FIFO) */
  absorbedForms?: ChimeraForm[];
}

export type VisibilityLevel = 'UNEXPLORED' | 'EXPLORED' | 'VISIBLE';

export type TraitId =
  | 'SHIELDED'
  | 'FROST_TOUCH'
  | 'EXPLOSIVE'
  | 'SCOUT'
  | 'SHADOW_WALKER'
  | 'PUSHER'
  | 'DASH_ON_REVEAL';

export type FactionPassive =
  | 'NONE'
  | 'FROST_WARDENS'
  | 'NECROMANCERS'
  | 'SIEGE_ENGINEERS'
  | 'RAIDERS';

export type AggroState = 'SLEEPING' | 'ALERTED' | 'ACTIVE';

export type GameMode = 'CAMPAIGN' | 'SKIRMISH' | 'SANDBOX';

export type AbilityId = 'PUSH' | 'BREAK_WALL';

export const MAX_TRAITS_PER_PIECE = 3;
export const MAX_SLIDE_STEPS = 16;
export const DEFAULT_BURN_TURNS = 2;
export const NECROMANCER_SPAWN_TURNS = 2;
export const WATCHTOWER_VISION_BONUS = 2;
export const SCOUT_VISION_BONUS = 2;
export const SILHOUETTE_RING_EXTENSION = 2;
export const SKIRMISH_BUDGET = 20;
export const SAVE_VERSION = 1;
export const MAX_GAS_CHAIN_TILES = 64;
export const MAX_CHAIN_ITERATIONS = 32;
export const MIASMA_SUFFOCATION_THRESHOLD = 2;
export const DEFAULT_COMPOSURE: ComposureLevel = 3;

export const BASE_VISION_RADIUS: Readonly<Record<PieceType, number>> = {
  PAWN: 2,
  KNIGHT: 2,
  ROOK: 3,
  BISHOP: 3,
  QUEEN: 3,
  KING: 3,
  SAINT_FAITH: 3,
  SAINT_MADNESS: 3,
  CHIMERA: 3,
};

export const UNIT_COSTS: Readonly<Record<Exclude<PieceType, 'KING'>, number>> = {
  PAWN: 1,
  KNIGHT: 3,
  BISHOP: 3,
  ROOK: 5,
  QUEEN: 9,
  SAINT_FAITH: 6,
  SAINT_MADNESS: 6,
  CHIMERA: 10,
};

export const SCOUT_PAWN_COST = 2;

export interface Coord {
  x: number;
  y: number;
}

export interface TileState extends TileV3Fields {
  type: TileType;
  burnTurns: number;
  /** Underlying tile restored when a BURNING tile extinguishes (defaults to PLAIN). */
  revertType?: 'PLAIN' | 'WATCHTOWER';
}

export interface Piece extends PieceV3Fields {
  id: string;
  side: Side;
  type: PieceType;
  pos: Coord;
  traits: TraitId[];
  shieldActive: boolean;
  frozenTurns: number;
  hasMoved: boolean;
  aggro: AggroState;
  usedDashThisTurn: boolean;
  wasVisibleAtTurnStart: boolean;
  isBoss?: boolean;
}

export interface LegalMoveMeta {
  to: Coord;
  path: Coord[];
  isDrifted: boolean;
  disobeyed: boolean;
  disobeyReason?: string;
  lethalWarning?: 'PIT' | 'SPIKES' | 'MIASMA' | 'BURNING' | 'GAS_BLAST';
}

export interface VisibleStateV3Fields {
  hallucinationSilhouettes: Coord[];
}

export interface PendingSpawn {
  pos: Coord;
  turnsRemaining: number;
  side: Side;
  pieceType: PieceType;
}

/**
 * Minimal board projection usable by both full GameState and fog-filtered VisibleState
 * without leaking hidden enemy data.
 */
export interface BoardView {
  width: number;
  height: number;
  tiles: readonly (readonly (TileState | null)[])[];
  pieces: readonly Piece[];
  factions: Readonly<Record<Side, FactionPassive>>;
}

export interface SlideResolution {
  /** Ordered coordinates traversed starting from origin (inclusive) through landing/impact/pit square. */
  path: Coord[];
  /** Resting coordinate of the moving piece, or null if it died in a PIT. */
  finalPos: Coord | null;
  /** True when ICE slide physics actually propelled or collided the piece past its target tile. */
  slid: boolean;
  /** True when the piece fell into a PIT and perished. */
  fellInPit: boolean;
  /** True when the piece survives and finishes on a BURNING tile. */
  endsOnBurning: boolean;
  /** ID of enemy piece collided with (captured or shield broken), if any. */
  hitPieceId: string | null;
  /** Coordinate of the collided enemy piece, if any. */
  hitPos: Coord | null;
  /** True if the collision broke an active shield (attacker bounces back). */
  brokeShield: boolean;
  /** True if the collision captured and removed the enemy piece. */
  captured: boolean;
  /** True if a surviving pawn finished on the enemy back rank and should promote. */
  promotes: boolean;
}

export interface LegalMove {
  pieceId: string;
  from: Coord;
  /** Directly targeted board coordinate (clicked tile). */
  to: Coord;
  resolution: SlideResolution;
  /** True if executing this move leads to a PIT death or ends on a BURNING tile or EXTENDED spikes. */
  isHazardous: boolean;
  /** True if this move uses 45° Curved Stress Drift (step >= 3 while composure === 1). */
  isDrifted?: boolean;
  /** Drift sign (+1 CW / -1 CCW) applied for this move when `isDrifted` is true. */
  driftSign?: 1 | -1;
}

export interface ConnectivityResult {
  connected: boolean;
  path: Coord[];
}

export type GameAction =
  | { type: 'MOVE'; pieceId: string; to: Coord }
  | { type: 'USE_ABILITY'; pieceId: string; ability: AbilityId; target: Coord }
  | { type: 'END_TURN' };

export type MatchEndReason =
  | 'KING_CAPTURED'
  | 'KING_FELL_IN_PIT'
  | 'KING_BURNED'
  | 'KING_SUFFOCATED'
  | 'KING_INCINERATED'
  | 'KING_SKEWERED'
  | 'MUTUAL_ELIMINATION';

export type ShieldBreakSource = 'ATTACK' | 'BURN' | 'MIASMA' | 'GAS_BLAST' | 'ARROW' | 'SPIKES';

export type ComposureChangeReason =
  | 'HAZARD'
  | 'ALLY_DEATH'
  | 'MADNESS_AURA'
  | 'FAITH_AURA'
  | 'BREAKDOWN_RECOVERY'
  | 'CLEANSE'
  | 'SHIELD_BROKEN'
  | 'CAPTURE';

export type V3GameEvent =
  // Zindan & Kimya
  | { type: 'PIECE_CHOKED_BY_MIASMA'; pieceId: string; at: Coord }
  | { type: 'PIECE_MIASMA_TICK'; pieceId: string; at: Coord; exposure: number }
  | { type: 'PIECE_SUFFOCATED'; pieceId: string; at: Coord }
  | { type: 'GAS_CHAIN_DETONATED'; origin: Coord; tiles: Coord[] }
  | { type: 'PIECE_INCINERATED'; pieceId: string; at: Coord }
  | { type: 'PLATE_TRIGGERED'; plateId: string; at: Coord; triggeredByPieceId: string }
  | { type: 'ARROW_FIRED'; emitterId: string; from: Coord; path: Coord[]; flaming: boolean }
  | { type: 'PIECE_SKEWERED'; pieceId: string; at: Coord; source: 'ARROW' | 'SPIKES' }
  | { type: 'TILE_COLLAPSED'; at: Coord; reason: 'DEPARTURE' | 'PASS_THROUGH' | 'BLAST' }
  | { type: 'SPIKES_PHASE_CHANGED'; changes: Array<{ at: Coord; phase: SpikePhase }> }
  // Psikoloji & Yeni Taşlar
  | {
      type: 'COMPOSURE_CHANGED';
      pieceId: string;
      from: ComposureLevel;
      to: ComposureLevel;
      reason: ComposureChangeReason;
    }
  | { type: 'PIECE_BREAKDOWN'; pieceId: string; at: Coord }
  | { type: 'PIECE_DRIFTED'; pieceId: string; path: Coord[]; driftSign: 1 | -1 }
  | { type: 'PIECE_DISOBEYED'; pieceId: string; attemptedTo: Coord; quote: string }
  | {
      type: 'SAINT_AURA_TICK';
      saintId: string;
      targetId: string;
      aspect: 'FAITH' | 'MADNESS';
      charge: number;
    }
  | {
      type: 'FAITH_ULTIMATE_TRIGGERED';
      saintId: string;
      shieldedTargetId: string;
      pulseOrigin: Coord;
      pulseRadius: 3;
      cleansedAllyIds: string[];
      silencedEnemyIds: string[];
    }
  | { type: 'MADNESS_ULTIMATE_TRIGGERED'; saintId: string; targetId: string; at: Coord }
  | { type: 'BERSERK_CHAIN_TRIGGERED'; pieceId: string; at: Coord; kickedPieceId?: string }
  | { type: 'PIECE_SILENCE_EXPIRED'; pieceId: string }
  | { type: 'CHIMERA_EVOLVED'; chimeraId: string; absorbedType: PieceType; droppedType?: PieceType }
  | { type: 'HALLUCINATION_DISPELLED'; at: Coord };

export type GameEvent =
  | { type: 'PIECE_MOVED'; pieceId: string; from: Coord; to: Coord }
  | { type: 'PIECE_SLID'; pieceId: string; path: Coord[]; to: Coord }
  | { type: 'SHIELD_BROKEN'; pieceId: string; pos: Coord; source: ShieldBreakSource }
  | {
      type: 'PIECE_CAPTURED';
      pieceId: string;
      byPieceId: string;
      pos: Coord;
      pieceType: PieceType;
      side: Side;
    }
  | {
      type: 'PIECE_FELL_IN_PIT';
      pieceId: string;
      pos: Coord;
      pieceType: PieceType;
      side: Side;
    }
  | { type: 'PIECE_BURNED'; pieceId: string; pos: Coord; killed: boolean }
  | { type: 'PIECE_FROZEN'; pieceId: string; pos: Coord; turns: number }
  | { type: 'PIECE_PUSHED'; pieceId: string; byPieceId: string; from: Coord; to: Coord }
  | { type: 'TILE_IGNITED'; pos: Coord; burnTurns: number }
  | { type: 'TILE_EXTINGUISHED'; pos: Coord; revertedTo: TileType }
  | { type: 'WALL_DESTROYED'; pos: Coord; byPieceId: string }
  | { type: 'ENEMY_ALERTED'; pieceId: string; pos: Coord }
  | { type: 'UNIT_SPAWNED'; pieceId: string; pos: Coord; side: Side; pieceType: PieceType }
  | {
      type: 'PIECE_PROMOTED';
      pieceId: string;
      pos: Coord;
      fromType: PieceType;
      toType: PieceType;
    }
  | { type: 'TURN_CHANGED'; nextTurn: Side; turnNumber: number }
  | { type: 'MATCH_ENDED'; winner: Side | 'DRAW'; reason: MatchEndReason }
  | V3GameEvent;

export interface GameState {
  width: number;
  height: number;
  tiles: TileState[][];
  pieces: Piece[];
  turn: Side;
  turnNumber: number;
  mode: GameMode;
  factions: Record<Side, FactionPassive>;
  fog: Record<Side, VisibilityLevel[][]>;
  pendingSpawns: PendingSpawn[];
  bonusMovePieceId: string | null;
  rngState: number;
  actionHistory: GameAction[];
  winner: Side | 'DRAW' | null;
  nextEntityId: number;
  bossCooldown: number;
}

export interface StepResult {
  nextState: GameState;
  events: GameEvent[];
  error?: string;
}

export interface Silhouette {
  pos: Coord;
  side: Side;
}

export interface VisibleState extends Partial<VisibleStateV3Fields> {
  viewer: FogPerspective;
  width: number;
  height: number;
  tiles: (TileState | null)[][];
  fog: VisibilityLevel[][];
  pieces: Piece[];
  silhouettes: Silhouette[];
  pendingSpawns: PendingSpawn[];
  turn: Side;
  turnNumber: number;
  mode: GameMode;
  factions: Record<Side, FactionPassive>;
  bonusMovePieceId: string | null;
  winner: Side | 'DRAW' | null;
}

export type AppScreen =
  | 'MAIN_MENU'
  | 'SQUAD_SELECT'
  | 'BATTLE'
  | 'CAMPAIGN_REWARD'
  | 'BOSS_BATTLE'
  | 'RUN_VICTORY'
  | 'RUN_DEFEAT'
  | 'SKIRMISH_DEPLOY'
  | 'SKIRMISH_DRAFT'
  | 'MATCH_SUMMARY'
  | 'SANDBOX';

export interface AppSettings {
  soundEnabled: boolean;
  soundVolume: number;
  animationSpeed: 1 | 2;
  showIntentArrows: boolean;
  narrativeTone?: 'unfiltered' | 'polite';
}

export interface RosterUnit {
  id: string;
  type: PieceType;
  traits: TraitId[];
}

export interface CampaignPactEffect {
  trait: TraitId;
  roomsRemaining: number;
}

export interface CampaignRunState {
  seed: string;
  rngState: number;
  squadId: string;
  /** Campaign Act number (omitted / 1 = Act 1 Glacier, 2 = Act 2 Dungeon Chemistry, 3 = Act 3 Psychology & Chimera). */
  act?: 1 | 2 | 3;
  roomIndex: number;
  roster: RosterUnit[];
  lostUnits: RosterUnit[];
  playerFaction: FactionPassive;
  shieldAllNextBattle: boolean;
  activePacts: CampaignPactEffect[];
  currentBattle: GameState | null;
}

export interface SkirmishRunState {
  seed: string;
  rngState: number;
  roundIndex: number;
  playerWins: number;
  enemyWins: number;
  lastRoundWinner: Side | null;
  playerRoster: RosterUnit[];
  enemyRoster: RosterUnit[];
  playerFaction: FactionPassive;
  enemyFaction: FactionPassive;
  aiTemplateName?: string;
  /** True when played by 2 human players on the same device (Pass & Play / rotating board). */
  isLocal2P?: boolean;
  currentBattle: GameState | null;
}

export interface AppRunState {
  saveVersion: typeof SAVE_VERSION;
  screen: AppScreen;
  settings: AppSettings;
  campaign: CampaignRunState | null;
  skirmish: SkirmishRunState | null;
}

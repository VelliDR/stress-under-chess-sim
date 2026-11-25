import {
  AiMemory,
  chooseCampaignAction,
  computeCampaignIntents,
  createAiMemory,
  filterVisibleIntents,
  updateAiMemory,
} from '../ai/campaignAi';
import { computeSkirmishRosterCost } from '../ai/skirmishAi';
import {
  AI_DIFFICULTY_PROFILES,
  AiDifficulty,
  ALL_AI_DIFFICULTIES,
  computeStressMetrics,
} from '../ai/sucsAi';
import { SucsAiRunner } from '../ai/sucsAiRunner';
import { SynthSfx } from '../audio/synthSfx';
import {
  buildCampaignEncounterById,
  generateSkirmishMap,
  getCampaignRoomsForAct,
  getCampaignRoomTemplate,
  SECRET_ACT4_ROOM,
} from '../data/encounters';
import { ALL_FACTIONS, FACTION_DEFINITIONS } from '../data/factions';
import {
  advanceToNextSkirmishRound,
  applyCampaignReward,
  applySkirmishDraftPick,
  autoDeploySkirmishRoster,
  buildValidatedSkirmishSidePieces,
  CampaignRewardCard,
  chooseAndApplyAiSkirmishDraft,
  continueCampaignToNextAct,
  createCampaignRun,
  createLocal2pSkirmishRun,
  createSkirmishRun,
  generateCampaignRewards,
  generateSkirmishDraftChoices,
  isValidSkirmishDeployCoord,
  resolveCampaignBattleOutcome,
  resolveSkirmishRoundOutcome,
  SkirmishDraftCard,
  startLocal2pRoundBattle,
  startSkirmishRoundBattle,
} from '../data/rewards';
import {
  buildNarrativePieceMap,
  getDefeatBanner,
  getLivePatchQuote,
  getRoomIntroQuote,
  getVictoryQuote,
  LivePatchId,
  mapMatchEndToDefeatReason,
  NarrativeTone,
  pickTerminalEntry,
} from '../data/narrative';
import {
  coordEquals,
  getLegalMoves,
  getPieceAt,
  isTileWalkable,
} from '../engine/board';
import { getPieceVisionRadius } from '../engine/fog';
import { computeStateHash } from '../engine/prng';
import { stepGame } from '../engine/reducer';
import { getLegalAbilities, LegalAbility } from '../engine/traits';
import {
  AbilityId,
  AppRunState,
  AppScreen,
  AppSettings,
  CampaignRunState,
  Coord,
  FactionPassive,
  FogPerspective,
  GameAction,
  GameEvent,
  GameState,
  LegalMove,
  MAX_TRAITS_PER_PIECE,
  Piece,
  PieceType,
  RosterUnit,
  SAVE_VERSION,
  Side,
  SkirmishRunState,
  TileState,
  TileType,
  TraitId,
  VisibleState,
} from '../engine/types';
import { getVisibleState, getVisibleStateForPerspective } from '../engine/visibility';
import { CanvasRenderer, IntentArrow, localPointToTile } from '../render/canvasRenderer';
import { FxQueue } from '../render/fxQueue';
import { SpeechOverlay } from '../render/speechOverlay';
import { RenderTheme } from '../render/spriteCache';
import { createPieceIconCanvas } from '../render/sprites';
import {
  clearSavedAppState,
  DEFAULT_APP_SETTINGS,
  getDailySeed,
  getResumableRunSummary,
  loadAiDifficulty,
  loadAppState,
  normalizeSeed,
  ResumableRunSummary,
  saveAiDifficulty,
  saveAppState,
} from '../storage/persistence';
import {
  createDefaultUiPrefs,
  loadUiPrefs,
  saveUiPrefs,
  UiPrefsState,
} from '../storage/uiPrefs';
import {
  buildQuickArmyTemplate,
  createDeployVisibilityFog,
  renderArmyBuilderCatalogCard,
} from './armyBuilder';
import { buildEndMatchMetricsGrid, PauseModal } from './battleHud';
import { CodexModal } from './codexModal';
import { FullscreenController } from './fullscreenController';
import { HudNotificationCenter, type HudToastTone } from './hudNotifications';
import { MainMenuControllerHandle, renderMainMenuView } from './mainMenu';
import { type PixelIconName, renderPixelIconSvg } from './pixelIcons';
import { getSandboxPreset, SANDBOX_PRESETS } from './sandboxPresets';
import { SettingsModal } from './settingsModal';
import { renderSquadSelectView } from './squadSelect';

type PerspectiveMode = 'AUTO' | FogPerspective;
type EnemyControlMode = 'MANUAL' | 'CAMPAIGN_AI' | 'SKIRMISH_AI';

interface UndoEntry {
  state: GameState;
  aiMemory: AiMemory;
}

const PIECE_NAMES: Readonly<Record<PieceType, string>> = {
  KING: 'Şah',
  QUEEN: 'Vezir',
  ROOK: 'Kale',
  BISHOP: 'Fil',
  KNIGHT: 'At',
  PAWN: 'Piyon',
  SAINT_FAITH: 'Ocaklı',
  SAINT_MADNESS: 'Meczup',
  CHIMERA: 'Gulyabani',
};

const TILE_INFO: Readonly<Record<TileType, { name: string; desc: string }>> = {
  PLAIN: { name: 'Düz Zemin', desc: 'Normal hareket ve açık görüş hattı.' },
  WALL: {
    name: 'Taş Duvar',
    desc: 'Geçilemez ve görüş hattını (LOS) keser. Yalnızca At üzerinden atlayabilir; Kuşatma Mühendisleri Kalesi kırabilir.',
  },
  PIT: {
    name: 'Çukur',
    desc: 'Yürünemez, görüşü kesmez. At üstünden atlayabilir; buzla kayarak veya itilerek giren taş yok olur.',
  },
  ICE: {
    name: 'Buz',
    desc: 'Üzerine yürüyerek/kayarak giren taş (At ve Buzul Muhafızları hariç) hareket yönünde engel görene dek kayar.',
  },
  WATCHTOWER: {
    name: 'Gözetleme Kulesi',
    desc: 'Üzerindeki taşın görüş yarıçapına +2 ekler.',
  },
  BURNING: {
    name: 'Yanan Kare',
    desc: 'Geçilebilir ancak tur sonunda üzerinde kalan aktif taraf taşı 1 yanma hasarı alır.',
  },
  CRACKED: {
    name: 'Çatlak Zemin',
    desc: 'Yürünebilir ancak üzerinden ayrılma, durmadan geçme veya patlama anında Çukura çöker.',
  },
};

const TRAIT_INFO: Readonly<Record<TraitId, { name: string; desc: string }>> = {
  SHIELDED: {
    name: 'Zırhlı',
    desc: 'Savaş başına 1 kez ilk saldırı veya yanma hasarını emer; saldıran geri seker.',
  },
  FROST_TOUCH: {
    name: 'Buz Dokunuşu',
    desc: 'Kalkanını kırdığı hedefi veya hareket sonunda ortogonal bitişiğindeki ilk düşmanı 1 tur dondurur.',
  },
  EXPLOSIVE: {
    name: 'Patlayıcı',
    desc: 'Öldüğünde (çukura düşmediyse) kendi karesi ve 4 ortogonal komşusunu 2 tur yakar.',
  },
  SCOUT: { name: 'Gözcü', desc: 'Görüş yarıçapı +2 artar.' },
  SHADOW_WALKER: {
    name: 'Gölge',
    desc: 'Silüet halkasında ? bırakmaz; yalnızca doğrudan görünür alana girince ortaya çıkar.',
  },
  PUSHER: {
    name: 'İtici',
    desc: 'Aktif yetenek (İT): Ortogonal bitişikteki 1 düşmanı uzaklaşma yönünde 1 kare iter (çukur/buz zinciri tetiklenir).',
  },
  DASH_ON_REVEAL: {
    name: 'Pusu',
    desc: 'Tur başında rakibe görünmezken hamle yapıp görünür olursa aynı tur 1 ekstra hamle kazanır.',
  },
};

function formatFactionOption(fac: FactionPassive): string {
  const def = FACTION_DEFINITIONS[fac];
  return fac === 'NONE' ? def.name : `${def.name} (${def.shortDesc})`;
}

function formatCoord(c: Coord, boardHeight: number): string {
  const file = String.fromCharCode(65 + c.x);
  const rank = boardHeight - c.y;
  return `${file}${rank}`;
}

function formatRosterUnitLabel(u: RosterUnit): string {
  const base = PIECE_NAMES[u.type];
  if (u.traits.length === 0) return base;
  return `${base} [${u.traits.map((t) => TRAIT_INFO[t].name).join(', ')}]`;
}

function cloneStateSnapshot(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function isEventVisibleToViewer(
  ev: GameEvent,
  prevView: VisibleState,
  nextView: VisibleState,
): boolean {
  if (nextView.viewer === 'OMNISCIENT') return true;
  if (ev.type === 'TURN_CHANGED' || ev.type === 'MATCH_ENDED') return true;

  const checkPos = (p: Coord): boolean =>
    prevView.fog[p.y]?.[p.x] === 'VISIBLE' || nextView.fog[p.y]?.[p.x] === 'VISIBLE';

  const checkPieceId = (pieceId: string): boolean =>
    prevView.pieces.some((p) => p.id === pieceId) || nextView.pieces.some((p) => p.id === pieceId);

  switch (ev.type) {
    case 'PIECE_MOVED':
    case 'PIECE_PUSHED':
      return checkPos(ev.from) || checkPos(ev.to);
    case 'PIECE_SLID':
      return ev.path.some(checkPos) || checkPos(ev.to);
    case 'SHIELD_BROKEN':
    case 'PIECE_CAPTURED':
    case 'PIECE_FELL_IN_PIT':
    case 'PIECE_BURNED':
    case 'PIECE_FROZEN':
    case 'TILE_IGNITED':
    case 'TILE_EXTINGUISHED':
    case 'WALL_DESTROYED':
    case 'ENEMY_ALERTED':
    case 'UNIT_SPAWNED':
    case 'PIECE_PROMOTED':
      return checkPos(ev.pos);
    case 'PIECE_CHOKED_BY_MIASMA':
    case 'PIECE_MIASMA_TICK':
    case 'PIECE_SUFFOCATED':
    case 'PIECE_INCINERATED':
    case 'PLATE_TRIGGERED':
    case 'PIECE_SKEWERED':
    case 'TILE_COLLAPSED':
    case 'PIECE_BREAKDOWN':
    case 'MADNESS_ULTIMATE_TRIGGERED':
    case 'BERSERK_CHAIN_TRIGGERED':
    case 'HALLUCINATION_DISPELLED':
      return checkPos(ev.at);
    case 'GAS_CHAIN_DETONATED':
      return checkPos(ev.origin) || ev.tiles.some(checkPos);
    case 'ARROW_FIRED':
      return checkPos(ev.from) || ev.path.some(checkPos);
    case 'SPIKES_PHASE_CHANGED':
      return ev.changes.some((c) => checkPos(c.at));
    case 'PIECE_DRIFTED':
      return ev.path.some(checkPos);
    case 'PIECE_DISOBEYED':
      return checkPieceId(ev.pieceId) || checkPos(ev.attemptedTo);
    case 'COMPOSURE_CHANGED':
    case 'PIECE_SILENCE_EXPIRED':
      return checkPieceId(ev.pieceId);
    case 'SAINT_AURA_TICK':
      return checkPieceId(ev.saintId) || checkPieceId(ev.targetId);
    case 'FAITH_ULTIMATE_TRIGGERED':
      return checkPos(ev.pulseOrigin) || checkPieceId(ev.saintId) || checkPieceId(ev.shieldedTargetId);
    case 'CHIMERA_EVOLVED':
      return checkPieceId(ev.chimeraId);
  }
}

function describeEvent(
  ev: GameEvent,
  boardHeight: number,
  piecesById?: Readonly<Record<string, { side?: 'PLAYER' | 'ENEMY'; type: string; pos?: Coord }>>,
): string {
  switch (ev.type) {
    case 'PIECE_MOVED':
      return `Hamle: ${formatCoord(ev.from, boardHeight)} → ${formatCoord(ev.to, boardHeight)}`;
    case 'PIECE_SLID':
      return `Buz Kayması: ${formatCoord(ev.to, boardHeight)} karesine kaydı`;
    case 'PIECE_PUSHED':
      return coordEquals(ev.from, ev.to)
        ? `İtme engellendi (${formatCoord(ev.from, boardHeight)})`
        : `İtme: ${formatCoord(ev.from, boardHeight)} → ${formatCoord(ev.to, boardHeight)}`;
    case 'SHIELD_BROKEN': {
      const sourceLabels: Record<typeof ev.source, string> = {
        ATTACK: 'Saldırı',
        BURN: 'Yanma',
        MIASMA: 'Zehirli Sis',
        GAS_BLAST: 'Gaz Patlaması',
        ARROW: 'Duvar Oku',
        SPIKES: 'Kazık',
      };
      return `Kalkan kırıldı (${formatCoord(ev.pos, boardHeight)} — ${sourceLabels[ev.source]})`;
    }
    case 'PIECE_CAPTURED':
      return `${ev.side === 'PLAYER' ? 'Oyuncu' : 'Düşman'} ${PIECE_NAMES[ev.pieceType]} ele geçirildi (${formatCoord(ev.pos, boardHeight)})`;
    case 'PIECE_FELL_IN_PIT':
      return `${ev.side === 'PLAYER' ? 'Oyuncu' : 'Düşman'} ${PIECE_NAMES[ev.pieceType]} çukura düştü (${formatCoord(ev.pos, boardHeight)}) — Buzdan kaydı, hayat da böyle.`;
    case 'PIECE_BURNED':
      return ev.killed
        ? `Taş alevde kül oldu (${formatCoord(ev.pos, boardHeight)})`
        : `Yanma hasarı emildi (${formatCoord(ev.pos, boardHeight)})`;
    case 'PIECE_FROZEN':
      return `Taş ${ev.turns} tur dondu (${formatCoord(ev.pos, boardHeight)})`;
    case 'TILE_IGNITED':
      return `Kare tutuştu (${formatCoord(ev.pos, boardHeight)}, ${ev.burnTurns} tur)`;
    case 'TILE_EXTINGUISHED':
      return `Alev söndü (${formatCoord(ev.pos, boardHeight)})`;
    case 'WALL_DESTROYED':
      return `Duvar yıkıldı (${formatCoord(ev.pos, boardHeight)})`;
    case 'ENEMY_ALERTED':
      return `Düşman uyandı! (${formatCoord(ev.pos, boardHeight)})`;
    case 'UNIT_SPAWNED':
      return `İskelet ${PIECE_NAMES[ev.pieceType]} doğdu (${formatCoord(ev.pos, boardHeight)})`;
    case 'PIECE_PROMOTED':
      return `Piyon Vezir'e terfi etti! (${formatCoord(ev.pos, boardHeight)})`;
    case 'TURN_CHANGED':
      return `Tur #${ev.turnNumber} — Sıra: ${ev.nextTurn === 'PLAYER' ? 'OYUNCU' : 'DÜŞMAN'}`;
    case 'MATCH_ENDED':
      return `Maç bitti: ${
        ev.winner === 'PLAYER' ? 'OYUNCU KAZANDI' : ev.winner === 'ENEMY' ? 'DÜŞMAN KAZANDI' : 'BERABERE'
      }`;
    case 'PIECE_CHOKED_BY_MIASMA':
      return `Zehirli sis felci! (${formatCoord(ev.at, boardHeight)})`;
    case 'PIECE_MIASMA_TICK':
      return `Zehirli sis maruziyeti: ${ev.exposure}/2 (${formatCoord(ev.at, boardHeight)})`;
    case 'PIECE_SUFFOCATED':
      return `Taş zehirli siste boğuldu! (${formatCoord(ev.at, boardHeight)})`;
    case 'GAS_CHAIN_DETONATED':
      return `Gaz zincirleme patlaması! ${ev.tiles.length} kare tutuştu (${formatCoord(ev.origin, boardHeight)})`;
    case 'PIECE_INCINERATED':
      return `Taş gaz patlamasında kül oldu! (${formatCoord(ev.at, boardHeight)})`;
    case 'PLATE_TRIGGERED':
      return `Baskı plakası tetiklendi! (${formatCoord(ev.at, boardHeight)})`;
    case 'ARROW_FIRED':
      return `${ev.flaming ? 'Alevli duvar oku' : 'Duvar oku'} ateşlendi (${formatCoord(ev.from, boardHeight)})`;
    case 'PIECE_SKEWERED':
      return `Taş ${ev.source === 'ARROW' ? 'okla' : 'kazıkla'} şişlendi! (${formatCoord(ev.at, boardHeight)})`;
    case 'TILE_COLLAPSED':
      return `Çatlak zemin çukura çöktü! (${formatCoord(ev.at, boardHeight)})`;
    case 'SPIKES_PHASE_CHANGED':
      return `Zindan kazıkları hareket etti (${ev.changes.length} kare)`;
    case 'COMPOSURE_CHANGED': {
      const p = piecesById?.[ev.pieceId];
      if (p !== undefined) {
        const owner = p.side === 'PLAYER' ? 'Oyuncu ' : p.side === 'ENEMY' ? 'Düşman ' : '';
        const aliasMap: Record<string, string> = {
          OCAKLI: 'Ocaklı',
          MECZUP: 'Meczup',
          GULYABANI: 'Gulyabani',
        };
        const label = PIECE_NAMES[p.type as PieceType] ?? aliasMap[p.type] ?? p.type;
        const coordPart = p.pos !== undefined ? ` (${formatCoord(p.pos, boardHeight)})` : '';
        return `${owner}${label}${coordPart} dayanıklılığı: ${ev.from} → ${ev.to}`;
      }
      return `Taş dayanıklılığı değişti: ${ev.from} → ${ev.to}`;
    }
    case 'PIECE_BREAKDOWN':
      return `Sinir krizi! Taş 1 tur dondu (${formatCoord(ev.at, boardHeight)})`;
    case 'PIECE_DRIFTED':
      return `45° kavisli yalpalama gerçekleşti!`;
    case 'PIECE_DISOBEYED':
      return `İtaatsizlik (${formatCoord(ev.attemptedTo, boardHeight)}): "${ev.quote}"`;
    case 'SAINT_AURA_TICK':
      return `${ev.aspect === 'FAITH' ? 'İnanç' : 'Çılgınlık'} aurası şarjı: ${ev.charge}/3`;
    case 'FAITH_ULTIMATE_TRIGGERED':
      return `Kutsal Arınma ve Susturma! (${ev.cleansedAllyIds.length} dost arındı, ${ev.silencedEnemyIds.length} düşman susturuldu)`;
    case 'MADNESS_ULTIMATE_TRIGGERED':
      return `Kanlı Cinnet! Taş Berserk kazandı (${formatCoord(ev.at, boardHeight)})`;
    case 'BERSERK_CHAIN_TRIGGERED':
      return `Berserk zincir hamlesi tetiklendi! (${formatCoord(ev.at, boardHeight)})`;
    case 'PIECE_SILENCE_EXPIRED':
      return `Susturma etkisi sona erdi`;
    case 'CHIMERA_EVOLVED':
      return `Kimera evrimleşti: ${PIECE_NAMES[ev.absorbedType]} yutuldu!`;
    case 'HALLUCINATION_DISPELLED':
      return `Halüsinasyon dağıldı (${formatCoord(ev.at, boardHeight)})`;
  }
}

/**
 * Top-level UI controller managing AppScreen state machine:
 * MAIN_MENU, SQUAD_SELECT, BATTLE, BOSS_BATTLE, CAMPAIGN_REWARD, RUN_VICTORY, RUN_DEFEAT, SANDBOX.
 */
export class UiController {
  private readonly root: HTMLElement;
  private readonly sfx: SynthSfx;
  private readonly fxQueue: FxQueue;
  private readonly speechOverlay: SpeechOverlay;
  private readonly aiRunner: SucsAiRunner;
  private renderer: CanvasRenderer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private rafId: number | null = null;
  private lastFrameMs = 0;

  private screen: AppScreen = 'MAIN_MENU';
  private lastResumableScreen: AppScreen = 'MAIN_MENU';
  private seedInput = getDailySeed();
  private saveNotice = '';
  private settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
  private uiPrefs: UiPrefsState = createDefaultUiPrefs();
  private aiDifficulty: AiDifficulty = 'TENSE';
  private mainMenuHandle: MainMenuControllerHandle | null = null;
  private codexModal: CodexModal | null = null;
  private settingsModal: SettingsModal | null = null;
  private pauseModal: PauseModal | null = null;
  private fullscreen: FullscreenController | null = null;
  private hudNotify: HudNotificationCenter | null = null;
  private globalScanlinesEl: HTMLDivElement | null = null;
  private pauseTopBtnEl: HTMLButtonElement | null = null;
  private topbarFsBtnEl: HTMLButtonElement | null = null;
  private deployDraggingUnitId: string | null = null;
  private lastStressTone: 'calm' | 'tense' | 'sweat' | 'panic' | null = null;
  private lastStressReasons: readonly string[] = [];
  private roomPopoverOpen = false;
  private logDrawerOpen = false;
  private deployDrawerOpen = true;
  private unreadLogCount = 0;

  // Active battle state (shared by SANDBOX, CAMPAIGN, SKIRMISH, and LOCAL_2P)
  private activeBattleKind: 'SANDBOX' | 'CAMPAIGN' | 'SKIRMISH' | 'LOCAL_2P' = 'SANDBOX';
  private state: GameState;
  private aiMemory: AiMemory = createAiMemory();
  private aiTimerId: number | null = null;
  private aiRunEpoch = 0;
  private cachedIntentArrows: IntentArrow[] = [];

  // Same-Device 2-Player (Pass & Play / Rotating Board + "Sıradaki" button) state
  private hotseatViewerSide: Side = 'PLAYER';
  private hotseatDeploySide: Side = 'PLAYER';
  private hotseatDraftSide: Side = 'PLAYER';
  private hotseatPlayerPlacements: Record<string, Coord> = {};
  private hotseatHandoffEl: HTMLDivElement | null = null;
  private nextPlayerBtnEl: HTMLButtonElement | null = null;

  // Sandbox state
  private presetId = SANDBOX_PRESETS[0]!.id;
  private undoStack: UndoEntry[] = [];
  private perspectiveMode: PerspectiveMode = 'AUTO';
  private enemyControl: EnemyControlMode = 'MANUAL';

  // Campaign state
  private campaign: CampaignRunState | null = null;
  private selectedCampaignAct: 1 | 2 | 3 = 1;
  private activeCampaignRoomOverrideId: string | null = null;
  private pendingRewards: CampaignRewardCard[] = [];
  private pendingRewardsNextRng = 0;
  private selectedRewardCardId: string | null = null;
  private lastBattleNewlyLost: RosterUnit[] = [];

  // Skirmish (Best of 3) state
  private skirmish: SkirmishRunState | null = null;
  private skirmishDeployMap: {
    name: string;
    width: number;
    height: number;
    tiles: TileState[][];
  } | null = null;
  private skirmishPlacements: Record<string, Coord> = {};
  private skirmishSelectedUnitId: string | null = null;
  private skirmishDraftPool: 'RARE' | 'STANDARD' = 'STANDARD';
  private skirmishDraftCards: SkirmishDraftCard[] = [];
  private pendingDraftNextRng = 0;
  private selectedDraftCardId: string | null = null;
  private skirmishLastAiNote = '';
  private skirmishMatchWinner: Side | 'DRAW' | null = null;
  private skirmishUnitSeq = 20;

  // Board interaction state
  private selectedCoord: Coord | null = null;
  private inspectedCoord: Coord | null = null;
  private hoveredCoord: Coord | null = null;
  private activeAbility: AbilityId | null = null;
  private legalMoves: LegalMove[] = [];
  private legalAbilities: LegalAbility[] = [];
  private showThreatOverlay = true;
  private cachedThreatCoords: Coord[] = [];
  private lastVisibleMove: { from: Coord; to: Coord } | null = null;
  private statusMessage = '';
  private eventLog: string[] = [];
  private currentStressScore = 0;
  private calmScreen = false;

  // Persistent topbar refs
  private shellEl!: HTMLDivElement;
  private topbarEl!: HTMLElement;
  private mainContainerEl!: HTMLDivElement;
  private modeBadgeEl!: HTMLSpanElement;
  private turnPillEl!: HTMLDivElement;
  private menuBackBtnEl!: HTMLButtonElement;
  private muteBtnEl!: HTMLButtonElement;
  private volumeWrapEl!: HTMLLabelElement;
  private volumeInputEl!: HTMLInputElement;
  private speedBtnEl!: HTMLButtonElement;
  private intentBtnEl!: HTMLButtonElement;
  private threatBtnEl!: HTMLButtonElement;
  private toneBtnEl!: HTMLButtonElement;

  // Board & stage HUD refs (re-created when entering SANDBOX / BATTLE / BOSS_BATTLE / SKIRMISH_DEPLOY)
  private canvasEl: HTMLCanvasElement | null = null;
  private canvasWrapEl: HTMLDivElement | null = null;
  private abilityGroupEl: HTMLDivElement | null = null;
  private passBtnEl: HTMLButtonElement | null = null;
  private undoBtnEl: HTMLButtonElement | null = null;
  private statusBannerEl: HTMLDivElement | null = null;
  private postBattleCtaEl: HTMLDivElement | null = null;
  private inspectCardEl: HTMLDivElement | null = null;
  private inspectorBodyEl: HTMLDivElement | null = null;
  private eventLogListEl: HTMLUListElement | null = null;
  private hashCodeEl: HTMLSpanElement | null = null;
  private campaignHudEl: HTMLDivElement | null = null;
  private roomChipBtnEl: HTMLButtonElement | null = null;
  private roomPopoverEl: HTMLDivElement | null = null;
  private hudTurnChipEl: HTMLDivElement | null = null;
  private hudStressChipEl: HTMLButtonElement | null = null;
  private hudSpeedBtnEl: HTMLButtonElement | null = null;
  private hudMuteBtnEl: HTMLButtonElement | null = null;
  private hudThreatBtnEl: HTMLButtonElement | null = null;
  private hudIntentBtnEl: HTMLButtonElement | null = null;
  private hudLogBtnEl: HTMLButtonElement | null = null;
  private hudLogDrawerEl: HTMLDivElement | null = null;
  private hudFsBtnEl: HTMLButtonElement | null = null;
  private deployDrawerEl: HTMLElement | null = null;
  private deployToggleBtnEl: HTMLButtonElement | null = null;
  private aiDifficultySelectEl: HTMLSelectElement | null = null;

  // Sandbox-only control refs
  private presetSelectEl: HTMLSelectElement | null = null;
  private presetDescEl: HTMLDivElement | null = null;
  private perspectiveBtns: Partial<Record<PerspectiveMode, HTMLButtonElement>> = {};
  private playerFactionSelectEl: HTMLSelectElement | null = null;
  private enemyFactionSelectEl: HTMLSelectElement | null = null;
  private enemyControlSelectEl: HTMLSelectElement | null = null;

  private readonly handleKeyDown: (e: KeyboardEvent) => void;
  private readonly handleWindowResize: () => void;

  public constructor(root: HTMLElement) {
    this.root = root;
    this.sfx = new SynthSfx(this.settings.soundVolume, !this.settings.soundEnabled);
    this.fxQueue = new FxQueue((kind) => this.sfx.play(kind), 'tfc-fx');
    this.speechOverlay = new SpeechOverlay({
      onTypewriterChar: (idx) => this.sfx.playTypewriterChar(idx),
    });
    this.aiRunner = new SucsAiRunner();
    this.state = getSandboxPreset(this.presetId).build();

    this.handleKeyDown = (e: KeyboardEvent): void => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      this.sfx.unlock();

      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        void this.toggleFullscreen();
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        if (this.isBoardScreen()) {
          e.preventDefault();
          this.toggleLogDrawer();
          return;
        }
      }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        this.toggleMute();
        return;
      }
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        if (this.codexModal?.isOpen()) {
          this.codexModal.close();
        } else {
          this.openCodexModal();
        }
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        this.toggleIntentArrows();
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        this.toggleThreatOverlay();
        return;
      }

      if (e.code === 'Escape') {
        if (this.codexModal?.isOpen()) {
          e.preventDefault();
          this.codexModal.close();
          return;
        }
        if (this.settingsModal?.isOpen()) {
          e.preventDefault();
          this.settingsModal.close();
          return;
        }
        if (this.pauseModal?.isOpen()) {
          e.preventDefault();
          this.pauseModal.close();
          return;
        }
      }

      if (this.screen === 'SKIRMISH_DEPLOY') {
        if (this.hotseatHandoffEl !== null) return;
        if (e.code === 'Escape') {
          e.preventDefault();
          if (this.skirmishSelectedUnitId !== null) {
            this.skirmishSelectedUnitId = null;
            this.drawDeployFrame();
          } else if (this.fullscreen?.isPseudoFullscreen()) {
            void this.fullscreen.exit();
          } else if (this.deployDrawerOpen) {
            this.setDeployDrawerOpen(false);
          }
        } else if (e.code === 'Space') {
          e.preventDefault();
          this.confirmSkirmishDeployAndStart();
        }
        return;
      }

      const onBoard = this.isBoardScreen();
      if (!onBoard) return;
      if (this.hotseatHandoffEl !== null) return;

      if (e.code === 'Enter' && this.isHotseatWaitingNext()) {
        e.preventDefault();
        this.advanceHotseatTurn();
        return;
      }

      if (e.code === 'Tab') {
        e.preventDefault();
        this.cycleSelectablePiece();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        if (this.logDrawerOpen || this.roomPopoverOpen) {
          this.closeFloatingDrawers();
        } else if (this.selectedCoord !== null || this.activeAbility !== null) {
          this.clearSelection();
        } else if (this.inspectedCoord !== null) {
          this.inspectedCoord = null;
          this.refreshInspector();
        } else if (this.fullscreen?.isPseudoFullscreen()) {
          void this.fullscreen.exit();
        } else {
          this.openPauseModal();
        }
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (this.state.winner !== null) {
          if (this.activeBattleKind === 'CAMPAIGN') {
            this.proceedAfterCampaignBattle();
          } else if (this.activeBattleKind === 'SKIRMISH' || this.activeBattleKind === 'LOCAL_2P') {
            this.proceedAfterSkirmishRound();
          }
        } else if (this.isHotseatWaitingNext()) {
          this.advanceHotseatTurn();
        } else {
          this.dispatchAction({ type: 'END_TURN' });
        }
      } else if ((e.key === 'z' || e.key === 'Z') && this.screen === 'SANDBOX') {
        e.preventDefault();
        this.undoLastAction();
      }
    };

    this.handleWindowResize = (): void => {
      if (this.screen === 'SKIRMISH_DEPLOY') {
        this.syncDeployCanvasSize();
      } else {
        this.syncCanvasSize();
      }
    };
  }

  public mount(): void {
    this.hydrateFromStorage();
    this.buildShellDom();
    this.fullscreen = new FullscreenController({
      targetEl: this.root,
      onChange: (active, mode) => {
        this.refreshFullscreenButtons();
        window.requestAnimationFrame(() => this.handleWindowResize());
        if (active) {
          this.hudNotify?.showBanner({
            eyebrow: 'GÖRÜNTÜ MODU',
            title: mode === 'pseudo' ? 'TAM EKRAN (MOBİL)' : 'TAM EKRAN',
            subtitle: 'Çıkmak için [F] veya [Esc] tuşuna bas',
            tone: 'player',
            durationMs: 1650,
          });
        }
      },
    });
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('resize', this.handleWindowResize);
    this.sfx.play('crtBoot');
    this.setScreen('MAIN_MENU');
  }

  private hydrateFromStorage(): void {
    this.aiDifficulty = loadAiDifficulty();
    this.uiPrefs = loadUiPrefs();
    this.calmScreen = this.uiPrefs.calmScreen;
    this.fxQueue.setCalmScreen(this.calmScreen);
    const loaded = loadAppState();
    if (loaded.status === 'OK' && loaded.state !== null) {
      this.settings = { ...loaded.state.settings };
      this.sfx.setVolume(this.settings.soundVolume);
      this.sfx.setMuted(!this.settings.soundEnabled);
      this.fxQueue.setSpeed(this.settings.animationSpeed);
      this.speechOverlay.setTone(this.getNarrativeTone());
      this.campaign = loaded.state.campaign;
      this.skirmish = loaded.state.skirmish;
      this.lastResumableScreen = loaded.state.screen;
    } else if (
      loaded.status === 'RESET_CORRUPT' ||
      loaded.status === 'RESET_VERSION' ||
      loaded.status === 'RESET_INVALID'
    ) {
      this.saveNotice =
        'Eski sürüm veya bozuk kayıt dosyası tespit edildi; güvenli biçimde sıfırlandı.';
    }
  }

  private buildPersistableState(): AppRunState {
    const activeRunScreen: AppScreen =
      this.screen === 'BATTLE' ||
      this.screen === 'BOSS_BATTLE' ||
      this.screen === 'CAMPAIGN_REWARD' ||
      this.screen === 'SKIRMISH_DEPLOY' ||
      this.screen === 'SKIRMISH_DRAFT'
        ? this.screen
        : this.lastResumableScreen;

    return {
      saveVersion: SAVE_VERSION,
      screen: activeRunScreen,
      settings: { ...this.settings },
      campaign: this.campaign,
      skirmish: this.skirmish,
    };
  }

  private persistState(): void {
    if (
      this.screen === 'BATTLE' ||
      this.screen === 'BOSS_BATTLE' ||
      this.screen === 'CAMPAIGN_REWARD' ||
      this.screen === 'SKIRMISH_DEPLOY' ||
      this.screen === 'SKIRMISH_DRAFT'
    ) {
      this.lastResumableScreen = this.screen;
    }
    saveAppState(this.buildPersistableState());
  }

  private resumeSavedRun(summary: ResumableRunSummary): void {
    this.saveNotice = '';
    if (summary.kind === 'CAMPAIGN' && this.campaign !== null) {
      this.seedInput = this.campaign.seed;
      if (summary.targetScreen === 'CAMPAIGN_REWARD') {
        const gen = generateCampaignRewards(this.campaign);
        this.pendingRewards = gen.cards;
        this.pendingRewardsNextRng = gen.nextRngState;
        this.selectedRewardCardId = null;
        this.setScreen('CAMPAIGN_REWARD');
      } else {
        this.enterCurrentCampaignRoom();
      }
      return;
    }

    if (summary.kind === 'SKIRMISH' && this.skirmish !== null) {
      this.seedInput = this.skirmish.seed;
      const is2p = this.skirmish.isLocal2P === true;
      if (summary.targetScreen === 'BATTLE' && this.skirmish.currentBattle !== null) {
        this.activeBattleKind = is2p ? 'LOCAL_2P' : 'SKIRMISH';
        this.state = this.skirmish.currentBattle;
        this.hotseatViewerSide = this.state.turn;
        this.aiMemory = updateAiMemory(createAiMemory(), getVisibleState(this.state, 'ENEMY'), 'ENEMY');
        this.undoStack = [];
        this.selectedCoord = null;
        this.inspectedCoord = null;
        this.hoveredCoord = null;
        this.activeAbility = null;
        this.legalMoves = [];
        this.legalAbilities = [];
        this.eventLog = [];
        this.pushLog(
          `${is2p ? 'Kayıtlı 2P Maç' : 'Kayıtlı Düello'} El ${this.skirmish.roundIndex + 1} devam ettiriliyor.`,
        );
        this.statusMessage = is2p
          ? `Kayıtlı el yüklendi — Sıra: ${this.getHotseatSideLabel(this.state.turn)} (Tur #${this.state.turnNumber}).`
          : `Kayıtlı el yüklendi (Tur #${this.state.turnNumber}).`;
        this.setScreen('BATTLE');
      } else if (summary.targetScreen === 'SKIRMISH_DRAFT') {
        this.hotseatDraftSide = 'PLAYER';
        const gen = generateSkirmishDraftChoices(this.skirmish, 'PLAYER');
        this.skirmishDraftPool = gen.pool;
        this.skirmishDraftCards = gen.cards;
        this.pendingDraftNextRng = gen.nextRngState;
        this.selectedDraftCardId = null;
        this.setScreen('SKIRMISH_DRAFT');
      } else {
        this.hotseatDeploySide = 'PLAYER';
        this.hotseatPlayerPlacements = {};
        this.enterSkirmishDeploy();
      }
    }
  }

  public destroy(): void {
    this.closeHotseatHandoff();
    this.teardownBoardScreen();
    this.fullscreen?.destroy();
    this.fullscreen = null;
    this.aiRunner.destroy();
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('resize', this.handleWindowResize);
  }

  private isLocal2pMode(): boolean {
    if (
      this.screen === 'SKIRMISH_DEPLOY' ||
      this.screen === 'SKIRMISH_DRAFT' ||
      this.screen === 'MATCH_SUMMARY'
    ) {
      return this.skirmish?.isLocal2P === true;
    }
    return this.activeBattleKind === 'LOCAL_2P';
  }

  private isHotseatWaitingNext(): boolean {
    return (
      this.activeBattleKind === 'LOCAL_2P' &&
      this.screen === 'BATTLE' &&
      this.state.winner === null &&
      this.state.turn !== this.hotseatViewerSide
    );
  }

  private getHotseatSideLabel(side: Side): string {
    return side === 'PLAYER' ? '1. Oyuncu (Mavi)' : '2. Oyuncu (Kırmızı)';
  }

  private getLocalControlledSide(): Side {
    if (this.activeBattleKind === 'LOCAL_2P') return this.hotseatViewerSide;
    if (this.screen === 'SANDBOX') return this.state.turn;
    return 'PLAYER';
  }

  private shouldFlipBoard(): boolean {
    if (this.screen === 'SKIRMISH_DEPLOY' && this.skirmish?.isLocal2P === true) {
      return this.hotseatDeploySide === 'ENEMY';
    }
    if (this.activeBattleKind === 'LOCAL_2P' && this.screen === 'BATTLE') {
      return this.hotseatViewerSide === 'ENEMY';
    }
    return false;
  }

  private isBoardScreen(): boolean {
    return this.screen === 'SANDBOX' || this.screen === 'BATTLE' || this.screen === 'BOSS_BATTLE';
  }

  private isStageScreen(): boolean {
    return this.isBoardScreen() || this.screen === 'SKIRMISH_DEPLOY';
  }

  private async toggleFullscreen(): Promise<void> {
    if (this.fullscreen === null) return;
    this.sfx.play('uiSelect');
    await this.fullscreen.toggle();
    this.refreshFullscreenButtons();
  }

  private refreshFullscreenButtons(): void {
    const active = this.fullscreen?.isFullscreen() === true;
    const iconName: PixelIconName = active ? 'fullscreenExit' : 'fullscreenEnter';
    const label = active ? 'Tam Ekrandan Çık [F]' : 'Tam Ekran [F]';
    if (this.hudFsBtnEl !== null) {
      this.hudFsBtnEl.innerHTML = renderPixelIconSvg(iconName, 18);
      this.hudFsBtnEl.title = label;
      this.hudFsBtnEl.setAttribute('aria-label', label);
      this.hudFsBtnEl.classList.toggle('is-active', active);
    }
    if (this.topbarFsBtnEl !== null) {
      this.topbarFsBtnEl.innerHTML = renderPixelIconSvg(iconName, 16);
      this.topbarFsBtnEl.title = label;
      this.topbarFsBtnEl.setAttribute('aria-label', label);
      this.topbarFsBtnEl.classList.toggle('is-active', active);
    }
    this.mainMenuHandle?.setFullscreenLabel?.(active);
  }

  private syncGlobalAtmosphere(): void {
    const theme = this.getActiveRenderTheme();
    this.root.dataset['theme'] = theme;
    if (typeof document !== 'undefined' && document.documentElement !== null) {
      document.documentElement.dataset['theme'] = theme;
    }
    if (this.globalScanlinesEl !== null) {
      const mode = this.screen === 'MAIN_MENU' ? 'off' : this.uiPrefs.crtScanlines;
      this.globalScanlinesEl.className =
        mode === 'retro'
          ? 'sucs-global-scanlines is-retro'
          : mode === 'light'
            ? 'sucs-global-scanlines is-light'
            : 'sucs-global-scanlines';
    }
  }

  private closeFloatingDrawers(): void {
    let changed = false;
    if (this.roomPopoverOpen) {
      this.roomPopoverOpen = false;
      changed = true;
    }
    if (this.logDrawerOpen) {
      this.logDrawerOpen = false;
      changed = true;
    }
    if (changed) {
      this.syncFloatingDrawerDom();
    }
  }

  private toggleRoomPopover(): void {
    this.roomPopoverOpen = !this.roomPopoverOpen;
    if (this.roomPopoverOpen) this.logDrawerOpen = false;
    this.syncFloatingDrawerDom();
  }

  private toggleLogDrawer(): void {
    this.logDrawerOpen = !this.logDrawerOpen;
    if (this.logDrawerOpen) {
      this.roomPopoverOpen = false;
      this.unreadLogCount = 0;
    }
    this.syncFloatingDrawerDom();
    this.refreshEventLog();
  }

  private setDeployDrawerOpen(open: boolean): void {
    this.deployDrawerOpen = open;
    if (this.deployDrawerEl !== null) {
      this.deployDrawerEl.style.display = open ? 'flex' : 'none';
    }
    if (this.deployToggleBtnEl !== null) {
      this.deployToggleBtnEl.classList.toggle('is-open', open);
    }
  }

  private syncFloatingDrawerDom(): void {
    if (this.roomPopoverEl !== null) {
      this.roomPopoverEl.style.display = this.roomPopoverOpen ? 'flex' : 'none';
    }
    if (this.roomChipBtnEl !== null) {
      this.roomChipBtnEl.classList.toggle('is-open', this.roomPopoverOpen);
    }
    if (this.hudLogDrawerEl !== null) {
      this.hudLogDrawerEl.style.display = this.logDrawerOpen ? 'flex' : 'none';
    }
    if (this.hudLogBtnEl !== null) {
      this.hudLogBtnEl.classList.toggle('is-active', this.logDrawerOpen);
    }
  }

  private isEnemyAiControlled(): boolean {
    if (this.activeBattleKind === 'LOCAL_2P') return false;
    if (this.screen === 'BATTLE' || this.screen === 'BOSS_BATTLE') return true;
    return this.screen === 'SANDBOX' && this.enemyControl !== 'MANUAL';
  }

  private getEffectivePerspective(): FogPerspective {
    if (this.activeBattleKind === 'LOCAL_2P') {
      return this.hotseatViewerSide;
    }
    if (this.screen === 'BATTLE' || this.screen === 'BOSS_BATTLE') {
      return 'PLAYER';
    }
    if (this.perspectiveMode === 'AUTO') {
      return this.enemyControl === 'MANUAL' ? this.state.turn : 'PLAYER';
    }
    return this.perspectiveMode;
  }

  private getNarrativeTone(): NarrativeTone {
    return this.settings.narrativeTone ?? 'unfiltered';
  }

  private getActiveRenderTheme(): RenderTheme {
    if (this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id) return 'crt';
    if (this.uiPrefs.crtThemeUnlocked && this.uiPrefs.crtThemeEnabled) return 'crt';
    return 'default';
  }

  private toggleNarrativeTone(): void {
    const nextTone: NarrativeTone = this.getNarrativeTone() === 'unfiltered' ? 'polite' : 'unfiltered';
    this.settings.narrativeTone = nextTone;
    this.speechOverlay.setTone(nextTone);
    this.mainMenuHandle?.setTone(nextTone);
    this.sfx.play('uiSelect');
    this.persistState();
    this.refreshTopBar();
  }

  private getCurrentVisibleState(): VisibleState {
    const perspective = this.getEffectivePerspective();
    return getVisibleStateForPerspective(
      this.state,
      perspective,
      perspective !== 'OMNISCIENT' ? { stressScore: this.currentStressScore } : {},
    );
  }

  private buildShellDom(): void {
    this.root.innerHTML = '';

    const shell = document.createElement('div');
    shell.className = 'tfc-shell';
    this.shellEl = shell;

    const topbar = document.createElement('header');
    topbar.className = 'tfc-topbar';
    this.topbarEl = topbar;

    const brand = document.createElement('div');
    brand.className = 'tfc-brand';
    const logoIcon = document.createElement('img');
    logoIcon.src = '/favicon.svg';
    logoIcon.alt = 'S.U.C.S. Logo';
    logoIcon.className = 'tfc-brand-logo';
    const title = document.createElement('h1');
    title.textContent = 'S.U.C.S.';
    title.title = 'Stress Under Chess Simulator';
    this.modeBadgeEl = document.createElement('span');
    this.modeBadgeEl.className = 'tfc-badge';
    this.menuBackBtnEl = this.createButton('← Menü', () => this.setScreen('MAIN_MENU'));
    brand.append(logoIcon, title, this.modeBadgeEl, this.menuBackBtnEl);

    this.turnPillEl = document.createElement('div');
    this.turnPillEl.className = 'tfc-turn-pill';

    const topControls = document.createElement('div');
    topControls.className = 'tfc-topbar-controls';

    this.speedBtnEl = this.createButton('1x', () => this.toggleAnimationSpeed());
    this.speedBtnEl.title = 'Animasyon Hızı (1x / 2x)';
    this.intentBtnEl = this.createButton('Niyet [I]', () => this.toggleIntentArrows());
    this.threatBtnEl = this.createButton('Tehdit [T]', () => this.toggleThreatOverlay());
    this.toneBtnEl = this.createButton('Dil: Filtresiz', () => this.toggleNarrativeTone());
    const codexTopBtn = this.createButton('Rehber', () => this.openCodexModal());
    codexTopBtn.title = 'Saha Rehberi & Ansiklopedi [H]';
    const sysTopBtn = this.createButton('Sistem', () => this.openSettingsModal());
    sysTopBtn.title = 'Sistem & Ayarlar Paneli';
    this.pauseTopBtnEl = this.createButton('Duraklat', () => this.openPauseModal());
    this.pauseTopBtnEl.title = 'Duraklat [Esc]';
    this.muteBtnEl = this.createButton('Ses', () => this.toggleMute());
    this.muteBtnEl.title = 'Ses Efektleri Aç / Kapat [M]';

    const volWrap = document.createElement('label');
    volWrap.className = 'tfc-volume';
    volWrap.textContent = 'Düzey';
    this.volumeWrapEl = volWrap;
    this.volumeInputEl = document.createElement('input');
    this.volumeInputEl.type = 'range';
    this.volumeInputEl.min = '0';
    this.volumeInputEl.max = '100';
    this.volumeInputEl.value = String(Math.round(this.settings.soundVolume * 100));
    this.volumeInputEl.addEventListener('input', () => {
      const vol = Number(this.volumeInputEl.value) / 100;
      this.settings.soundVolume = vol;
      this.sfx.setVolume(vol);
      if (vol > 0 && !this.settings.soundEnabled) {
        this.settings.soundEnabled = true;
        this.sfx.setMuted(false);
        this.refreshTopBar();
      }
      this.persistState();
    });
    volWrap.appendChild(this.volumeInputEl);

    this.topbarFsBtnEl = document.createElement('button');
    this.topbarFsBtnEl.type = 'button';
    this.topbarFsBtnEl.className = 'px-icon-btn';
    this.topbarFsBtnEl.innerHTML = renderPixelIconSvg('fullscreenEnter', 16);
    this.topbarFsBtnEl.title = 'Tam Ekran [F]';
    this.topbarFsBtnEl.setAttribute('aria-label', 'Tam Ekran [F]');
    this.topbarFsBtnEl.addEventListener('click', () => {
      this.sfx.unlock();
      void this.toggleFullscreen();
    });

    topControls.append(
      this.speedBtnEl,
      this.muteBtnEl,
      codexTopBtn,
      sysTopBtn,
      this.pauseTopBtnEl!,
      this.topbarFsBtnEl,
      this.intentBtnEl,
      this.threatBtnEl,
      this.toneBtnEl,
      volWrap,
    );
    topbar.append(brand, this.turnPillEl, topControls);

    this.mainContainerEl = document.createElement('div');
    this.mainContainerEl.style.display = 'flex';
    this.mainContainerEl.style.flexDirection = 'column';
    this.mainContainerEl.style.flex = '1';

    this.globalScanlinesEl = document.createElement('div');
    this.globalScanlinesEl.className = 'sucs-global-scanlines';
    this.globalScanlinesEl.setAttribute('aria-hidden', 'true');

    shell.append(topbar, this.mainContainerEl, this.globalScanlinesEl);
    this.root.appendChild(shell);
  }

  private setScreen(nextScreen: AppScreen): void {
    const prevScreen = this.screen;
    if (prevScreen === 'RUN_VICTORY' || prevScreen === 'RUN_DEFEAT') {
      this.campaign = null;
      this.lastResumableScreen = 'MAIN_MENU';
    } else if (prevScreen === 'MATCH_SUMMARY') {
      this.skirmish = null;
      this.lastResumableScreen = 'MAIN_MENU';
    }
    if (nextScreen === 'MAIN_MENU') {
      this.closeHotseatHandoff();
      if (this.activeBattleKind === 'LOCAL_2P') {
        this.activeBattleKind = 'SANDBOX';
      }
    }
    this.teardownBoardScreen();
    this.screen = nextScreen;
    this.mainContainerEl.innerHTML = '';
    if (!this.calmScreen && prevScreen !== nextScreen) {
      this.mainContainerEl.classList.remove('sucs-crt-wipe');
      void this.mainContainerEl.offsetWidth;
      this.mainContainerEl.classList.add('sucs-crt-wipe');
    }

    switch (nextScreen) {
      case 'MAIN_MENU':
        this.renderMainMenuScreen();
        break;
      case 'SQUAD_SELECT':
        this.renderSquadSelectScreen();
        break;
      case 'BATTLE':
      case 'BOSS_BATTLE':
      case 'SANDBOX':
        this.renderBoardScreen();
        break;
      case 'CAMPAIGN_REWARD':
        this.renderCampaignRewardScreen();
        break;
      case 'RUN_VICTORY':
      case 'RUN_DEFEAT':
        this.renderCampaignSummaryScreen(nextScreen === 'RUN_VICTORY');
        break;
      case 'SKIRMISH_DEPLOY':
        this.renderSkirmishDeployScreen();
        break;
      case 'SKIRMISH_DRAFT':
        this.renderSkirmishDraftScreen();
        break;
      case 'MATCH_SUMMARY':
        this.renderSkirmishSummaryScreen();
        break;
      default:
        this.renderMainMenuScreen();
        break;
    }

    this.refreshTopBar();
  }

  private teardownBoardScreen(): void {
    this.cancelAiTimer();
    this.mainMenuHandle?.destroy();
    this.mainMenuHandle = null;
    this.pauseModal?.close();
    this.pauseModal = null;
    this.hudNotify?.destroy();
    this.hudNotify = null;
    this.root.style.setProperty('--px', '2px');
    this.roomPopoverOpen = false;
    this.logDrawerOpen = false;
    this.unreadLogCount = 0;
    this.lastStressTone = null;
    this.lastStressReasons = [];
    this.deployDraggingUnitId = null;
    this.lastVisibleMove = null;
    this.cachedThreatCoords = [];
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.fxQueue.skipAll();
    this.speechOverlay.clear();
    this.canvasEl = null;
    this.canvasWrapEl = null;
    this.abilityGroupEl = null;
    this.passBtnEl = null;
    this.nextPlayerBtnEl = null;
    this.undoBtnEl = null;
    this.statusBannerEl = null;
    this.postBattleCtaEl = null;
    this.inspectCardEl = null;
    this.inspectorBodyEl = null;
    this.eventLogListEl = null;
    this.hashCodeEl = null;
    this.campaignHudEl = null;
    this.roomChipBtnEl = null;
    this.roomPopoverEl = null;
    this.hudTurnChipEl = null;
    this.hudStressChipEl = null;
    this.hudSpeedBtnEl = null;
    this.hudMuteBtnEl = null;
    this.hudThreatBtnEl = null;
    this.hudIntentBtnEl = null;
    this.hudLogBtnEl = null;
    this.hudLogDrawerEl = null;
    this.hudFsBtnEl = null;
    this.deployDrawerEl = null;
    this.deployToggleBtnEl = null;
    this.aiDifficultySelectEl = null;
    this.presetSelectEl = null;
    this.presetDescEl = null;
    this.perspectiveBtns = {};
    this.playerFactionSelectEl = null;
    this.enemyFactionSelectEl = null;
    this.enemyControlSelectEl = null;
  }

  private renderMainMenuScreen(): void {
    this.mainMenuHandle = renderMainMenuView({
      rootEl: this.mainContainerEl,
      prefs: this.uiPrefs,
      tone: this.getNarrativeTone(),
      theme: this.getActiveRenderTheme(),
      aiDifficulty: this.aiDifficulty,
      dailySeed: getDailySeed(),
      resumable: getResumableRunSummary(this.buildPersistableState()),
      saveNotice: this.saveNotice,
      bindButton: (label, onClick, extraClass) => this.createButton(label, onClick, extraClass),
      playHoverSfx: () => this.sfx.play('menuHover'),
      playClickSfx: () => {
        this.sfx.unlock();
        this.sfx.play('menuClick');
      },
      playBootSfx: () => {
        this.sfx.unlock();
        this.sfx.play('crtBoot');
      },
      soundMuted: !this.settings.soundEnabled,
      onBootSeen: () => {
        if (!this.uiPrefs.bootSeen) {
          this.uiPrefs.bootSeen = true;
          saveUiPrefs(this.uiPrefs);
        }
      },
      onResumeSavedRun: (resumable) => this.resumeSavedRun(resumable),
      onDeleteSave: () => {
        this.campaign = null;
        this.skirmish = null;
        this.lastResumableScreen = 'MAIN_MENU';
        this.persistState();
        this.sfx.play('uiSelect');
        this.setScreen('MAIN_MENU');
      },
      onSelectCampaign: () => this.setScreen('SQUAD_SELECT'),
      onStartSkirmish: () => this.startNewSkirmish(),
      onCycleAiDifficulty: () => {
        const idx = ALL_AI_DIFFICULTIES.indexOf(this.aiDifficulty);
        this.aiDifficulty = ALL_AI_DIFFICULTIES[(idx + 1) % ALL_AI_DIFFICULTIES.length]!;
        saveAiDifficulty(this.aiDifficulty);
        return this.aiDifficulty;
      },
      onStartLocal2P: () => this.startNewLocal2P(),
      onEnterSandbox: () => this.enterSandbox(),
      onApplyDailySeedCampaign: () => {
        this.seedInput = getDailySeed();
        this.setScreen('SQUAD_SELECT');
      },
      onOpenCodex: () => this.openCodexModal(),
      onOpenSettings: () => this.openSettingsModal(),
      onToggleMute: () => {
        this.toggleMute();
        return !this.settings.soundEnabled;
      },
      isFullscreen: this.fullscreen?.isFullscreen() === true,
      onToggleFullscreen: () => {
        void this.toggleFullscreen();
      },
    });
  }

  private renderSquadSelectScreen(): void {
    renderSquadSelectView({
      rootEl: this.mainContainerEl,
      seedInput: this.seedInput,
      selectedAct: this.selectedCampaignAct,
      prefs: this.uiPrefs,
      theme: this.getActiveRenderTheme(),
      pieceNames: PIECE_NAMES,
      bindButton: (label, onClick, extraClass) => this.createButton(label, onClick, extraClass),
      playSelectSfx: () => this.sfx.play('uiSelect'),
      onChangeSeed: (nextSeed) => {
        this.seedInput = nextSeed;
      },
      onSelectAct: (act) => {
        this.selectedCampaignAct = act;
        this.setScreen('SQUAD_SELECT');
      },
      onStartSquad: (squadId) => this.startNewCampaign(squadId),
      onStartSecretRootSquad: () => {
        const cleanSeed = normalizeSeed(this.seedInput, getDailySeed());
        this.seedInput = cleanSeed;
        const base = createCampaignRun('cult-and-beast', cleanSeed, 3);
        const rootRoster: RosterUnit[] = [
          { id: 'p_king', type: 'KING', traits: [] },
          { id: 'p_root_ch', type: 'CHIMERA', traits: [] },
          { id: 'p_root_f', type: 'SAINT_FAITH', traits: [] },
          { id: 'p_root_m', type: 'SAINT_MADNESS', traits: [] },
        ];
        this.startSecretAct4Core({ ...base, roster: rootRoster });
        this.persistState();
      },
      onBack: () => this.setScreen('MAIN_MENU'),
    });
  }

  private startNewCampaign(squadId: string): void {
    const cleanSeed = normalizeSeed(this.seedInput, getDailySeed());
    this.seedInput = cleanSeed;
    this.saveNotice = '';
    this.activeCampaignRoomOverrideId = null;
    this.campaign = createCampaignRun(squadId, cleanSeed, this.selectedCampaignAct);
    this.skirmish = null;
    this.pendingRewards = [];
    this.selectedRewardCardId = null;
    this.lastBattleNewlyLost = [];
    this.enterCurrentCampaignRoom();
    this.persistState();
  }

  private startSecretAct4Core(baseRun: CampaignRunState): void {
    const built = buildCampaignEncounterById(SECRET_ACT4_ROOM.id, {
      seed: baseRun.seed,
      roster: baseRun.roster,
      playerFaction: baseRun.playerFaction,
      shieldAllNextBattle: false,
      activePacts: baseRun.activePacts,
    });
    this.activeCampaignRoomOverrideId = SECRET_ACT4_ROOM.id;
    this.campaign = {
      ...baseRun,
      act: 3,
      roomIndex: getCampaignRoomsForAct(3).length - 1,
      currentBattle: built.state,
    };
    this.pendingRewards = [];
    this.selectedRewardCardId = null;
    this.lastBattleNewlyLost = [];
    this.enterCurrentCampaignRoom();
  }

  private enterCurrentCampaignRoom(): void {
    if (this.campaign === null || this.campaign.currentBattle === null) {
      this.setScreen('MAIN_MENU');
      return;
    }
    const template =
      this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id
        ? SECRET_ACT4_ROOM
        : getCampaignRoomTemplate(this.campaign.roomIndex, this.campaign.act ?? 1);
    this.activeBattleKind = 'CAMPAIGN';
    this.state = this.campaign.currentBattle;
    this.aiMemory = createAiMemory();
    this.undoStack = [];
    this.selectedCoord = null;
    this.inspectedCoord = null;
    this.hoveredCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];
    this.eventLog = [];
    this.pushLog(`${template.name} başladı!`);
    const introQuote = getRoomIntroQuote(template.id, this.getNarrativeTone(), this.state.rngState);
    if (introQuote.length > 0) {
      this.pushLog(`[BÜYÜKUSTA-OS] ${introQuote}`);
      this.statusMessage = introQuote;
    } else {
      this.statusMessage = `${template.name}: Düşmanlar uyuyor; görüşe girdiklerinde önce ! ile uyanırlar.`;
    }
    this.setScreen(template.isBoss ? 'BOSS_BATTLE' : 'BATTLE');
    const act = this.campaign.act ?? 1;
    const rooms = getCampaignRoomsForAct(act);
    const isSecret = this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id;
    this.hudNotify?.showBanner({
      eyebrow: isSecret ? 'GİZLİ ÇEKİRDEK' : `ODA ${this.campaign.roomIndex + 1} / ${rooms.length}`,
      title: template.name,
      subtitle: `${FACTION_DEFINITIONS[template.enemyFaction].name} · ${template.subtitle}`,
      tone: template.isBoss ? 'enemy' : 'player',
      durationMs: 2600,
    });
    if (this.campaign.activePacts.length > 0) {
      const pactSummary = this.campaign.activePacts
        .map((p) => `Düşman piyonları: ${TRAIT_INFO[p.trait].name} (${p.roomsRemaining} oda)`)
        .join(' · ');
      this.hudNotify?.pushToast({
        title: 'AKTİF PAZARLIK',
        text: pactSummary,
        tone: 'warn',
        icon: 'alert',
        durationMs: 4800,
      });
    }
    if (introQuote.length > 0) {
      this.speechOverlay.setTone(this.getNarrativeTone());
      this.speechOverlay.showCrtBand({
        speaker: 'BÜYÜKUSTA-OS',
        text: introQuote,
        mode: template.isBoss ? 'crimson' : 'green',
        quoteSource: { kind: 'ROOM_INTRO', roomId: template.id, seed: this.state.rngState },
      });
    }
  }

  private enterSandbox(): void {
    this.activeBattleKind = 'SANDBOX';
    this.state = getSandboxPreset(this.presetId).build();
    this.aiMemory = createAiMemory();
    this.undoStack = [];
    this.selectedCoord = null;
    this.inspectedCoord = null;
    this.hoveredCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];
    this.eventLog = [];
    this.pushLog('Sandbox hazır. Her iki tarafı da manuel veya AI ile oynayabilirsin.');
    this.statusMessage = 'Bir taş seçerek hamle veya yetenek önizlemesi yapabilirsin.';
    this.setScreen('SANDBOX');
    this.hudNotify?.showBanner({
      eyebrow: 'KAOS LABORATUVARI',
      title: getSandboxPreset(this.presetId).name,
      subtitle: 'Sol üstteki LAB düğmesinden senaryo, sis ve AI ayarlarını aç',
      tone: 'crt',
      durationMs: 2400,
    });
  }

  private createPixelIconButton(
    icon: PixelIconName,
    title: string,
    onClick: () => void,
    extraClass = '',
    sizePx = 16,
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = extraClass ? `px-icon-btn ${extraClass}` : 'px-icon-btn';
    btn.innerHTML = renderPixelIconSvg(icon, sizePx);
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('pointerenter', () => {
      if (!btn.disabled) this.sfx.play('menuHover');
    });
    btn.addEventListener('click', () => {
      this.sfx.unlock();
      this.sfx.play('menuClick');
      onClick();
    });
    return btn;
  }

  private renderBoardScreen(): void {
    const stage = document.createElement('main');
    stage.className = 'sucs-stage';

    // 1. Tam ekran 100vw × 100dvh piksel canvas katmanı
    this.canvasWrapEl = document.createElement('div');
    this.canvasWrapEl.className = 'sucs-stage-canvas-wrap';
    this.canvasEl = document.createElement('canvas');
    this.canvasEl.setAttribute('aria-label', 'S.U.C.S. Tam Ekran Taktik Tahtası');
    this.canvasWrapEl.appendChild(this.canvasEl);

    // 2. Yüzen Gerçek Oyun HUD Katmanı (tıklama geçirgen)
    const hud = document.createElement('div');
    hud.className = 'sucs-hud-layer';
    this.hudNotify = new HudNotificationCenter({ maxToasts: 4 });

    // --- SOL-ÜST: Oda / Mod / Lab Çipi + Açılır Görev Dosyası / Sandbox Çekmecesi ---
    const hudTl = document.createElement('div');
    hudTl.className = 'sucs-hud-tl';

    this.roomChipBtnEl = document.createElement('button');
    this.roomChipBtnEl.type = 'button';
    this.roomChipBtnEl.className = 'px-chip';
    this.roomChipBtnEl.title =
      this.screen === 'SANDBOX'
        ? 'Kaos Laboratuvarı Kontrollerini Aç / Kapat'
        : 'Oda, Fraksiyon ve Pazarlık Detaylarını Göster';
    this.roomChipBtnEl.addEventListener('pointerenter', () => this.sfx.play('menuHover'));
    this.roomChipBtnEl.addEventListener('click', () => {
      this.sfx.unlock();
      this.sfx.play('menuClick');
      this.toggleRoomPopover();
    });

    this.roomPopoverEl = document.createElement('div');
    this.roomPopoverEl.className = 'sucs-hud-popover px-frame';
    this.roomPopoverEl.style.display = 'none';
    if (this.screen === 'SANDBOX') {
      this.roomPopoverEl.appendChild(this.buildSandboxControlsCard());
    } else {
      const hudCard = document.createElement('div');
      hudCard.className = 'tfc-inspector-grid';
      this.campaignHudEl = hudCard;
      this.roomPopoverEl.appendChild(hudCard);
    }
    const popoverMenuBtn = this.createButton('← Ana Menü', () => this.setScreen('MAIN_MENU'));
    this.roomPopoverEl.appendChild(popoverMenuBtn);
    hudTl.append(this.roomChipBtnEl, this.roomPopoverEl);

    // --- ÜST-ORTA: Minimal Tur Şeridi + Geçici Faz / Oda Bildirim Bandı ---
    const hudTc = document.createElement('div');
    hudTc.className = 'sucs-hud-tc';
    this.hudTurnChipEl = document.createElement('div');
    this.hudTurnChipEl.className = 'px-chip sucs-turn-chip';
    hudTc.append(this.hudTurnChipEl, this.hudNotify.bannerHostEl);

    // --- SAĞ-ÜST: Segmentli Piksel Stres Göstergesi + Hızlı Piksel İkonlar ---
    const hudTr = document.createElement('div');
    hudTr.className = 'sucs-hud-tr';

    this.hudStressChipEl = document.createElement('button');
    this.hudStressChipEl.type = 'button';
    this.hudStressChipEl.className = 'px-chip sucs-stress-chip';
    this.hudStressChipEl.title = 'Stres nedenlerini bildirim olarak göster';
    this.hudStressChipEl.addEventListener('click', () => {
      this.sfx.unlock();
      this.sfx.play('uiSelect');
      const note =
        this.lastStressReasons.length > 0
          ? this.lastStressReasons.join(' · ')
          : 'Nabız normal — sisin ardında şimdilik sessizlik hakim.';
      this.hudNotify?.pushToast({
        title: `STRES ANALİZİ · %${this.currentStressScore}`,
        text: note,
        tone: this.currentStressScore >= 75 ? 'enemy' : this.currentStressScore >= 50 ? 'warn' : 'player',
        icon: 'alert',
        durationMs: 4200,
      });
    });

    const topIconBar = document.createElement('div');
    topIconBar.className = 'sucs-icon-bar';
    this.hudSpeedBtnEl = this.createPixelIconButton('speed1x', 'Animasyon Hızı (1x / 2x)', () =>
      this.toggleAnimationSpeed(),
    );
    this.hudMuteBtnEl = this.createPixelIconButton('soundOn', 'Ses Aç / Kapat [M]', () =>
      this.toggleMute(),
    );
    const codexIconBtn = this.createPixelIconButton('codex', 'Saha Rehberi [H]', () =>
      this.openCodexModal(),
    );
    const pauseIconBtn = this.createPixelIconButton('pause', 'Duraklat / Sistem [Esc]', () =>
      this.openPauseModal(),
    );
    topIconBar.append(this.hudSpeedBtnEl, this.hudMuteBtnEl, codexIconBtn, pauseIconBtn);
    hudTr.append(this.hudStressChipEl, topIconBar);

    // --- SOL-ALT: Bağlamsal Yüzen Piksel İnceleme Kartı (Hover / Dokunma ile açılır) ---
    const hudBl = document.createElement('div');
    hudBl.className = 'sucs-hud-bl';
    this.inspectCardEl = document.createElement('div');
    this.inspectCardEl.className = 'sucs-inspect-card px-frame';
    this.inspectCardEl.style.display = 'none';
    this.inspectorBodyEl = document.createElement('div');
    this.inspectorBodyEl.className = 'tfc-inspector-grid';
    this.inspectCardEl.appendChild(this.inspectorBodyEl);
    hudBl.appendChild(this.inspectCardEl);

    // --- ALT-ORTA: Yüzen Eylem Kümesi (Pas Geç, İt, Duvar Kır, 2P Sıradaki, Maç Sonu CTA) ---
    const hudBc = document.createElement('div');
    hudBc.className = 'sucs-hud-bc';

    this.postBattleCtaEl = document.createElement('div');
    this.postBattleCtaEl.style.display = 'none';

    const actionCluster = document.createElement('div');
    actionCluster.className = 'sucs-action-cluster';

    this.abilityGroupEl = document.createElement('div');
    this.abilityGroupEl.className = 'tfc-btn-group';

    const turnActions = document.createElement('div');
    turnActions.className = 'tfc-btn-group sucs-turn-actions';

    if (this.activeBattleKind === 'LOCAL_2P') {
      this.nextPlayerBtnEl = this.createButton(
        'Sıradaki ↻',
        () => this.advanceHotseatTurn(),
        'sucs-next-player-btn',
      );
      this.nextPlayerBtnEl.title = 'Sıradaki oyuncuya geç ve tahtayı 180° çevir [Enter / Space]';
      turnActions.appendChild(this.nextPlayerBtnEl);
    }

    this.passBtnEl = this.createButton(
      'Turu Pas Geç',
      () => this.dispatchAction({ type: 'END_TURN' }),
      'is-primary',
    );
    this.passBtnEl.title = 'Turu Pas Geç [Space]';
    turnActions.appendChild(this.passBtnEl);

    if (this.screen === 'SANDBOX') {
      this.undoBtnEl = this.createButton('Geri Al [Z]', () => this.undoLastAction());
      const resetBtn = this.createButton('Sıfırla', () => this.resetPreset(), 'is-danger');
      turnActions.append(this.undoBtnEl, resetBtn);
    }

    actionCluster.append(this.abilityGroupEl, turnActions);
    hudBc.append(this.postBattleCtaEl, actionCluster);

    // --- SAĞ-ALT: Olay Günlüğü Çekmecesi + Taktik Anahtarlar + YouTube Tarzı Tam Ekran [F] ---
    const hudBr = document.createElement('div');
    hudBr.className = 'sucs-hud-br';

    this.hudLogDrawerEl = document.createElement('div');
    this.hudLogDrawerEl.className = 'sucs-log-drawer px-frame';
    this.hudLogDrawerEl.style.display = 'none';

    const logHead = document.createElement('div');
    logHead.className = 'tfc-card-title';
    const logHeadingText = document.createElement('span');
    logHeadingText.textContent = 'OLAY GÜNLÜĞÜ [L]';
    this.hashCodeEl = document.createElement('span');
    this.hashCodeEl.className = 'tfc-hash-code';
    logHead.append(logHeadingText, this.hashCodeEl);

    this.eventLogListEl = document.createElement('ul');
    this.eventLogListEl.className = 'tfc-log-list';

    const kbdRow = document.createElement('div');
    kbdRow.className = 'tfc-kbd-row';
    kbdRow.innerHTML =
      '<span><kbd>F</kbd> Tam Ekran</span>' +
      '<span><kbd>Tab</kbd> Taş</span>' +
      '<span><kbd>Space</kbd> Pas</span>' +
      '<span><kbd>L</kbd> Günlük</span>' +
      '<span><kbd>T</kbd> Tehdit</span>' +
      '<span><kbd>I</kbd> Niyet</span>' +
      '<span><kbd>M</kbd> Ses</span>' +
      '<span><kbd>Esc</kbd> Duraklat</span>';

    this.hudLogDrawerEl.append(logHead, this.eventLogListEl, kbdRow);

    const bottomIconBar = document.createElement('div');
    bottomIconBar.className = 'sucs-icon-bar';
    this.hudThreatBtnEl = this.createPixelIconButton('threat', 'Düşman Tehdit Alanı [T]', () =>
      this.toggleThreatOverlay(),
    );
    this.hudIntentBtnEl = this.createPixelIconButton('intent', 'Düşman Niyet Okları [I]', () =>
      this.toggleIntentArrows(),
    );
    this.hudLogBtnEl = this.createPixelIconButton('log', 'Olay Günlüğü & Kısayollar [L]', () =>
      this.toggleLogDrawer(),
    );
    this.hudFsBtnEl = this.createPixelIconButton(
      this.fullscreen?.isFullscreen() ? 'fullscreenExit' : 'fullscreenEnter',
      'Tam Ekran [F]',
      () => {
        void this.toggleFullscreen();
      },
      'sucs-fullscreen-btn',
      18,
    );
    bottomIconBar.append(this.hudThreatBtnEl, this.hudIntentBtnEl, this.hudLogBtnEl, this.hudFsBtnEl);
    hudBr.append(this.hudLogDrawerEl, bottomIconBar);

    hud.append(hudTl, hudTc, hudTr, this.hudNotify.toastFeedEl, hudBl, hudBc, hudBr);
    stage.append(this.canvasWrapEl, hud);
    this.mainContainerEl.appendChild(stage);

    // Mount HiDPI CanvasRenderer
    this.renderer = new CanvasRenderer(this.canvasEl, undefined, {
      theme: this.getActiveRenderTheme(),
    });
    this.canvasEl.addEventListener('pointerdown', (e: PointerEvent) => {
      this.closeFloatingDrawers();
      if (this.renderer === null || this.canvasEl === null) return;
      const rect = this.canvasEl.getBoundingClientRect();
      const hit = localPointToTile(
        this.renderer.getLayout(),
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.state.width,
        this.state.height,
        this.shouldFlipBoard(),
      );
      if (hit === null && (this.inspectedCoord !== null || this.selectedCoord !== null)) {
        this.inspectedCoord = null;
        this.clearSelection(false);
        this.refreshInspector();
      }
    });
    this.renderer.bindPointerEvents({
      onTileTap: (coord) => {
        this.closeFloatingDrawers();
        this.onTileTap(coord);
      },
      onTileHover: (coord) => this.onTileHover(coord),
      onPointerActivity: () => this.sfx.unlock(),
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
      this.resizeObserver.observe(this.canvasWrapEl);
    }

    this.syncCanvasSize();
    this.refreshFullscreenButtons();
    this.refreshUi();
    this.startLoop();
    this.scheduleAiTurnIfNeeded();
  }

  private buildSandboxControlsCard(): HTMLDivElement {
    const sandboxCard = document.createElement('div');
    sandboxCard.className = 'tfc-card';
    const sandboxTitle = document.createElement('h2');
    sandboxTitle.className = 'tfc-card-title';
    sandboxTitle.textContent = 'Sandbox & Sis Kontrolü';

    const presetRow = document.createElement('div');
    presetRow.className = 'tfc-field-row';
    const presetLabel = document.createElement('label');
    presetLabel.textContent = 'Senaryo';
    this.presetSelectEl = document.createElement('select');
    this.presetSelectEl.className = 'tfc-select';
    for (let i = 0; i < SANDBOX_PRESETS.length; i++) {
      const preset = SANDBOX_PRESETS[i]!;
      const opt = document.createElement('option');
      opt.value = preset.id;
      opt.textContent = preset.name;
      this.presetSelectEl.appendChild(opt);
    }
    this.presetSelectEl.value = this.presetId;
    this.presetSelectEl.addEventListener('change', () => {
      this.presetId = this.presetSelectEl!.value;
      this.resetPreset();
    });
    presetRow.append(presetLabel, this.presetSelectEl);

    this.presetDescEl = document.createElement('div');
    this.presetDescEl.className = 'tfc-status-banner';

    const perspGroup = document.createElement('div');
    perspGroup.className = 'tfc-btn-group';
    const perspDefs: readonly { mode: PerspectiveMode; label: string }[] = [
      { mode: 'AUTO', label: 'Otomatik' },
      { mode: 'PLAYER', label: 'Oyuncu Sisi' },
      { mode: 'ENEMY', label: 'Düşman Sisi' },
      { mode: 'OMNISCIENT', label: 'Tam Görüş' },
    ];
    for (let i = 0; i < perspDefs.length; i++) {
      const def = perspDefs[i]!;
      const btn = this.createButton(def.label, () => this.setPerspectiveMode(def.mode));
      this.perspectiveBtns[def.mode] = btn;
      perspGroup.appendChild(btn);
    }

    const aiRow = document.createElement('div');
    aiRow.className = 'tfc-field-row';
    const aiLabel = document.createElement('label');
    aiLabel.textContent = 'Düşman Kontrolü';
    this.enemyControlSelectEl = document.createElement('select');
    this.enemyControlSelectEl.className = 'tfc-select';
    const aiOptions: readonly { value: EnemyControlMode; label: string }[] = [
      { value: 'MANUAL', label: 'Manuel (İki Taraf)' },
      { value: 'CAMPAIGN_AI', label: 'Sefer AI (Niyet + Hafıza)' },
      { value: 'SKIRMISH_AI', label: 'S.U.C.S. Bot (Belief + Kombo AI)' },
    ];
    for (let i = 0; i < aiOptions.length; i++) {
      const item = aiOptions[i]!;
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      this.enemyControlSelectEl.appendChild(opt);
    }
    this.enemyControlSelectEl.value = this.enemyControl;
    this.enemyControlSelectEl.addEventListener('change', () => {
      this.enemyControl = this.enemyControlSelectEl!.value as EnemyControlMode;
      this.cancelAiTimer();
      this.clearSelection(false);
      this.refreshUi();
      this.scheduleAiTurnIfNeeded();
    });
    aiRow.append(aiLabel, this.enemyControlSelectEl);

    const diffRow = document.createElement('div');
    diffRow.className = 'tfc-field-row';
    const diffLabel = document.createElement('label');
    diffLabel.textContent = 'AI Zorluk';
    this.aiDifficultySelectEl = document.createElement('select');
    this.aiDifficultySelectEl.className = 'tfc-select';
    for (let i = 0; i < ALL_AI_DIFFICULTIES.length; i++) {
      const id = ALL_AI_DIFFICULTIES[i]!;
      const p = AI_DIFFICULTY_PROFILES[id];
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = `${p.name} (${p.badge} · ${p.timeBudgetMs}ms)`;
      this.aiDifficultySelectEl.appendChild(opt);
    }
    this.aiDifficultySelectEl.value = this.aiDifficulty;
    this.aiDifficultySelectEl.addEventListener('change', () => {
      this.aiDifficulty = this.aiDifficultySelectEl!.value as AiDifficulty;
      saveAiDifficulty(this.aiDifficulty);
      this.sfx.play('uiSelect');
      this.refreshUi();
    });
    diffRow.append(diffLabel, this.aiDifficultySelectEl);

    const pFacRow = this.createFactionRow('Oyuncu Pasifi', (fac) =>
      this.setFactionPassive('PLAYER', fac),
    );
    this.playerFactionSelectEl = pFacRow.select;

    const eFacRow = this.createFactionRow('Düşman Pasifi', (fac) =>
      this.setFactionPassive('ENEMY', fac),
    );
    this.enemyFactionSelectEl = eFacRow.select;

    sandboxCard.append(
      sandboxTitle,
      presetRow,
      this.presetDescEl,
      perspGroup,
      aiRow,
      diffRow,
      pFacRow.row,
      eFacRow.row,
    );
    return sandboxCard;
  }

  private renderCampaignRewardScreen(): void {
    if (this.campaign === null) {
      this.setScreen('MAIN_MENU');
      return;
    }

    const run = this.campaign;
    const act = run.act ?? 1;
    const clearedRoom = getCampaignRoomTemplate(run.roomIndex, act);
    const nextRoom = getCampaignRoomTemplate(run.roomIndex + 1, act);

    const wrap = document.createElement('section');
    wrap.className = 'tfc-screen-center';

    const hero = document.createElement('div');
    hero.className = 'tfc-hero';
    hero.innerHTML =
      `<h2>${clearedRoom.name} Temizlendi!</h2>` +
      `<p>Sıradaki oda: <strong>${nextRoom.name}</strong> (${FACTION_DEFINITIONS[nextRoom.enemyFaction].name}) · Aşağıdaki 3 karttan 1 ödül seç.</p>`;

    if (this.lastBattleNewlyLost.length > 0) {
      const lostWarn = document.createElement('div');
      lostWarn.className = 'tfc-status-banner is-error';
      lostWarn.textContent = `Bu savaşta kaybedilen birimler: ${this.lastBattleNewlyLost.map(formatRosterUnitLabel).join(', ')}`;
      wrap.append(hero, lostWarn);
    } else {
      wrap.appendChild(hero);
    }

    const grid = document.createElement('div');
    grid.className = 'tfc-card-grid';

    for (let i = 0; i < this.pendingRewards.length; i++) {
      const card = this.pendingRewards[i]!;
      const cardEl = document.createElement('div');
      const isSelected = this.selectedRewardCardId === card.id;
      cardEl.className =
        'tfc-choice-card' +
        (card.rarity === 'PACT' ? ' is-pact' : card.rarity === 'RARE' ? ' is-rare' : '') +
        (isSelected ? ' is-selected' : '');

      const body = document.createElement('div');
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '6px';

      const sub = document.createElement('div');
      sub.className = 'tfc-choice-subtitle';
      sub.textContent = card.subtitle;
      if (card.rarity === 'PACT') sub.style.color = '#f87171';

      const h3 = document.createElement('h3');
      h3.textContent = card.title;

      const desc = document.createElement('p');
      desc.textContent = card.description;

      body.append(sub, h3, desc);

      const needsTarget =
        (card.addTraits !== undefined && card.addTraits.length > 0) ||
        (card.allowReviveOrShieldAll === true && run.lostUnits.length > 0);

      const actionBtn = this.createButton(
        needsTarget ? (isSelected ? 'Hedef Seçiliyor ↓' : 'Seç ve Hedef Belirle') : 'Ödülü Al →',
        () => {
          if (needsTarget) {
            this.selectedRewardCardId = card.id;
            this.sfx.play('uiSelect');
            this.renderCampaignRewardScreenInPlace();
          } else {
            this.confirmCampaignReward(card, { repairChoice: 'SHIELD_ALL' });
          }
        },
        card.rarity === 'PACT' ? 'is-gold' : 'is-primary',
      );

      cardEl.append(body, actionBtn);
      grid.appendChild(cardEl);
    }

    wrap.appendChild(grid);

    // Contextual target picker panel if selected card requires choosing a unit / revive option
    const activeCard = this.pendingRewards.find((c) => c.id === this.selectedRewardCardId);
    if (activeCard !== undefined) {
      const targetPanel = document.createElement('div');
      targetPanel.className = 'tfc-target-panel';

      if (activeCard.addTraits !== undefined && activeCard.addTraits.length > 0) {
        const heading = document.createElement('div');
        heading.className = 'tfc-inspect-heading';
        heading.textContent = `Mutasyon (${activeCard.addTraits.join(' + ')}) uygulanacak taşı seç:`;
        targetPanel.appendChild(heading);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'tfc-btn-group';
        let eligibleCount = 0;

        for (let i = 0; i < run.roster.length; i++) {
          const unit = run.roster[i]!;
          const canReceive =
            unit.traits.length < MAX_TRAITS_PER_PIECE &&
            activeCard.addTraits.some((t) => !unit.traits.includes(t));
          if (canReceive) eligibleCount++;
          const uBtn = this.createButton(formatRosterUnitLabel(unit), () => {
            this.confirmCampaignReward(activeCard, { targetUnitId: unit.id });
          });
          uBtn.disabled = !canReceive;
          btnGroup.appendChild(uBtn);
        }

        targetPanel.appendChild(btnGroup);
        if (eligibleCount === 0) {
          const note = document.createElement('div');
          note.className = 'tfc-status-banner is-warn';
          note.textContent = 'Tüm taşların mutasyon yuvaları dolu veya bu mutasyona zaten sahip; başka bir kart seçebilirsin.';
          targetPanel.appendChild(note);
        }
      } else if (activeCard.allowReviveOrShieldAll) {
        const heading = document.createElement('div');
        heading.className = 'tfc-inspect-heading';
        heading.textContent = 'Kaybedilen 1 taşı dirilt VEYA tüm orduna kalkan ver:';
        targetPanel.appendChild(heading);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'tfc-btn-group';
        for (let i = 0; i < run.lostUnits.length; i++) {
          const lost = run.lostUnits[i]!;
          const revBtn = this.createButton(
            `Dirilt: ${formatRosterUnitLabel(lost)}`,
            () =>
              this.confirmCampaignReward(activeCard, {
                repairChoice: 'REVIVE',
                targetUnitId: lost.id,
              }),
            'is-primary',
          );
          btnGroup.appendChild(revBtn);
        }

        const shieldBtn = this.createButton(
          'Tüm Orduya Sonraki Savaş İçin SHIELDED Ver',
          () => this.confirmCampaignReward(activeCard, { repairChoice: 'SHIELD_ALL' }),
          'is-gold',
        );
        btnGroup.appendChild(shieldBtn);
        targetPanel.appendChild(btnGroup);
      }

      wrap.appendChild(targetPanel);
    }

    // Current army status strip
    const armyBox = document.createElement('div');
    armyBox.className = 'tfc-summary-box';
    const armyHeading = document.createElement('div');
    armyHeading.className = 'tfc-card-title';
    armyHeading.textContent = `Mevcut Ordu (${run.roster.length} hayatta · ${run.lostUnits.length} kayıp)`;
    const pills = document.createElement('div');
    pills.className = 'tfc-unit-pills';
    for (let i = 0; i < run.roster.length; i++) {
      const p = document.createElement('span');
      p.className = 'tfc-unit-pill';
      p.textContent = formatRosterUnitLabel(run.roster[i]!);
      pills.appendChild(p);
    }
    armyBox.append(armyHeading, pills);
    wrap.appendChild(armyBox);

    this.mainContainerEl.appendChild(wrap);
  }

  private renderCampaignRewardScreenInPlace(): void {
    this.mainContainerEl.innerHTML = '';
    this.renderCampaignRewardScreen();
  }

  private confirmCampaignReward(
    card: CampaignRewardCard,
    options: { targetUnitId?: string; repairChoice?: 'REVIVE' | 'SHIELD_ALL' },
  ): void {
    if (this.campaign === null) return;
    const baseRun: CampaignRunState =
      this.pendingRewardsNextRng !== 0
        ? { ...this.campaign, rngState: this.pendingRewardsNextRng }
        : this.campaign;
    const applied = applyCampaignReward(baseRun, card, options);
    if (applied.error !== undefined) {
      this.sfx.play('uiInvalid');
      return;
    }
    this.sfx.play('promote');
    this.campaign = applied.nextRun;
    this.pendingRewards = [];
    this.pendingRewardsNextRng = 0;
    this.selectedRewardCardId = null;
    this.enterCurrentCampaignRoom();
    this.persistState();
  }

  private renderCampaignSummaryScreen(isVictory: boolean): void {
    const run = this.campaign;
    const act = run?.act ?? 1;
    const rooms = getCampaignRoomsForAct(act);
    const isSecretCore = this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id;
    const tone = this.getNarrativeTone();
    const wrap = document.createElement('section');
    wrap.className = 'tfc-screen-center';

    const hero = document.createElement('div');
    hero.className = 'tfc-hero';
    if (isVictory) {
      const vicHeading = isSecretCore
        ? '0x00_ÇEKİRDEK ÇÖKTÜ · GERÇEK ZAFER!'
        : `STRES SEFERİ ZAFERİ · ${act}. PERDE TAMAMLANDI!`;
      const vicQuote = getVictoryQuote(isSecretCore, tone, this.state.rngState);
      hero.innerHTML = `<h2 style="color:#34d399;">${vicHeading}</h2><p>${vicQuote}</p>`;
    } else {
      const defeatBanner = getDefeatBanner('KING_CAPTURED', tone, this.state.rngState, this.state.turnNumber);
      hero.innerHTML =
        `<h2 style="color:#f87171;">${defeatBanner}</h2>` +
        '<p>Permadeath kuralı gereği sefer burada bitti.</p>';
    }

    const summary = document.createElement('div');
    summary.className = 'tfc-summary-box';

    if (run !== null) {
      const roomsStr = isSecretCore ? '0x00_ÇEKİRDEK' : `P${act} · ${run.roomIndex + 1}/${rooms.length}`;
      const metricsGrid = buildEndMatchMetricsGrid({
        roomsCleared: roomsStr,
        capturesCount: this.uiPrefs.stats.totalCaptures,
        peakStress: this.uiPrefs.stats.peakStress,
        seed: run.seed,
      });
      summary.appendChild(metricsGrid);

      const survTitle = document.createElement('div');
      survTitle.className = 'tfc-card-title';
      survTitle.textContent = `Hayatta Kalan Birimler (${run.roster.length})`;
      const survPills = document.createElement('div');
      survPills.className = 'tfc-unit-pills';
      for (let i = 0; i < run.roster.length; i++) {
        const pill = document.createElement('span');
        pill.className = 'tfc-unit-pill';
        pill.textContent = formatRosterUnitLabel(run.roster[i]!);
        survPills.appendChild(pill);
      }
      summary.append(survTitle, survPills);

      if (run.lostUnits.length > 0) {
        const lostTitle = document.createElement('div');
        lostTitle.className = 'tfc-card-title';
        lostTitle.textContent = `Düşen Birimler — Permadeath (${run.lostUnits.length})`;
        const lostPills = document.createElement('div');
        lostPills.className = 'tfc-unit-pills';
        for (let i = 0; i < run.lostUnits.length; i++) {
          const pill = document.createElement('span');
          pill.className = 'tfc-unit-pill is-lost';
          pill.textContent = formatRosterUnitLabel(run.lostUnits[i]!);
          lostPills.appendChild(pill);
        }
        summary.append(lostTitle, lostPills);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'tfc-btn-group';
    if (isVictory && run !== null && !isSecretCore) {
      if (act === 1) {
        actions.appendChild(
          this.createButton(
            'Perde 2: Zindan Kimyası →',
            () => {
              this.activeCampaignRoomOverrideId = null;
              this.campaign = continueCampaignToNextAct(run, 2);
              this.enterCurrentCampaignRoom();
              this.persistState();
            },
            'is-gold',
          ),
        );
      } else if (act === 2) {
        actions.appendChild(
          this.createButton(
            'Perde 3: Gulyabani & Azizeler →',
            () => {
              this.activeCampaignRoomOverrideId = null;
              this.campaign = continueCampaignToNextAct(run, 3);
              this.enterCurrentCampaignRoom();
              this.persistState();
            },
            'is-gold',
          ),
        );
      } else if (act === 3) {
        actions.appendChild(
          this.createButton(
            'Gizli Çekirdek: 0x00_ÇEKİRDEK →',
            () => this.startSecretAct4Core(run),
            'is-gold',
          ),
        );
      }
    }
    if (run !== null) {
      const sameSeedBtn = this.createButton(
        'AYNI TOHUMLA TEKRAR DENE',
        () => {
          this.seedInput = run.seed;
          this.selectedCampaignAct = (run.act ?? 1) as 1 | 2 | 3;
          this.startNewCampaign(run.squadId);
        },
        'is-gold',
      );
      actions.appendChild(sameSeedBtn);
    }
    const retryBtn = this.createButton(
      'YENİ SEFER',
      () => this.setScreen('SQUAD_SELECT'),
      'is-primary',
    );
    const menuBtn = this.createButton('Ana Menüye Dön', () => this.setScreen('MAIN_MENU'));
    actions.append(retryBtn, menuBtn);

    wrap.append(hero, summary, actions);
    this.mainContainerEl.appendChild(wrap);
  }

  private syncModalBodyLock(): void {
    if (typeof document === 'undefined' || document.body === null) return;
    const anyOpen =
      this.codexModal?.isOpen() === true ||
      this.settingsModal?.isOpen() === true ||
      this.pauseModal?.isOpen() === true ||
      this.hotseatHandoffEl !== null;
    document.body.classList.toggle('is-modal-open', anyOpen);
  }

  private showDockSubtitle(
    speaker: string,
    text: string,
    kind: 'lastWords' | 'bark' | 'crt',
  ): void {
    const cleanText = text.replace(/\{\/?(shake|wave|pop)\}/g, '');
    const tone: HudToastTone = kind === 'lastWords' ? 'enemy' : kind === 'crt' ? 'crt' : 'warn';
    const icon: PixelIconName = kind === 'lastWords' ? 'skull' : kind === 'crt' ? 'log' : 'alert';
    this.hudNotify?.pushToast({
      title: kind === 'lastWords' ? `† ${speaker}` : speaker,
      text: `"${cleanText}"`,
      tone,
      icon,
      durationMs: kind === 'lastWords' ? 5400 : 4600,
    });
  }

  private openCodexModal(): void {
    this.codexModal?.close();
    this.codexModal = new CodexModal({
      prefs: this.uiPrefs,
      theme: this.getActiveRenderTheme(),
      pieceNames: PIECE_NAMES,
      traitInfo: TRAIT_INFO,
      playClickSfx: () => {
        this.sfx.unlock();
        this.sfx.play('menuClick');
      },
      onClose: () => {
        this.codexModal = null;
        this.syncModalBodyLock();
      },
    });
    this.codexModal.open(this.root);
    this.syncModalBodyLock();
  }

  private openSettingsModal(): void {
    this.settingsModal?.close();
    this.settingsModal = new SettingsModal({
      settings: this.settings,
      prefs: this.uiPrefs,
      exportJson: () =>
        JSON.stringify(
          {
            sucs_save_v1: this.buildPersistableState(),
            sucs_ui_prefs_v1: this.uiPrefs,
          },
          null,
          2,
        ),
      importJson: (raw) => {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed !== 'object' || parsed === null) {
            return { ok: false, error: 'Geçersiz JSON yapısı.' };
          }
          if (typeof parsed['sucs_ui_prefs_v1'] === 'object' && parsed['sucs_ui_prefs_v1'] !== null) {
            const p = parsed['sucs_ui_prefs_v1'] as UiPrefsState;
            this.uiPrefs = { ...createDefaultUiPrefs(), ...p };
            saveUiPrefs(this.uiPrefs);
          }
          if (typeof parsed['sucs_save_v1'] === 'object' && parsed['sucs_save_v1'] !== null) {
            saveAppState(parsed['sucs_save_v1'] as AppRunState);
            this.hydrateFromStorage();
          }
          this.refreshTopBar();
          if (this.screen === 'MAIN_MENU') this.setScreen('MAIN_MENU');
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            error: `Ayrıştırma hatası: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      onUpdate: (next) => {
        this.settings.narrativeTone = next.narrativeTone;
        this.settings.animationSpeed = next.animationSpeed;
        this.settings.showIntentArrows = next.showIntentArrows;
        this.settings.soundEnabled = next.soundEnabled;
        this.settings.soundVolume = next.soundVolume;

        this.uiPrefs.crtScanlines = next.crtScanlines;
        this.uiPrefs.crtThemeEnabled = next.crtThemeEnabled;
        this.uiPrefs.calmScreen = next.calmScreen;
        this.uiPrefs.showLethalWarnings = next.showLethalWarnings;
        this.calmScreen = next.calmScreen;

        this.sfx.setMuted(!this.settings.soundEnabled);
        this.sfx.setVolume(this.settings.soundVolume);
        this.fxQueue.setSpeed(this.settings.animationSpeed);
        this.fxQueue.setCalmScreen(this.calmScreen);
        this.speechOverlay.setTone(next.narrativeTone);
        this.mainMenuHandle?.setTone(next.narrativeTone);
        this.mainMenuHandle?.setTheme(this.getActiveRenderTheme());
        this.mainMenuHandle?.setMutedLabel(!this.settings.soundEnabled);
        this.renderer?.setTheme(this.getActiveRenderTheme());

        saveUiPrefs(this.uiPrefs);
        this.persistState();
        this.recomputeIntentArrows();
        this.refreshTopBar();
      },
      onPlayTestSfx: () => {
        this.sfx.unlock();
        this.sfx.play('menuClick');
      },
      onPlayClickSfx: () => {
        this.sfx.unlock();
        this.sfx.play('menuClick');
      },
      onResetAllProgress: () => {
        clearSavedAppState();
        this.uiPrefs = createDefaultUiPrefs();
        saveUiPrefs(this.uiPrefs);
        this.campaign = null;
        this.skirmish = null;
        this.lastResumableScreen = 'MAIN_MENU';
        this.setScreen('MAIN_MENU');
      },
      onClose: () => {
        this.settingsModal = null;
        this.syncModalBodyLock();
      },
    });
    this.settingsModal.open(this.root);
    this.syncModalBodyLock();
  }

  private openPauseModal(): void {
    if (!this.isBoardScreen()) return;
    this.pauseModal?.close();
    const seedLabel = this.campaign?.seed ?? this.skirmish?.seed ?? this.seedInput;
    this.pauseModal = new PauseModal({
      seed: seedLabel,
      stateHash: computeStateHash(this.state),
      isFullscreen: this.fullscreen?.isFullscreen() === true,
      onResume: () => {
        this.pauseModal = null;
        this.syncModalBodyLock();
      },
      onToggleFullscreen: () => {
        this.pauseModal = null;
        this.syncModalBodyLock();
        void this.toggleFullscreen();
      },
      onOpenCodex: () => this.openCodexModal(),
      onOpenSettings: () => this.openSettingsModal(),
      onSurrenderToMenu: () => {
        this.pauseModal = null;
        this.syncModalBodyLock();
        this.setScreen('MAIN_MENU');
      },
    });
    this.pauseModal.open(this.root);
    this.syncModalBodyLock();
  }

  // ==========================================================================
  // AYNI CİHAZDA 2 OYUNCULU (DÖNEN TAHTA + SIRADAKİ TUŞU) YAŞAM DÖNGÜSÜ
  // ==========================================================================

  private closeHotseatHandoff(): void {
    if (this.hotseatHandoffEl !== null) {
      this.hotseatHandoffEl.remove();
      this.hotseatHandoffEl = null;
      this.syncModalBodyLock();
    }
  }

  private openHotseatHandoff(opts: {
    targetSide: Side;
    eyebrow: string;
    title: string;
    detail: string;
    buttonLabel: string;
    onConfirm: () => void;
  }): void {
    this.closeHotseatHandoff();

    const backdrop = document.createElement('div');
    backdrop.className = 'tfc-modal-backdrop sucs-handoff-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', opts.title);

    const card = document.createElement('div');
    card.className = `tfc-modal-card sucs-handoff-card is-${opts.targetSide === 'PLAYER' ? 'player' : 'enemy'}`;

    const eyebrow = document.createElement('div');
    eyebrow.className = 'tfc-hero-eyebrow';
    eyebrow.textContent = opts.eyebrow;

    const heading = document.createElement('h2');
    heading.textContent = opts.title;

    const desc = document.createElement('p');
    desc.textContent = opts.detail;

    const orientBadge = document.createElement('div');
    orientBadge.className = 'tfc-badge';
    orientBadge.textContent =
      opts.targetSide === 'ENEMY' ? 'Tahta 180° Dönecek · Kırmızı Alt' : 'Standart Yön · Mavi Alt';

    const confirmBtn = this.createButton(
      opts.buttonLabel,
      () => {
        this.closeHotseatHandoff();
        opts.onConfirm();
      },
      'is-gold sucs-handoff-btn',
    );

    card.append(eyebrow, heading, desc, orientBadge, confirmBtn);
    backdrop.appendChild(card);
    this.root.appendChild(backdrop);
    this.hotseatHandoffEl = backdrop;
    this.syncModalBodyLock();
  }

  private startNewLocal2P(): void {
    const cleanSeed = normalizeSeed(this.seedInput, getDailySeed());
    this.seedInput = cleanSeed;
    this.saveNotice = '';
    this.skirmish = createLocal2pSkirmishRun(cleanSeed);
    this.campaign = null;
    this.skirmishLastAiNote = '';
    this.skirmishMatchWinner = null;
    this.skirmishUnitSeq = 20;
    this.hotseatDeploySide = 'PLAYER';
    this.hotseatDraftSide = 'PLAYER';
    this.hotseatViewerSide = 'PLAYER';
    this.hotseatPlayerPlacements = {};
    this.enterSkirmishDeploy();
    this.persistState();
  }

  /**
   * Explicit "Sıradaki" button handler in Local 2P battle:
   * Board NEVER auto-flips after a move; only flips 180° and switches Fog of War
   * when the next player taps "Sıradaki ↻".
   */
  private advanceHotseatTurn(): void {
    if (!this.isHotseatWaitingNext()) return;

    this.fxQueue.skipAll();
    this.speechOverlay.clear();

    this.hotseatViewerSide = this.state.turn;
    this.selectedCoord = null;
    this.inspectedCoord = null;
    this.hoveredCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];
    this.lastVisibleMove = null;

    if (this.canvasWrapEl !== null && !this.calmScreen) {
      this.canvasWrapEl.classList.remove('sucs-board-flip-pulse');
      void this.canvasWrapEl.offsetWidth;
      this.canvasWrapEl.classList.add('sucs-board-flip-pulse');
    }

    this.sfx.play('promote');
    const sideLabel = this.getHotseatSideLabel(this.hotseatViewerSide);
    this.hudNotify?.showBanner({
      eyebrow: `TUR #${this.state.turnNumber}`,
      title: `TAHTA ÇEVRİLDİ · ${sideLabel.toUpperCase()}`,
      tone: this.hotseatViewerSide === 'PLAYER' ? 'player' : 'enemy',
      durationMs: 1600,
    });
    this.setStatus(
      `Tahta çevrildi — Sıra: ${sideLabel} (Tur #${this.state.turnNumber}).`,
      'normal',
    );
    this.refreshUi();
  }

  // ==========================================================================
  // MOD 2: ASİMETRİK ORDU VE GELİŞEN DÜELLO (BEST-OF-3) EKRANLARI
  // ==========================================================================

  private startNewSkirmish(): void {
    const cleanSeed = normalizeSeed(this.seedInput, getDailySeed());
    this.seedInput = cleanSeed;
    this.saveNotice = '';
    this.skirmish = createSkirmishRun(cleanSeed);
    this.campaign = null;
    this.skirmishLastAiNote = '';
    this.skirmishMatchWinner = null;
    this.skirmishUnitSeq = 20;
    this.enterSkirmishDeploy();
    this.persistState();
  }

  private enterSkirmishDeploy(): void {
    if (this.skirmish === null) {
      this.setScreen('MAIN_MENU');
      return;
    }
    const is2p = this.skirmish.isLocal2P === true;
    const activeSide: Side = is2p ? this.hotseatDeploySide : 'PLAYER';
    const roster = activeSide === 'PLAYER' ? this.skirmish.playerRoster : this.skirmish.enemyRoster;
    const generated = generateSkirmishMap(this.skirmish.roundIndex, this.skirmish.seed);
    this.skirmishDeployMap = {
      name: generated.template.name,
      width: generated.width,
      height: generated.height,
      tiles: generated.tiles,
    };
    const auto = autoDeploySkirmishRoster(
      generated.tiles,
      generated.width,
      generated.height,
      roster,
      this.skirmish.rngState,
      activeSide,
    );
    this.skirmish = { ...this.skirmish, rngState: auto.nextRngState };
    this.skirmishPlacements = auto.placements;
    this.skirmishSelectedUnitId = roster[0]?.id ?? null;
    this.hoveredCoord = null;
    if (is2p) {
      const label = this.getHotseatSideLabel(activeSide);
      this.statusMessage =
        this.skirmish.roundIndex === 0
          ? `${label}: 20 puanlık ordunu kur ve kendi alt 2 sıradaki yeşil karelere gizlice yerleştir.`
          : `${label}: El ${this.skirmish.roundIndex + 1} için güncel ordunu yerleştir.`;
    } else {
      this.statusMessage =
        this.skirmish.roundIndex === 0
          ? '20 puanlık ordunu kur ve son 2 sıradaki yeşil karelere gizlice yerleştir.'
          : 'Yeni haritada güncel ordunu yeniden dizebilir veya doğrudan eli başlatabilirsin.';
    }
    this.setScreen('SKIRMISH_DEPLOY');
  }

  private getActiveDeployContext(): {
    side: Side;
    roster: RosterUnit[];
    roundIndex: number;
    playerWins: number;
    enemyWins: number;
    localFaction: FactionPassive;
    seedLabel: string;
    isLocal2P: boolean;
  } | null {
    if (this.skirmish !== null) {
      const isLocal2P = this.skirmish.isLocal2P === true;
      const side: Side = isLocal2P ? this.hotseatDeploySide : 'PLAYER';
      return {
        side,
        roster: side === 'PLAYER' ? this.skirmish.playerRoster : this.skirmish.enemyRoster,
        roundIndex: this.skirmish.roundIndex,
        playerWins: this.skirmish.playerWins,
        enemyWins: this.skirmish.enemyWins,
        localFaction:
          side === 'PLAYER' ? this.skirmish.playerFaction : this.skirmish.enemyFaction,
        seedLabel: this.skirmish.seed,
        isLocal2P,
      };
    }
    return null;
  }

  private buildDeployPreviewVisibleState(): VisibleState {
    const map = this.skirmishDeployMap!;
    const ctx = this.getActiveDeployContext()!;
    const pieces: Piece[] = [];

    for (let i = 0; i < ctx.roster.length; i++) {
      const u = ctx.roster[i]!;
      const pos = this.skirmishPlacements[u.id];
      if (pos === undefined) continue;
      pieces.push({
        id: u.id,
        side: ctx.side,
        type: u.type,
        pos: { x: pos.x, y: pos.y },
        traits: u.traits.slice(),
        shieldActive: u.traits.includes('SHIELDED'),
        frozenTurns: 0,
        hasMoved: false,
        aggro: 'ACTIVE',
        usedDashThisTurn: false,
        wasVisibleAtTurnStart: false,
      });
    }

    return {
      viewer: ctx.side,
      width: map.width,
      height: map.height,
      tiles: map.tiles,
      fog: createDeployVisibilityFog(map.width, map.height, ctx.side, map.tiles),
      pieces,
      silhouettes: [],
      pendingSpawns: [],
      turn: ctx.side,
      turnNumber: 1,
      mode: 'SKIRMISH',
      factions: {
        PLAYER: ctx.side === 'PLAYER' ? ctx.localFaction : 'NONE',
        ENEMY: ctx.side === 'ENEMY' ? ctx.localFaction : 'NONE',
      },
      bonusMovePieceId: null,
      winner: null,
    };
  }

  private renderSkirmishDeployScreen(): void {
    const ctx = this.getActiveDeployContext();
    if (ctx === null || this.skirmishDeployMap === null) {
      this.setScreen('MAIN_MENU');
      return;
    }

    const map = this.skirmishDeployMap;
    const stage = document.createElement('main');
    stage.className = 'sucs-stage';

    this.canvasWrapEl = document.createElement('div');
    this.canvasWrapEl.className = 'sucs-stage-canvas-wrap';
    this.canvasEl = document.createElement('canvas');
    this.canvasEl.setAttribute('aria-label', 'Düello Gizli Dizilim Tahtası');
    this.canvasWrapEl.appendChild(this.canvasEl);

    const hud = document.createElement('div');
    hud.className = 'sucs-hud-layer';
    this.hudNotify = new HudNotificationCenter({ maxToasts: 3 });

    // Sol-Üst: Menü + El bilgisi
    const hudTl = document.createElement('div');
    hudTl.className = 'sucs-hud-tl';
    const topLeftRow = document.createElement('div');
    topLeftRow.className = 'sucs-icon-bar';
    const menuBtn = this.createButton('← Menü', () => this.setScreen('MAIN_MENU'));
    const roundChip = document.createElement('div');
    roundChip.className = 'px-chip';
    roundChip.textContent = `${ctx.isLocal2P ? `${this.getHotseatSideLabel(ctx.side)} · ` : ''}EL ${ctx.roundIndex + 1}/3 · ${map.name}`;
    topLeftRow.append(menuBtn, roundChip);
    hudTl.appendChild(topLeftRow);

    // Üst-Orta: Gizli dizilim şeridi + bildirim bandı
    const hudTc = document.createElement('div');
    hudTc.className = 'sucs-hud-tc';
    const phaseChip = document.createElement('div');
    phaseChip.className = 'px-chip sucs-turn-chip is-player';
    phaseChip.textContent = ctx.roundIndex === 0 ? 'GİZLİ DİZİLİM · 20P ORDU KUR' : 'GİZLİ DİZİLİM · TAŞLARINI DİZ';
    hudTc.append(phaseChip, this.hudNotify.bannerHostEl);

    // Sağ-Üst: Ordu Çekmecesi aç/kapa + Ses
    const hudTr = document.createElement('div');
    hudTr.className = 'sucs-hud-tr';
    this.deployDrawerOpen = typeof window === 'undefined' ? true : window.innerWidth >= 720 || ctx.roundIndex === 0;
    this.deployToggleBtnEl = document.createElement('button');
    this.deployToggleBtnEl.type = 'button';
    this.deployToggleBtnEl.className = 'px-chip' + (this.deployDrawerOpen ? ' is-open' : '');
    this.deployToggleBtnEl.innerHTML = `${renderPixelIconSvg('army', 14)}<span>ORDU PANELİ</span>`;
    this.deployToggleBtnEl.addEventListener('click', () => {
      this.sfx.unlock();
      this.sfx.play('menuClick');
      this.setDeployDrawerOpen(!this.deployDrawerOpen);
      this.syncDeployCanvasSize();
    });
    this.hudMuteBtnEl = this.createPixelIconButton('soundOn', 'Ses Aç / Kapat [M]', () =>
      this.toggleMute(),
    );
    hudTr.append(this.deployToggleBtnEl, this.hudMuteBtnEl);

    // Yüzen Sağ Ordu Kurucu Çekmecesi
    const sidebar = document.createElement('aside');
    sidebar.className = 'sucs-deploy-drawer px-frame';
    sidebar.style.display = this.deployDrawerOpen ? 'flex' : 'none';
    this.deployDrawerEl = sidebar;
    this.renderSkirmishDeploySidebar(sidebar);

    // Alt-Orta: Otomatik Diz + Eli Başlat yüzen butonları
    const hudBc = document.createElement('div');
    hudBc.className = 'sucs-hud-bc';
    const actionCluster = document.createElement('div');
    actionCluster.className = 'sucs-action-cluster';
    const autoBtn = this.createButton('Otomatik Diz', () => {
      const cur = this.getActiveDeployContext();
      if (cur === null || this.skirmishDeployMap === null || this.skirmish === null) return;

      const auto = autoDeploySkirmishRoster(
        this.skirmishDeployMap.tiles,
        this.skirmishDeployMap.width,
        this.skirmishDeployMap.height,
        cur.roster,
        this.skirmish.rngState,
        cur.side,
      );
      this.skirmish = { ...this.skirmish, rngState: auto.nextRngState };
      this.skirmishPlacements = auto.placements;
      this.sfx.play('uiSelect');
      this.renderSkirmishDeploySidebar(sidebar);
      this.drawDeployFrame();
    });
    const startBtnLabel = ctx.isLocal2P
      ? ctx.side === 'PLAYER'
        ? '1. Oyuncu Hazır → Sıradaki'
        : `El ${ctx.roundIndex + 1}'i Başlat →`
      : `El ${ctx.roundIndex + 1}'i Başlat →`;
    const startBtn = this.createButton(
      startBtnLabel,
      () => this.confirmSkirmishDeployAndStart(),
      'is-primary',
    );
    actionCluster.append(autoBtn, startBtn);
    hudBc.appendChild(actionCluster);

    // Sağ-Alt: YouTube Tarzı Tam Ekran
    const hudBr = document.createElement('div');
    hudBr.className = 'sucs-hud-br';
    this.hudFsBtnEl = this.createPixelIconButton(
      this.fullscreen?.isFullscreen() ? 'fullscreenExit' : 'fullscreenEnter',
      'Tam Ekran [F]',
      () => {
        void this.toggleFullscreen();
      },
      'sucs-fullscreen-btn',
      18,
    );
    hudBr.appendChild(this.hudFsBtnEl);

    hud.append(hudTl, hudTc, hudTr, this.hudNotify.toastFeedEl, sidebar, hudBc, hudBr);
    stage.append(this.canvasWrapEl, hud);
    this.mainContainerEl.appendChild(stage);

    this.renderer = new CanvasRenderer(this.canvasEl, undefined, {
      theme: this.getActiveRenderTheme(),
    });
    this.renderer.bindPointerEvents({
      onTileTap: (coord) => {
        if (this.deployDraggingUnitId !== null) {
          this.deployDraggingUnitId = null;
        }
        this.onDeployTileTap(coord, sidebar);
      },
      onTileHover: (coord) => {
        this.hoveredCoord = coord;
        this.drawDeployFrame();
      },
      onPointerActivity: () => this.sfx.unlock(),
    });

    // Gizli Dizilim Sürükle-Bırak Desteği (Drag & Drop)
    this.canvasEl.addEventListener('pointerdown', (e: PointerEvent) => {
      const actCtx = this.getActiveDeployContext();
      if (this.renderer === null || actCtx === null || this.skirmishDeployMap === null) return;
      const rect = this.canvasEl!.getBoundingClientRect();
      const coord = localPointToTile(
        this.renderer.getLayout(),
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.skirmishDeployMap.width,
        this.skirmishDeployMap.height,
        this.shouldFlipBoard(),
      );
      if (coord === null) return;
      const dragId = Object.keys(this.skirmishPlacements).find((id) => {
        const p = this.skirmishPlacements[id];
        return p !== undefined && coordEquals(p, coord);
      });
      if (dragId !== undefined) {
        this.deployDraggingUnitId = dragId;
        this.skirmishSelectedUnitId = dragId;
      }
    });
    this.canvasEl.addEventListener('pointerup', (e: PointerEvent) => {
      const dragId = this.deployDraggingUnitId;
      if (dragId === null || this.renderer === null || this.skirmishDeployMap === null) return;
      const rect = this.canvasEl!.getBoundingClientRect();
      const dropCoord = localPointToTile(
        this.renderer.getLayout(),
        e.clientX - rect.left,
        e.clientY - rect.top,
        this.skirmishDeployMap.width,
        this.skirmishDeployMap.height,
        this.shouldFlipBoard(),
      );
      if (dropCoord !== null) {
        const startPos = this.skirmishPlacements[dragId];
        if (startPos !== undefined && !coordEquals(startPos, dropCoord)) {
          this.deployDraggingUnitId = null;
          this.skirmishSelectedUnitId = dragId;
          this.onDeployTileTap(dropCoord, sidebar);
        }
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.syncDeployCanvasSize());
      this.resizeObserver.observe(this.canvasWrapEl);
    }

    this.syncDeployCanvasSize();
    this.refreshFullscreenButtons();
    this.drawDeployFrame();
    this.hudNotify.pushToast({
      title: 'GİZLİ DİZİLİM',
      text: this.statusMessage,
      tone: 'player',
      icon: 'army',
      durationMs: 4200,
    });
  }

  private syncDeployCanvasSize(): void {
    if (this.renderer === null || this.canvasWrapEl === null || this.skirmishDeployMap === null) {
      return;
    }
    const { width, height } = this.skirmishDeployMap;
    const rect = this.canvasWrapEl.getBoundingClientRect();
    const cssW = Math.max(240, rect.width || (typeof window !== 'undefined' ? window.innerWidth : 640));
    const cssH = Math.max(
      240,
      rect.height || (typeof window !== 'undefined' ? window.innerHeight : Math.round((cssW * height) / width)),
    );
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const rightReserve = this.deployDrawerOpen && cssW >= 900 ? 364 : 8;
    this.renderer.resize(cssW, cssH, dpr, {
      top: 44,
      bottom: 48,
      left: 8,
      right: rightReserve,
    });
    const pxUnit = Math.max(2, Math.min(4, Math.round(this.renderer.getLayout().tileSize / 32)));
    this.root.style.setProperty('--px', `${pxUnit}px`);
    this.drawDeployFrame();
  }

  private drawDeployFrame(): void {
    const ctx = this.getActiveDeployContext();
    if (this.renderer === null || ctx === null || this.skirmishDeployMap === null) {
      return;
    }
    const visible = this.buildDeployPreviewVisibleState();
    const selectedCoord =
      this.skirmishSelectedUnitId !== null
        ? (this.skirmishPlacements[this.skirmishSelectedUnitId] ?? null)
        : null;
    const deployZoneRows =
      ctx.side === 'PLAYER'
        ? [this.skirmishDeployMap.height - 2, this.skirmishDeployMap.height - 1]
        : [0, 1];
    this.renderer.render(visible, {
      selectedCoord,
      inspectedCoord: null,
      hoveredCoord: this.hoveredCoord,
      legalMoves: [],
      legalAbilities: [],
      activeAbility: null,
      deployZoneRows,
      flipBoard: this.shouldFlipBoard(),
      timeMs: performance.now(),
    });
  }

  private onDeployTileTap(coord: Coord, sidebarEl: HTMLElement): void {
    const ctx = this.getActiveDeployContext();
    if (ctx === null || this.skirmishDeployMap === null) return;
    const map = this.skirmishDeployMap;

    if (!isValidSkirmishDeployCoord(map.tiles, map.width, map.height, coord, ctx.side)) {
      this.sfx.play('uiInvalid');
      this.setStatus(
        'Taşları yalnızca kendi alt 2 sırandaki yeşil (duvar/çukur olmayan) karelere dizebilirsin.',
        'warn',
      );
      return;
    }

    // Check if another local unit occupies `coord`
    const occupantId = Object.keys(this.skirmishPlacements).find((id) => {
      const p = this.skirmishPlacements[id];
      return p !== undefined && coordEquals(p, coord);
    });

    if (this.skirmishSelectedUnitId === null) {
      if (occupantId !== undefined) {
        this.skirmishSelectedUnitId = occupantId;
        this.sfx.play('uiSelect');
        this.setStatus('Taş seçildi. Taşımak veya yer değiştirmek için yeşil bir kareye tıkla.', 'normal');
      }
    } else if (occupantId === this.skirmishSelectedUnitId) {
      this.skirmishSelectedUnitId = null;
      this.setStatus('Seçim kaldırıldı.', 'normal');
    } else if (occupantId !== undefined) {
      // Swap positions between selected unit and occupant
      const prevCoord = this.skirmishPlacements[this.skirmishSelectedUnitId];
      if (prevCoord !== undefined) {
        this.skirmishPlacements[occupantId] = { x: prevCoord.x, y: prevCoord.y };
      }
      this.skirmishPlacements[this.skirmishSelectedUnitId] = { x: coord.x, y: coord.y };
      this.sfx.play('move');
      this.setStatus(`Taşların yeri değiştirildi (${formatCoord(coord, map.height)}).`, 'normal');
    } else {
      // Move selected unit into empty valid deploy square
      this.skirmishPlacements[this.skirmishSelectedUnitId] = { x: coord.x, y: coord.y };
      this.sfx.play('move');
      this.setStatus(`Taş ${formatCoord(coord, map.height)} karesine yerleştirildi.`, 'normal');
    }

    this.renderSkirmishDeploySidebar(sidebarEl);
    this.drawDeployFrame();
  }

  private countWalkableDeploySlots(side: Side): number {
    if (this.skirmishDeployMap === null) return 0;
    const { tiles, width, height } = this.skirmishDeployMap;
    const rows = side === 'PLAYER' ? [height - 2, height - 1] : [0, 1];
    let count = 0;
    for (let r = 0; r < rows.length; r++) {
      const y = rows[r]!;
      for (let x = 0; x < width; x++) {
        if (isTileWalkable(tiles[y]?.[x])) count++;
      }
    }
    return count;
  }

  private findFreeDeploySlot(side: Side): Coord | null {
    if (this.skirmishDeployMap === null) return null;
    const { tiles, width, height } = this.skirmishDeployMap;
    const rows = side === 'PLAYER' ? [height - 2, height - 1] : [0, 1];
    for (let r = 0; r < rows.length; r++) {
      const y = rows[r]!;
      for (let x = 0; x < width; x++) {
        const c: Coord = { x, y };
        if (!isTileWalkable(tiles[y]?.[x])) continue;
        const taken = Object.values(this.skirmishPlacements).some((p) => coordEquals(p, c));
        if (!taken) return c;
      }
    }
    return null;
  }

  private renderSkirmishDeploySidebar(sidebarEl: HTMLElement): void {
    const ctx = this.getActiveDeployContext();
    if (ctx === null || this.skirmishDeployMap === null || this.skirmish === null) return;
    const map = this.skirmishDeployMap;
    sidebarEl.innerHTML = '';

    const localWins = ctx.side === 'PLAYER' ? ctx.playerWins : ctx.enemyWins;
    const remoteWins = ctx.side === 'PLAYER' ? ctx.enemyWins : ctx.playerWins;
    const sideTitle = ctx.isLocal2P ? `${this.getHotseatSideLabel(ctx.side)} · ` : '';

    // Card 1: Best-of-3 Status
    const metaCard = document.createElement('div');
    metaCard.className = 'tfc-card';
    metaCard.innerHTML =
      `<h2 class="tfc-card-title"><span>${sideTitle}El ${ctx.roundIndex + 1} / 3 · ${map.name}</span><span class="tfc-badge">${localWins} — ${remoteWins}</span></h2>` +
      `<div class="tfc-inspect-block">` +
      `<div class="tfc-field-row"><label>Fraksiyon</label><strong>${FACTION_DEFINITIONS[ctx.localFaction].name}</strong></div>` +
      `<div class="tfc-field-row"><label>Rakip Ordusu</label><strong style="color:#f87171;">Gizli (Savaş Sisinde)</strong></div>` +
      `<div class="tfc-field-row"><label>Seed</label><span class="tfc-hash-code">${ctx.seedLabel}</span></div>` +
      `</div>`;

    if (!ctx.isLocal2P && this.skirmishLastAiNote) {
      const note = document.createElement('div');
      note.className = 'tfc-status-banner is-warn';
      note.textContent = this.skirmishLastAiNote;
      metaCard.appendChild(note);
    }
    sidebarEl.appendChild(metaCard);

    const updateSideRoster = (nextRoster: RosterUnit[], nextRng?: number): void => {
      if (this.skirmish === null) return;
      this.skirmish = {
        ...this.skirmish,
        ...(ctx.side === 'PLAYER' ? { playerRoster: nextRoster } : { enemyRoster: nextRoster }),
        ...(nextRng !== undefined ? { rngState: nextRng } : {}),
      };
    };

    // Card 2: Round 1 20-Point Battery Army Builder (9 birim + Hızlı Şablonlar)
    if (ctx.roundIndex === 0) {
      const spent = computeSkirmishRosterCost(ctx.roster);
      const maxSlots = this.countWalkableDeploySlots(ctx.side);
      const idPrefix = ctx.isLocal2P ? (ctx.side === 'PLAYER' ? 'p1' : 'p2') : 'sp';

      renderArmyBuilderCatalogCard({
        containerEl: sidebarEl,
        spent,
        rosterLength: ctx.roster.length,
        maxSlots,
        locked: false,
        theme: this.getActiveRenderTheme(),
        bindButton: (lbl, fn, cls) => this.createButton(lbl, fn, cls),
        onApplyTemplate: (template) => {
          if (this.skirmishDeployMap === null || this.skirmish === null) return;
          const rng = this.skirmish.rngState;
          const nextRoster = buildQuickArmyTemplate(template, idPrefix, rng);
          const auto = autoDeploySkirmishRoster(
            this.skirmishDeployMap.tiles,
            this.skirmishDeployMap.width,
            this.skirmishDeployMap.height,
            nextRoster,
            rng,
            ctx.side,
          );
          updateSideRoster(nextRoster, auto.nextRngState);
          this.skirmishPlacements = auto.placements;
          this.skirmishSelectedUnitId = nextRoster[0]?.id ?? null;
          this.sfx.play('uiSelect');
          this.renderSkirmishDeploySidebar(sidebarEl);
          this.drawDeployFrame();
        },
        onAddUnit: (item) => {
          if (this.skirmish === null) return;
          const freeSlot = this.findFreeDeploySlot(ctx.side);
          if (freeSlot === null) {
            this.sfx.play('uiInvalid');
            this.setStatus('Dizilim bölgesinde boş kare kalmadı.', 'warn');
            return;
          }
          const newId = `${idPrefix}_${++this.skirmishUnitSeq}`;
          const newUnit: RosterUnit = {
            id: newId,
            type: item.type,
            traits: item.traits.slice(),
          };
          const currentRoster =
            ctx.side === 'PLAYER' ? this.skirmish.playerRoster : this.skirmish.enemyRoster;
          updateSideRoster([...currentRoster, newUnit]);
          this.skirmishPlacements[newId] = freeSlot;
          this.skirmishSelectedUnitId = newId;
          this.sfx.play('uiSelect');
          this.renderSkirmishDeploySidebar(sidebarEl);
          this.drawDeployFrame();
        },
      });
    }

    // Card 3: Active Roster & Placement List
    const rosterCard = document.createElement('div');
    rosterCard.className = 'tfc-card';
    const rTitle = document.createElement('h2');
    rTitle.className = 'tfc-card-title';
    rTitle.textContent = `Ordun (${ctx.roster.length} Birim) · Tıkla ve Taşı`;

    const rList = document.createElement('div');
    rList.className = 'tfc-roster-list';

    for (let i = 0; i < ctx.roster.length; i++) {
      const unit = ctx.roster[i]!;
      const pos = this.skirmishPlacements[unit.id];
      const row = document.createElement('div');
      row.className =
        'tfc-roster-row' + (this.skirmishSelectedUnitId === unit.id ? ' is-selected' : '');

      const labelBtn = this.createButton(
        `${formatRosterUnitLabel(unit)} ${pos !== undefined ? `· ${formatCoord(pos, map.height)}` : ''}`,
        () => {
          this.skirmishSelectedUnitId = unit.id;
          this.sfx.play('uiSelect');
          this.renderSkirmishDeploySidebar(sidebarEl);
          this.drawDeployFrame();
        },
      );
      labelBtn.style.border = 'none';
      labelBtn.style.background = 'transparent';
      labelBtn.style.padding = '2px 4px';

      row.appendChild(labelBtn);

      if (ctx.roundIndex === 0 && unit.type !== 'KING') {
        const remBtn = this.createButton('×', () => {
          if (this.skirmish === null) return;
          const currentRoster =
            ctx.side === 'PLAYER' ? this.skirmish.playerRoster : this.skirmish.enemyRoster;
          const filtered = currentRoster.filter((u) => u.id !== unit.id);
          updateSideRoster(filtered);
          delete this.skirmishPlacements[unit.id];
          if (this.skirmishSelectedUnitId === unit.id) {
            const king = filtered.find((u) => u.type === 'KING');
            this.skirmishSelectedUnitId = king?.id ?? null;
          }
          this.sfx.play('uiSelect');
          this.renderSkirmishDeploySidebar(sidebarEl);
          this.drawDeployFrame();
        }, 'is-danger');
        row.appendChild(remBtn);
      }

      rList.appendChild(row);
    }

    rosterCard.append(rTitle, rList);
    sidebarEl.appendChild(rosterCard);
  }

  private confirmSkirmishDeployAndStart(): void {
    if (this.skirmish === null || this.skirmishDeployMap === null) return;

    if (this.skirmish.isLocal2P === true) {
      const map = this.skirmishDeployMap;
      const enforceBudget = this.skirmish.roundIndex === 0;

      if (this.hotseatDeploySide === 'PLAYER') {
        const checkP1 = buildValidatedSkirmishSidePieces(
          this.skirmish.playerRoster,
          this.skirmishPlacements,
          map.tiles,
          map.width,
          map.height,
          'PLAYER',
          enforceBudget,
        );
        if (checkP1.error !== undefined) {
          this.sfx.play('uiInvalid');
          this.setStatus(checkP1.error, 'error');
          return;
        }
        this.hotseatPlayerPlacements = { ...this.skirmishPlacements };
        this.sfx.play('promote');
        this.openHotseatHandoff({
          targetSide: 'ENEMY',
          eyebrow: `YÜZ YÜZE 2P · EL ${this.skirmish.roundIndex + 1} / 3`,
          title: 'Cihazı 2. Oyuncu (Kırmızı)\'ya Ver',
          detail:
            '1. Oyuncu gizli dizilimini tamamladı. 2. Oyuncu hazır olduğunda tahta 180° dönecek ve kendi gizli ordusunu kuracak.',
          buttonLabel: 'Sıradaki: 2. Oyuncu Dizilimi ↻',
          onConfirm: () => {
            this.hotseatDeploySide = 'ENEMY';
            this.enterSkirmishDeploy();
          },
        });
        return;
      }

      // 2. Oyuncu dizilimini doğrula ve savaşı başlat
      const launched = startLocal2pRoundBattle(
        this.skirmish,
        this.hotseatPlayerPlacements,
        this.skirmishPlacements,
      );
      if (launched.error !== undefined || launched.nextRun.currentBattle === null) {
        this.sfx.play('uiInvalid');
        this.setStatus(launched.error ?? 'Dizilim doğrulanamadı.', 'error');
        return;
      }

      this.skirmish = launched.nextRun;
      this.activeBattleKind = 'LOCAL_2P';
      this.state = launched.nextRun.currentBattle;
      this.hotseatViewerSide = 'PLAYER';
      this.undoStack = [];
      this.selectedCoord = null;
      this.inspectedCoord = null;
      this.hoveredCoord = null;
      this.activeAbility = null;
      this.legalMoves = [];
      this.legalAbilities = [];
      this.eventLog = [];
      this.pushLog(`2P Düello El ${this.skirmish.roundIndex + 1} başladı! İki ordu da gizlice dizildi.`);
      this.statusMessage = `El ${this.skirmish.roundIndex + 1} / 3 — Sıra: 1. Oyuncu (Mavi). Hamle sonrası "Sıradaki" tuşuyla tahtayı çevir.`;
      this.sfx.play('promote');
      this.openHotseatHandoff({
        targetSide: 'PLAYER',
        eyebrow: `YÜZ YÜZE 2P · EL ${this.skirmish.roundIndex + 1} BAŞLIYOR`,
        title: 'Cihazı 1. Oyuncu (Mavi)\'ya Ver',
        detail:
          'İki ordu da sisin ardında yerini aldı. Her hamleden sonra tahta otomatik dönmez — cihazı devredip "Sıradaki" tuşuna basın.',
        buttonLabel: 'Sıradaki: 1. Oyuncu Başlasın →',
        onConfirm: () => {
          this.setScreen('BATTLE');
          this.persistState();
        },
      });
      return;
    }

    const launched = startSkirmishRoundBattle(this.skirmish, this.skirmishPlacements);
    if (launched.error !== undefined || launched.nextRun.currentBattle === null) {
      this.sfx.play('uiInvalid');
      this.setStatus(launched.error ?? 'Dizilim doğrulanamadı.', 'error');
      return;
    }

    this.skirmish = launched.nextRun;
    this.activeBattleKind = 'SKIRMISH';
    this.state = launched.nextRun.currentBattle;
    this.aiMemory = createAiMemory();
    this.undoStack = [];
    this.selectedCoord = null;
    this.inspectedCoord = null;
    this.hoveredCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];
    this.eventLog = [];
    this.pushLog(`Düello El ${this.skirmish.roundIndex + 1} başladı! Rakip gizli dizilimini tamamladı.`);
    this.statusMessage = `El ${this.skirmish.roundIndex + 1} / 3 — 120ms Alpha-Beta Düello AI'ya karşı ilk hamle senin!`;
    this.setScreen('BATTLE');
    this.hudNotify?.showBanner({
      eyebrow: `TAKTİK KRİZ · EL ${this.skirmish.roundIndex + 1} / 3`,
      title: 'ÇATIŞMA BAŞLADI',
      subtitle: 'Rakip gizli dizilimini tamamladı · İlk hamle senin!',
      tone: 'player',
      durationMs: 2200,
    });
    this.persistState();
  }

  private proceedAfterSkirmishRound(): void {
    if (this.skirmish === null) return;
    const resolved = resolveSkirmishRoundOutcome(this.skirmish, this.state);
    this.skirmish = resolved.nextRun;

    if (resolved.status === 'MATCH_OVER') {
      this.skirmishMatchWinner = resolved.matchWinner;
      this.setScreen('MATCH_SUMMARY');
      // Clear finished run from auto-save while keeping settings intact
      saveAppState({
        saveVersion: SAVE_VERSION,
        screen: 'MAIN_MENU',
        settings: { ...this.settings },
        campaign: this.campaign,
        skirmish: null,
      });
      return;
    }

    this.hotseatDraftSide = 'PLAYER';
    const gen = generateSkirmishDraftChoices(this.skirmish, 'PLAYER');
    this.skirmishDraftPool = gen.pool;
    this.skirmishDraftCards = gen.cards;
    this.pendingDraftNextRng = gen.nextRngState;
    this.selectedDraftCardId = null;

    if (this.skirmish.isLocal2P === true) {
      this.openHotseatHandoff({
        targetSide: 'PLAYER',
        eyebrow: `YÜZ YÜZE 2P · EL ARASI DRAFT`,
        title: 'Cihazı 1. Oyuncu (Mavi)\'ya Ver',
        detail: '1. Oyuncu bir sonraki el için güçlendirme kartını seçecek.',
        buttonLabel: 'Sıradaki: 1. Oyuncu Draft →',
        onConfirm: () => {
          this.setScreen('SKIRMISH_DRAFT');
          this.persistState();
        },
      });
      return;
    }

    this.setScreen('SKIRMISH_DRAFT');
    this.persistState();
  }

  private renderSkirmishDraftScreen(): void {
    if (this.skirmish === null) {
      this.setScreen('MAIN_MENU');
      return;
    }

    const is2p = this.skirmish.isLocal2P === true;
    const roundIndex = this.skirmish.roundIndex;
    const localSide: Side = is2p ? this.hotseatDraftSide : 'PLAYER';
    const localWins = localSide === 'PLAYER' ? this.skirmish.playerWins : this.skirmish.enemyWins;
    const remoteWins = localSide === 'PLAYER' ? this.skirmish.enemyWins : this.skirmish.playerWins;
    const localRoster =
      localSide === 'PLAYER' ? this.skirmish.playerRoster : this.skirmish.enemyRoster;
    const isRare = this.skirmishDraftPool === 'RARE';

    const wrap = document.createElement('section');
    wrap.className = 'tfc-screen-center';

    const hero = document.createElement('div');
    hero.className = 'tfc-hero';
    hero.innerHTML =
      `<h2>${is2p ? `${this.getHotseatSideLabel(localSide)} · ` : ''}El ${roundIndex + 1} Bitti · Skor ${localWins} — ${remoteWins}</h2>` +
      `<p>${
        isRare
          ? '<strong style="color:#fbbf24;">GERİ DÖNÜŞ AVANTAJI!</strong> Önceki eli kaybettiğin için <strong>Nadir/Epik Havuz</strong>dan seçiyorsun.'
          : 'Önceki eli kazandığın için <strong>Standart Havuz</strong>dan seçiyorsun (rakip Nadir havuzdan seçecek).'
      }</p>`;

    wrap.appendChild(hero);

    const grid = document.createElement('div');
    grid.className = 'tfc-card-grid';

    for (let i = 0; i < this.skirmishDraftCards.length; i++) {
      const card = this.skirmishDraftCards[i]!;
      const isSelected = this.selectedDraftCardId === card.id;
      const cardEl = document.createElement('div');
      cardEl.className =
        'tfc-choice-card' +
        (card.pool === 'RARE' ? ' is-rare' : '') +
        (isSelected ? ' is-selected' : '');

      const body = document.createElement('div');
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.gap = '6px';

      const sub = document.createElement('div');
      sub.className = 'tfc-choice-subtitle';
      sub.textContent = card.pool === 'RARE' ? 'Nadir / Epik Kart' : 'Standart Kart';

      const h3 = document.createElement('h3');
      h3.textContent = card.title;

      const desc = document.createElement('p');
      desc.textContent = card.description;

      body.append(sub, h3, desc);

      const needsTarget = card.addTraitToAllOrTarget?.targetMode === 'PICK_UNIT';
      const btn = this.createButton(
        needsTarget
          ? isSelected
            ? 'Taş Seçiliyor ↓'
            : 'Seç ve Taş Belirle'
          : 'Kartı Seç →',
        () => {
          if (needsTarget) {
            this.selectedDraftCardId = card.id;
            this.sfx.play('uiSelect');
            this.mainContainerEl.innerHTML = '';
            this.renderSkirmishDraftScreen();
          } else {
            this.confirmSkirmishDraftPick(card);
          }
        },
        card.pool === 'RARE' ? 'is-gold' : 'is-primary',
      );

      cardEl.append(body, btn);
      grid.appendChild(cardEl);
    }

    wrap.appendChild(grid);

    // Target unit selector for trait draft cards
    const activeCard = this.skirmishDraftCards.find((c) => c.id === this.selectedDraftCardId);
    if (activeCard?.addTraitToAllOrTarget?.targetMode === 'PICK_UNIT') {
      const trait = activeCard.addTraitToAllOrTarget.trait;
      const panel = document.createElement('div');
      panel.className = 'tfc-target-panel';
      const heading = document.createElement('div');
      heading.className = 'tfc-inspect-heading';
      heading.textContent = `${trait} eklenecek taşı seç:`;
      panel.appendChild(heading);

      const btnGroup = document.createElement('div');
      btnGroup.className = 'tfc-btn-group';
      for (let i = 0; i < localRoster.length; i++) {
        const u = localRoster[i]!;
        const eligible = !u.traits.includes(trait) && u.traits.length < MAX_TRAITS_PER_PIECE;
        const uBtn = this.createButton(formatRosterUnitLabel(u), () =>
          this.confirmSkirmishDraftPick(activeCard, u.id),
        );
        uBtn.disabled = !eligible;
        btnGroup.appendChild(uBtn);
      }
      panel.appendChild(btnGroup);
      wrap.appendChild(panel);
    }

    this.mainContainerEl.appendChild(wrap);
  }

  private confirmSkirmishDraftPick(card: SkirmishDraftCard, targetUnitId?: string): void {
    if (this.skirmish === null) return;
    const baseRun: SkirmishRunState =
      this.pendingDraftNextRng !== 0
        ? { ...this.skirmish, rngState: this.pendingDraftNextRng }
        : this.skirmish;

    if (this.skirmish.isLocal2P === true) {
      const applied = applySkirmishDraftPick(baseRun, this.hotseatDraftSide, card, targetUnitId);
      if (applied.error !== undefined) {
        this.sfx.play('uiInvalid');
        return;
      }
      this.skirmish = applied.nextRun;
      this.pendingDraftNextRng = 0;
      this.selectedDraftCardId = null;
      this.sfx.play('promote');

      if (this.hotseatDraftSide === 'PLAYER') {
        this.hotseatDraftSide = 'ENEMY';
        const gen2 = generateSkirmishDraftChoices(this.skirmish, 'ENEMY');
        this.skirmishDraftPool = gen2.pool;
        this.skirmishDraftCards = gen2.cards;
        this.pendingDraftNextRng = gen2.nextRngState;
        this.openHotseatHandoff({
          targetSide: 'ENEMY',
          eyebrow: 'YÜZ YÜZE 2P · EL ARASI DRAFT',
          title: 'Cihazı 2. Oyuncu (Kırmızı)\'ya Ver',
          detail: '1. Oyuncu kartını seçti. Şimdi 2. Oyuncu güçlendirme kartını seçecek.',
          buttonLabel: 'Sıradaki: 2. Oyuncu Draft →',
          onConfirm: () => {
            this.mainContainerEl.innerHTML = '';
            this.renderSkirmishDraftScreen();
          },
        });
        return;
      }

      // Both players finished drafting -> advance to next round deploy (Player 1 first)
      this.skirmish = advanceToNextSkirmishRound(this.skirmish);
      this.hotseatDeploySide = 'PLAYER';
      this.hotseatPlayerPlacements = {};
      this.openHotseatHandoff({
        targetSide: 'PLAYER',
        eyebrow: `YÜZ YÜZE 2P · EL ${this.skirmish.roundIndex + 1} / 3`,
        title: 'Cihazı 1. Oyuncu (Mavi)\'ya Ver',
        detail: 'Her iki taraf da kartını seçti. Yeni haritada 1. Oyuncu gizli dizilimini yapacak.',
        buttonLabel: 'Sıradaki: 1. Oyuncu Dizilimi →',
        onConfirm: () => {
          this.enterSkirmishDeploy();
          this.persistState();
        },
      });
      return;
    }

    const playerApplied = applySkirmishDraftPick(baseRun, 'PLAYER', card, targetUnitId);
    if (playerApplied.error !== undefined) {
      this.sfx.play('uiInvalid');
      return;
    }

    const aiDraft = chooseAndApplyAiSkirmishDraft(playerApplied.nextRun);
    this.skirmish = advanceToNextSkirmishRound(aiDraft.nextRun);
    this.pendingDraftNextRng = 0;
    this.skirmishLastAiNote = `Rakip AI el arası ${
      aiDraft.pool === 'RARE' ? 'Nadir/Epik' : 'Standart'
    } havuzdan ordusunu güçlendirdi!`;
    this.sfx.play('promote');
    this.enterSkirmishDeploy();
    this.persistState();
  }

  private renderSkirmishSummaryScreen(): void {
    const run = this.skirmish;
    const is2p = run?.isLocal2P === true;
    const winner = this.skirmishMatchWinner;
    const isDraw = winner === 'DRAW' || winner === null;

    const wrap = document.createElement('section');
    wrap.className = 'tfc-screen-center';

    const hero = document.createElement('div');
    hero.className = 'tfc-hero';
    if (is2p) {
      hero.innerHTML =
        winner === 'PLAYER'
          ? '<h2 style="color:#38bdf8;">1. OYUNCU (MAVİ) ZAFERİ · BEST OF 3!</h2>' +
            '<p>Aynı cihazda 2 oyunculu seriyi 1. Oyuncu kazandı. Aşağıdan hemen rövanşa başlayabilirsiniz!</p>'
          : winner === 'ENEMY'
            ? '<h2 style="color:#f87171;">2. OYUNCU (KIRMIZI) ZAFERİ · BEST OF 3!</h2>' +
              '<p>Aynı cihazda 2 oyunculu seriyi 2. Oyuncu kazandı. Aşağıdan hemen rövanşa başlayabilirsiniz!</p>'
            : '<h2 style="color:#fbbf24;">DÜELLO BERABERE</h2>' +
              '<p>Üç el sonunda iki oyuncu da eşit kaldı!</p>';
    } else {
      hero.innerHTML =
        winner === 'PLAYER'
          ? '<h2 style="color:#34d399;">DÜELLO ZAFERİ · BEST OF 3 KAZANILDI!</h2>' +
            '<p>Asimetrik ordun ve el arası draft tercihlerinle Düello AI\'yı alt ettin!</p>'
          : !isDraw
            ? '<h2 style="color:#f87171;">DÜELLO YENİLGİSİ</h2>' +
              '<p>Rakip AI seriyi önde bitirdi. Farklı ordu bütçesiyle rövanş alabilirsin!</p>'
            : '<h2 style="color:#fbbf24;">DÜELLO BERABERE</h2>' +
              '<p>Üç el sonunda taraflar eşit kaldı!</p>';
    }

    const summary = document.createElement('div');
    summary.className = 'tfc-summary-box';

    if (run !== null) {
      const scoreRow = document.createElement('div');
      scoreRow.className = 'tfc-field-row';
      scoreRow.innerHTML = is2p
        ? `<span>Final Skor: <strong>1. Oyuncu ${run.playerWins} — ${run.enemyWins} 2. Oyuncu</strong></span>` +
          `<span>Seed: <strong class="tfc-hash-code">${run.seed}</strong></span>`
        : `<span>Final Skor: <strong>Oyuncu ${run.playerWins} — ${run.enemyWins} Düşman</strong></span>` +
          `<span>Seed: <strong class="tfc-hash-code">${run.seed}</strong></span>`;

      const secondRow = document.createElement('div');
      secondRow.className = 'tfc-field-row';
      secondRow.innerHTML = is2p
        ? `<span>1. Oyuncu Fraksiyon: <strong>${FACTION_DEFINITIONS[run.playerFaction].name}</strong></span>` +
          `<span>2. Oyuncu Fraksiyon: <strong>${FACTION_DEFINITIONS[run.enemyFaction].name}</strong></span>`
        : `<span>Rakibin Gizli Şablonu: <strong style="color:#fca5a5;">${run.aiTemplateName ?? 'Asimetrik Ordu'}</strong></span>` +
          `<span>Rakip Fraksiyon: <strong>${FACTION_DEFINITIONS[run.enemyFaction].name}</strong></span>`;

      const pTitle = document.createElement('div');
      pTitle.className = 'tfc-card-title';
      pTitle.textContent = is2p
        ? `1. Oyuncu Son Ordusu (${run.playerRoster.length} Birim)`
        : `Senin Son Ordun (${FACTION_DEFINITIONS[run.playerFaction].name})`;
      const pPills = document.createElement('div');
      pPills.className = 'tfc-unit-pills';
      for (let i = 0; i < run.playerRoster.length; i++) {
        const pill = document.createElement('span');
        pill.className = 'tfc-unit-pill';
        pill.textContent = formatRosterUnitLabel(run.playerRoster[i]!);
        pPills.appendChild(pill);
      }

      const eTitle = document.createElement('div');
      eTitle.className = 'tfc-card-title';
      eTitle.textContent = is2p
        ? `2. Oyuncu Son Ordusu (${run.enemyRoster.length} Birim)`
        : `Rakibin Son Ordusu (${run.enemyRoster.length} Birim)`;
      const ePills = document.createElement('div');
      ePills.className = 'tfc-unit-pills';
      for (let i = 0; i < run.enemyRoster.length; i++) {
        const pill = document.createElement('span');
        pill.className = 'tfc-unit-pill';
        pill.textContent = formatRosterUnitLabel(run.enemyRoster[i]!);
        ePills.appendChild(pill);
      }

      summary.append(scoreRow, secondRow, pTitle, pPills, eTitle, ePills);
    }

    const actions = document.createElement('div');
    actions.className = 'tfc-btn-group';
    actions.append(
      this.createButton(
        is2p ? 'Rövanş (Aynı Cihazda 2P)' : 'Yeni Düello Başlat',
        () => (is2p ? this.startNewLocal2P() : this.startNewSkirmish()),
        'is-primary',
      ),
      this.createButton('Ana Menüye Dön', () => this.setScreen('MAIN_MENU')),
    );

    wrap.append(hero, summary, actions);
    this.mainContainerEl.appendChild(wrap);
  }

  private createButton(label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = extraClass ? `tfc-btn ${extraClass}` : 'tfc-btn';
    btn.textContent = label;
    btn.addEventListener('pointerenter', () => {
      if (!btn.disabled) this.sfx.play('menuHover');
    });
    btn.addEventListener('click', () => {
      this.sfx.unlock();
      this.sfx.play('menuClick');
      onClick();
    });
    return btn;
  }

  private createFactionRow(
    labelText: string,
    onChange: (fac: FactionPassive) => void,
  ): { row: HTMLDivElement; select: HTMLSelectElement } {
    const row = document.createElement('div');
    row.className = 'tfc-field-row';
    const label = document.createElement('label');
    label.textContent = labelText;
    const select = document.createElement('select');
    select.className = 'tfc-select';
    for (let i = 0; i < ALL_FACTIONS.length; i++) {
      const fac = ALL_FACTIONS[i]!;
      const opt = document.createElement('option');
      opt.value = fac;
      opt.textContent = formatFactionOption(fac);
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      onChange(select.value as FactionPassive);
    });
    row.append(label, select);
    return { row, select };
  }

  private syncCanvasSize(): void {
    if (this.renderer === null || this.canvasWrapEl === null) return;
    const rect = this.canvasWrapEl.getBoundingClientRect();
    const cssW = Math.max(240, rect.width || (typeof window !== 'undefined' ? window.innerWidth : 640));
    const cssH = Math.max(
      240,
      rect.height ||
        (typeof window !== 'undefined'
          ? window.innerHeight
          : Math.round((cssW * this.state.height) / this.state.width)),
    );
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const compact = cssH < 640 || cssW < 720;
    this.renderer.resize(cssW, cssH, dpr, {
      top: compact ? 42 : 36,
      bottom: compact ? 46 : 40,
      left: 6,
      right: 6,
    });
    const pxUnit = Math.max(2, Math.min(4, Math.round(this.renderer.getLayout().tileSize / 32)));
    this.root.style.setProperty('--px', `${pxUnit}px`);
  }

  private startLoop(): void {
    this.lastFrameMs = performance.now();
    const tick = (nowMs: number): void => {
      const dtMs = Math.max(0, Math.min(100, nowMs - this.lastFrameMs));
      this.lastFrameMs = nowMs;
      this.fxQueue.update(dtMs);
      this.speechOverlay.update(dtMs);

      if (this.renderer !== null) {
        const visible = this.getCurrentVisibleState();
        this.renderer.render(visible, {
          selectedCoord: this.selectedCoord,
          inspectedCoord: this.inspectedCoord,
          hoveredCoord: this.hoveredCoord,
          legalMoves: this.legalMoves,
          legalAbilities: this.legalAbilities,
          activeAbility: this.activeAbility,
          intentArrows: this.cachedIntentArrows,
          showIntentArrows: this.settings.showIntentArrows,
          lastVisibleMove: this.lastVisibleMove,
          threatCoords: this.cachedThreatCoords,
          showThreatOverlay: this.showThreatOverlay,
          flipBoard: this.shouldFlipBoard(),
          fx: this.fxQueue.getSnapshot(),
          timeMs: nowMs,
          theme: this.getActiveRenderTheme(),
          stressScore: this.currentStressScore,
          showLethalWarnings: this.uiPrefs.showLethalWarnings,
          calmScreen: this.calmScreen,
          postRenderOverlay: (ctx, layout, state, tMs, flip) =>
            this.speechOverlay.render(ctx, layout, state, tMs, flip, this.calmScreen),
        });
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private onTileHover(coord: Coord | null): void {
    this.hoveredCoord = coord;
    if (this.inspectedCoord === null && this.isBoardScreen()) {
      this.refreshInspector();
    }

    if (coord !== null && this.selectedCoord !== null && this.activeAbility === null) {
      const move = this.legalMoves.find((m) => coordEquals(m.to, coord));
      if (move !== undefined && move.isHazardous) {
        this.setStatus(
          move.resolution.fellInPit
            ? 'TEHLİKE: Bu hamle taşını buzdan kaydırıp ÇUKURA düşürecek!'
            : 'TEHLİKE: Bu hamle taşını YANAN KARE üzerinde bitirecek!',
          'warn',
        );
      } else if (move !== undefined && move.resolution.slid) {
        const dest = move.resolution.finalPos;
        this.setStatus(
          dest !== null
            ? `Buz kayması önizlemesi → ${formatCoord(dest, this.state.height)}`
            : 'Buz kayması önizlemesi',
          'normal',
        );
      }
    }
  }

  private onTileTap(coord: Coord): void {
    if (this.fxQueue.hasActiveSteps()) {
      // 2.6 Kural 2: Son 100 ms içindeki tıklama tamponlanır, animasyon bitince anında işlenir
      if (this.fxQueue.isInInputBufferWindow()) {
        const queuedCoord = { x: coord.x, y: coord.y };
        this.fxQueue.bufferInput(() => this.onTileTap(queuedCoord));
        return;
      }
      this.fxQueue.skipAll();
    }

    this.inspectedCoord = { x: coord.x, y: coord.y };

    if (this.state.winner !== null) {
      this.refreshInspector();
      return;
    }

    if (this.isEnemyAiControlled() && this.state.turn === 'ENEMY') {
      this.refreshInspector();
      return;
    }

    if (this.isHotseatWaitingNext()) {
      this.setStatus(
        `Hamleni tamamladın! Cihazı ${this.getHotseatSideLabel(this.state.turn)}'ya verip "Sıradaki" tuşuna bas.`,
        'warn',
      );
      this.refreshInspector();
      return;
    }

    const visible = this.getCurrentVisibleState();
    const clickedPiece = getPieceAt(visible.pieces, coord);

    if (this.selectedCoord !== null) {
      const selectedPiece = getPieceAt(visible.pieces, this.selectedCoord);

      if (selectedPiece !== undefined) {
        if (this.activeAbility !== null) {
          const abilityMatch = this.legalAbilities.find(
            (a) => a.ability === this.activeAbility && coordEquals(a.target, coord),
          );
          if (abilityMatch !== undefined) {
            this.dispatchAction({
              type: 'USE_ABILITY',
              pieceId: selectedPiece.id,
              ability: abilityMatch.ability,
              target: abilityMatch.target,
            });
            return;
          }
        } else {
          const moveMatch = this.legalMoves.find((m) => coordEquals(m.to, coord));
          if (moveMatch !== undefined) {
            this.dispatchAction({
              type: 'MOVE',
              pieceId: selectedPiece.id,
              to: moveMatch.to,
            });
            return;
          }

          const directAbility = this.legalAbilities.find((a) => coordEquals(a.target, coord));
          if (directAbility !== undefined) {
            this.dispatchAction({
              type: 'USE_ABILITY',
              pieceId: selectedPiece.id,
              ability: directAbility.ability,
              target: directAbility.target,
            });
            return;
          }
        }

        if (coordEquals(this.selectedCoord, coord)) {
          this.clearSelection(false);
          this.refreshInspector();
          return;
        }
      }
    }

    if (
      clickedPiece !== undefined &&
      clickedPiece.side === this.state.turn &&
      clickedPiece.side === this.getLocalControlledSide()
    ) {
      if (this.state.bonusMovePieceId !== null && clickedPiece.id !== this.state.bonusMovePieceId) {
        this.sfx.play('uiInvalid');
        this.setStatus(
          'Pusu ekstra hamlesi aktif! Yalnızca parlak taş hareket edebilir veya Space ile turu bitirebilirsin.',
          'warn',
        );
        this.refreshUi();
        return;
      }

      if (clickedPiece.frozenTurns > 0) {
        this.sfx.play('uiInvalid');
        this.setStatus(
          `${PIECE_NAMES[clickedPiece.type]} ${clickedPiece.frozenTurns} tur donmuş; hareket edemez.`,
          'warn',
        );
        this.selectedCoord = null;
        this.activeAbility = null;
        this.legalMoves = [];
        this.legalAbilities = [];
        this.refreshUi();
        return;
      }

      this.selectedCoord = { x: coord.x, y: coord.y };
      this.activeAbility = null;
      this.recomputeSelectionTargets(visible, clickedPiece);
      this.sfx.play('uiSelect');
      this.setStatus(
        `${PIECE_NAMES[clickedPiece.type]} seçildi (${this.legalMoves.length} hamle, ${this.legalAbilities.length} yetenek).`,
        'normal',
      );
      this.refreshUi();
      return;
    }

    this.selectedCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];

    if (clickedPiece !== undefined && clickedPiece.side !== this.state.turn) {
      this.setStatus(
        `${PIECE_NAMES[clickedPiece.type]} inceleniyor. Sıra ${this.state.turn === 'PLAYER' ? 'OYUNCU' : 'DÜŞMAN'} tarafında.`,
        'normal',
      );
    }

    this.refreshUi();
  }

  private recomputeSelectionTargets(visible: VisibleState, piece: Piece): void {
    this.legalMoves = getLegalMoves(visible, piece, visible.bonusMovePieceId);
    this.legalAbilities = getLegalAbilities(visible, piece, visible.bonusMovePieceId);
  }

  private dispatchAction(action: GameAction, fromAi = false): void {
    if (this.state.winner !== null) return;
    if (this.isHotseatWaitingNext()) return;
    if (!fromAi && this.isEnemyAiControlled() && this.state.turn === 'ENEMY') return;

    this.cancelAiTimer();
    const prevSnapshot = cloneStateSnapshot(this.state);
    const prevMemory = JSON.parse(JSON.stringify(this.aiMemory)) as AiMemory;
    const prevView = this.getCurrentVisibleState();
    const result = stepGame(this.state, action);

    if (result.error !== undefined) {
      this.sfx.play('uiInvalid');
      this.setStatus(`Geçersiz aksiyon: ${result.error}`, 'error');
      return;
    }

    if (this.screen === 'SANDBOX') {
      this.undoStack.push({ state: prevSnapshot, aiMemory: prevMemory });
    }

    this.state = result.nextState;
    if (this.campaign !== null && this.activeBattleKind === 'CAMPAIGN') {
      this.campaign.currentBattle = this.state;
      this.persistState();
    } else if (
      this.skirmish !== null &&
      (this.activeBattleKind === 'SKIRMISH' || this.activeBattleKind === 'LOCAL_2P')
    ) {
      this.skirmish.currentBattle = this.state;
      this.persistState();
    }

    this.aiMemory = updateAiMemory(this.aiMemory, getVisibleState(this.state, 'ENEMY'), 'ENEMY');

    const nextView = this.getCurrentVisibleState();
    const uiEvents: GameEvent[] = result.events.slice();

    // Detect PANIC hallucinations dispelled when revealed empty in fog
    const prevHallucinations = prevView.hallucinationSilhouettes ?? [];
    for (let i = 0; i < prevHallucinations.length; i++) {
      const hPos = prevHallucinations[i]!;
      if (
        nextView.fog[hPos.y]?.[hPos.x] === 'VISIBLE' &&
        getPieceAt(nextView.pieces, hPos) === undefined
      ) {
        uiEvents.push({ type: 'HALLUCINATION_DISPELLED', at: { x: hPos.x, y: hPos.y } });
      }
    }

    this.fxQueue.enqueue(uiEvents, prevView.pieces, prevView, nextView);
    this.updateLastVisibleMoveFromEvents(uiEvents, prevView, nextView);

    const captureCount = uiEvents.filter(
      (e) =>
        (e.type === 'PIECE_CAPTURED' && e.side === 'ENEMY') ||
        e.type === 'PIECE_FELL_IN_PIT' ||
        e.type === 'PIECE_SUFFOCATED' ||
        e.type === 'PIECE_INCINERATED' ||
        e.type === 'PIECE_SKEWERED',
    ).length;
    if (captureCount > 0) {
      this.uiPrefs.stats.totalCaptures += captureCount;
      saveUiPrefs(this.uiPrefs);
    }

    // Eski açık taş balonu yeterince okunduysa arşive akıt (taze balonu hemen ezme)
    this.speechOverlay.archiveActiveBark(false);
    const narrativePieceMap = buildNarrativePieceMap(prevView.pieces, nextView.pieces);
    const terminalEntry = pickTerminalEntry(uiEvents, {
      seed: this.state.rngState,
      turnNumber: this.state.turnNumber,
      tone: this.getNarrativeTone(),
      piecesById: narrativePieceMap,
    });

    for (let i = 0; i < uiEvents.length; i++) {
      const ev = uiEvents[i]!;
      if (isEventVisibleToViewer(ev, prevView, nextView)) {
        const desc = describeEvent(ev, this.state.height, narrativePieceMap);
        this.pushLog(desc);
        this.emitHudNotificationForEvent(ev, desc);
      }
    }
    if (terminalEntry !== null) {
      this.pushLog(`[${terminalEntry.speaker}] "${terminalEntry.text}"`);
      this.speechOverlay.setTone(this.getNarrativeTone());
      const anchor = terminalEntry.coord ?? { x: Math.floor(this.state.width / 2), y: Math.floor(this.state.height / 2) };
      if (terminalEntry.layer === 'CRT_BAND') {
        this.speechOverlay.showCrtBand({
          speaker: terminalEntry.speaker,
          text: terminalEntry.richText ?? terminalEntry.text,
          mode: 'crimson',
        });
        this.showDockSubtitle(terminalEntry.speaker, terminalEntry.text, 'crt');
      } else if (terminalEntry.layer === 'LAST_WORDS') {
        this.speechOverlay.showLastWords(terminalEntry, anchor);
        this.showDockSubtitle(terminalEntry.speaker, terminalEntry.text, 'lastWords');
      } else {
        this.speechOverlay.showBark(terminalEntry, anchor);
        this.showDockSubtitle(terminalEntry.speaker, terminalEntry.text, 'bark');
      }
    }

    // Boss LIVE PATCH CRT Müdahale Bandı (cooldown 1 -> 3 döndüğünde)
    if (
      this.screen === 'BOSS_BATTLE' &&
      prevSnapshot.bossCooldown === 1 &&
      this.state.bossCooldown === 3
    ) {
      const actNum = this.campaign?.act ?? 2;
      const patchPool: readonly LivePatchId[] =
        actNum === 2
          ? ['PATCH_204_MIASMA']
          : ['PATCH_01_PANIC', 'PATCH_02_CRACKED', 'PATCH_03_RESET'];
      const patchId = patchPool[this.state.turnNumber % patchPool.length]!;
      const patchQuote = getLivePatchQuote(patchId, this.getNarrativeTone(), this.state.turnNumber);
      this.pushLog(`[BÜYÜKUSTA-OS] ${patchQuote}`);
      this.speechOverlay.showCrtBand({
        speaker: 'BÜYÜKUSTA-OS // LIVE_PATCH',
        text: patchQuote,
        mode: 'crimson',
        quoteSource: { kind: 'LIVE_PATCH', patchId, turnNumber: this.state.turnNumber },
      });
    }

    const disobEvent = uiEvents.find((e) => e.type === 'PIECE_DISOBEYED');
    if (disobEvent !== undefined && disobEvent.type === 'PIECE_DISOBEYED') {
      const baseMsg =
        terminalEntry !== null
          ? `${terminalEntry.speaker}: "${terminalEntry.text}"`
          : `İTAATSİZLİK: "${disobEvent.quote}"`;
      this.setStatus(
        this.isHotseatWaitingNext()
          ? `${baseMsg} · Cihazı ${this.getHotseatSideLabel(this.state.turn)}'ya verip "Sıradaki" tuşuna bas.`
          : baseMsg,
        'warn',
      );
      this.refreshUi();
      return;
    }

    if (
      this.state.bonusMovePieceId !== null &&
      this.state.winner === null &&
      (this.state.turn === 'PLAYER' || !this.isEnemyAiControlled())
    ) {
      const dashPiece = nextView.pieces.find((p) => p.id === this.state.bonusMovePieceId);
      if (dashPiece !== undefined) {
        this.selectedCoord = { x: dashPiece.pos.x, y: dashPiece.pos.y };
        this.inspectedCoord = { x: dashPiece.pos.x, y: dashPiece.pos.y };
        this.activeAbility = null;
        this.recomputeSelectionTargets(nextView, dashPiece);
        this.setStatus(
          'PUSU TETİKLENDİ! Aynı taşla 1 ekstra hamle yapabilir veya Space ile turu bitirebilirsin.',
          'warn',
        );
        this.refreshUi();
        return;
      }
    }

    this.selectedCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];

    if (this.state.winner !== null) {
      if (this.activeBattleKind === 'LOCAL_2P') {
        const winMsg =
          this.state.winner === 'PLAYER'
            ? 'EL ZAFERİ! 1. Oyuncu (Mavi) rakip Şahı devirdi!'
            : this.state.winner === 'ENEMY'
              ? 'EL ZAFERİ! 2. Oyuncu (Kırmızı) rakip Şahı devirdi!'
              : 'EL BERABERE! İki Şah aynı anda düştü.';
        this.setStatus(winMsg, 'warn');
      } else {
        const matchEndEv = result.events.find((e) => e.type === 'MATCH_ENDED');
        const tone = this.getNarrativeTone();
        if (this.state.winner === 'PLAYER') {
          const isSecretCore = this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id;
          const vicQuote = getVictoryQuote(isSecretCore, tone, this.state.rngState);
          this.setStatus(`ZAFER! ${vicQuote}`, 'warn');
          this.speechOverlay.showCrtBand({
            speaker: 'BÜYÜKUSTA-OS',
            text: vicQuote,
            mode: isSecretCore ? 'crimson' : 'green',
            quoteSource: { kind: 'VICTORY', isSecretCore, seed: this.state.rngState },
          });
        } else if (this.state.winner === 'ENEMY') {
          const defeatReason = mapMatchEndToDefeatReason(
            matchEndEv?.type === 'MATCH_ENDED' ? matchEndEv.reason : undefined,
          );
          const banner = getDefeatBanner(defeatReason, tone, this.state.rngState, this.state.turnNumber);
          this.setStatus(`YENİLGİ — ${banner}`, 'error');
          this.speechOverlay.showCrtBand({
            speaker: 'BÜYÜKUSTA-OS // TERMINATED',
            text: banner,
            mode: 'crimson',
            quoteSource: { kind: 'DEFEAT', reason: defeatReason, seed: this.state.rngState, turnNumber: this.state.turnNumber },
          });
        } else {
          this.setStatus('BERABERE! İki Şah aynı anda düştü.', 'warn');
        }
      }
    } else if (this.isHotseatWaitingNext()) {
      this.setStatus(
        `Hamle tamamlandı! Cihazı ${this.getHotseatSideLabel(this.state.turn)}'ya ver → "Sıradaki" tuşuna bas.`,
        'warn',
      );
    } else {
      const sideLabel =
        this.activeBattleKind === 'LOCAL_2P'
          ? this.getHotseatSideLabel(this.state.turn)
          : this.state.turn === 'PLAYER'
            ? 'OYUNCU'
            : 'DÜŞMAN';
      this.setStatus(`Sıra ${sideLabel} tarafında (Tur #${this.state.turnNumber}).`, 'normal');
    }

    this.refreshUi();
    this.scheduleAiTurnIfNeeded(captureCount > 0);
  }

  private proceedAfterCampaignBattle(): void {
    if (this.campaign === null) return;
    const resolved = resolveCampaignBattleOutcome(this.campaign, this.state);
    this.campaign = resolved.nextRun;
    this.lastBattleNewlyLost = resolved.newlyLost;

    // Meta istatistikler & Perde 4 Kök Erişim / Günlük Tohum kilidi
    this.uiPrefs.stats.bestRooms = Math.max(
      this.uiPrefs.stats.bestRooms,
      resolved.nextRun.roomIndex + 1,
    );
    this.uiPrefs.stats.peakStress = Math.max(this.uiPrefs.stats.peakStress, this.currentStressScore);
    if (this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id && this.state.winner === 'PLAYER') {
      this.uiPrefs.act4Cleared = true;
      this.uiPrefs.crtThemeUnlocked = true;
    }
    if (resolved.status === 'RUN_VICTORY' && resolved.nextRun.seed === getDailySeed()) {
      this.uiPrefs.dailyCompleted = { date: getDailySeed(), turns: this.state.turnNumber };
    }
    saveUiPrefs(this.uiPrefs);

    if (resolved.status === 'RUN_VICTORY' || resolved.status === 'RUN_DEFEAT') {
      this.setScreen(resolved.status === 'RUN_VICTORY' ? 'RUN_VICTORY' : 'RUN_DEFEAT');
      // Clear finished run from auto-save while keeping settings intact
      saveAppState({
        saveVersion: SAVE_VERSION,
        screen: 'MAIN_MENU',
        settings: { ...this.settings },
        campaign: null,
        skirmish: this.skirmish,
      });
      return;
    }

    const gen = generateCampaignRewards(this.campaign);
    this.pendingRewards = gen.cards;
    this.pendingRewardsNextRng = gen.nextRngState;
    this.selectedRewardCardId = null;
    this.setScreen('CAMPAIGN_REWARD');
    this.persistState();
  }

  private cancelAiTimer(): void {
    this.aiRunEpoch++;
    this.aiRunner.cancelPending();
    if (this.aiTimerId !== null) {
      window.clearTimeout(this.aiTimerId);
      this.aiTimerId = null;
    }
  }

  private scheduleAiTurnIfNeeded(hadDeath = false): void {
    this.cancelAiTimer();
    if (!this.isEnemyAiControlled()) return;
    if (this.state.winner !== null || this.state.turn !== 'ENEMY') return;

    const fxRemainingMs = this.fxQueue.getRemainingDurationMs();
    const basePauseMs = this.settings.animationSpeed === 2 ? 320 : 650;
    const deathBreathMs = hadDeath ? (this.settings.animationSpeed === 2 ? 240 : 520) : 0;
    const delayMs = Math.round(Math.min(2200, fxRemainingMs + basePauseMs + deathBreathMs));
    this.aiTimerId = window.setTimeout(() => {
      this.aiTimerId = null;
      this.runAiTurn();
    }, delayMs);
  }

  private runAiTurn(): void {
    if (!this.isEnemyAiControlled() || this.state.winner !== null || this.state.turn !== 'ENEMY') {
      return;
    }

    // Strict Rule 5: AI ONLY consumes getVisibleState(state, 'ENEMY')
    const enemyVisible = getVisibleState(this.state, 'ENEMY');
    const useSucsBot =
      this.activeBattleKind === 'SKIRMISH' ||
      (this.screen === 'SANDBOX' && this.enemyControl === 'SKIRMISH_AI') ||
      (this.activeBattleKind === 'CAMPAIGN' &&
        this.screen === 'BOSS_BATTLE' &&
        this.aiDifficulty === 'PANIC');

    if (!useSucsBot) {
      const decision = chooseCampaignAction(
        enemyVisible,
        this.aiMemory,
        this.state.rngState,
        'ENEMY',
      );
      this.aiMemory = decision.memory;
      this.dispatchAction(decision.action, true);
      return;
    }

    const epoch = ++this.aiRunEpoch;
    const prof = AI_DIFFICULTY_PROFILES[this.aiDifficulty];
    const rngSnap = this.state.rngState;
    const memSnap = this.aiMemory;
    this.setStatus(`${prof.name} (${prof.badge}) düşünüyor...`, 'normal');

    void this.aiRunner
      .run(enemyVisible, memSnap, this.aiDifficulty, rngSnap, 'ENEMY')
      .then((decision) => {
        if (epoch !== this.aiRunEpoch) return;
        if (!this.isEnemyAiControlled() || this.state.winner !== null || this.state.turn !== 'ENEMY') {
          return;
        }
        this.aiMemory = decision.memory;
        const tagNote = decision.tacticalTag !== undefined ? ` — ${decision.tacticalTag}` : '';
        this.pushLog(
          `${prof.name} [D${decision.completedDepth} · ${decision.nodesSearched} düğüm · ${Math.round(decision.elapsedMs)}ms]${tagNote}`,
        );
        this.dispatchAction(decision.action, true);
      });
  }

  private undoLastAction(): void {
    if (this.screen !== 'SANDBOX') return;
    this.cancelAiTimer();
    const prev = this.undoStack.pop();
    if (prev === undefined) {
      this.sfx.play('uiInvalid');
      this.setStatus('Geri alınacak hamle yok.', 'normal');
      return;
    }

    this.fxQueue.skipAll();
    this.state = prev.state;
    this.aiMemory = prev.aiMemory;
    this.lastVisibleMove = null;
    this.selectedCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];
    this.sfx.play('uiSelect');
    this.pushLog(`Geri alındı → Tur #${this.state.turnNumber}`);
    this.setStatus('Son aksiyon geri alındı.', 'normal');
    this.refreshUi();
  }

  private resetPreset(): void {
    this.cancelAiTimer();
    this.fxQueue.skipAll();
    const preset = getSandboxPreset(this.presetId);
    this.state = preset.build();
    this.undoStack = [];
    this.aiMemory = createAiMemory();
    this.lastVisibleMove = null;
    this.selectedCoord = null;
    this.inspectedCoord = null;
    this.hoveredCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];
    this.eventLog = [];
    this.pushLog(`Senaryo yüklendi: ${preset.name}`);
    this.setStatus('Senaryo sıfırlandı. Bir taş seçerek başla.', 'normal');
    this.syncCanvasSize();
    this.refreshUi();
  }

  private setPerspectiveMode(mode: PerspectiveMode): void {
    this.perspectiveMode = mode;
    this.clearSelection(false);
    this.sfx.play('uiSelect');
    this.refreshUi();
  }

  private setFactionPassive(side: Side, passive: FactionPassive): void {
    if (this.state.factions[side] === passive) return;
    this.cancelAiTimer();
    this.undoStack.push({
      state: cloneStateSnapshot(this.state),
      aiMemory: JSON.parse(JSON.stringify(this.aiMemory)) as AiMemory,
    });
    this.state = {
      ...cloneStateSnapshot(this.state),
      factions: {
        ...this.state.factions,
        [side]: passive,
      },
    };
    this.clearSelection(false);
    this.pushLog(
      `${side === 'PLAYER' ? 'Oyuncu' : 'Düşman'} fraksiyonu → ${formatFactionOption(passive)}`,
    );
    this.refreshUi();
  }

  private toggleMute(): void {
    this.settings.soundEnabled = !this.settings.soundEnabled;
    this.sfx.setMuted(!this.settings.soundEnabled);
    this.mainMenuHandle?.setMutedLabel(!this.settings.soundEnabled);
    this.persistState();
    this.refreshTopBar();
  }

  private toggleAnimationSpeed(): void {
    this.settings.animationSpeed = this.settings.animationSpeed === 1 ? 2 : 1;
    this.fxQueue.setSpeed(this.settings.animationSpeed);
    this.sfx.play('uiSelect');
    this.persistState();
    this.refreshTopBar();
  }

  private toggleIntentArrows(): void {
    this.settings.showIntentArrows = !this.settings.showIntentArrows;
    this.sfx.play('uiSelect');
    this.recomputeIntentArrows();
    this.persistState();
    this.refreshTopBar();
  }

  private toggleThreatOverlay(): void {
    this.showThreatOverlay = !this.showThreatOverlay;
    this.sfx.play('uiSelect');
    this.recomputeThreatCoords();
    this.refreshTopBar();
  }

  private cycleSelectablePiece(): void {
    if (this.state.winner !== null) return;
    if (this.isEnemyAiControlled() && this.state.turn === 'ENEMY') return;
    if (this.isHotseatWaitingNext()) return;

    const visible = this.getCurrentVisibleState();
    const mySide = this.getLocalControlledSide();
    const candidates = visible.pieces.filter((p) => {
      if (p.side !== mySide || p.side !== this.state.turn) return false;
      if (p.frozenTurns > 0) return false;
      if (this.state.bonusMovePieceId !== null && p.id !== this.state.bonusMovePieceId) {
        return false;
      }
      return (
        getLegalMoves(visible, p, visible.bonusMovePieceId).length > 0 ||
        getLegalAbilities(visible, p, visible.bonusMovePieceId).length > 0
      );
    });
    if (candidates.length === 0) return;

    let nextIdx = 0;
    if (this.selectedCoord !== null) {
      const curIdx = candidates.findIndex((p) => coordEquals(p.pos, this.selectedCoord!));
      if (curIdx >= 0) {
        nextIdx = (curIdx + 1) % candidates.length;
      }
    }
    const picked = candidates[nextIdx]!;
    this.selectedCoord = { x: picked.pos.x, y: picked.pos.y };
    this.inspectedCoord = { x: picked.pos.x, y: picked.pos.y };
    this.activeAbility = null;
    this.recomputeSelectionTargets(visible, picked);
    this.sfx.play('uiSelect');
    this.setStatus(
      `${PIECE_NAMES[picked.type]} seçildi (${this.legalMoves.length} hamle, ${this.legalAbilities.length} yetenek).`,
      'normal',
    );
    this.refreshUi();
  }

  private updateLastVisibleMoveFromEvents(
    events: readonly GameEvent[],
    prevView: VisibleState,
    nextView: VisibleState,
  ): void {
    let moveFrom: Coord | null = null;
    let moveTo: Coord | null = null;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === 'PIECE_MOVED' && isEventVisibleToViewer(ev, prevView, nextView)) {
        moveFrom = { x: ev.from.x, y: ev.from.y };
        moveTo = { x: ev.to.x, y: ev.to.y };
      } else if (ev.type === 'PIECE_SLID' && moveFrom !== null && isEventVisibleToViewer(ev, prevView, nextView)) {
        moveTo = { x: ev.to.x, y: ev.to.y };
      }
    }
    if (moveFrom !== null && moveTo !== null) {
      this.lastVisibleMove = { from: moveFrom, to: moveTo };
    }
  }

  private recomputeThreatCoords(): void {
    if (!this.isBoardScreen() || !this.showThreatOverlay || this.state.winner !== null) {
      this.cachedThreatCoords = [];
      return;
    }
    const visible = this.getCurrentVisibleState();
    const mySide = this.getLocalControlledSide();
    const oppSide: Side = mySide === 'PLAYER' ? 'ENEMY' : 'PLAYER';
    const coords: Coord[] = [];

    for (let i = 0; i < visible.pieces.length; i++) {
      const p = visible.pieces[i]!;
      if (p.side !== oppSide || p.frozenTurns > 0) continue;
      if (visible.mode === 'CAMPAIGN' && p.aggro === 'SLEEPING') continue;
      const moves = getLegalMoves(visible, p, null);
      for (let m = 0; m < moves.length; m++) {
        const res = moves[m]!.resolution;
        const target = res.hitPos ?? res.finalPos;
        if (target !== null) {
          coords.push(target);
        }
      }
    }
    this.cachedThreatCoords = coords;
  }

  private clearSelection(announce = true): void {
    this.selectedCoord = null;
    this.activeAbility = null;
    this.legalMoves = [];
    this.legalAbilities = [];
    if (announce) {
      this.setStatus('Seçim iptal edildi.', 'normal');
    }
    this.refreshAbilityBar();
  }

  private emitHudNotificationForEvent(ev: GameEvent, desc: string): void {
    if (this.hudNotify === null) return;
    switch (ev.type) {
      case 'TURN_CHANGED': {
        if (this.activeBattleKind === 'LOCAL_2P') {
          this.hudNotify.showBanner({
            eyebrow: `TUR #${ev.turnNumber}`,
            title: `SIRADAKİ: ${this.getHotseatSideLabel(ev.nextTurn).toUpperCase()}`,
            subtitle: 'Cihazı devredip "Sıradaki" tuşuna bas',
            tone: 'warn',
            durationMs: 1700,
          });
        } else {
          const isPlayer = ev.nextTurn === 'PLAYER';
          this.hudNotify.showBanner({
            eyebrow: `TUR #${ev.turnNumber}`,
            title: isPlayer ? 'OYUNCU SIRASI' : 'DÜŞMAN HAMLESİ',
            tone: isPlayer ? 'player' : 'enemy',
            durationMs: 1150,
          });
        }
        if (this.screen === 'BOSS_BATTLE' && this.state.bossCooldown === 1 && ev.nextTurn === 'PLAYER') {
          this.hudNotify.pushToast({
            title: 'BOSS UYARISI · 1 TUR',
            text: 'Boss Şah bir sonraki turda etrafına buz ve alev halkası saçacak!',
            tone: 'warn',
            icon: 'alert',
            durationMs: 4400,
          });
        }
        return;
      }
      case 'MATCH_ENDED': {
        this.hudNotify.showBanner({
          eyebrow: 'SAVAŞ SONUCU',
          title:
            ev.winner === 'PLAYER'
              ? 'ZAFER!'
              : ev.winner === 'ENEMY'
                ? 'YENİLGİ'
                : 'BERABERE',
          tone: ev.winner === 'PLAYER' ? 'player' : ev.winner === 'ENEMY' ? 'enemy' : 'warn',
          durationMs: 2600,
        });
        return;
      }
      case 'PIECE_CAPTURED':
      case 'PIECE_FELL_IN_PIT':
      case 'PIECE_SUFFOCATED':
      case 'PIECE_INCINERATED':
      case 'PIECE_SKEWERED':
        this.hudNotify.pushToast({
          title: 'KAYIP',
          text: desc,
          tone: 'enemy',
          icon: 'skull',
          durationMs: 4200,
        });
        return;
      case 'PIECE_BURNED':
        if (ev.killed) {
          this.hudNotify.pushToast({
            title: 'ALEV KAYBI',
            text: desc,
            tone: 'enemy',
            icon: 'skull',
            durationMs: 4200,
          });
        }
        return;
      case 'SHIELD_BROKEN':
      case 'WALL_DESTROYED':
      case 'TILE_COLLAPSED':
      case 'GAS_CHAIN_DETONATED':
      case 'ARROW_FIRED':
      case 'PLATE_TRIGGERED':
        this.hudNotify.pushToast({
          title: 'TAKTİK OLAY',
          text: desc,
          tone: 'warn',
          icon: 'alert',
          durationMs: 3800,
        });
        return;
      case 'ENEMY_ALERTED':
      case 'UNIT_SPAWNED':
      case 'PIECE_FROZEN':
      case 'PIECE_BREAKDOWN':
      case 'PIECE_DRIFTED':
      case 'PIECE_DISOBEYED':
      case 'CHIMERA_EVOLVED':
        this.hudNotify.pushToast({
          title: 'SİSTEM UYARISI',
          text: desc,
          tone: 'enemy',
          icon: 'alert',
          durationMs: 4000,
        });
        return;
      case 'PIECE_PROMOTED':
      case 'FAITH_ULTIMATE_TRIGGERED':
      case 'MADNESS_ULTIMATE_TRIGGERED':
      case 'BERSERK_CHAIN_TRIGGERED':
      case 'HALLUCINATION_DISPELLED':
        this.hudNotify.pushToast({
          title: 'ÖZEL TETİKLEME',
          text: desc,
          tone: 'player',
          icon: 'shield',
          durationMs: 4200,
        });
        return;
      default:
        return;
    }
  }

  private setStatus(msg: string, tone: 'normal' | 'warn' | 'error'): void {
    this.statusMessage = msg;
    if (this.isStageScreen() && this.hudNotify !== null && (tone === 'warn' || tone === 'error')) {
      this.hudNotify.pushToast({
        title: tone === 'error' ? 'HATA' : 'UYARI',
        text: msg,
        tone: tone === 'error' ? 'enemy' : 'warn',
        icon: 'alert',
        durationMs: 3600,
      });
    }
    if (this.statusBannerEl !== null) {
      this.statusBannerEl.textContent = msg;
      this.statusBannerEl.className =
        tone === 'warn'
          ? 'tfc-status-banner is-warn'
          : tone === 'error'
            ? 'tfc-status-banner is-error'
            : 'tfc-status-banner';
    }
  }

  private pushLog(entry: string): void {
    this.eventLog.unshift(entry);
    if (this.eventLog.length > 25) {
      this.eventLog.length = 25;
    }
    if (!this.logDrawerOpen) {
      this.unreadLogCount = Math.min(99, this.unreadLogCount + 1);
    }
  }

  private recomputeIntentArrows(): void {
    if (
      !this.isBoardScreen() ||
      !this.settings.showIntentArrows ||
      this.state.winner !== null ||
      this.activeBattleKind === 'SKIRMISH' ||
      this.activeBattleKind === 'LOCAL_2P'
    ) {
      this.cachedIntentArrows = [];
      return;
    }
    const enemyView = getVisibleState(this.state, 'ENEMY');
    const viewerView = this.getCurrentVisibleState();
    const rawIntents = computeCampaignIntents(enemyView, this.aiMemory, 'ENEMY');
    const visibleIntents = filterVisibleIntents(rawIntents, viewerView);
    this.cachedIntentArrows = visibleIntents.map((intent) => ({
      pieceId: intent.pieceId,
      from: intent.from,
      to: intent.to,
      isAttack: intent.isAttack,
    }));
  }

  private refreshUi(): void {
    this.recomputeIntentArrows();
    this.recomputeThreatCoords();
    this.refreshTopBar();
    if (!this.isBoardScreen()) return;
    this.refreshStressMeter();
    this.refreshPostBattleCta();
    this.refreshAbilityBar();
    if (this.screen === 'SANDBOX') {
      this.refreshSandboxPanel();
    } else {
      this.refreshCampaignHud();
    }
    this.refreshInspector();
    this.refreshEventLog();
  }

  private refreshStressMeter(): void {
    if (this.hudStressChipEl === null) return;
    const localSide = this.getLocalControlledSide();
    const visible = getVisibleState(this.state, localSide);
    const bossCd = this.screen === 'BOSS_BATTLE' ? this.state.bossCooldown : 0;
    const metrics = computeStressMetrics(visible, localSide, bossCd);
    this.currentStressScore = metrics.percent;
    this.lastStressReasons = metrics.reasons;

    // Stres seviyesi kritik eşiğe sıçradığında gerçek oyun uyarısı düşür
    const tierOrder = { calm: 0, tense: 1, sweat: 2, panic: 3 } as const;
    if (
      this.lastStressTone !== null &&
      tierOrder[metrics.tone] > tierOrder[this.lastStressTone] &&
      (metrics.tone === 'sweat' || metrics.tone === 'panic')
    ) {
      this.hudNotify?.pushToast({
        title: `STRES %${metrics.percent} · ${metrics.label}`,
        text:
          metrics.reasons.length > 0
            ? metrics.reasons.slice(0, 2).join(' · ')
            : 'Baskı artıyor — taşlarının sinirleri geriliyor!',
        tone: metrics.tone === 'panic' ? 'enemy' : 'warn',
        icon: 'alert',
        durationMs: 4200,
      });
    }
    this.lastStressTone = metrics.tone;

    const litCount = Math.max(0, Math.min(8, Math.round((metrics.percent / 100) * 8)));
    const pipsHtml = Array.from({ length: 8 }, (_, idx) => {
      const lit = idx < litCount;
      return `<span class="sucs-stress-pip${lit ? ` is-lit is-${metrics.tone}` : ''}"></span>`;
    }).join('');

    this.hudStressChipEl.className = `px-chip sucs-stress-chip is-${metrics.tone}`;
    this.hudStressChipEl.title =
      metrics.reasons.length > 0
        ? `Stres: %${metrics.percent} (${metrics.reasons.join(' · ')})`
        : `Stres: %${metrics.percent} · ${metrics.label}`;
    this.hudStressChipEl.innerHTML =
      `<span class="sucs-stress-pips">${pipsHtml}</span>` +
      `<span class="sucs-stress-label">%${metrics.percent} · ${metrics.label}</span>`;
  }

  private refreshTopBar(): void {
    const onBoard = this.isBoardScreen();
    const onStage = this.isStageScreen();
    const isMenu = this.screen === 'MAIN_MENU';
    this.shellEl.classList.toggle('is-stage-shell', onStage);
    this.shellEl.classList.toggle('is-battle-shell', onBoard);
    this.shellEl.classList.toggle('is-menu-shell', isMenu);
    // Ana Menü ve Tam Ekran Oyun Sahnelerinde (Savaş / Dizilim) web üst çubuğunu tamamen gizle!
    this.topbarEl.style.display = isMenu || onStage ? 'none' : 'flex';
    this.menuBackBtnEl.style.display = isMenu ? 'none' : 'inline-flex';
    if (this.pauseTopBtnEl !== null) {
      this.pauseTopBtnEl.style.display = onBoard ? 'inline-flex' : 'none';
    }
    this.speedBtnEl.style.display = onBoard ? 'inline-flex' : 'none';
    this.muteBtnEl.style.display = onBoard ? 'inline-flex' : 'none';
    this.intentBtnEl.style.display = 'none';
    this.threatBtnEl.style.display = 'none';
    this.toneBtnEl.style.display = 'none';
    this.volumeWrapEl.style.display = 'none';

    const screenLabels: Record<AppScreen, string> = {
      MAIN_MENU: 'Ana Menü',
      SQUAD_SELECT: 'Stres Seferi · Manga',
      BATTLE: 'Stres Seferi · Çatışma',
      BOSS_BATTLE: 'Stres Seferi · BOSS',
      CAMPAIGN_REWARD: 'Stres Seferi · Ödül',
      RUN_VICTORY: 'Stres Seferi · Zafer',
      RUN_DEFEAT: 'Stres Seferi · S.U.C.S.',
      SKIRMISH_DEPLOY: 'Taktik Kriz · Dizilim',
      SKIRMISH_DRAFT: 'Taktik Kriz · Draft',
      MATCH_SUMMARY: 'Taktik Kriz · Özet',
      SANDBOX: 'Kaos Laboratuvarı',
    };
    if (this.isLocal2pMode() && this.skirmish !== null) {
      const roundNum = this.skirmish.roundIndex + 1;
      this.modeBadgeEl.textContent = `Yüz Yüze 2P · El ${roundNum}/3`;
    } else {
      this.modeBadgeEl.textContent =
        this.screen === 'BATTLE' && this.activeBattleKind === 'SKIRMISH'
          ? `Taktik Kriz · El ${(this.skirmish?.roundIndex ?? 0) + 1} / 3`
          : screenLabels[this.screen];
    }

    let turnClass = 'is-player';
    let turnText = '';
    if (onBoard) {
      if (this.activeBattleKind === 'LOCAL_2P') {
        if (this.state.winner !== null) {
          turnClass = 'is-ended';
          turnText =
            this.state.winner === 'PLAYER'
              ? 'EL BİTTİ · 1. OYUNCU KAZANDI'
              : this.state.winner === 'ENEMY'
                ? 'EL BİTTİ · 2. OYUNCU KAZANDI'
                : 'EL BİTTİ · BERABERE';
        } else if (this.isHotseatWaitingNext()) {
          const nextNum = this.state.turn === 'PLAYER' ? '1. OYUNCU' : '2. OYUNCU';
          turnClass = 'is-ended';
          turnText = `HAMLE BİTTİ · SIRADAKİ: ${nextNum}`;
        } else if (this.state.bonusMovePieceId !== null) {
          const curNum = this.hotseatViewerSide === 'PLAYER' ? '1. OYUNCU' : '2. OYUNCU';
          turnClass = 'is-ended';
          turnText = `T${this.state.turnNumber} · ${curNum} · PUSU +1`;
        } else {
          const isP1 = this.hotseatViewerSide === 'PLAYER';
          turnClass = isP1 ? 'is-player' : 'is-enemy';
          turnText = `T${this.state.turnNumber} · ${isP1 ? '1. OYUNCU (MAVİ)' : '2. OYUNCU (KIRMIZI)'}`;
        }
      } else if (this.state.winner !== null) {
        turnClass = 'is-ended';
        turnText =
          this.state.winner === 'PLAYER'
            ? 'ZAFER · OYUNCU KAZANDI'
            : this.state.winner === 'ENEMY'
              ? 'YENİLGİ · DÜŞMAN KAZANDI'
              : 'MAÇ BİTTİ · BERABERE';
      } else if (this.state.bonusMovePieceId !== null) {
        turnClass = 'is-ended';
        turnText = `T${this.state.turnNumber} · PUSU EKSTRA`;
      } else {
        const isPlayer = this.state.turn === 'PLAYER';
        turnClass = isPlayer ? 'is-player' : 'is-enemy';
        turnText = `T${this.state.turnNumber} · ${isPlayer ? 'OYUNCU' : 'DÜŞMAN'}`;
      }
      this.turnPillEl.style.display = 'inline-flex';
      this.turnPillEl.className = `tfc-turn-pill ${turnClass}`;
      this.turnPillEl.textContent = turnText;
    } else {
      this.turnPillEl.style.display = 'none';
    }

    if (this.hudTurnChipEl !== null) {
      this.hudTurnChipEl.className = `px-chip sucs-turn-chip ${turnClass}`;
      this.hudTurnChipEl.textContent = turnText;
    }

    this.speedBtnEl.textContent = `${this.settings.animationSpeed}x`;
    this.speedBtnEl.classList.toggle('is-active', this.settings.animationSpeed === 2);

    this.muteBtnEl.textContent = this.settings.soundEnabled ? 'Ses: Açık' : 'Ses: Kapalı';
    this.muteBtnEl.classList.toggle('is-active', this.settings.soundEnabled);

    if (this.hudSpeedBtnEl !== null) {
      const fast = this.settings.animationSpeed === 2;
      this.hudSpeedBtnEl.innerHTML = `${renderPixelIconSvg(fast ? 'speed2x' : 'speed1x', 14)}<span>${this.settings.animationSpeed}x</span>`;
      this.hudSpeedBtnEl.classList.toggle('is-active', fast);
    }
    if (this.hudMuteBtnEl !== null) {
      this.hudMuteBtnEl.innerHTML = renderPixelIconSvg(
        this.settings.soundEnabled ? 'soundOn' : 'soundOff',
        16,
      );
      this.hudMuteBtnEl.classList.toggle('is-active', this.settings.soundEnabled);
    }
    if (this.hudThreatBtnEl !== null) {
      this.hudThreatBtnEl.classList.toggle('is-warn-active', this.showThreatOverlay);
    }
    if (this.hudIntentBtnEl !== null) {
      this.hudIntentBtnEl.classList.toggle('is-active', this.settings.showIntentArrows);
    }

    this.refreshFullscreenButtons();
    this.syncGlobalAtmosphere();
  }

  private refreshPostBattleCta(): void {
    if (this.postBattleCtaEl === null) return;
    if (this.screen === 'SANDBOX' || this.state.winner === null) {
      this.postBattleCtaEl.style.display = 'none';
      this.postBattleCtaEl.innerHTML = '';
      return;
    }

    if (
      (this.activeBattleKind === 'SKIRMISH' || this.activeBattleKind === 'LOCAL_2P') &&
      this.skirmish !== null
    ) {
      this.postBattleCtaEl.style.display = 'flex';
      this.postBattleCtaEl.className = 'sucs-post-cta px-frame';
      this.postBattleCtaEl.innerHTML = '';

      const is2p = this.activeBattleKind === 'LOCAL_2P';
      const pWins = this.skirmish.playerWins + (this.state.winner === 'PLAYER' ? 1 : 0);
      const eWins = this.skirmish.enemyWins + (this.state.winner === 'ENEMY' ? 1 : 0);
      const matchOver = pWins >= 2 || eWins >= 2 || this.skirmish.roundIndex >= 2;

      const text = document.createElement('strong');
      if (is2p) {
        text.textContent =
          this.state.winner === 'PLAYER'
            ? `El ${this.skirmish.roundIndex + 1}: 1. Oyuncu (Mavi) kazandı! (Skor: ${pWins} — ${eWins})`
            : this.state.winner === 'ENEMY'
              ? `El ${this.skirmish.roundIndex + 1}: 2. Oyuncu (Kırmızı) kazandı! (Skor: ${pWins} — ${eWins})`
              : `El ${this.skirmish.roundIndex + 1} berabere! (Skor: ${pWins} — ${eWins})`;
      } else {
        text.textContent =
          this.state.winner === 'PLAYER'
            ? `El ${this.skirmish.roundIndex + 1} senin! (Skor: ${pWins} — ${eWins})`
            : this.state.winner === 'ENEMY'
              ? `El ${this.skirmish.roundIndex + 1} rakibin! (Skor: ${pWins} — ${eWins})`
              : `El ${this.skirmish.roundIndex + 1} berabere! (Skor: ${pWins} — ${eWins})`;
      }

      const btn = this.createButton(
        matchOver ? 'Maç Özetine Geç →' : 'El Arası Draft Ekranına Geç →',
        () => this.proceedAfterSkirmishRound(),
        this.state.winner === 'PLAYER' ? 'is-gold' : 'is-primary',
      );
      this.postBattleCtaEl.append(text, btn);
      return;
    }

    if (this.campaign === null) {
      this.postBattleCtaEl.style.display = 'none';
      this.postBattleCtaEl.innerHTML = '';
      return;
    }

    this.postBattleCtaEl.style.display = 'flex';
    this.postBattleCtaEl.className = 'sucs-post-cta px-frame';
    this.postBattleCtaEl.innerHTML = '';

    const text = document.createElement('strong');
    const isWin = this.state.winner === 'PLAYER';
    const act = this.campaign.act ?? 1;
    const rooms = getCampaignRoomsForAct(act);
    const isSecretCore = this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id;
    const isBoss = isSecretCore || this.campaign.roomIndex >= rooms.length - 1;
    text.textContent = isWin
      ? isSecretCore
        ? '0x00_ÇEKİRDEK çöktü! Gizli finali tamamladın!'
        : isBoss
          ? `Boss devrildi! ${act}. Perdeyi tamamladın!`
          : 'Oda temizlendi! Savaş sonrası ödülünü seç.'
      : 'Şahın düştü. Sefer sona erdi.';

    const btn = this.createButton(
      isWin ? (isBoss ? 'Zafer Ekranına Geç →' : 'Ödül Seçimine Geç →') : 'Koşu Özetini Gör →',
      () => this.proceedAfterCampaignBattle(),
      isWin ? 'is-gold' : 'is-danger',
    );
    this.postBattleCtaEl.append(text, btn);
  }

  private refreshCampaignHud(): void {
    if (this.campaignHudEl === null) return;

    if (this.activeBattleKind === 'LOCAL_2P' && this.skirmish !== null) {
      const run = this.skirmish;
      const viewSide = this.hotseatViewerSide;
      const aliveP1 = this.state.pieces.filter((p) => p.side === 'PLAYER').length;
      const aliveP2 = this.state.pieces.filter((p) => p.side === 'ENEMY').length;
      const waitingNext = this.isHotseatWaitingNext();

      this.campaignHudEl.innerHTML = '';

      const title = document.createElement('h2');
      title.className = 'tfc-card-title';
      title.innerHTML = `<span>Yüz Yüze 2P · El ${run.roundIndex + 1} / 3</span><span class="tfc-badge">${run.playerWins} — ${run.enemyWins}</span>`;

      const infoBlock = document.createElement('div');
      infoBlock.className = 'tfc-inspect-block';
      infoBlock.innerHTML =
        `<div class="tfc-field-row"><label>Tahta Yönü</label><strong>${
          viewSide === 'PLAYER' ? '1. Oyuncu (Mavi · Alt)' : '2. Oyuncu (Kırmızı · 180°)'
        }</strong></div>` +
        `<div class="tfc-field-row"><label>Durum</label><strong style="color:${
          waitingNext ? '#fbbf24' : '#38bdf8'
        };">${
          waitingNext
            ? `Sıradaki bekleniyor (${this.getHotseatSideLabel(this.state.turn)})`
            : `${this.getHotseatSideLabel(viewSide)} hamle yapıyor`
        }</strong></div>` +
        `<div class="tfc-field-row"><label>1. Oyuncu Fraksiyon</label><strong>${FACTION_DEFINITIONS[run.playerFaction].name}</strong></div>` +
        `<div class="tfc-field-row"><label>2. Oyuncu Fraksiyon</label><strong>${FACTION_DEFINITIONS[run.enemyFaction].name}</strong></div>` +
        `<div class="tfc-field-row"><label>Hayatta (Mavi / Kırmızı)</label><strong>${aliveP1} / ${aliveP2}</strong></div>` +
        `<div class="tfc-field-row"><label>Seed</label><span class="tfc-hash-code">${run.seed}</span></div>`;

      this.campaignHudEl.append(title, infoBlock);
      if (this.roomChipBtnEl !== null) {
        this.roomChipBtnEl.innerHTML =
          `${renderPixelIconSvg('flag', 14)}` +
          `<span>2P · EL ${run.roundIndex + 1}/3</span>` +
          `<span class="sucs-chip-sub">${run.playerWins}-${run.enemyWins} · ${aliveP1}/${aliveP2}</span>`;
      }
      return;
    }

    if (this.activeBattleKind === 'SKIRMISH' && this.skirmish !== null) {
      const run = this.skirmish;
      const alivePlayer = this.state.pieces.filter((p) => p.side === 'PLAYER').length;
      this.campaignHudEl.innerHTML = '';

      const prof = AI_DIFFICULTY_PROFILES[this.aiDifficulty];
      const title = document.createElement('h2');
      title.className = 'tfc-card-title';
      title.innerHTML = `<span>Taktik Kriz · El ${run.roundIndex + 1} / 3</span><span class="tfc-badge">${run.playerWins} — ${run.enemyWins}</span>`;

      const infoBlock = document.createElement('div');
      infoBlock.className = 'tfc-inspect-block';
      infoBlock.innerHTML =
        `<div class="tfc-field-row"><label>Senin Fraksiyonun</label><strong>${FACTION_DEFINITIONS[run.playerFaction].name}</strong></div>` +
        `<div class="tfc-field-row"><label>Rakip Fraksiyonu</label><strong>${FACTION_DEFINITIONS[run.enemyFaction].name}</strong></div>` +
        `<div class="tfc-field-row"><label>Hayatta Kalan Birim</label><strong>${alivePlayer} / ${run.playerRoster.length}</strong></div>` +
        `<div class="tfc-field-row"><label>Rakip AI</label><strong>${prof.name} (${prof.badge})</strong></div>` +
        `<div class="tfc-field-row"><label>Seed</label><span class="tfc-hash-code">${run.seed}</span></div>`;

      this.campaignHudEl.append(title, infoBlock);
      if (this.roomChipBtnEl !== null) {
        this.roomChipBtnEl.innerHTML =
          `${renderPixelIconSvg('flag', 14)}` +
          `<span>EL ${run.roundIndex + 1}/3 · ${run.playerWins}-${run.enemyWins}</span>` +
          `<span class="sucs-chip-sub">${alivePlayer}/${run.playerRoster.length}</span>`;
      }
      return;
    }

    if (this.campaign === null) return;
    const run = this.campaign;
    const act = run.act ?? 1;
    const rooms = getCampaignRoomsForAct(act);
    const isSecretCore = this.activeCampaignRoomOverrideId === SECRET_ACT4_ROOM.id;
    const room = isSecretCore
      ? SECRET_ACT4_ROOM
      : getCampaignRoomTemplate(run.roomIndex, act);
    const enemyFac = FACTION_DEFINITIONS[room.enemyFaction];
    const alivePlayer = this.state.pieces.filter((p) => p.side === 'PLAYER').length;

    if (this.roomChipBtnEl !== null) {
      const pactTag =
        run.activePacts.length > 0 ? `<span class="sucs-chip-alert">PAZARLIK</span>` : '';
      const bossTag =
        room.isBoss && this.state.bossCooldown > 0
          ? `<span class="sucs-chip-boss">BOSS ${this.state.bossCooldown}T</span>`
          : '';
      this.roomChipBtnEl.innerHTML =
        `${renderPixelIconSvg('flag', 14)}` +
        `<span>${isSecretCore ? '0x00_ÇEKİRDEK' : `${run.roomIndex + 1}/${rooms.length} · ${room.name}`}</span>` +
        `<span class="sucs-chip-sub">${alivePlayer}/${run.roster.length}</span>` +
        bossTag +
        pactTag;
    }

    this.campaignHudEl.innerHTML = '';

    const title = document.createElement('h2');
    title.className = 'tfc-card-title';
    title.innerHTML = isSecretCore
      ? `<span>${room.name}</span><span class="tfc-badge">GİZLİ BOSS</span>`
      : `<span>${room.name}</span><span class="tfc-badge">${run.roomIndex + 1} / ${rooms.length}</span>`;

    const sub = document.createElement('div');
    sub.className = 'tfc-status-banner';
    sub.textContent = room.subtitle;

    const infoBlock = document.createElement('div');
    infoBlock.className = 'tfc-inspect-block';
    infoBlock.innerHTML =
      `<div class="tfc-field-row"><label>Düşman Fraksiyonu</label><strong>${enemyFac.name}</strong></div>` +
      `<div class="tfc-field-row"><label>Hayatta Kalan Birim</label><strong>${alivePlayer} / ${run.roster.length}</strong></div>` +
      `<div class="tfc-field-row"><label>Seed</label><span class="tfc-hash-code">${run.seed}</span></div>`;

    this.campaignHudEl.append(title, sub, infoBlock);

    if (room.isBoss && this.state.bossCooldown > 0) {
      const bossAlert = document.createElement('div');
      bossAlert.className = 'tfc-inspect-block';
      bossAlert.style.borderColor = '#f59e0b';
      bossAlert.innerHTML =
        `<div class="tfc-inspect-heading"><span style="color:#fbbf24;">BOSS BUZ/ALEV HALKASI</span><span class="tfc-badge">${this.state.bossCooldown} tur</span></div>` +
        '<div style="font-size:0.76rem;color:#cbd5e1;">Sayaç sıfırlandığında Boss Şah etrafındaki 1 karelik alana ateş ve buz saçar.</div>';
      this.campaignHudEl.appendChild(bossAlert);
    }

    if (run.activePacts.length > 0) {
      const pactBox = document.createElement('div');
      pactBox.className = 'tfc-inspect-block';
      pactBox.style.borderColor = '#f87171';
      const lines = run.activePacts
        .map((p) => `Düşman piyonları: ${TRAIT_INFO[p.trait].name} (${p.roomsRemaining} oda)`)
        .join(' · ');
      pactBox.innerHTML = `<div style="font-size:0.76rem;color:#fca5a5;"><strong>Aktif Pazarlık:</strong> ${lines}</div>`;
      this.campaignHudEl.appendChild(pactBox);
    }
  }

  private refreshAbilityBar(): void {
    if (this.abilityGroupEl === null) return;
    this.abilityGroupEl.innerHTML = '';

    const hasPush = this.legalAbilities.some((a) => a.ability === 'PUSH');
    const hasBreakWall = this.legalAbilities.some((a) => a.ability === 'BREAK_WALL');

    if (this.selectedCoord !== null && (hasPush || hasBreakWall)) {
      const moveBtn = this.createButton(
        `Hareket (${this.legalMoves.length})`,
        () => {
          this.activeAbility = null;
          this.refreshAbilityBar();
        },
        this.activeAbility === null ? 'is-active' : '',
      );
      this.abilityGroupEl.appendChild(moveBtn);

      if (hasPush) {
        const pushCount = this.legalAbilities.filter((a) => a.ability === 'PUSH').length;
        const pushBtn = this.createButton(
          `İt · PUSH (${pushCount})`,
          () => {
            this.activeAbility = this.activeAbility === 'PUSH' ? null : 'PUSH';
            this.setStatus(
              this.activeAbility === 'PUSH'
                ? 'İtme modu: İtmek istediğin bitişik düşmana tıkla.'
                : 'Hareket moduna dönüldü.',
              'normal',
            );
            this.refreshAbilityBar();
          },
          `is-ability-push ${this.activeAbility === 'PUSH' ? 'is-active' : ''}`,
        );
        this.abilityGroupEl.appendChild(pushBtn);
      }

      if (hasBreakWall) {
        const wallCount = this.legalAbilities.filter((a) => a.ability === 'BREAK_WALL').length;
        const wallBtn = this.createButton(
          `Duvar Kır (${wallCount})`,
          () => {
            this.activeAbility = this.activeAbility === 'BREAK_WALL' ? null : 'BREAK_WALL';
            this.setStatus(
              this.activeAbility === 'BREAK_WALL'
                ? 'Kuşatma modu: Yıkmak istediğin bitişik duvara tıkla.'
                : 'Hareket moduna dönüldü.',
              'normal',
            );
            this.refreshAbilityBar();
          },
          `is-ability-break ${this.activeAbility === 'BREAK_WALL' ? 'is-active' : ''}`,
        );
        this.abilityGroupEl.appendChild(wallBtn);
      }
    }

    if (this.undoBtnEl !== null) {
      this.undoBtnEl.disabled = this.undoStack.length === 0;
    }
    const waitingNext = this.isHotseatWaitingNext();
    if (this.nextPlayerBtnEl !== null) {
      this.nextPlayerBtnEl.disabled = !waitingNext;
      this.nextPlayerBtnEl.classList.toggle('is-gold', waitingNext);
      this.nextPlayerBtnEl.classList.toggle('sucs-next-player-ready', waitingNext);
      if (waitingNext) {
        const nextShort = this.state.turn === 'PLAYER' ? '1. Oyuncu' : '2. Oyuncu';
        this.nextPlayerBtnEl.textContent = `Sıradaki: ${nextShort} ↻`;
      } else {
        this.nextPlayerBtnEl.textContent = 'Sıradaki ↻';
      }
    }
    if (this.passBtnEl !== null) {
      this.passBtnEl.disabled =
        this.state.winner !== null ||
        waitingNext ||
        (this.isEnemyAiControlled() && this.state.turn === 'ENEMY');
    }
  }

  private refreshSandboxPanel(): void {
    const preset = getSandboxPreset(this.presetId);
    if (this.presetSelectEl !== null) this.presetSelectEl.value = preset.id;
    if (this.presetDescEl !== null) this.presetDescEl.textContent = preset.description;

    const modes: readonly PerspectiveMode[] = ['AUTO', 'PLAYER', 'ENEMY', 'OMNISCIENT'];
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i]!;
      this.perspectiveBtns[m]?.classList.toggle('is-active', this.perspectiveMode === m);
    }

    if (this.playerFactionSelectEl !== null) {
      this.playerFactionSelectEl.value = this.state.factions.PLAYER;
    }
    if (this.enemyFactionSelectEl !== null) {
      this.enemyFactionSelectEl.value = this.state.factions.ENEMY;
    }
    if (this.enemyControlSelectEl !== null) {
      this.enemyControlSelectEl.value = this.enemyControl;
    }
    if (this.aiDifficultySelectEl !== null) {
      this.aiDifficultySelectEl.value = this.aiDifficulty;
    }
    if (this.roomChipBtnEl !== null) {
      this.roomChipBtnEl.innerHTML =
        `${renderPixelIconSvg('lab', 14)}` +
        `<span>LAB · ${preset.name}</span>` +
        `<span class="sucs-chip-sub">${this.perspectiveMode}</span>`;
    }
  }

  private refreshInspector(): void {
    if (this.inspectorBodyEl === null) return;
    this.inspectorBodyEl.innerHTML = '';

    const activeCoord = this.inspectedCoord ?? this.hoveredCoord;
    if (activeCoord === null) {
      if (this.inspectCardEl !== null) {
        this.inspectCardEl.style.display = 'none';
      }
      return;
    }
    if (this.inspectCardEl !== null) {
      this.inspectCardEl.style.display = 'flex';
    }

    const visible = this.getCurrentVisibleState();
    const coord = activeCoord;
    const vis = visible.fog[coord.y]?.[coord.x] ?? 'UNEXPLORED';
    const tile = visible.tiles[coord.y]?.[coord.x] ?? null;
    const coordText = formatCoord(coord, visible.height);

    const tileBlock = document.createElement('div');
    tileBlock.className = 'tfc-inspect-block';

    const visLabel =
      vis === 'VISIBLE' ? 'Görünür' : vis === 'EXPLORED' ? 'Sisli' : 'Karanlık';

    const tileHead = document.createElement('div');
    tileHead.className = 'sucs-inspect-topbar';
    const tileTitle = document.createElement('strong');
    tileTitle.style.fontSize = '0.84rem';
    tileTitle.textContent =
      tile === null ? `${coordText} · Bilinmeyen` : `${coordText} · ${TILE_INFO[tile.type].name}`;
    const rightMeta = document.createElement('div');
    rightMeta.style.display = 'inline-flex';
    rightMeta.style.alignItems = 'center';
    rightMeta.style.gap = '4px';
    const tileVis = document.createElement('span');
    tileVis.className = 'tfc-badge';
    tileVis.textContent = visLabel;
    rightMeta.appendChild(tileVis);
    if (this.inspectedCoord !== null) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'sucs-inspect-close';
      closeBtn.innerHTML = renderPixelIconSvg('close', 12);
      closeBtn.title = 'İncelemeyi Kapat [Esc]';
      closeBtn.setAttribute('aria-label', 'İncelemeyi Kapat');
      closeBtn.addEventListener('click', () => {
        this.inspectedCoord = null;
        this.refreshInspector();
      });
      rightMeta.appendChild(closeBtn);
    }
    tileHead.append(tileTitle, rightMeta);

    const tileDesc = document.createElement('div');
    tileDesc.style.color = '#94a3b8';
    tileDesc.style.fontSize = '0.78rem';
    tileDesc.textContent =
      tile === null
        ? 'Bu kare henüz görüş alanına girmedi.'
        : tile.type === 'BURNING'
          ? `${TILE_INFO.BURNING.desc} (Kalan alev: ${tile.burnTurns} tur)`
          : TILE_INFO[tile.type].desc;

    const tileExtraNotes: string[] = [];
    if (tile !== null && tile.gas?.kind === 'MIASMA') {
      tileExtraNotes.push(
        tile.gas.turnsRemaining === null
          ? 'Zehirli Sis (Kalıcı): Arkasındaki görüşü keser, 2 turda boğar, ateşle zincirleme patlar.'
          : `Zehirli Sis (${tile.gas.turnsRemaining} yarım-tur): Arkasındaki görüşü keser, ateşle patlar.`,
      );
    }
    if (tile !== null && tile.trap !== undefined) {
      if (tile.trap.kind === 'PRESSURE_PLATE') {
        tileExtraNotes.push(
          `Baskı Plakası (Soğuma: ${tile.trap.cooldown}/${tile.trap.maxCooldown}): Basılınca bağlı duvar oklarını ateşler.`,
        );
      } else if (tile.trap.kind === 'ARROW_EMITTER') {
        const ammoStr = tile.trap.ammo === null ? 'Sınırsız' : String(tile.trap.ammo);
        tileExtraNotes.push(
          `Duvar Oku (Cephane: ${ammoStr}${tile.trap.flaming ? ', Alevli' : ''}${tile.trap.piercing ? ', Delici' : ''}).`,
        );
      } else if (tile.trap.kind === 'SPIKES') {
        const phaseLabel =
          tile.trap.phase === 0
            ? 'Kapalı (Güvenli)'
            : tile.trap.phase === 1
              ? 'Tıkırtı (Gelecek yarım-turda AÇILIR!)'
              : 'AÇIK (Ölümcül!)';
        tileExtraNotes.push(`Ritimli Kazıklar: ${phaseLabel}`);
      }
    }

    tileBlock.append(tileHead, tileDesc);
    for (let i = 0; i < tileExtraNotes.length; i++) {
      const extraEl = document.createElement('div');
      extraEl.style.color = '#86efac';
      extraEl.style.fontSize = '0.75rem';
      extraEl.style.marginTop = '4px';
      extraEl.textContent = tileExtraNotes[i]!;
      tileBlock.appendChild(extraEl);
    }
    this.inspectorBodyEl.appendChild(tileBlock);

    const silhouette = visible.silhouettes.find((s) => coordEquals(s.pos, coord));
    if (silhouette !== undefined) {
      const silBlock = document.createElement('div');
      silBlock.className = 'tfc-inspect-block';
      silBlock.innerHTML =
        '<div class="tfc-inspect-heading"><span>? Düşman Silüeti</span></div>' +
        '<div style="color:#fca5a5;font-size:0.78rem;">Görüş menzilinin +2 kare halkasında bir düşman hareketi sezildi (türü gizli).</div>';
      this.inspectorBodyEl.appendChild(silBlock);
    }

    const spawn = visible.pendingSpawns.find((sp) => coordEquals(sp.pos, coord));
    if (spawn !== undefined) {
      const spBlock = document.createElement('div');
      spBlock.className = 'tfc-inspect-block';
      const head = document.createElement('div');
      head.className = 'tfc-inspect-heading';
      head.textContent = `Nekromanser İşareti (${spawn.turnsRemaining} tur)`;
      const desc = document.createElement('div');
      desc.style.color = '#a7f3d0';
      desc.style.fontSize = '0.78rem';
      desc.textContent = `Sayaç sıfırlanınca kare boşsa ${spawn.side === 'PLAYER' ? 'Oyuncu' : 'Düşman'} İskelet Piyonu doğar.`;
      spBlock.append(head, desc);
      this.inspectorBodyEl.appendChild(spBlock);
    }

    const piece = getPieceAt(visible.pieces, coord);
    if (piece !== undefined) {
      const pieceBlock = document.createElement('div');
      pieceBlock.className = 'tfc-inspect-block';

      const head = document.createElement('div');
      head.className = 'tfc-inspect-heading';
      const portraitWrap = document.createElement('div');
      portraitWrap.className = 'sucs-inspect-portrait-row';
      const portraitCanvas = createPieceIconCanvas(
        piece.type,
        piece.side,
        48,
        this.getActiveRenderTheme(),
        piece.isBoss === true,
      );
      if (portraitCanvas !== null) {
        portraitWrap.appendChild(portraitCanvas);
      }

      const nameSpan = document.createElement('span');
      const ownerLabel =
        this.activeBattleKind === 'LOCAL_2P'
          ? piece.side === 'PLAYER'
            ? '1. Oyuncu'
            : '2. Oyuncu'
          : piece.side === 'PLAYER'
            ? 'Oyuncu'
            : 'Düşman';
      nameSpan.textContent = `${ownerLabel} ${PIECE_NAMES[piece.type]}${piece.isBoss ? ' (BOSS)' : ''}`;
      nameSpan.style.color = piece.side === 'PLAYER' ? '#38bdf8' : '#f87171';
      portraitWrap.appendChild(nameSpan);

      const visionSpan = document.createElement('span');
      visionSpan.className = 'tfc-badge';
      visionSpan.textContent = `Görüş: ${getPieceVisionRadius(visible, piece)}`;
      head.append(portraitWrap, visionSpan);

      // Görsel Dayanıklılık Çentiği (3 dişli) & Gulyabani [2/2] Kılık Yuvaları
      const compVal = piece.composure ?? 3;
      const compRow = document.createElement('div');
      compRow.className = 'sucs-composure-row';
      compRow.innerHTML =
        `<span>Dayanıklılık:</span>` +
        [1, 2, 3]
          .map(
            (n) =>
              `<span class="sucs-comp-pip${n <= compVal ? (compVal === 1 ? ' is-crit' : compVal === 2 ? ' is-mid' : ' is-calm') : ''}"></span>`,
          )
          .join('') +
        `<span>(${compVal}/3)</span>`;
      pieceBlock.append(head, compRow);

      if (piece.type === 'CHIMERA') {
        const forms = piece.absorbedForms ?? [];
        const chimRow = document.createElement('div');
        chimRow.className = 'sucs-guise-slots';
        for (let sIdx = 0; sIdx < 2; sIdx++) {
          const f = forms[sIdx];
          const pill = document.createElement('span');
          pill.className = 'tfc-badge';
          pill.textContent = f !== undefined ? `[${sIdx + 1}/2] ${PIECE_NAMES[f.sourceType]}` : `[${sIdx + 1}/2] BOŞ`;
          chimRow.appendChild(pill);
        }
        pieceBlock.appendChild(chimRow);
      }

      const meta = document.createElement('div');
      meta.style.color = '#cbd5e1';
      meta.style.fontSize = '0.76rem';
      const tags: string[] = [];
      if (piece.shieldActive) tags.push((piece.silencedTurns ?? 0) > 0 && piece.type !== 'CHIMERA' ? 'Kalkan Bastırıldı' : 'Kalkan Aktif');
      if (piece.frozenTurns > 0) tags.push(`Donmuş (${piece.frozenTurns} tur)`);
      if ((piece.composure ?? 3) < 3) tags.push(`Dayanıklılık: ${piece.composure}/3`);
      if ((piece.miasmaExposure ?? 0) > 0) tags.push(`Zehir: ${piece.miasmaExposure}/2`);
      if ((piece.silencedTurns ?? 0) > 0 && piece.type !== 'CHIMERA') tags.push(`Susturulmuş (${piece.silencedTurns} tur)`);
      if ((piece.faithCharge ?? 0) > 0) tags.push(`Ocaklı Şarj: ${piece.faithCharge}/3`);
      if ((piece.madnessCharge ?? 0) > 0) tags.push(`Meczup Şarj: ${piece.madnessCharge}/3`);
      if (piece.berserkReady === true) tags.push('KANLI CİNNET HAZIR');
      if (piece.type === 'CHIMERA' && (piece.absorbedForms?.length ?? 0) > 0) {
        tags.push(`Kılıklar: ${piece.absorbedForms!.map((f) => PIECE_NAMES[f.sourceType]).join(' + ')}`);
      }
      if (visible.mode === 'CAMPAIGN' && piece.side === 'ENEMY') {
        tags.push(
          piece.aggro === 'SLEEPING'
            ? 'Uyuyor'
            : piece.aggro === 'ALERTED'
              ? 'Uyandı (!)'
              : 'Aktif',
        );
      }
      if (visible.bonusMovePieceId === piece.id) tags.push('Ekstra Pusu Hamlesi!');
      meta.textContent = tags.join(' · ') || (piece.hasMoved ? 'Hareket Etti' : 'İlk Hamle');

      pieceBlock.appendChild(meta);

      if (piece.traits.length > 0) {
        const traitList = document.createElement('div');
        traitList.className = 'tfc-trait-list';
        for (let i = 0; i < piece.traits.length; i++) {
          const trait = piece.traits[i]!;
          const info = TRAIT_INFO[trait];
          const item = document.createElement('div');
          item.className = 'tfc-trait-item';
          const strong = document.createElement('strong');
          strong.textContent = info.name;
          const span = document.createElement('span');
          span.textContent = info.desc;
          item.append(strong, span);
          traitList.appendChild(item);
        }
        pieceBlock.appendChild(traitList);
      }

      this.inspectorBodyEl.appendChild(pieceBlock);
    }
  }

  private refreshEventLog(): void {
    if (this.hashCodeEl !== null) {
      this.hashCodeEl.textContent = `#${computeStateHash(this.state)} (${this.state.actionHistory.length})`;
    }
    if (this.hudLogBtnEl !== null) {
      const badge =
        !this.logDrawerOpen && this.unreadLogCount > 0
          ? `<span class="sucs-icon-count">${this.unreadLogCount}</span>`
          : '';
      this.hudLogBtnEl.innerHTML = `${renderPixelIconSvg('log', 16)}${badge}`;
    }
    if (this.eventLogListEl === null) return;
    this.eventLogListEl.innerHTML = '';
    for (let i = 0; i < this.eventLog.length; i++) {
      const li = document.createElement('li');
      li.textContent = this.eventLog[i]!;
      this.eventLogListEl.appendChild(li);
    }
  }
}

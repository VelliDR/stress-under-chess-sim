import { AiDifficulty } from '../ai/sucsAi';
import { nextInt, seedToRngState } from '../engine/prng';
import {
  AppRunState,
  AppScreen,
  AppSettings,
  CampaignRunState,
  SAVE_VERSION,
  SkirmishRunState,
} from '../engine/types';

export const SAVE_STORAGE_KEY = 'sucs_save_v1';
export const LEGACY_SAVE_STORAGE_KEY = 'tfc_save_v1';
export const AI_DIFFICULTY_STORAGE_KEY = 'sucs_ai_difficulty_v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LoadSaveStatus =
  | 'OK'
  | 'EMPTY'
  | 'RESET_CORRUPT'
  | 'RESET_VERSION'
  | 'RESET_INVALID'
  | 'UNAVAILABLE';

export interface LoadSaveResult {
  state: AppRunState | null;
  status: LoadSaveStatus;
}

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = {
  soundEnabled: true,
  soundVolume: 0.65,
  animationSpeed: 1,
  showIntentArrows: true,
};

const VALID_SCREENS: readonly AppScreen[] = [
  'MAIN_MENU',
  'SQUAD_SELECT',
  'BATTLE',
  'BOSS_BATTLE',
  'CAMPAIGN_REWARD',
  'RUN_VICTORY',
  'RUN_DEFEAT',
  'SKIRMISH_DEPLOY',
  'SKIRMISH_DRAFT',
  'MATCH_SUMMARY',
  'SANDBOX',
];

function resolveStorage(override?: StorageLike): StorageLike | null {
  if (override !== undefined) return override;
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      const storage = (globalThis as unknown as { localStorage?: StorageLike }).localStorage;
      return storage ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Produces the deterministic Daily Seed in strict `YYYY-MM-DD` format.
 * Optional explicit calendar parts allow 100% deterministic testing.
 */
export function getDailySeed(parts?: { year: number; month: number; day: number }): string {
  if (parts !== undefined) {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Generates a clean custom seed string deterministically from an input seed/counter (zero Math.random).
 */
export function generateCustomSeed(entropy: string | number): string {
  const rng = seedToRngState(`custom-seed::${entropy}`);
  const roll = nextInt(rng, 10000, 99999);
  return `SUCS-${roll.value}`;
}

export function loadAiDifficulty(storageOverride?: StorageLike): AiDifficulty {
  const storage = resolveStorage(storageOverride);
  if (storage === null) return 'TENSE';
  try {
    const raw = storage.getItem(AI_DIFFICULTY_STORAGE_KEY);
    if (raw === 'CALM' || raw === 'TENSE' || raw === 'PANIC') {
      return raw;
    }
  } catch {
    // ignore storage errors
  }
  return 'TENSE';
}

export function saveAiDifficulty(
  difficulty: AiDifficulty,
  storageOverride?: StorageLike,
): boolean {
  const storage = resolveStorage(storageOverride);
  if (storage === null) return false;
  try {
    storage.setItem(AI_DIFFICULTY_STORAGE_KEY, difficulty);
    return true;
  } catch {
    return false;
  }
}

export function normalizeSeed(raw: string, fallback?: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 0) return trimmed.slice(0, 48);
  return fallback ?? getDailySeed();
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidScreen(val: unknown): val is AppScreen {
  return typeof val === 'string' && VALID_SCREENS.includes(val as AppScreen);
}

function sanitizeSettings(raw: unknown): AppSettings | null {
  if (!isPlainRecord(raw)) return null;
  const soundEnabled =
    typeof raw['soundEnabled'] === 'boolean'
      ? raw['soundEnabled']
      : DEFAULT_APP_SETTINGS.soundEnabled;
  const rawVol = raw['soundVolume'];
  const soundVolume =
    typeof rawVol === 'number' && Number.isFinite(rawVol)
      ? Math.max(0, Math.min(1, rawVol))
      : DEFAULT_APP_SETTINGS.soundVolume;
  const animationSpeed: 1 | 2 = raw['animationSpeed'] === 2 ? 2 : 1;
  const showIntentArrows =
    typeof raw['showIntentArrows'] === 'boolean'
      ? raw['showIntentArrows']
      : DEFAULT_APP_SETTINGS.showIntentArrows;

  const narrativeTone =
    raw['narrativeTone'] === 'unfiltered' || raw['narrativeTone'] === 'polite'
      ? raw['narrativeTone']
      : undefined;

  return {
    soundEnabled,
    soundVolume,
    animationSpeed,
    showIntentArrows,
    ...(narrativeTone !== undefined ? { narrativeTone } : {}),
  };
}

function isValidGameStateShape(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  return (
    typeof raw['width'] === 'number' &&
    typeof raw['height'] === 'number' &&
    Array.isArray(raw['tiles']) &&
    Array.isArray(raw['pieces']) &&
    Array.isArray(raw['actionHistory']) &&
    isPlainRecord(raw['fog']) &&
    isPlainRecord(raw['factions']) &&
    typeof raw['rngState'] === 'number' &&
    (raw['turn'] === 'PLAYER' || raw['turn'] === 'ENEMY')
  );
}

function isValidCampaignShape(raw: unknown): raw is CampaignRunState {
  if (!isPlainRecord(raw)) return false;
  if (
    typeof raw['seed'] !== 'string' ||
    typeof raw['rngState'] !== 'number' ||
    typeof raw['squadId'] !== 'string' ||
    typeof raw['roomIndex'] !== 'number' ||
    !Array.isArray(raw['roster']) ||
    !Array.isArray(raw['lostUnits']) ||
    !Array.isArray(raw['activePacts'])
  ) {
    return false;
  }
  if (raw['currentBattle'] !== null && !isValidGameStateShape(raw['currentBattle'])) {
    return false;
  }
  return true;
}

function isValidSkirmishShape(raw: unknown): raw is SkirmishRunState {
  if (!isPlainRecord(raw)) return false;
  if (
    typeof raw['seed'] !== 'string' ||
    typeof raw['rngState'] !== 'number' ||
    typeof raw['roundIndex'] !== 'number' ||
    typeof raw['playerWins'] !== 'number' ||
    typeof raw['enemyWins'] !== 'number' ||
    !Array.isArray(raw['playerRoster']) ||
    !Array.isArray(raw['enemyRoster'])
  ) {
    return false;
  }
  if (raw['currentBattle'] !== null && !isValidGameStateShape(raw['currentBattle'])) {
    return false;
  }
  return true;
}

/**
 * Serializes and writes `AppRunState` to `localStorage` (`tfc_save_v1`).
 * Never throws on unavailable storage or quota errors.
 */
export function saveAppState(state: AppRunState, storageOverride?: StorageLike): boolean {
  const storage = resolveStorage(storageOverride);
  if (storage === null) return false;
  try {
    const payload: AppRunState = {
      ...state,
      saveVersion: SAVE_VERSION,
    };
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function clearSavedAppState(storageOverride?: StorageLike): void {
  const storage = resolveStorage(storageOverride);
  if (storage === null) return;
  try {
    storage.removeItem(SAVE_STORAGE_KEY);
    storage.removeItem(LEGACY_SAVE_STORAGE_KEY);
  } catch {
    // Ignore storage removal errors
  }
}

/**
 * Loads and validates `AppRunState` from `sucs_save_v1` (migrating legacy `tfc_save_v1` seamlessly).
 * Automatically performs a safe reset (removes corrupted/mismatched entry) on bad JSON,
 * schema version mismatch, or malformed structure.
 */
export function loadAppState(storageOverride?: StorageLike): LoadSaveResult {
  const storage = resolveStorage(storageOverride);
  if (storage === null) {
    return { state: null, status: 'UNAVAILABLE' };
  }

  let raw: string | null = null;
  let fromLegacy = false;
  try {
    raw = storage.getItem(SAVE_STORAGE_KEY);
    if (raw === null || raw.trim().length === 0) {
      const legacyRaw = storage.getItem(LEGACY_SAVE_STORAGE_KEY);
      if (legacyRaw !== null && legacyRaw.trim().length > 0) {
        raw = legacyRaw;
        fromLegacy = true;
      }
    }
  } catch {
    return { state: null, status: 'UNAVAILABLE' };
  }

  if (raw === null || raw.trim().length === 0) {
    return { state: null, status: 'EMPTY' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearSavedAppState(storage);
    return { state: null, status: 'RESET_CORRUPT' };
  }

  if (!isPlainRecord(parsed)) {
    clearSavedAppState(storage);
    return { state: null, status: 'RESET_INVALID' };
  }

  if (parsed['saveVersion'] !== SAVE_VERSION) {
    clearSavedAppState(storage);
    return { state: null, status: 'RESET_VERSION' };
  }

  const settings = sanitizeSettings(parsed['settings']);
  if (settings === null || !isValidScreen(parsed['screen'])) {
    clearSavedAppState(storage);
    return { state: null, status: 'RESET_INVALID' };
  }

  const rawCampaign = parsed['campaign'];
  const rawSkirmish = parsed['skirmish'];
  if (rawCampaign !== null && !isValidCampaignShape(rawCampaign)) {
    clearSavedAppState(storage);
    return { state: null, status: 'RESET_INVALID' };
  }
  if (rawSkirmish !== null && !isValidSkirmishShape(rawSkirmish)) {
    clearSavedAppState(storage);
    return { state: null, status: 'RESET_INVALID' };
  }

  const state: AppRunState = {
    saveVersion: SAVE_VERSION,
    screen: parsed['screen'],
    settings,
    campaign: rawCampaign === null ? null : rawCampaign,
    skirmish: rawSkirmish === null ? null : rawSkirmish,
  };

  // Auto-migrate legacy tfc_save_v1 into sucs_save_v1
  if (fromLegacy) {
    try {
      storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(state));
      storage.removeItem(LEGACY_SAVE_STORAGE_KEY);
    } catch {
      // Non-fatal if storage is read-only
    }
  }

  return { status: 'OK', state };
}

export interface ResumableRunSummary {
  kind: 'CAMPAIGN' | 'SKIRMISH';
  title: string;
  detail: string;
  seed: string;
  targetScreen: AppScreen;
}

/**
 * Inspects a saved AppRunState to determine whether an active Campaign or Skirmish run
 * can be resumed from the Main Menu.
 */
export function getResumableRunSummary(saved: AppRunState | null): ResumableRunSummary | null {
  if (saved === null) return null;

  if (saved.campaign !== null) {
    const c = saved.campaign;
    const isRewardScreen = saved.screen === 'CAMPAIGN_REWARD' && c.currentBattle === null;
    if (c.currentBattle !== null || isRewardScreen) {
      const targetScreen: AppScreen = isRewardScreen
        ? 'CAMPAIGN_REWARD'
        : c.roomIndex >= 4
          ? 'BOSS_BATTLE'
          : 'BATTLE';
      return {
        kind: 'CAMPAIGN',
        title: `Kayıtlı Sefer · Oda ${c.roomIndex + 1} / 5`,
        detail: isRewardScreen
          ? `Ödül Seçimi Bekliyor · ${c.roster.length} Hayatta`
          : `Tur #${c.currentBattle!.turnNumber} · ${c.roster.length} Birim`,
        seed: c.seed,
        targetScreen,
      };
    }
  }

  if (saved.skirmish !== null) {
    const s = saved.skirmish;
    const matchOver = s.playerWins >= 2 || s.enemyWins >= 2;
    if (!matchOver) {
      const targetScreen: AppScreen =
        s.currentBattle !== null
          ? 'BATTLE'
          : saved.screen === 'SKIRMISH_DRAFT'
            ? 'SKIRMISH_DRAFT'
            : 'SKIRMISH_DEPLOY';
      return {
        kind: 'SKIRMISH',
        title: `${s.isLocal2P ? 'Kayıtlı 2P Maç' : 'Kayıtlı Düello'} · El ${s.roundIndex + 1} / 3`,
        detail: `Skor ${s.playerWins} — ${s.enemyWins} · ${
          targetScreen === 'BATTLE'
            ? `Tur #${s.currentBattle!.turnNumber}`
            : targetScreen === 'SKIRMISH_DRAFT'
              ? 'El Arası Draft'
              : 'Gizli Dizilim'
        }`,
        seed: s.seed,
        targetScreen,
      };
    }
  }

  return null;
}

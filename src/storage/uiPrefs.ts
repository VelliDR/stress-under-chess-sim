// src/storage/uiPrefs.ts
// S.U.C.S. — Saf UI/Tercih & Meta-İlerleme Depolaması (sucs_ui_prefs_v1).
// Motor ayar şemasını (sucs_save_v1 / AppSettings) bozmamak için ayrı anahtar kullanır.

import type { StorageLike } from './persistence';

export const UI_PREFS_STORAGE_KEY = 'sucs_ui_prefs_v1';

export type CrtScanlineMode = 'off' | 'light' | 'retro';

export interface DailyCompletionMeta {
  date: string;
  turns: number;
}

export interface UiMetaStats {
  bestRooms: number;
  totalCaptures: number;
  peakStress: number;
  bestSeed: string;
}

export interface UiPrefsState {
  bootSeen: boolean;
  crtScanlines: CrtScanlineMode;
  crtThemeUnlocked: boolean;
  crtThemeEnabled: boolean;
  calmScreen: boolean;
  showLethalWarnings: boolean;
  act4Switches: [boolean, boolean];
  act4Cleared: boolean;
  dailyCompleted: DailyCompletionMeta | null;
  stats: UiMetaStats;
}

export function createDefaultUiPrefs(): UiPrefsState {
  return {
    bootSeen: false,
    crtScanlines: 'light',
    crtThemeUnlocked: false,
    crtThemeEnabled: false,
    calmScreen: false,
    showLethalWarnings: true,
    act4Switches: [false, false],
    act4Cleared: false,
    dailyCompleted: null,
    stats: {
      bestRooms: 0,
      totalCaptures: 0,
      peakStress: 0,
      bestSeed: '',
    },
  };
}

function resolveUiStorage(override?: StorageLike): StorageLike | null {
  if (override !== undefined) return override;
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      const s = (globalThis as unknown as { localStorage?: StorageLike }).localStorage;
      return s ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

export function loadUiPrefs(storageOverride?: StorageLike): UiPrefsState {
  const def = createDefaultUiPrefs();
  const storage = resolveUiStorage(storageOverride);
  if (storage === null) return def;

  try {
    const raw = storage.getItem(UI_PREFS_STORAGE_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return def;

    const switchesRaw = Array.isArray(parsed['act4Switches']) ? parsed['act4Switches'] : [];
    const statsRaw =
      typeof parsed['stats'] === 'object' && parsed['stats'] !== null
        ? (parsed['stats'] as Record<string, unknown>)
        : {};
    const dailyRaw =
      typeof parsed['dailyCompleted'] === 'object' && parsed['dailyCompleted'] !== null
        ? (parsed['dailyCompleted'] as Record<string, unknown>)
        : null;

    const crtScanlines: CrtScanlineMode =
      parsed['crtScanlines'] === 'off' || parsed['crtScanlines'] === 'retro'
        ? parsed['crtScanlines']
        : 'light';

    return {
      bootSeen: parsed['bootSeen'] === true,
      crtScanlines,
      crtThemeUnlocked: parsed['crtThemeUnlocked'] === true,
      crtThemeEnabled: parsed['crtThemeEnabled'] === true,
      calmScreen: parsed['calmScreen'] === true,
      showLethalWarnings:
        typeof parsed['showLethalWarnings'] === 'boolean' ? parsed['showLethalWarnings'] : true,
      act4Switches: [switchesRaw[0] === true, switchesRaw[1] === true],
      act4Cleared: parsed['act4Cleared'] === true,
      dailyCompleted:
        dailyRaw !== null &&
        typeof dailyRaw['date'] === 'string' &&
        typeof dailyRaw['turns'] === 'number'
          ? { date: dailyRaw['date'], turns: Math.max(1, Math.floor(dailyRaw['turns'])) }
          : null,
      stats: {
        bestRooms:
          typeof statsRaw['bestRooms'] === 'number' ? Math.max(0, statsRaw['bestRooms']) : 0,
        totalCaptures:
          typeof statsRaw['totalCaptures'] === 'number'
            ? Math.max(0, statsRaw['totalCaptures'])
            : 0,
        peakStress:
          typeof statsRaw['peakStress'] === 'number' ? Math.max(0, statsRaw['peakStress']) : 0,
        bestSeed: typeof statsRaw['bestSeed'] === 'string' ? statsRaw['bestSeed'] : '',
      },
    };
  } catch {
    return def;
  }
}

export function saveUiPrefs(prefs: UiPrefsState, storageOverride?: StorageLike): boolean {
  const storage = resolveUiStorage(storageOverride);
  if (storage === null) return false;
  try {
    storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

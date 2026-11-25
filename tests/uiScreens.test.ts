import { describe, expect, it } from 'vitest';
import { computeSkirmishRosterCost } from '../src/ai/skirmishAi';
import { createEmptyTiles, createTile } from '../src/engine/board';
import { createDefaultUiPrefs, loadUiPrefs, saveUiPrefs, UI_PREFS_STORAGE_KEY } from '../src/storage/uiPrefs';
import {
  buildQuickArmyTemplate,
  computeBudgetBatterySegments,
  createDeployVisibilityFog,
} from '../src/ui/armyBuilder';

function makeMemStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    store,
    getItem: (k) => (k in store ? store[k]! : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
}

describe('FAZ UI-5 — Menu Prefs, 20-Segment Army Builder Battery & Hidden 2-Row Deploy Fog', () => {
  it('round-trips UI preferences & Act 4 root/CRT unlock flags cleanly in separate sucs_ui_prefs_v1 key', () => {
    const storage = makeMemStorage();
    const def = createDefaultUiPrefs();
    def.bootSeen = true;
    def.act4Switches = [true, false];
    def.act4Cleared = true;
    def.crtThemeUnlocked = true;
    def.dailyCompleted = { date: '2026-11-25', turns: 9 };
    def.stats.bestRooms = 5;

    expect(saveUiPrefs(def, storage)).toBe(true);
    expect(storage.store[UI_PREFS_STORAGE_KEY]).toBeDefined();
    const loaded = loadUiPrefs(storage);
    expect(loaded).toEqual(def);
  });

  it('computes 20-segment retro battery colors (green -> amber -> ice blue) and exact 20p quick templates', () => {
    const low = computeBudgetBatterySegments(10, 20);
    expect(low).toHaveLength(20);
    expect(low[0]!.tone).toBe('green');
    expect(low.filter((s) => s.filled)).toHaveLength(10);

    const nearFull = computeBudgetBatterySegments(17, 20);
    expect(nearFull[0]!.tone).toBe('amber');

    const full = computeBudgetBatterySegments(20, 20);
    expect(full[19]!.filled).toBe(true);
    expect(full[0]!.tone).toBe('ice');

    const heavy = buildQuickArmyTemplate('HEAVY_CAVALRY', 'sp', 11);
    expect(computeSkirmishRosterCost(heavy)).toBe(20);

    const hearth = buildQuickArmyTemplate('HEARTH_BEAST', 'sp', 11);
    expect(computeSkirmishRosterCost(hearth)).toBe(20);
    expect(hearth.some((u) => u.type === 'CHIMERA')).toBe(true);
    expect(hearth.some((u) => u.type === 'SAINT_FAITH')).toBe(true);

    const randA = buildQuickArmyTemplate('RANDOM_SPREAD', 'sp', 42);
    const randB = buildQuickArmyTemplate('RANDOM_SPREAD', 'sp', 42);
    expect(randA).toEqual(randB);
    expect(computeSkirmishRosterCost(randA)).toBeLessThanOrEqual(20);

    const cleared = buildQuickArmyTemplate('CLEAR', 'sp', 11);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.type).toBe('KING');
  });

  it('hides upper rows in thick UNEXPLORED fog during SKIRMISH_DEPLOY while showing faint wall hints and bright 2 deploy rows', () => {
    const tiles = createEmptyTiles(8, 8);
    tiles[2]![3] = createTile('WALL');
    tiles[1]![5] = createTile('WATCHTOWER');
    tiles[6]![2] = createTile('ICE');

    const playerFog = createDeployVisibilityFog(8, 8, 'PLAYER', tiles);
    expect(playerFog[6]![2]).toBe('VISIBLE');
    expect(playerFog[7]![0]).toBe('VISIBLE');
    expect(playerFog[4]![4]).toBe('UNEXPLORED');
    expect(playerFog[2]![3]).toBe('EXPLORED'); // Wall clue faintly visible
    expect(playerFog[1]![5]).toBe('EXPLORED'); // Watchtower clue faintly visible

    const guestFog = createDeployVisibilityFog(8, 8, 'ENEMY', tiles);
    expect(guestFog[0]![0]).toBe('VISIBLE');
    expect(guestFog[1]![5]).toBe('VISIBLE');
    expect(guestFog[7]![0]).toBe('UNEXPLORED');
  });
});

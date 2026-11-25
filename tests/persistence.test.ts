import { describe, expect, it } from 'vitest';
import {
  createCampaignRun,
  createSkirmishRun,
  generateCampaignRewards,
  generateSkirmishDraftChoices,
} from '../src/data/rewards';
import { computeStateHash } from '../src/engine/prng';
import { stepGame } from '../src/engine/reducer';
import { AppRunState, SAVE_VERSION } from '../src/engine/types';
import {
  clearSavedAppState,
  generateCustomSeed,
  getDailySeed,
  getResumableRunSummary,
  LEGACY_SAVE_STORAGE_KEY,
  loadAiDifficulty,
  loadAppState,
  normalizeSeed,
  SAVE_STORAGE_KEY,
  saveAiDifficulty,
  saveAppState,
  StorageLike,
} from '../src/storage/persistence';

function makeMemoryStorage(): StorageLike & { store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    store,
    getItem: (key: string) => (key in store ? store[key]! : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

describe('Persistence — Versioned localStorage (tfc_save_v1) & Safe Reset', () => {
  it('round-trips Campaign state, battle hash, and settings accurately via tfc_save_v1', () => {
    const storage = makeMemoryStorage();
    const run = createCampaignRun('recon-squad', '2026-11-22');
    // Execute 1 turn pass so actionHistory and turnNumber advance
    const stepped = stepGame(run.currentBattle!, { type: 'END_TURN' });
    const updatedRun = { ...run, currentBattle: stepped.nextState };
    const hashBefore = computeStateHash(updatedRun.currentBattle);

    const payload: AppRunState = {
      saveVersion: SAVE_VERSION,
      screen: 'BATTLE',
      settings: {
        soundEnabled: false,
        soundVolume: 0.4,
        animationSpeed: 2,
        showIntentArrows: false,
      },
      campaign: updatedRun,
      skirmish: null,
    };

    expect(saveAppState(payload, storage)).toBe(true);
    expect(storage.store[SAVE_STORAGE_KEY]).toBeDefined();

    const loaded = loadAppState(storage);
    expect(loaded.status).toBe('OK');
    expect(loaded.state).not.toBeNull();
    expect(loaded.state!.settings).toEqual(payload.settings);
    expect(computeStateHash(loaded.state!.campaign!.currentBattle!)).toBe(hashBefore);

    const summary = getResumableRunSummary(loaded.state);
    expect(summary).not.toBeNull();
    expect(summary!.kind).toBe('CAMPAIGN');
    expect(summary!.targetScreen).toBe('BATTLE');
    expect(summary!.seed).toBe('2026-11-22');
  });

  it('deterministically regenerates identical reward/draft cards after saving and reloading', () => {
    const storage = makeMemoryStorage();
    const camp = { ...createCampaignRun('assassins', 'reload-reward'), currentBattle: null };
    const cardsBefore = generateCampaignRewards(camp).cards;

    saveAppState(
      {
        saveVersion: SAVE_VERSION,
        screen: 'CAMPAIGN_REWARD',
        settings: { soundEnabled: true, soundVolume: 0.65, animationSpeed: 1, showIntentArrows: true },
        campaign: camp,
        skirmish: null,
      },
      storage,
    );

    const loaded = loadAppState(storage);
    expect(loaded.status).toBe('OK');
    expect(getResumableRunSummary(loaded.state)?.targetScreen).toBe('CAMPAIGN_REWARD');
    expect(generateCampaignRewards(loaded.state!.campaign!).cards).toEqual(cardsBefore);

    // Same invariant for Skirmish Draft
    const skir = { ...createSkirmishRun('reload-draft'), lastRoundWinner: 'ENEMY' as const, enemyWins: 1 };
    const draftBefore = generateSkirmishDraftChoices(skir, 'PLAYER');
    saveAppState(
      {
        saveVersion: SAVE_VERSION,
        screen: 'SKIRMISH_DRAFT',
        settings: { soundEnabled: true, soundVolume: 0.65, animationSpeed: 1, showIntentArrows: true },
        campaign: null,
        skirmish: skir,
      },
      storage,
    );
    const loadedSkir = loadAppState(storage);
    expect(getResumableRunSummary(loadedSkir.state)?.targetScreen).toBe('SKIRMISH_DRAFT');
    expect(generateSkirmishDraftChoices(loadedSkir.state!.skirmish!, 'PLAYER').cards).toEqual(
      draftBefore.cards,
    );
  });

  it('safely resets corrupted JSON, mismatched saveVersion, and malformed structures without throwing', () => {
    const storage = makeMemoryStorage();

    // 1) Empty
    expect(loadAppState(storage)).toEqual({ state: null, status: 'EMPTY' });

    // 2) Corrupted JSON
    storage.setItem(SAVE_STORAGE_KEY, '{corrupt::json');
    const corrupt = loadAppState(storage);
    expect(corrupt).toEqual({ state: null, status: 'RESET_CORRUPT' });
    expect(storage.getItem(SAVE_STORAGE_KEY)).toBeNull();

    // 3) Version mismatch
    storage.setItem(
      SAVE_STORAGE_KEY,
      JSON.stringify({
        saveVersion: 99,
        screen: 'MAIN_MENU',
        settings: { soundEnabled: true, soundVolume: 0.5, animationSpeed: 1, showIntentArrows: true },
        campaign: null,
        skirmish: null,
      }),
    );
    const mismatch = loadAppState(storage);
    expect(mismatch).toEqual({ state: null, status: 'RESET_VERSION' });
    expect(storage.getItem(SAVE_STORAGE_KEY)).toBeNull();

    // 4) Malformed payload (invalid screen)
    storage.setItem(
      SAVE_STORAGE_KEY,
      JSON.stringify({
        saveVersion: SAVE_VERSION,
        screen: 'UNKNOWN_SCREEN',
        settings: { soundEnabled: true, soundVolume: 0.5, animationSpeed: 1, showIntentArrows: true },
        campaign: null,
        skirmish: null,
      }),
    );
    const invalid = loadAppState(storage);
    expect(invalid).toEqual({ state: null, status: 'RESET_INVALID' });
    expect(storage.getItem(SAVE_STORAGE_KEY)).toBeNull();

    // 5) Throwing storage adapter gracefully returns UNAVAILABLE / false
    const brokenStorage: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadAppState(brokenStorage)).toEqual({ state: null, status: 'UNAVAILABLE' });
    expect(
      saveAppState(
        {
          saveVersion: SAVE_VERSION,
          screen: 'MAIN_MENU',
          settings: { soundEnabled: true, soundVolume: 0.5, animationSpeed: 1, showIntentArrows: true },
          campaign: null,
          skirmish: null,
        },
        brokenStorage,
      ),
    ).toBe(false);
    expect(() => clearSavedAppState(brokenStorage)).not.toThrow();
  });
});

describe('Daily Seed (YYYY-MM-DD) & Deterministic Custom Seed', () => {
  it('formats YYYY-MM-DD daily seeds cleanly and generates deterministic custom seeds', () => {
    expect(getDailySeed({ year: 2026, month: 3, day: 7 })).toBe('2026-03-07');
    expect(getDailySeed({ year: 2026, month: 11, day: 22 })).toBe('2026-11-22');
    expect(getDailySeed()).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(generateCustomSeed('same-entropy')).toBe(generateCustomSeed('same-entropy'));
    expect(generateCustomSeed('same-entropy')).toMatch(/^SUCS-\d{5}$/);

    expect(normalizeSeed('  my-seed  ', '2026-11-22')).toBe('my-seed');
    expect(normalizeSeed('   ', '2026-11-22')).toBe('2026-11-22');
  });

  it('migrates legacy tfc_save_v1 saves into sucs_save_v1 and persists AI difficulty safely', () => {
    const storage = makeMemoryStorage();
    const legacyPayload: AppRunState = {
      saveVersion: SAVE_VERSION,
      screen: 'MAIN_MENU',
      settings: { soundEnabled: true, soundVolume: 0.7, animationSpeed: 2, showIntentArrows: true },
      campaign: null,
      skirmish: null,
    };
    storage.setItem(LEGACY_SAVE_STORAGE_KEY, JSON.stringify(legacyPayload));

    const loaded = loadAppState(storage);
    expect(loaded.status).toBe('OK');
    expect(loaded.state?.settings.animationSpeed).toBe(2);
    expect(storage.getItem(SAVE_STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem(LEGACY_SAVE_STORAGE_KEY)).toBeNull();

    expect(loadAiDifficulty(storage)).toBe('TENSE');
    expect(saveAiDifficulty('PANIC', storage)).toBe(true);
    expect(loadAiDifficulty(storage)).toBe('PANIC');
  });
});

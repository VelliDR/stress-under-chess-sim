// src/ui/mainMenu.ts
// S.U.C.S. v0.94 — Açılış CRT Isınma Sekansı, Canlı 8x8 Arka Plan Dioraması,
// Paskalya Yumurtalı Çatlak Taçlı Şah Logosu ve 42%/58% Asimetrik Komuta Terminali.

import { AI_DIFFICULTY_PROFILES, type AiDifficulty } from '../ai/sucsAi';
import { createEmptyTiles, createTile } from '../engine/board';
import { createGameState } from '../engine/reducer';
import type { GameEvent, GameState, VisibleState } from '../engine/types';
import { getVisibleStateForPerspective } from '../engine/visibility';
import { getMenuTickerQuotes, type NarrativeTone } from '../data/narrative';
import { CanvasRenderer } from '../render/canvasRenderer';
import { FxQueue } from '../render/fxQueue';
import type { RenderTheme } from '../render/spriteCache';
import { createPieceIconCanvas } from '../render/sprites';
import type { ResumableRunSummary } from '../storage/persistence';
import type { UiPrefsState } from '../storage/uiPrefs';
import { type PixelIconName, renderPixelIconSvg } from './pixelIcons';

export type MenuModeId = 'CAMPAIGN' | 'SKIRMISH' | 'HOTSEAT_2P' | 'SANDBOX';

export interface MainMenuViewOptions {
  rootEl: HTMLElement;
  prefs: UiPrefsState;
  tone: NarrativeTone;
  theme: RenderTheme;
  aiDifficulty: AiDifficulty;
  dailySeed: string;
  resumable: ResumableRunSummary | null;
  saveNotice: string;
  bindButton: (
    label: string,
    onClick: () => void,
    extraClass?: string,
  ) => HTMLButtonElement;
  playHoverSfx: () => void;
  playClickSfx: () => void;
  playBootSfx: () => void;
  soundMuted: boolean;
  onBootSeen: () => void;
  onResumeSavedRun: (summary: ResumableRunSummary) => void;
  onDeleteSave: () => void;
  onSelectCampaign: () => void;
  onStartSkirmish: () => void;
  onCycleAiDifficulty: () => AiDifficulty;
  onStartLocal2P: () => void;
  onEnterSandbox: () => void;
  onApplyDailySeedCampaign: () => void;
  onOpenCodex: () => void;
  onOpenSettings: () => void;
  onToggleMute: () => boolean;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export interface MainMenuControllerHandle {
  destroy: () => void;
  setTone: (tone: NarrativeTone) => void;
  setTheme: (theme: RenderTheme) => void;
  setMutedLabel: (muted: boolean) => void;
  setFullscreenLabel?: (active: boolean) => void;
}

const MODE_PREVIEWS: Record<
  MenuModeId,
  {
    title: string;
    subtitle: string;
    bullets: readonly [string, string, string];
    quoteUnfiltered: string;
    quotePolite: string;
  }
> = {
  CAMPAIGN: {
    title: '[01] STRES SEFERİ',
    subtitle: 'TEK KİŞİLİK ROGUELIKE · PERMADEATH · PERDE 1–3 + GİZLİ 0x00_ÇEKİRDEK',
    bullets: [
      'Kaybettiğin taş bir daha dönmez; Şah düştüğünde tüm koşu sıfırlanır.',
      'Buz kayması, Miasma + Alevli ok kimyası, kablolu baskı plakaları ve 3-fazlı kazıklar.',
      'Ocaklı (7×7 susturma), Meczup (Kanlı Cinnet) ve Efsun Tutmaz Gulyabani ile yüzleş.',
    ],
    quoteUnfiltered: '"Bakalım 30 yıllık ELO enkazıyla Perde 3’ten sağ çıkabilecek misin."',
    quotePolite: '"Üç perde boyunca mutasyonları dengeleyip Büyükusta-OS çekirdeğini devir."',
  },
  SKIRMISH: {
    title: '[02] TAKTİK KRİZ',
    subtitle: 'BEST OF 3 · 20 PUANLIK GİZLİ ORDU · BELIEF-AWARE S.U.C.S. AI',
    bullets: [
      '20 puanlık bütçeyle gizli son 2 sırada ordunu kur, rakibin dizilimi siste kalır.',
      'El kaybeden geri dönüş avantajı olarak Nadir/Epik kirli kart havuzundan çeker.',
      'Sağ üstteki rozetten S.U.C.S. AI kişiliğini (Stajyer / Taktisyen / Panik) tek tıkla çevir.',
    ],
    quoteUnfiltered: '"S.U.C.S. BOT sisin içindeki açıklarını koklayıp seni çukura itmek için bekliyor."',
    quotePolite: '"Gizli dizilim, Pusu ekstra hamlesi ve Nadir el-arası draft ile düelloyu kazan."',
  },
  HOTSEAT_2P: {
    title: '[03] YÜZ YÜZE PANİK',
    subtitle: 'AYNI CİHAZDA 2P · DÖNEN TAHTA · SIRADAKİ TUŞUYLA GEÇİŞ',
    bullets: [
      'Ağ, QR veya kopma derdi yok: İki oyuncu tek telefon ya da bilgisayarda Best-of-3 oynar.',
      'Her hamlede tahta otomatik dönmez; hamleni izle, cihazı ver ve "Sıradaki" tuşuyla 180° çevir.',
      'Her iki taraf da gizli dizilim, savaş sisi ve el-arası geri dönüş draft kartlarını kullanır.',
    ],
    quoteUnfiltered: '"Telefonu arkadaşının eline tutuştur, Sıradaki’ye bassın ve buzdan çukura düşüşünü izle."',
    quotePolite: '"Aynı cihazda iki kişilik, 180° dönen tahta ve kontrollü Sıradaki geçişiyle kararlı düello."',
  },
  SANDBOX: {
    title: '[04] KAOS LABORATUVARI',
    subtitle: 'SANDBOX · KURALLARI KIR · TUZAK & PSİKOLOJİ DENEYLERİ',
    bullets: [
      'Gaz + Ateş domino zinciri, Ocaklı susturma, Meczup cinneti ve Gulyabani evrimini test et.',
      'Sis perspektifini (PLAYER / ENEMY / OMNISCIENT) ve fraksiyon pasiflerini anında değiştir.',
      'Her hamleyi [Z] ile sınırsız geri sar ve ham kararlılık durumlarını incele.',
    ],
    quoteUnfiltered: '"Kuralları kır, kendi taşını okla vurup sonra da beni suçlama."',
    quotePolite: '"Tüm fizik, psikoloji ve tuzak etkileşimlerini kontrollü sahnelerde sına."',
  },
};

const EASTER_EGG_ROASTS_UNF: readonly string[] = [
  '> BÜYÜKUSTA-OS: "Taçlı kafaya tıklamayı kes, parmak izini bile ELO 100 ölçtüm."',
  '> BÜYÜKUSTA-OS: "Her tıkta Şah daha fazla terliyor; az sonra boğulacaksın."',
  '> BÜYÜKUSTA-OS: "Tamam şampiyon, yeterince vurdun — taç kırıldı, şimdi oyunu aç!"',
];

const EASTER_EGG_ROASTS_POL: readonly string[] = [
  '> BÜYÜKUSTA-OS: "Logo kalibrasyonunu zorlama denek; simülasyon zaten hassas."',
  '> BÜYÜKUSTA-OS: "Şah stres seviyesi gereksiz yere yükseliyor, komuta paneline dön."',
  '> BÜYÜKUSTA-OS: "Taç çatlak eşiği aşıldı. İyi şanslar."',
];

function buildMenuDioramaState(): {
  baseState: GameState;
  visible: VisibleState;
  events: GameEvent[];
} {
  const tiles = createEmptyTiles(8, 8);
  for (let x = 2; x <= 5; x++) {
    tiles[3]![x] = createTile('ICE');
    if (x === 3 || x === 4) {
      tiles[3]![x]!.gas = { kind: 'MIASMA', turnsRemaining: 4 };
    }
  }
  tiles[4]![2] = createTile('CRACKED');
  tiles[4]![5] = {
    type: 'PLAIN',
    burnTurns: 0,
    trap: { kind: 'PRESSURE_PLATE', id: 'd_pl', targetIds: ['d_em'], cooldown: 0, maxCooldown: 1 },
  };
  tiles[4]![0] = {
    type: 'WALL',
    burnTurns: 0,
    trap: { kind: 'ARROW_EMITTER', id: 'd_em', dir: { dx: 1, dy: 0 }, ammo: 3, flaming: true, piercing: false },
  };
  tiles[2]![1] = createTile('WATCHTOWER');
  tiles[2]![6] = createTile('PIT');
  tiles[5]![3] = createTile('BURNING', 2);

  const pieces = [
    {
      id: 'dio_king',
      side: 'PLAYER' as const,
      type: 'KING' as const,
      pos: { x: 3, y: 5 },
      traits: [] as never[],
      shieldActive: false,
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE' as const,
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: true,
      composure: 1 as const,
    },
    {
      id: 'dio_ocakli',
      side: 'PLAYER' as const,
      type: 'SAINT_FAITH' as const,
      pos: { x: 2, y: 6 },
      traits: [] as never[],
      shieldActive: true,
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE' as const,
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: true,
      faithCharge: 2,
    },
    {
      id: 'dio_meczup',
      side: 'ENEMY' as const,
      type: 'SAINT_MADNESS' as const,
      pos: { x: 5, y: 2 },
      traits: [] as never[],
      shieldActive: false,
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE' as const,
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: true,
      madnessCharge: 2,
    },
    {
      id: 'dio_gulyabani',
      side: 'ENEMY' as const,
      type: 'CHIMERA' as const,
      pos: { x: 6, y: 1 },
      traits: [] as never[],
      shieldActive: false,
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE' as const,
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: true,
      absorbedForms: [
        { sourceType: 'KNIGHT' as const, copiedTraits: [] },
        { sourceType: 'ROOK' as const, copiedTraits: [] },
      ],
    },
  ];

  const baseState = createGameState({
    width: 8,
    height: 8,
    tiles,
    pieces,
    mode: 'CAMPAIGN',
    seed: 'diorama-v094',
  });
  const visible = getVisibleStateForPerspective(baseState, 'PLAYER', { stressScore: 82 });
  visible.silhouettes.push({ pos: { x: 1, y: 0 }, side: 'ENEMY' });
  visible.silhouettes.push({ pos: { x: 7, y: 2 }, side: 'ENEMY' });

  const demoEvents: GameEvent[] = [
    {
      type: 'PIECE_SLID',
      pieceId: 'dio_king',
      path: [
        { x: 3, y: 3 },
        { x: 4, y: 3 },
        { x: 5, y: 4 },
      ],
      to: { x: 5, y: 4 },
    },
    {
      type: 'PLATE_TRIGGERED',
      plateId: 'd_pl',
      at: { x: 5, y: 4 },
      triggeredByPieceId: 'dio_king',
    },
    {
      type: 'ARROW_FIRED',
      emitterId: 'd_em',
      from: { x: 0, y: 4 },
      path: [
        { x: 1, y: 4 },
        { x: 2, y: 4 },
        { x: 3, y: 4 },
      ],
      flaming: true,
    },
    {
      type: 'GAS_CHAIN_DETONATED',
      origin: { x: 3, y: 3 },
      tiles: [
        { x: 3, y: 3 },
        { x: 4, y: 3 },
      ],
    },
  ];

  return { baseState, visible, events: demoEvents };
}

/**
 * 4.1 & 4.2 S.U.C.S. v0.94 Ana Menü — 0.8s CRT Isınma, Canlı Arka Plan Dioraması,
 * Paskalya Yumurtalı Şah Logosu ve 42%/58% Asimetrik Komuta Ekranı.
 */
export function renderMainMenuView(opts: MainMenuViewOptions): MainMenuControllerHandle {
  const { rootEl, prefs } = opts;
  let currentTone = opts.tone;
  let currentTheme = opts.theme;
  let hoveredMode: MenuModeId = 'CAMPAIGN';
  let easterEggLevel = 0;
  let tickerIndex = 0;
  let forcedRoastText: string | null = null;
  let rafId = 0;
  let lastMs = typeof performance !== 'undefined' ? performance.now() : 0;
  let demoAccumMs = 0;
  let tickerAccumMs = 0;
  let muteBtnRef: HTMLButtonElement | null = null;
  let resizeObs: ResizeObserver | null = null;

  const diorama = buildMenuDioramaState();
  // Sessiz demo motoru (sfxCallback = null — menüde rahatsız edici patlama çalmaz)
  const demoFx = new FxQueue(null, 'menu-diorama');
  demoFx.setCalmScreen(prefs.calmScreen);

  const shell = document.createElement('section');
  shell.className = 'sucs-menu-shell';

  // 1) Canlı Arka Plan Diorama Katmanı (masaüstünde sağ %58 + tam arka plan derinliği)
  const backdropWrap = document.createElement('div');
  backdropWrap.className = 'sucs-diorama-backdrop';
  const dioramaCanvas = document.createElement('canvas');
  dioramaCanvas.setAttribute('aria-hidden', 'true');
  backdropWrap.appendChild(dioramaCanvas);
  const dioramaScrim = document.createElement('div');
  dioramaScrim.className = 'sucs-diorama-scrim';
  backdropWrap.appendChild(dioramaScrim);
  shell.appendChild(backdropWrap);

  // CRT Tarama Çizgileri Katmanı
  if (prefs.crtScanlines !== 'off') {
    const scanOverlay = document.createElement('div');
    scanOverlay.className =
      prefs.crtScanlines === 'retro' ? 'sucs-crt-scanlines is-retro' : 'sucs-crt-scanlines';
    shell.appendChild(scanOverlay);
  }

  // 2) Ön Plan Grid: Sol %42 Komuta Paneli + Sağ %58 Mod Önizleme
  const layoutGrid = document.createElement('div');
  layoutGrid.className = 'sucs-menu-grid';

  const leftCol = document.createElement('div');
  leftCol.className = 'sucs-menu-left';

  // Logo + Easter Egg (tıkladıkça terleyen & çatlayan Şah ikonu)
  const logoRow = document.createElement('div');
  logoRow.className = 'sucs-menu-header';
  const logoBtn = document.createElement('button');
  logoBtn.type = 'button';
  logoBtn.className = 'sucs-logo-easter-btn';
  logoBtn.title = 'Çatlak taçlı Şah (tıklamayı dene)';
  const redrawLogo = (): void => {
    logoBtn.innerHTML = '';
    const iconCanvas = createPieceIconCanvas('KING', 'PLAYER', 44, currentTheme, false);
    if (iconCanvas !== null) {
      if (easterEggLevel > 0) {
        const ctx = iconCanvas.getContext('2d');
        if (ctx !== null) {
          // Ekstra ter damlaları & çatlak izleri
          ctx.fillStyle = '#38bdf8';
          const dropCount = Math.min(4, easterEggLevel);
          for (let d = 0; d < dropCount; d++) {
            ctx.fillRect(6 + d * 8, 12 + (d % 2) * 5, 3, 4);
          }
          if (easterEggLevel >= 2) {
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(18, 4, 2, 7);
            ctx.fillRect(20, 8, 2, 5);
          }
        }
      }
      logoBtn.appendChild(iconCanvas);
    }
  };
  redrawLogo();

  const titleWrap = document.createElement('div');
  titleWrap.innerHTML =
    '<div class="tfc-hero-eyebrow">S.U.C.S. v0.94 // BÜYÜKUSTA-OS</div>' +
    '<h2 class="sucs-menu-title">STRESS UNDER CHESS SIMULATOR</h2>' +
    '<div class="tfc-hero-slogan">Sis, tuzak kimyası ve sinir krizi altında taktik roguelike satranç.</div>';

  logoBtn.addEventListener('click', () => {
    opts.playClickSfx();
    easterEggLevel++;
    redrawLogo();
    const roasts =
      currentTone === 'unfiltered' ? EASTER_EGG_ROASTS_UNF : EASTER_EGG_ROASTS_POL;
    forcedRoastText = roasts[(easterEggLevel - 1) % roasts.length]!;
    syncTickerDom();
  });

  logoRow.append(logoBtn, titleWrap);
  leftCol.appendChild(logoRow);

  if (opts.saveNotice) {
    const noticeEl = document.createElement('div');
    noticeEl.className = 'tfc-status-banner is-warn';
    noticeEl.textContent = opts.saveNotice;
    leftCol.appendChild(noticeEl);
  }

  // Koşullu En Üst Kart: [▶ DEVAM ET]
  if (opts.resumable !== null) {
    const resCard = document.createElement('div');
    resCard.className = 'sucs-resume-card';
    const meta = document.createElement('div');
    meta.innerHTML =
      `<div class="sucs-resume-title">▶ DEVAM ET · ${opts.resumable.title}</div>` +
      `<div class="sucs-resume-sub">${opts.resumable.detail} · TOHUM #${opts.resumable.seed}</div>`;

    const resActions = document.createElement('div');
    resActions.className = 'tfc-btn-group';
    resActions.appendChild(
      opts.bindButton(
        'DEVAM ET →',
        () => opts.onResumeSavedRun(opts.resumable!),
        'is-gold',
      ),
    );
    resActions.appendChild(
      opts.bindButton('SİL', () => opts.onDeleteSave(), 'is-danger'),
    );
    resCard.append(meta, resActions);
    leftCol.appendChild(resCard);
  }

  // Komuta Satırları ([01]..[04])
  const cmdList = document.createElement('div');
  cmdList.className = 'sucs-cmd-list';

  const swDone = (prefs.act4Switches[0] ? 1 : 0) + (prefs.act4Switches[1] ? 1 : 0);
  let activeAi = opts.aiDifficulty;

  const makeCmdRow = (optsRow: {
    mode: MenuModeId;
    num: string;
    title: string;
    sub: string;
    onClick: () => void;
    rightSlot?: HTMLElement;
  }): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'sucs-cmd-row' + (hoveredMode === optsRow.mode ? ' is-focused' : '');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'sucs-cmd-trigger';

    const cursorSpan = document.createElement('span');
    cursorSpan.className = 'sucs-cmd-cursor';
    cursorSpan.textContent = '>';

    const body = document.createElement('div');
    body.className = 'sucs-cmd-body';
    body.innerHTML =
      `<div class="sucs-cmd-title"><span class="sucs-cmd-num">[${optsRow.num}]</span> ${optsRow.title}</div>` +
      `<div class="sucs-cmd-sub">${optsRow.sub}</div>`;

    trigger.append(cursorSpan, body);
    row.appendChild(trigger);
    if (optsRow.rightSlot !== undefined) {
      const slotWrap = document.createElement('div');
      slotWrap.className = 'sucs-cmd-right';
      slotWrap.appendChild(optsRow.rightSlot);
      row.appendChild(slotWrap);
    }

    const activateHover = (): void => {
      if (hoveredMode !== optsRow.mode) {
        hoveredMode = optsRow.mode;
        opts.playHoverSfx();
        syncPreviewPanel();
        const allRows = cmdList.querySelectorAll('.sucs-cmd-row');
        allRows.forEach((el) => el.classList.remove('is-focused'));
        row.classList.add('is-focused');
      }
    };
    row.addEventListener('pointerenter', activateHover);
    trigger.addEventListener('focus', activateHover);
    trigger.addEventListener('click', () => {
      opts.playClickSfx();
      optsRow.onClick();
    });
    return row;
  };

  const act4Chip = document.createElement('span');
  act4Chip.className = 'tfc-badge';
  act4Chip.textContent = prefs.act4Cleared ? 'ROOT ★' : `[${swDone}/2]`;

  const aiPill = document.createElement('button');
  aiPill.type = 'button';
  aiPill.className = 'sucs-inline-pill';
  const syncAiPill = (): void => {
    const prof = AI_DIFFICULTY_PROFILES[activeAi];
    aiPill.textContent = prof.name.toLocaleUpperCase('tr-TR');
    aiPill.title = `${prof.badge}: ${prof.subtitle} (değiştirmek için tıkla)`;
  };
  syncAiPill();
  aiPill.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.playClickSfx();
    activeAi = opts.onCycleAiDifficulty();
    syncAiPill();
  });

  const hotseatChip = document.createElement('span');
  hotseatChip.className = 'tfc-badge';
  hotseatChip.textContent = '2P · 180° ↻';

  const sandboxChip = document.createElement('span');
  sandboxChip.className = 'tfc-badge';
  sandboxChip.textContent = 'Z · R · SIS';

  cmdList.append(
    makeCmdRow({
      mode: 'CAMPAIGN',
      num: '01',
      title: 'STRES SEFERİ',
      sub: 'Perde 1–3 + Gizli Perde 4 · Permadeath Roguelike',
      onClick: opts.onSelectCampaign,
      rightSlot: act4Chip,
    }),
    makeCmdRow({
      mode: 'SKIRMISH',
      num: '02',
      title: 'TAKTİK KRİZ',
      sub: 'Best-of-3 Asimetrik Düello vs AI · 20p Gizli Ordu',
      onClick: opts.onStartSkirmish,
      rightSlot: aiPill,
    }),
    makeCmdRow({
      mode: 'HOTSEAT_2P',
      num: '03',
      title: 'YÜZ YÜZE PANİK',
      sub: 'Aynı Cihazda 2P · Dönen Tahta & Sıradaki Tuşu',
      onClick: opts.onStartLocal2P,
      rightSlot: hotseatChip,
    }),
    makeCmdRow({
      mode: 'SANDBOX',
      num: '04',
      title: 'KAOS LABORATUVARI',
      sub: 'Kuralları kır, tuzak ve psikoloji komboları dene',
      onClick: opts.onEnterSandbox,
      rightSlot: sandboxChip,
    }),
  );
  leftCol.appendChild(cmdList);

  // Alt Yardımcı Çubuk: GÜNLÜK TOHUM · REHBER · SİSTEM · SES
  const utilBar = document.createElement('div');
  utilBar.className = 'sucs-util-bar';
  const dailyDone = prefs.dailyCompleted?.date === opts.dailySeed;
  const dailyLabel = dailyDone
    ? `✓ GÜNLÜK (${opts.dailySeed} · ${prefs.dailyCompleted!.turns}t)`
    : `GÜNLÜK TOHUM (${opts.dailySeed})`;
  const dailyBtn = opts.bindButton(
    dailyLabel,
    opts.onApplyDailySeedCampaign,
    dailyDone ? 'is-active' : '',
  );
  const codexBtn = opts.bindButton('REHBER', opts.onOpenCodex);
  const sysBtn = opts.bindButton('SİSTEM', opts.onOpenSettings);
  muteBtnRef = opts.bindButton('', () => {
    const nowMuted = opts.onToggleMute();
    if (muteBtnRef !== null) {
      muteBtnRef.innerHTML = `${renderPixelIconSvg(nowMuted ? 'soundOff' : 'soundOn', 14)}<span>${nowMuted ? 'SES KAPALI' : 'SES AÇIK'}</span>`;
    }
  });
  muteBtnRef.innerHTML = `${renderPixelIconSvg(opts.soundMuted ? 'soundOff' : 'soundOn', 14)}<span>${opts.soundMuted ? 'SES KAPALI' : 'SES AÇIK'}</span>`;

  let fsBtnRef: HTMLButtonElement | null = null;
  if (opts.onToggleFullscreen !== undefined) {
    fsBtnRef = opts.bindButton('', () => opts.onToggleFullscreen?.());
    const syncFs = (active: boolean): void => {
      if (fsBtnRef === null) return;
      const ic: PixelIconName = active ? 'fullscreenExit' : 'fullscreenEnter';
      fsBtnRef.innerHTML = `${renderPixelIconSvg(ic, 14)}<span>${active ? 'ÇIK [F]' : 'TAM EKRAN [F]'}</span>`;
      fsBtnRef.classList.toggle('is-active', active);
    };
    syncFs(opts.isFullscreen === true);
    utilBar.append(dailyBtn, codexBtn, sysBtn, muteBtnRef, fsBtnRef);
  } else {
    utilBar.append(dailyBtn, codexBtn, sysBtn, muteBtnRef);
  }
  leftCol.appendChild(utilBar);

  // Sağ %58 Önizleme Kartı (Canlı Dioramanın Üzerinde Yarı Saydam)
  const rightCol = document.createElement('div');
  rightCol.className = 'sucs-menu-right';
  const previewCard = document.createElement('div');
  previewCard.className = 'sucs-preview-card';
  const syncPreviewPanel = (): void => {
    const info = MODE_PREVIEWS[hoveredMode];
    const statLine =
      prefs.stats.bestRooms > 0 || prefs.stats.totalCaptures > 0
        ? `REKOR: ${prefs.stats.bestRooms} ODA · ${prefs.stats.totalCaptures} YEME · MAX STRES %${prefs.stats.peakStress}`
        : 'REKOR: KAYIT BEKLENİYOR // İLK ÇÖKÜŞÜNÜ YAŞA';
    const quote = currentTone === 'unfiltered' ? info.quoteUnfiltered : info.quotePolite;
    previewCard.innerHTML =
      `<div class="sucs-preview-eyebrow">${info.subtitle}</div>` +
      `<h3>${info.title}</h3>` +
      `<ul class="sucs-preview-bullets">` +
      info.bullets.map((b) => `<li>${b}</li>`).join('') +
      `</ul>` +
      `<div class="sucs-preview-stat">${statLine}</div>` +
      `<div class="sucs-preview-quote">${quote}</div>`;
  };
  syncPreviewPanel();
  rightCol.appendChild(previewCard);

  layoutGrid.append(leftCol, rightCol);
  shell.appendChild(layoutGrid);

  // En Alt Bant: BÜYÜKUSTA-OS KAYAN BANDI (her 7 sn'de değişir; tone ile anında güncellenir)
  const tickerBar = document.createElement('div');
  tickerBar.className = 'sucs-ticker-bar';
  const tickerTextEl = document.createElement('div');
  tickerTextEl.className = 'sucs-ticker-text';
  tickerBar.appendChild(tickerTextEl);
  shell.appendChild(tickerBar);

  const syncTickerDom = (): void => {
    if (forcedRoastText !== null) {
      tickerTextEl.textContent = forcedRoastText;
      return;
    }
    const pool = getMenuTickerQuotes(currentTone);
    const clean = pool[tickerIndex % pool.length]!.replace(/\{\/?(shake|wave|pop)\}/g, '');
    tickerTextEl.textContent = clean;
  };
  syncTickerDom();

  // Açılış CRT Isınma Sekansı (ilk açılışta 0.8s, ikincide 0.3s, tek tıkla geçilebilir)
  let bootTimerId: ReturnType<typeof setTimeout> | null = null;
  if (typeof document !== 'undefined') {
    const bootEl = document.createElement('div');
    bootEl.className = 'sucs-boot-overlay';
    const bootMs = prefs.bootSeen ? 300 : 800;
    bootEl.style.setProperty('--boot-dur', `${bootMs}ms`);
    bootEl.innerHTML =
      '<div class="sucs-boot-line"></div>' +
      '<div class="sucs-boot-term">' +
      '<div>S.U.C.S. v0.94 BOOT...</div>' +
      '<div>BÜYÜKUSTA-OS: AKTİF</div>' +
      '<div style="color:#f87171;">UYARI: DENEK NABZI YÜKSEK</div>' +
      '</div>';
    const finishBoot = (): void => {
      if (bootTimerId !== null) {
        clearTimeout(bootTimerId);
        bootTimerId = null;
      }
      bootEl.remove();
      opts.onBootSeen();
    };
    bootEl.addEventListener('click', () => {
      opts.playBootSfx();
      finishBoot();
    });
    shell.appendChild(bootEl);
    bootTimerId = setTimeout(finishBoot, bootMs);
  }

  rootEl.appendChild(shell);

  // Headless-safe CanvasRenderer + canlı animasyon döngüsü
  let renderer: CanvasRenderer | null = null;
  try {
    renderer = new CanvasRenderer(dioramaCanvas, undefined, { theme: currentTheme });
  } catch {
    renderer = null;
  }

  const syncDioramaSize = (): void => {
    if (renderer === null) return;
    const rect = backdropWrap.getBoundingClientRect();
    const w = Math.max(320, rect.width || 960);
    const h = Math.max(240, rect.height || 600);
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    renderer.resize(w, h, dpr);
  };

  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(syncDioramaSize);
    resizeObs.observe(backdropWrap);
  }
  syncDioramaSize();

  if (typeof requestAnimationFrame === 'function') {
    const tick = (nowMs: number): void => {
      const dt = Math.max(0, Math.min(100, nowMs - lastMs));
      lastMs = nowMs;
      demoAccumMs += dt;
      tickerAccumMs += dt;

      if (demoAccumMs >= 9000 && !demoFx.hasActiveSteps()) {
        demoAccumMs = 0;
        demoFx.enqueue(diorama.events, diorama.baseState.pieces, diorama.visible, diorama.visible);
      }
      if (tickerAccumMs >= 7000) {
        tickerAccumMs = 0;
        forcedRoastText = null;
        tickerIndex++;
        syncTickerDom();
      }

      demoFx.update(dt);
      if (renderer !== null) {
        renderer.render(diorama.visible, {
          selectedCoord: null,
          inspectedCoord: null,
          hoveredCoord: null,
          legalMoves: [],
          legalAbilities: [],
          activeAbility: null,
          fx: demoFx.getSnapshot(),
          timeMs: nowMs,
          theme: currentTheme,
          stressScore: 80 + Math.min(18, easterEggLevel * 4),
          calmScreen: prefs.calmScreen,
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  return {
    destroy: () => {
      if (bootTimerId !== null) clearTimeout(bootTimerId);
      if (rafId !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      resizeObs?.disconnect();
      renderer?.destroy();
    },
    setTone: (tone) => {
      currentTone = tone;
      forcedRoastText = null;
      syncPreviewPanel();
      syncTickerDom();
    },
    setTheme: (theme) => {
      currentTheme = theme;
      renderer?.setTheme(theme);
      redrawLogo();
    },
    setMutedLabel: (muted) => {
      if (muteBtnRef !== null) {
        muteBtnRef.innerHTML = `${renderPixelIconSvg(muted ? 'soundOff' : 'soundOn', 14)}<span>${muted ? 'SES KAPALI' : 'SES AÇIK'}</span>`;
      }
    },
    setFullscreenLabel: (active) => {
      if (fsBtnRef !== null) {
        const ic: PixelIconName = active ? 'fullscreenExit' : 'fullscreenEnter';
        fsBtnRef.innerHTML = `${renderPixelIconSvg(ic, 14)}<span>${active ? 'ÇIK [F]' : 'TAM EKRAN [F]'}</span>`;
        fsBtnRef.classList.toggle('is-active', active);
      }
    },
  };
}

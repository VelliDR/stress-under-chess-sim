// src/ui/squadSelect.ts
// S.U.C.S. — 4+1 Taktik Dosya Kartlı Manga Seçim Ekranı (Canlı 24x24 Sprite + Risk Ölçeri + Tohum Zar).

import { ALL_STARTER_SQUADS } from '../data/squads';
import type { RenderTheme } from '../render/spriteCache';
import { createPieceIconCanvas } from '../render/sprites';
import { generateCustomSeed, getDailySeed, normalizeSeed } from '../storage/persistence';
import type { UiPrefsState } from '../storage/uiPrefs';

export interface SquadSelectViewOptions {
  rootEl: HTMLElement;
  seedInput: string;
  selectedAct: 1 | 2 | 3;
  prefs: UiPrefsState;
  theme: RenderTheme;
  pieceNames: Readonly<Record<string, string>>;
  bindButton: (label: string, onClick: () => void, extraClass?: string) => HTMLButtonElement;
  playSelectSfx: () => void;
  onChangeSeed: (seed: string) => void;
  onSelectAct: (act: 1 | 2 | 3) => void;
  onStartSquad: (squadId: string) => void;
  onStartSecretRootSquad: () => void;
  onBack: () => void;
}

const SQUAD_RISK_NOTCHES: Readonly<Record<string, 1 | 2 | 3>> = {
  'recon-squad': 1,
  'siege-corps': 2,
  assassins: 3,
  'cult-and-beast': 3,
};

const TRAIT_LABEL_TR: Readonly<Record<string, string>> = {
  SHIELDED: 'Zırhlı',
  FROST_TOUCH: 'Buz',
  EXPLOSIVE: 'Patlayıcı',
  SCOUT: 'Gözcü',
  SHADOW_WALKER: 'Gölge',
  PUSHER: 'İtici',
  DASH_ON_REVEAL: 'Pusu',
};

const TRAIT_SHORT_TR: Readonly<Record<string, string>> = {
  SHIELDED: 'ZRH',
  FROST_TOUCH: 'BUZ',
  EXPLOSIVE: 'PAT',
  SCOUT: 'GÖZ',
  SHADOW_WALKER: 'GLG',
  PUSHER: 'İT',
  DASH_ON_REVEAL: 'PSU',
};

export function renderSquadSelectView(opts: SquadSelectViewOptions): void {
  const wrap = document.createElement('section');
  wrap.className = 'tfc-screen-center';

  const actLabels: Record<1 | 2 | 3, { title: string; desc: string }> = {
    1: {
      title: 'Perde 1 · Buzul Kuşatması',
      desc: 'Klasik 4 çatışma + Buzul Boss. Başlangıç dengesi.',
    },
    2: {
      title: 'Perde 2 · Zindan Kimyası',
      desc: 'Miasma gaz zinciri, kablolu ok tuzakları, çatlak zemin, kazıklar + KİMYAGER-OS.',
    },
    3: {
      title: 'Perde 3 · Psikoloji & Gulyabani',
      desc: '45° yalpalama, Ocaklı (7×7 susturma), Meczup (cinnet) ve Efsun Tutmaz Gulyabani + BÜYÜKUSTA-OS.',
    },
  };

  // Üst Satır: Başlık + Sağ Üstte Özel Tohum & Zar Üretici
  const topBar = document.createElement('div');
  topBar.className = 'sucs-squad-topbar';

  const hero = document.createElement('div');
  hero.className = 'tfc-hero';
  hero.style.textAlign = 'left';
  hero.innerHTML =
    '<h2>[01] Taktik Manga Dosyası & Perde Seçimi</h2>' +
    `<p><strong>${actLabels[opts.selectedAct].title}</strong> — ${actLabels[opts.selectedAct].desc}</p>`;

  const seedWrap = document.createElement('div');
  seedWrap.className = 'tfc-seed-bar';
  const seedLbl = document.createElement('label');
  seedLbl.textContent = 'Tohum:';
  const seedInput = document.createElement('input');
  seedInput.type = 'text';
  seedInput.className = 'tfc-input';
  seedInput.value = opts.seedInput;
  seedInput.placeholder = getDailySeed();
  seedInput.addEventListener('input', () => {
    opts.onChangeSeed(normalizeSeed(seedInput.value, getDailySeed()));
  });
  let rollCount = 1;
  const diceBtn = opts.bindButton('🎲 Zar', () => {
    const fresh = generateCustomSeed(`${Date.now()}-${rollCount++}`);
    seedInput.value = fresh;
    opts.onChangeSeed(fresh);
    opts.playSelectSfx();
  });
  seedWrap.append(seedLbl, seedInput, diceBtn);
  topBar.append(hero, seedWrap);

  // Perde Seçici
  const actBar = document.createElement('div');
  actBar.className = 'tfc-btn-group';
  actBar.style.justifyContent = 'center';
  for (const actNum of [1, 2, 3] as const) {
    actBar.appendChild(
      opts.bindButton(
        actLabels[actNum].title,
        () => opts.onSelectAct(actNum),
        opts.selectedAct === actNum ? 'is-primary' : '',
      ),
    );
  }

  // 4 + 1 Taktik Dosya Kartları
  const grid = document.createElement('div');
  grid.className = 'sucs-dossier-grid';

  for (let i = 0; i < ALL_STARTER_SQUADS.length; i++) {
    const squad = ALL_STARTER_SQUADS[i]!;
    const card = document.createElement('div');
    card.className = 'tfc-choice-card sucs-dossier-card';

    // Canlı 24x24 taş dizilimi önizlemesi (6 taş tek satırda hizalı)
    const previewStrip = document.createElement('div');
    previewStrip.className = 'sucs-sprite-lineup';
    for (let u = 0; u < squad.units.length; u++) {
      const unit = squad.units[u]!;
      const slot = document.createElement('div');
      slot.className = 'sucs-sprite-chip';
      const iconCanvas = createPieceIconCanvas(unit.type, 'PLAYER', 24, opts.theme, false);
      if (iconCanvas !== null) {
        slot.appendChild(iconCanvas);
      }
      if (unit.traits.length > 0) {
        const tId = unit.traits[0]!;
        const badge = document.createElement('span');
        badge.className = 'sucs-chip-trait';
        badge.textContent = TRAIT_SHORT_TR[tId] ?? tId.slice(0, 3);
        badge.title = unit.traits.map((t) => TRAIT_LABEL_TR[t] ?? t).join(', ');
        slot.appendChild(badge);
      }
      previewStrip.appendChild(slot);
    }

    const risk = SQUAD_RISK_NOTCHES[squad.id] ?? 2;
    const riskBar = document.createElement('div');
    riskBar.className = 'sucs-risk-meter';
    riskBar.innerHTML =
      `<span>RİSK:</span>` +
      [1, 2, 3]
        .map((n) => `<span class="sucs-risk-notch${n <= risk ? ' is-lit' : ''}"></span>`)
        .join('');

    const head = document.createElement('div');
    head.className = 'sucs-dossier-head';
    const sub = document.createElement('div');
    sub.className = 'tfc-choice-subtitle';
    sub.textContent = squad.tagline;
    head.append(sub, riskBar);

    const h3 = document.createElement('h3');
    h3.textContent = squad.name;

    const desc = document.createElement('p');
    desc.textContent = squad.description;

    const pills = document.createElement('div');
    pills.className = 'tfc-unit-pills';
    for (let u = 0; u < squad.units.length; u++) {
      const unit = squad.units[u]!;
      const pill = document.createElement('span');
      pill.className = 'tfc-unit-pill';
      const baseName = opts.pieceNames[unit.type] ?? unit.type;
      const trTraits = unit.traits.map((t) => TRAIT_LABEL_TR[t] ?? t);
      pill.textContent = trTraits.length > 0 ? `${baseName} (${trTraits.join(', ')})` : baseName;
      pills.appendChild(pill);
    }

    const pickBtn = opts.bindButton(
      `${squad.name} ile Başla →`,
      () => opts.onStartSquad(squad.id),
      'is-primary',
    );

    card.append(head, previewStrip, h3, desc, pills, pickBtn);
    grid.appendChild(card);
  }

  // 5. Gizli Dosya: Kök Erişim (0x00_ROOT) — Tam genişlikli kompakt yatay şerit (ekran dışına taşmaz)
  const rootUnlocked = opts.prefs.act4Cleared;
  const swCount = (opts.prefs.act4Switches[0] ? 1 : 0) + (opts.prefs.act4Switches[1] ? 1 : 0);
  const rootBanner = document.createElement('div');
  rootBanner.className =
    'sucs-root-banner sucs-root-card' + (rootUnlocked ? ' is-rare' : ' is-locked');
  const rootInfo = document.createElement('div');
  rootInfo.className = 'sucs-root-banner-info';
  rootInfo.innerHTML = rootUnlocked
    ? '<div class="tfc-choice-subtitle" style="color:#4ade80;">0x00_ROOT // AÇILDI</div>' +
      '<h3>Kök Erişim (Root Manga)</h3>' +
      '<p>Çekirdek kırıldı: Şah + Gulyabani + Ocaklı + Meczup ile doğrudan anomali seferi.</p>'
    : `<div class="tfc-choice-subtitle" style="color:#f43f5e;">KİLİTLİ DOSYA // 0x00_ROOT (${swCount}/2 ANAHTAR)</div>` +
      '<h3>Kök Erişim — Gizli Perde 4 Mangası</h3>' +
      '<p>Perde 2 ve Perde 3’teki 2 gizli şalteri bulup Çekirdeği aştığında açılır.</p>';

  const rootBtn = opts.bindButton(
    rootUnlocked ? 'Kök Erişimi Başlat →' : 'PERDE 4 GEREKLİ',
    () => {
      if (rootUnlocked) opts.onStartSecretRootSquad();
    },
    rootUnlocked ? 'is-gold' : '',
  );
  rootBtn.disabled = !rootUnlocked;
  rootBanner.append(rootInfo, rootBtn);

  // Üst çubukta zaten "← Ana Menü" bulunduğu için tekrarlı alt buton kaldırıldı
  wrap.className = 'tfc-screen-center sucs-squad-screen';
  wrap.append(topBar, actBar, grid, rootBanner);
  opts.rootEl.appendChild(wrap);
}

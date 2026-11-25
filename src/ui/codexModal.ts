// src/ui/codexModal.ts
// S.U.C.S. — 4 Sekmeli Saha Rehberi & Ansiklopedi Modalı (Veri kaybı olmadan hem Menü'den hem Esc Duraklatma'dan açılır).

import { ALL_SKIRMISH_UNIT_CATALOG } from '../data/squads';
import type { PieceType, TraitId } from '../engine/types';
import type { RenderTheme } from '../render/spriteCache';
import { createPieceIconCanvas } from '../render/sprites';
import type { UiPrefsState } from '../storage/uiPrefs';

export type CodexTabId = 'UNITS' | 'TRAPS' | 'PSYCH' | 'LOGS';

export interface CodexModalOptions {
  prefs: UiPrefsState;
  theme: RenderTheme;
  pieceNames: Readonly<Record<PieceType, string>>;
  traitInfo: Readonly<Record<TraitId, { name: string; desc: string }>>;
  playClickSfx: () => void;
  onClose?: () => void;
}

const PIECE_DIAGRAM_HINT: Readonly<Record<PieceType, string>> = {
  PAWN: '↑ 1 kare ileri, ↗↖ çapraz yeme; son sırada Vezir terfisi.',
  KNIGHT: 'L atlayışı (duvar ve çukur üstünden atlar, buzda kaymaz).',
  BISHOP: 'Sınırsız çapraz (Kırılgan iken 3. karede 45° kavisli yalpalama yapabilir).',
  ROOK: 'Sınırsız yatay/dikey kayma (Duvar Kırma / İtme kombolarıyla uyumlu).',
  QUEEN: '8 yönde sınırsız menzil; yüksek bütçeli birincil tehdit (9p).',
  KING: 'Her yöne 1 kare; stres/tehditte terler, düşerse anında oyun biter.',
  SAINT_FAITH: '2× Şah adımı; 5×5 Arınma aurası + 3. turda Nazar Boncuğu & 7×7 Susturma.',
  SAINT_MADNESS: '2× Şah adımı; 5×5 Zırh Delici aura + 3. turda Deli Davulu & Kanlı Cinnet zinciri.',
  CHIMERA: '3× Şah adımı; Efsun Tutmaz (tam debuff bağışıklığı) + 2 yuvalı FIFO kılık çalma.',
};

const ALL_TRAIT_ORDER: readonly TraitId[] = [
  'SHIELDED',
  'FROST_TOUCH',
  'EXPLOSIVE',
  'SCOUT',
  'SHADOW_WALKER',
  'PUSHER',
  'DASH_ON_REVEAL',
];

export class CodexModal {
  private readonly opts: CodexModalOptions;
  private overlayEl: HTMLDivElement | null = null;
  private bodyEl: HTMLDivElement | null = null;
  private tabButtons: Partial<Record<CodexTabId, HTMLButtonElement>> = {};
  private activeTab: CodexTabId = 'UNITS';

  public constructor(opts: CodexModalOptions) {
    this.opts = opts;
  }

  public isOpen(): boolean {
    return this.overlayEl !== null;
  }

  public open(parent: HTMLElement = document.body, initialTab: CodexTabId = 'UNITS'): void {
    this.close();
    this.activeTab = initialTab;

    const overlay = document.createElement('div');
    overlay.className = 'tfc-modal-backdrop';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Saha Rehberi ve Ansiklopedi');

    const card = document.createElement('div');
    card.className = 'tfc-modal-card sucs-codex-card';

    const header = document.createElement('div');
    header.className = 'tfc-modal-header';
    const titleWrap = document.createElement('div');
    titleWrap.innerHTML =
      '<h2>Saha Rehberi & Ansiklopedi (Codex v0.94)</h2>' +
      '<p>9 birim profili, zindan kimyası şemaları, psikoloji kuralları ve Büyükusta-OS arşivleri.</p>';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tfc-btn';
    closeBtn.textContent = '✕ Kapat [Esc]';
    closeBtn.addEventListener('click', () => {
      this.opts.playClickSfx();
      this.close();
    });
    header.append(titleWrap, closeBtn);

    const tabsRow = document.createElement('div');
    tabsRow.className = 'tfc-btn-group sucs-codex-tabs';
    const tabs: ReadonlyArray<{ id: CodexTabId; label: string }> = [
      { id: 'UNITS', label: '1. Birimler (9)' },
      { id: 'TRAPS', label: '2. Zemin & Tuzaklar' },
      { id: 'PSYCH', label: '3. Psikoloji & Mutasyonlar' },
      { id: 'LOGS', label: '4. Büyükusta-OS Kayıtları' },
    ];
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i]!;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tfc-btn' + (t.id === this.activeTab ? ' is-active' : '');
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        this.opts.playClickSfx();
        this.activeTab = t.id;
        this.syncTabsAndBody();
      });
      this.tabButtons[t.id] = btn;
      tabsRow.appendChild(btn);
    }

    const body = document.createElement('div');
    body.className = 'sucs-codex-body';
    this.bodyEl = body;

    card.append(header, tabsRow, body);
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    parent.appendChild(overlay);
    this.overlayEl = overlay;

    this.syncTabsAndBody();
  }

  public close(): void {
    if (this.overlayEl !== null) {
      this.overlayEl.remove();
      this.overlayEl = null;
      this.bodyEl = null;
      this.tabButtons = {};
      this.opts.onClose?.();
    }
  }

  private syncTabsAndBody(): void {
    (['UNITS', 'TRAPS', 'PSYCH', 'LOGS'] as CodexTabId[]).forEach((id) => {
      this.tabButtons[id]?.classList.toggle('is-active', id === this.activeTab);
    });
    if (this.bodyEl === null) return;
    this.bodyEl.innerHTML = '';

    if (this.activeTab === 'UNITS') {
      this.renderUnitsTab(this.bodyEl);
    } else if (this.activeTab === 'TRAPS') {
      this.renderTrapsTab(this.bodyEl);
    } else if (this.activeTab === 'PSYCH') {
      this.renderPsychTab(this.bodyEl);
    } else {
      this.renderLogsTab(this.bodyEl);
    }
  }

  private renderUnitsTab(container: HTMLElement): void {
    const grid = document.createElement('div');
    grid.className = 'sucs-codex-grid';
    const types: readonly PieceType[] = [
      'PAWN',
      'KNIGHT',
      'BISHOP',
      'ROOK',
      'QUEEN',
      'KING',
      'SAINT_FAITH',
      'SAINT_MADNESS',
      'CHIMERA',
    ];

    for (let i = 0; i < types.length; i++) {
      const t = types[i]!;
      const cat = ALL_SKIRMISH_UNIT_CATALOG.find((c) => c.type === t && c.traits.length === 0);
      const card = document.createElement('div');
      card.className = 'sucs-codex-item';

      const top = document.createElement('div');
      top.className = 'sucs-codex-item-head';
      const icon = createPieceIconCanvas(t, 'PLAYER', 44, this.opts.theme, false);
      if (icon !== null) top.appendChild(icon);

      const meta = document.createElement('div');
      const costText = t === 'KING' ? 'LİDER' : `${cat?.cost ?? '?'}P`;
      meta.innerHTML =
        `<div class="sucs-codex-title-row"><strong>${this.opts.pieceNames[t]}</strong><span class="tfc-badge">${costText}</span></div>` +
        `<div class="sucs-codex-desc">${PIECE_DIAGRAM_HINT[t]}</div>`;
      top.appendChild(meta);
      card.appendChild(top);
      grid.appendChild(card);
    }
    container.appendChild(grid);
  }

  private renderTrapsTab(container: HTMLElement): void {
    const items: ReadonlyArray<{ title: string; badge: string; desc: string }> = [
      {
        title: 'Buz (ICE) & Gözcü Kulesi (WATCHTOWER)',
        badge: 'ZEMİN FİZİĞİ',
        desc: 'ICE üstüne giren taş durana veya duvara/taşa çarpana dek düz kayar; duvara çarpma düşmanı ezer. Kule +2 görüş sağlar.',
      },
      {
        title: 'Hardal Gazı (MIASMA) + Alevli Ok Domino Zinciri',
        badge: '25ms BFS DOMİNO',
        desc: 'Miasma içinde üst üste 2 tur bitiren taş boğulur. İçine Alevli Ok veya Yanma girerse 45 ms içe çekme ardından BFS 25 ms domino patlaması tüm bağlı gazları yakar!',
      },
      {
        title: 'Çatlak Zemin (CRACKED)',
        badge: 'TEK GEÇİŞLİ',
        desc: 'Üstüne basılıp ayrılınca veya ağır darbede çatırdayarak Çukura (PIT) çöker.',
      },
      {
        title: 'Bakır Kablolu Baskı Plakası → Duvar Oku',
        badge: 'TUZAK HATTI',
        desc: 'Plakaya basılınca bakır kablodan kehribar sinyal akar ve bağlı duvar yarığından ok (veya alevli ok) fırlar.',
      },
      {
        title: '3 Fazlı Ritimli Kazıklar (SPIKES)',
        badge: 'GÜVENLİ → UYARI → AÇIK',
        desc: 'Faz 0 gizli; Faz 1 sarı uyarı ucunu gösterir; Faz 2 açıldığında karedeki kalkanı kırar veya taşı şişler.',
      },
    ];

    const list = document.createElement('div');
    list.className = 'sucs-codex-list';
    for (const item of items) {
      const box = document.createElement('div');
      box.className = 'sucs-codex-item';
      box.innerHTML =
        `<div class="tfc-inspect-heading"><strong>${item.title}</strong><span class="tfc-badge">${item.badge}</span></div>` +
        `<p class="sucs-codex-desc">${item.desc}</p>`;
      list.appendChild(box);
    }
    container.appendChild(list);
  }

  private renderPsychTab(container: HTMLElement): void {
    const psychBox = document.createElement('div');
    psychBox.className = 'sucs-codex-item';
    psychBox.innerHTML =
      `<div class="tfc-inspect-heading"><strong>3 Dişli Dayanıklılık (Composure) & 45° Kavisli Yalpalama</strong><span class="tfc-badge">PSİKOLOJİ</span></div>` +
      `<p class="sucs-codex-desc">• <strong>3 (Sakin):</strong> Tam kontrol · <strong>2 (Gergin):</strong> Kehribar bar · <strong>1 (Kırılgan):</strong> Titreme + 3. kareden sonra 45° kavisli yalpalama & İtaatsizlik · <strong>0 (Çöküş):</strong> 1 tur kilitlenir.<br/>` +
      `• <strong>Ağız Bağlama (Susturma):</strong> Ocaklı 7×7 ultisi düşman mutasyonlarını, kalkanını ve pasif auralarını 2 tur düğümler (Gulyabani hariç: <em>Efsun Tutmaz!</em>).</p>`;
    container.appendChild(psychBox);

    const grid = document.createElement('div');
    grid.className = 'sucs-codex-grid';
    for (const trait of ALL_TRAIT_ORDER) {
      const info = this.opts.traitInfo[trait];
      const item = document.createElement('div');
      item.className = 'sucs-codex-item';
      item.innerHTML =
        `<div class="tfc-inspect-heading"><strong>${info.name}</strong><span class="tfc-badge">MUTASYON</span></div>` +
        `<p class="sucs-codex-desc">${info.desc}</p>`;
      grid.appendChild(item);
    }
    container.appendChild(grid);
  }

  private renderLogsTab(container: HTMLElement): void {
    const p = this.opts.prefs;
    const sw1 = p.act4Switches[0];
    const sw2 = p.act4Switches[1];

    const notes: ReadonlyArray<{ title: string; unlocked: boolean; text: string; hint: string }> = [
      {
        title: 'KAYIT_01 // SİMÜLASYON PROTOKOLÜ',
        unlocked: true,
        text: '"Deneklerin kalp atışı yükseldiğinde radar sahte silüetler üretir. Kendi gölgene saldırmak ELO kaybıdır." — BÜYÜKUSTA-OS',
        hint: '',
      },
      {
        title: 'KAYIT_02 // VAKUM & HARDAL REAKSİYONU',
        unlocked: p.stats.bestRooms >= 3,
        text: '"Perde 2’deki Kimyager havalandırmayı tersine çevirmeden önce Miasma karelerini ateşten uzak tut; domino gecikmesi kaçmana yetmeyebilir."',
        hint: 'Açmak için Seferde en az Oda 3’e ulaş.',
      },
      {
        title: 'GİZLİ ŞALTER #1 // PERDE 2 ANOMALİSİ',
        unlocked: sw1 || p.act4Cleared,
        text: 'Perde 2 Boss odası öncesi devre dışı kalan servis rölesi bulundu [1/2].',
        hint: 'İpucu: Perde 2 boss karşılaşmasını hasarsız veya tüm tuzakları tetiklemeden aş.',
      },
      {
        title: 'GİZLİ ŞALTER #2 // 0x00_ÇEKİRDEK ERİŞİMİ',
        unlocked: sw2 || p.act4Cleared,
        text: 'Perde 3 Çekirdek kilidi kırıldı; CRT Terminali ve Kök Manga devrede.',
        hint: 'İpucu: Perde 3 Finalini tamamladığında Gizli Çekirdek (0x00_ÇEKİRDEK) kapısı açılır.',
      },
    ];

    const list = document.createElement('div');
    list.className = 'sucs-codex-list';
    for (const n of notes) {
      const box = document.createElement('div');
      box.className = 'sucs-codex-item';
      box.innerHTML =
        `<div class="tfc-inspect-heading"><strong>${n.title}</strong><span class="tfc-badge">${n.unlocked ? 'AÇIK' : 'ŞİFRELİ'}</span></div>` +
        `<p class="sucs-codex-desc">${n.unlocked ? n.text : n.hint}</p>`;
      list.appendChild(box);
    }
    container.appendChild(list);
  }
}

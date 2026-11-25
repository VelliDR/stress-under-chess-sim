// src/ui/battleHud.ts
// S.U.C.S. — Esc Duraklatma Perdesi, Mobil Alt Terminal Çekmecesi & 4 Metrikli Maç Sonu Kartları.

export interface PauseModalOptions {
  seed: string;
  stateHash: string;
  isFullscreen?: boolean;
  onResume: () => void;
  onToggleFullscreen?: () => void;
  onOpenCodex: () => void;
  onOpenSettings: () => void;
  onSurrenderToMenu: () => void;
}

export class PauseModal {
  private readonly opts: PauseModalOptions;
  private overlayEl: HTMLDivElement | null = null;

  public constructor(opts: PauseModalOptions) {
    this.opts = opts;
  }

  public isOpen(): boolean {
    return this.overlayEl !== null;
  }

  public open(parent: HTMLElement = document.body): void {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'tfc-modal-backdrop sucs-pause-backdrop';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Oyun Duraklatıldı');

    const card = document.createElement('div');
    card.className = 'tfc-modal-card sucs-pause-card';

    const header = document.createElement('div');
    header.className = 'sucs-pause-head';
    header.innerHTML =
      '<h2>// SİMÜLASYON DURAKLATILDI</h2>' +
      `<div class="sucs-pause-meta">SEED: <span class="tfc-hash-code">${this.opts.seed}</span> · HASH: <span class="tfc-hash-code">#${this.opts.stateHash.slice(0, 6)}</span></div>`;

    const btnCol = document.createElement('div');
    btnCol.className = 'sucs-pause-actions';

    const makeBtn = (label: string, fn: () => void, cls = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls ? `tfc-btn ${cls}` : 'tfc-btn';
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };

    const buttons: HTMLButtonElement[] = [
      makeBtn('▶ Devam Et [Esc]', () => {
        this.close();
        this.opts.onResume();
      }, 'is-primary'),
    ];
    if (this.opts.onToggleFullscreen !== undefined) {
      buttons.push(
        makeBtn(
          this.opts.isFullscreen ? 'Tam Ekrandan Çık [F]' : 'Tam Ekran [F]',
          () => {
            this.close();
            this.opts.onToggleFullscreen?.();
          },
        ),
      );
    }
    buttons.push(
      makeBtn('Rehber [H]', () => this.opts.onOpenCodex()),
      makeBtn('Sistem', () => this.opts.onOpenSettings()),
      makeBtn('Teslim Ol / Ana Menü', () => {
        this.close();
        this.opts.onSurrenderToMenu();
      }, 'is-danger'),
    );
    btnCol.append(...buttons);

    card.append(header, btnCol);
    overlay.appendChild(card);
    parent.appendChild(overlay);
    this.overlayEl = overlay;
  }

  public close(): void {
    if (this.overlayEl !== null) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }
}

export interface EndMatchMetrics {
  roomsCleared: string;
  capturesCount: number;
  peakStress: number;
  seed: string;
}

/**
 * Bölüm 4.4 Maç Sonu — 4 Metrik Kartı (Geçilen Oda, Yenen Taş, En Yüksek Stres, Kullanılan Tohum).
 */
export function buildEndMatchMetricsGrid(metrics: EndMatchMetrics): HTMLDivElement {
  const grid = document.createElement('div');
  grid.className = 'sucs-metrics-grid';

  const cards: ReadonlyArray<{ label: string; value: string; accent: string }> = [
    { label: 'GEÇİLEN ODA', value: metrics.roomsCleared, accent: '#38bdf8' },
    { label: 'YENEN TAŞ', value: String(metrics.capturesCount), accent: '#f87171' },
    { label: 'EN YÜKSEK STRES', value: `%${metrics.peakStress}`, accent: '#f59e0b' },
    { label: 'KULLANILAN TOHUM', value: metrics.seed, accent: '#4ade80' },
  ];

  for (const c of cards) {
    const box = document.createElement('div');
    box.className = 'sucs-metric-card';
    box.innerHTML =
      `<div class="sucs-metric-label">${c.label}</div>` +
      `<div class="sucs-metric-value" style="color:${c.accent};">${c.value}</div>`;
    grid.appendChild(box);
  }
  return grid;
}

/**
 * Bölüm 5 Mobil Terminal Çekmecesi: En altta son terminal satırını gösterir;
 * dokunulunca son 25 kaydı yukarı açılan çekmece olarak sunar.
 */
export class MobileTerminalDrawer {
  public readonly el: HTMLDivElement;
  private readonly latestLineEl: HTMLButtonElement;
  private readonly drawerBodyEl: HTMLUListElement;
  private expanded = false;

  public constructor() {
    this.el = document.createElement('div');
    this.el.className = 'sucs-mobile-log-bar';

    this.drawerBodyEl = document.createElement('ul');
    this.drawerBodyEl.className = 'tfc-log-list sucs-mobile-log-list';
    this.drawerBodyEl.style.display = 'none';

    this.latestLineEl = document.createElement('button');
    this.latestLineEl.type = 'button';
    this.latestLineEl.className = 'sucs-mobile-log-toggle';
    this.latestLineEl.textContent = '> Terminal hazır (tıkla: son 25 kayıt)';
    this.latestLineEl.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.drawerBodyEl.style.display = this.expanded ? 'flex' : 'none';
    });

    this.el.append(this.drawerBodyEl, this.latestLineEl);
  }

  public update(entries: readonly string[]): void {
    const latest = entries[0] ?? 'BÜYÜKUSTA-OS: Beklemede...';
    this.latestLineEl.textContent = `${this.expanded ? '▼' : '▲'} ${latest}`;
    this.drawerBodyEl.innerHTML = '';
    const slice = entries.slice(0, 25);
    for (let i = 0; i < slice.length; i++) {
      const li = document.createElement('li');
      li.textContent = slice[i]!;
      this.drawerBodyEl.appendChild(li);
    }
  }
}

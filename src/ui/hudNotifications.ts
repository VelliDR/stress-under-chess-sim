// src/ui/hudNotifications.ts
// S.U.C.S. — Gerçek Oyun HUD Bildirim Merkezi:
//   1. Üst-Orta Faz / Oda Bildirim Bandı (Tur geçişi, Oda girişi, Tam Ekran, Boss uyarısı)
//   2. Sağ-Üst Akışkan Savaş & Olay Bildirimleri (Combat Toast Stack — tıklama geçirgen, otomatik sönümlenen)

import { type PixelIconName, renderPixelIconSvg } from './pixelIcons';

export type HudToastTone = 'player' | 'enemy' | 'warn' | 'crt' | 'info';

export interface HudToastInput {
  readonly title?: string;
  readonly text: string;
  readonly tone?: HudToastTone;
  readonly icon?: PixelIconName;
  readonly durationMs?: number;
}

export interface HudBannerInput {
  readonly eyebrow?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly tone?: HudToastTone;
  readonly durationMs?: number;
}

interface ActiveToastRecord {
  readonly id: number;
  readonly el: HTMLDivElement;
  readonly timerId: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_ICON_BY_TONE: Readonly<Record<HudToastTone, PixelIconName>> = {
  player: 'shield',
  enemy: 'skull',
  warn: 'alert',
  crt: 'log',
  info: 'flag',
};

/**
 * Tam ekran savaş sahnesi üstündeki geçici bildirimleri yönetir.
 * Katman tamamen `pointer-events: none` olarak tasarlanmıştır; tahta tıklamalarını asla engellemez.
 */
export class HudNotificationCenter {
  public readonly bannerHostEl: HTMLDivElement;
  public readonly toastFeedEl: HTMLDivElement;

  private readonly maxToasts: number;
  private seq = 0;
  private activeToasts: ActiveToastRecord[] = [];
  private activeBannerEl: HTMLDivElement | null = null;
  private bannerTimerId: ReturnType<typeof setTimeout> | null = null;
  private lastToastKey = '';
  private lastToastAtMs = 0;

  public constructor(options?: { maxToasts?: number }) {
    this.maxToasts = Math.max(1, options?.maxToasts ?? 4);

    this.bannerHostEl = document.createElement('div');
    this.bannerHostEl.className = 'sucs-banner-host';
    this.bannerHostEl.setAttribute('aria-live', 'polite');

    this.toastFeedEl = document.createElement('div');
    this.toastFeedEl.className = 'sucs-toast-feed';
    this.toastFeedEl.setAttribute('aria-live', 'polite');
  }

  public showBanner(input: HudBannerInput): void {
    this.clearBanner();

    const tone = input.tone ?? 'info';
    const durationMs = Math.max(900, input.durationMs ?? 1900);

    const card = document.createElement('div');
    card.className = `sucs-phase-banner px-frame is-${tone}`;
    card.style.setProperty('--banner-dur', `${durationMs}ms`);

    if (input.eyebrow !== undefined && input.eyebrow.length > 0) {
      const eye = document.createElement('div');
      eye.className = 'sucs-phase-banner-eyebrow';
      eye.textContent = input.eyebrow;
      card.appendChild(eye);
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'sucs-phase-banner-title';
    titleEl.textContent = input.title;
    card.appendChild(titleEl);

    if (input.subtitle !== undefined && input.subtitle.length > 0) {
      const subEl = document.createElement('div');
      subEl.className = 'sucs-phase-banner-sub';
      subEl.textContent = input.subtitle;
      card.appendChild(subEl);
    }

    this.bannerHostEl.appendChild(card);
    this.activeBannerEl = card;

    if (typeof setTimeout === 'function') {
      this.bannerTimerId = setTimeout(() => {
        this.bannerTimerId = null;
        this.clearBanner();
      }, durationMs);
    }
  }

  public pushToast(input: HudToastInput): void {
    const cleanText = input.text.trim();
    if (cleanText.length === 0) return;

    const tone = input.tone ?? 'info';
    const now = Date.now();
    const dedupKey = `${tone}:${input.title ?? ''}:${cleanText}`;
    if (dedupKey === this.lastToastKey && now - this.lastToastAtMs < 450) {
      return;
    }
    this.lastToastKey = dedupKey;
    this.lastToastAtMs = now;

    // Limit visible toast stack (evict oldest first)
    while (this.activeToasts.length >= this.maxToasts) {
      const oldest = this.activeToasts.shift();
      if (oldest !== undefined) {
        if (oldest.timerId !== null) clearTimeout(oldest.timerId);
        oldest.el.remove();
      }
    }

    const durationMs = Math.max(1500, input.durationMs ?? 4200);
    const id = ++this.seq;
    const iconName = input.icon ?? DEFAULT_ICON_BY_TONE[tone];

    const item = document.createElement('div');
    item.className = `sucs-toast-item px-frame is-${tone}`;
    item.style.setProperty('--toast-dur', `${durationMs}ms`);

    const iconWrap = document.createElement('span');
    iconWrap.className = 'sucs-toast-icon';
    iconWrap.innerHTML = renderPixelIconSvg(iconName, 14);

    const body = document.createElement('div');
    body.className = 'sucs-toast-body';

    if (input.title !== undefined && input.title.length > 0) {
      const titleEl = document.createElement('div');
      titleEl.className = 'sucs-toast-title';
      titleEl.textContent = input.title;
      body.appendChild(titleEl);
    }

    const textEl = document.createElement('div');
    textEl.className = 'sucs-toast-text';
    textEl.textContent = cleanText;
    body.appendChild(textEl);

    const bar = document.createElement('span');
    bar.className = 'sucs-toast-drain';

    item.append(iconWrap, body, bar);
    this.toastFeedEl.appendChild(item);

    const timerId =
      typeof setTimeout === 'function'
        ? setTimeout(() => {
            this.removeToast(id);
          }, durationMs)
        : null;

    this.activeToasts.push({ id, el: item, timerId });
  }

  public getActiveToastCount(): number {
    return this.activeToasts.length;
  }

  public hasActiveBanner(): boolean {
    return this.activeBannerEl !== null;
  }

  public clearBanner(): void {
    if (this.bannerTimerId !== null) {
      clearTimeout(this.bannerTimerId);
      this.bannerTimerId = null;
    }
    if (this.activeBannerEl !== null) {
      this.activeBannerEl.remove();
      this.activeBannerEl = null;
    }
  }

  public clear(): void {
    this.clearBanner();
    for (let i = 0; i < this.activeToasts.length; i++) {
      const rec = this.activeToasts[i]!;
      if (rec.timerId !== null) clearTimeout(rec.timerId);
      rec.el.remove();
    }
    this.activeToasts = [];
    this.lastToastKey = '';
  }

  public destroy(): void {
    this.clear();
  }

  private removeToast(id: number): void {
    const idx = this.activeToasts.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [rec] = this.activeToasts.splice(idx, 1);
    if (rec !== undefined) {
      if (rec.timerId !== null) clearTimeout(rec.timerId);
      rec.el.remove();
    }
  }
}

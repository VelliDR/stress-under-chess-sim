import { describe, expect, it, vi } from 'vitest';
import { computeBoardLayout } from '../src/render/canvasRenderer';
import { FullscreenController, type DocumentLike } from '../src/ui/fullscreenController';
import { HudNotificationCenter } from '../src/ui/hudNotifications';
import { renderPixelIconSvg, type PixelIconName } from '../src/ui/pixelIcons';

interface MockElement {
  className: string;
  textContent: string;
  innerHTML: string;
  style: Record<string, string> & { setProperty: (k: string, v: string) => void };
  classList: {
    toggle: (cls: string, force?: boolean) => boolean;
    contains: (cls: string) => boolean;
  };
  children: MockElement[];
  setAttribute: (k: string, v: string) => void;
  append: (...nodes: MockElement[]) => void;
  appendChild: (node: MockElement) => MockElement;
  remove: () => void;
  isRemoved: () => boolean;
  requestFullscreen?: () => Promise<void>;
}

function makeMockElement(): MockElement {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  const children: MockElement[] = [];
  let removed = false;
  const el: MockElement = {
    className: '',
    textContent: '',
    innerHTML: '',
    style: Object.assign(style, {
      setProperty: (k: string, v: string) => {
        style[k] = v;
      },
    }),
    classList: {
      toggle: (cls: string, force?: boolean) => {
        if (force === true) classes.add(cls);
        else if (force === false) classes.delete(cls);
        else if (classes.has(cls)) classes.delete(cls);
        else classes.add(cls);
        return classes.has(cls);
      },
      contains: (cls: string) => classes.has(cls),
    },
    children,
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    append: (...nodes: MockElement[]) => {
      children.push(...nodes);
    },
    appendChild: (node: MockElement) => {
      children.push(node);
      return node;
    },
    remove: () => {
      removed = true;
    },
    isRemoved: () => removed,
  };
  return el;
}

describe('FAZ UI-7 — FullscreenController, HudNotificationCenter, PixelIcons & DPR-aware BoardLayout', () => {
  it('renders crisp integer-rect 16x16 pixel SVG icons with zero smooth paths', () => {
    const names: readonly PixelIconName[] = [
      'fullscreenEnter',
      'fullscreenExit',
      'soundOn',
      'soundOff',
      'pause',
      'codex',
      'log',
      'threat',
      'intent',
      'skull',
      'shield',
      'alert',
    ];
    for (const name of names) {
      const svg = renderPixelIconSvg(name, 16);
      expect(svg).toContain('shape-rendering="crispEdges"');
      expect(svg).toContain('<rect ');
      expect(svg).not.toContain('<path');
      expect(svg).not.toContain('<circle');
    }
  });

  it('uses native Fullscreen API when supported and falls back to 100dvh pseudo-fullscreen on iOS Safari', async () => {
    // 1) Native Desktop Fullscreen
    const listeners: Record<string, EventListener[]> = {};
    let fsEl: Element | null = null;
    const target = makeMockElement();
    target.requestFullscreen = async () => {
      fsEl = target as unknown as Element;
    };
    const bodyEl = makeMockElement();
    const doc: DocumentLike = {
      fullscreenEnabled: true,
      get fullscreenElement() {
        return fsEl;
      },
      exitFullscreen: async () => {
        fsEl = null;
      },
      addEventListener: (t, fn) => {
        listeners[t] = listeners[t] ?? [];
        listeners[t]!.push(fn);
      },
      removeEventListener: (t, fn) => {
        listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
      },
      body: bodyEl,
    };

    const changes: Array<[boolean, string]> = [];
    const ctrl = new FullscreenController({
      targetEl: target as unknown as HTMLElement,
      doc,
      nav: { userAgent: 'Mozilla/5.0 X11 Linux', platform: 'Linux x86_64', maxTouchPoints: 0 },
      onChange: (active, mode) => changes.push([active, mode]),
    });

    expect(ctrl.supportsNativeFullscreen()).toBe(true);
    await ctrl.toggle();
    expect(ctrl.isFullscreen()).toBe(true);
    expect(ctrl.getMode()).toBe('native');
    expect(target.classList.contains('is-fullscreen-active')).toBe(true);
    expect(target.classList.contains('is-pseudo-fullscreen')).toBe(false);

    await ctrl.toggle();
    expect(ctrl.isFullscreen()).toBe(false);
    expect(ctrl.getMode()).toBe('none');
    expect(changes).toEqual([
      [true, 'native'],
      [false, 'none'],
    ]);
    ctrl.destroy();

    // 2) iOS Safari Fallback
    const iosTarget = makeMockElement();
    const iosCtrl = new FullscreenController({
      targetEl: iosTarget as unknown as HTMLElement,
      doc,
      nav: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', platform: 'iPhone', maxTouchPoints: 5 },
    });

    expect(iosCtrl.supportsNativeFullscreen()).toBe(false);
    await iosCtrl.enter();
    expect(iosCtrl.isFullscreen()).toBe(true);
    expect(iosCtrl.getMode()).toBe('pseudo');
    expect(iosTarget.classList.contains('is-pseudo-fullscreen')).toBe(true);
    expect(bodyEl.classList.contains('is-pseudo-fullscreen-body')).toBe(true);
    await iosCtrl.exit();
    expect(iosCtrl.isFullscreen()).toBe(false);
    expect(iosTarget.classList.contains('is-pseudo-fullscreen')).toBe(false);
    iosCtrl.destroy();
  });

  it('caps combat toast stack, deduplicates rapid alerts, and auto-expires banners cleanly', () => {
    vi.useFakeTimers();
    const prevDoc = (globalThis as Record<string, unknown>)['document'];
    (globalThis as Record<string, unknown>)['document'] = {
      createElement: () => makeMockElement(),
    };
    try {
      const hud = new HudNotificationCenter({ maxToasts: 3 });

      hud.showBanner({ eyebrow: 'TUR #1', title: 'OYUNCU SIRASI', durationMs: 1200 });
      expect(hud.hasActiveBanner()).toBe(true);

      hud.pushToast({ title: 'A', text: 'İlk olay', tone: 'player', durationMs: 2000 });
      // Rapid duplicate ignored
      hud.pushToast({ title: 'A', text: 'İlk olay', tone: 'player', durationMs: 2000 });
      expect(hud.getActiveToastCount()).toBe(1);

      hud.pushToast({ title: 'B', text: 'İkinci olay', tone: 'warn', durationMs: 2000 });
      hud.pushToast({ title: 'C', text: 'Üçüncü olay', tone: 'enemy', durationMs: 2000 });
      hud.pushToast({ title: 'D', text: 'Dördüncü olay', tone: 'crt', durationMs: 2000 });
      // Strictly capped at maxToasts = 3
      expect(hud.getActiveToastCount()).toBe(3);

      vi.advanceTimersByTime(1250);
      expect(hud.hasActiveBanner()).toBe(false);

      vi.advanceTimersByTime(1000);
      expect(hud.getActiveToastCount()).toBe(0);
      hud.destroy();
    } finally {
      (globalThis as Record<string, unknown>)['document'] = prevDoc;
      vi.useRealTimers();
    }
  });

  it('unlocks 96px (3x) tiles on 1080p full-bleed viewport with HUD safe insets and supports DPR=2 half-steps with zero physical mixels', () => {
    // Full-bleed 1080p browser viewport (~1850x960) with floating HUD insets -> 9x8 board hits 96px (3x)!
    const full1080 = computeBoardLayout(1850, 960, 9, 8, 1, { top: 36, bottom: 40, left: 6, right: 6 });
    expect(full1080.tileSize).toBe(96);
    expect(full1080.offsetY).toBeGreaterThanOrEqual(36);

    // 1080p Fullscreen (1920x1080) even on 9x9 Boss board -> crisp 96px (3x) with HUD clearance!
    const bossFs = computeBoardLayout(1920, 1080, 9, 9, 1, { top: 36, bottom: 40, left: 6, right: 6 });
    expect(bossFs.tileSize).toBe(96);
    expect(bossFs.offsetY).toBeGreaterThanOrEqual(36);

    // Retina DPR=2 mid viewport: rawTile=84 -> snaps to 80 CSS px (= 160 physical px = 5x32 zero mixels!)
    const retinaMid = computeBoardLayout(900, 720, 8, 8, 2);
    expect(retinaMid.tileSize).toBe(80);
    expect((retinaMid.tileSize * retinaMid.dpr) % 32).toBe(0);
  });
});

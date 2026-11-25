import { describe, expect, it } from 'vitest';
import { getPieceQuote } from '../src/data/narrative';
import { createDefaultUiPrefs } from '../src/storage/uiPrefs';
import { buildEndMatchMetricsGrid, MobileTerminalDrawer, PauseModal } from '../src/ui/battleHud';
import { CodexModal } from '../src/ui/codexModal';
import { SettingsModal } from '../src/ui/settingsModal';

/** Minimal headless DOM mock for verifying UI modals in Node Vitest environment */
function installMockDom(): { cleanup: () => void; bodyChildren: unknown[] } {
  const prevDoc = (globalThis as Record<string, unknown>)['document'];

  class MockEl {
    public tagName: string;
    public className = '';
    public type = '';
    public min = '';
    public max = '';
    public value = '';
    public checked = false;
    public disabled = false;
    public placeholder = '';
    public rows = 1;
    public width = 0;
    public height = 0;
    public style: Record<string, string> = {};
    public children: MockEl[] = [];
    public attrs: Record<string, string> = {};
    public listeners: Record<string, Array<(ev: unknown) => void>> = {};
    private _innerHTML = '';
    private _textContent = '';

    public constructor(tag: string) {
      this.tagName = tag.toUpperCase();
    }

    public get innerHTML(): string {
      return this._innerHTML;
    }

    public set innerHTML(v: string) {
      this._innerHTML = v;
      if (v === '') this.children = [];
    }

    public get textContent(): string {
      return this._textContent;
    }

    public set textContent(v: string) {
      this._textContent = v;
    }

    public get classList() {
      return {
        toggle: (cls: string, force?: boolean) => {
          const set = new Set(this.className.split(' ').filter(Boolean));
          if (force === true) set.add(cls);
          else if (force === false) set.delete(cls);
          else if (set.has(cls)) set.delete(cls);
          else set.add(cls);
          this.className = Array.from(set).join(' ');
        },
        add: (...cls: string[]) => {
          const set = new Set([...this.className.split(' ').filter(Boolean), ...cls]);
          this.className = Array.from(set).join(' ');
        },
        remove: (...cls: string[]) => {
          const set = new Set(this.className.split(' ').filter(Boolean));
          cls.forEach((c) => set.delete(c));
          this.className = Array.from(set).join(' ');
        },
      };
    }

    public setAttribute(k: string, v: string): void {
      this.attrs[k] = v;
    }

    public append(...nodes: MockEl[]): void {
      this.children.push(...nodes);
    }

    public appendChild(node: MockEl): MockEl {
      this.children.push(node);
      return node;
    }

    public remove(): void {
      this.children = [];
    }

    public addEventListener(type: string, fn: (ev: unknown) => void): void {
      if (this.listeners[type] === undefined) this.listeners[type] = [];
      this.listeners[type]!.push(fn);
    }

    public trigger(type: string, extra: Record<string, unknown> = {}): void {
      const list = this.listeners[type] ?? [];
      for (const fn of list) fn({ target: this, ...extra });
    }

    public select(): void {}

    public focus(): void {}

    public getContext(): {
      fillStyle: string;
      imageSmoothingEnabled: boolean;
      fillRect: () => void;
      clearRect: () => void;
    } {
      return {
        fillStyle: '',
        imageSmoothingEnabled: false,
        fillRect: () => undefined,
        clearRect: () => undefined,
      };
    }
  }

  const rootBody = new MockEl('body');
  (globalThis as Record<string, unknown>)['document'] = {
    body: rootBody,
    createElement: (tag: string) => new MockEl(tag),
  };

  return {
    bodyChildren: rootBody.children,
    cleanup: () => {
      (globalThis as Record<string, unknown>)['document'] = prevDoc;
    },
  };
}

function collectAllText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const el = node as { textContent?: string; innerHTML?: string; children?: unknown[] };
  let acc = (el.textContent ?? '') + ' ' + (el.innerHTML ?? '');
  if (Array.isArray(el.children)) {
    for (const c of el.children) {
      acc += ' ' + collectAllText(c);
    }
  }
  return acc;
}

function findButtons(node: unknown, out: Array<{ textContent: string; trigger: (t: string) => void; disabled: boolean }> = []) {
  if (typeof node !== 'object' || node === null) return out;
  const el = node as { tagName?: string; textContent?: string; trigger?: (t: string) => void; disabled?: boolean; children?: unknown[] };
  if (el.tagName === 'BUTTON' && el.trigger !== undefined) {
    out.push(el as { textContent: string; trigger: (t: string) => void; disabled: boolean });
  }
  if (Array.isArray(el.children)) {
    for (const c of el.children) findButtons(c, out);
  }
  return out;
}

describe('FAZ UI-6 — CodexModal, SettingsModal (Live Tone Preview + Double-Confirm Reset), PauseModal & Mobile Drawer', () => {
  it('renders 4-tab CodexModal cleanly including Units, Chemistry/Traps, Psychology, and Büyükusta-OS Logs', () => {
    const dom = installMockDom();
    try {
      const prefs = createDefaultUiPrefs();
      prefs.act4Switches = [true, false];
      prefs.stats.bestRooms = 4;

      const codex = new CodexModal({
        prefs,
        theme: 'default',
        pieceNames: {
          PAWN: 'Piyon',
          KNIGHT: 'At',
          BISHOP: 'Fil',
          ROOK: 'Kale',
          QUEEN: 'Vezir',
          KING: 'Şah',
          SAINT_FAITH: 'Ocaklı',
          SAINT_MADNESS: 'Meczup',
          CHIMERA: 'Gulyabani',
        },
        traitInfo: {
          SHIELDED: { name: 'Kalkan', desc: '1 darbe emer' },
          FROST_TOUCH: { name: 'Buz', desc: 'Dondurur' },
          EXPLOSIVE: { name: 'Patlayıcı', desc: 'Artı patlar' },
          SCOUT: { name: 'Gözcü', desc: '+2 görüş' },
          SHADOW_WALKER: { name: 'Gölge', desc: 'Silüet bırakmaz' },
          PUSHER: { name: 'İtici', desc: '1 kare iter' },
          DASH_ON_REVEAL: { name: 'Pusu', desc: 'Ekstra hamle' },
        },
        playClickSfx: () => undefined,
      });

      codex.open();
      expect(codex.isOpen()).toBe(true);
      const modalRoot = dom.bodyChildren[0];
      expect(collectAllText(modalRoot)).toContain('Ocaklı');

      const btns = findButtons(modalRoot);
      // Switch to Tab 2 (Traps), Tab 3 (Psych), Tab 4 (Logs)
      btns.find((b) => b.textContent.includes('2. Zemin'))!.trigger('click');
      expect(collectAllText(modalRoot)).toContain('25ms BFS DOMİNO');

      btns.find((b) => b.textContent.includes('3. Psikoloji'))!.trigger('click');
      expect(collectAllText(modalRoot)).toContain('Ağız Bağlama');

      btns.find((b) => b.textContent.includes('4. Büyükusta-OS'))!.trigger('click');
      expect(collectAllText(modalRoot)).toContain('1/2');
      codex.close();
      expect(codex.isOpen()).toBe(false);
    } finally {
      dom.cleanup();
    }
  });

  it('updates live pawn quote preview on tone toggle and requires double click for reset in SettingsModal', () => {
    const dom = installMockDom();
    try {
      const prefs = createDefaultUiPrefs();
      let updates = 0;
      let resetCount = 0;
      let testClicks = 0;

      const settingsModal = new SettingsModal({
        settings: {
          soundEnabled: true,
          soundVolume: 0.65,
          animationSpeed: 1,
          showIntentArrows: true,
          narrativeTone: 'unfiltered',
        },
        prefs,
        exportJson: () => '{"ok":true}',
        importJson: () => ({ ok: true }),
        onUpdate: () => {
          updates++;
        },
        onPlayTestSfx: () => {
          testClicks++;
        },
        onPlayClickSfx: () => undefined,
        onResetAllProgress: () => {
          resetCount++;
        },
      });

      settingsModal.open();
      const root = dom.bodyChildren[0];
      const expectedUnf = getPieceQuote('PAWN', 'DISOBEY', 'unfiltered', 'settings-preview')!;
      const expectedPol = getPieceQuote('PAWN', 'DISOBEY', 'polite', 'settings-preview')!;
      expect(collectAllText(root)).toContain(expectedUnf);

      const btns = findButtons(root);
      btns.find((b) => b.textContent === 'Efendi Mod')!.trigger('click');
      expect(collectAllText(root)).toContain(expectedPol);
      expect(updates).toBe(1);

      // Double confirmation on Reset button
      const resetBtn = btns.find((b) => b.textContent === 'İlerlemeyi Sıfırla')!;
      resetBtn.trigger('click');
      expect(resetCount).toBe(0);
      expect(resetBtn.textContent).toContain('EMİN MİSİN');
      resetBtn.trigger('click');
      expect(resetCount).toBe(1);
      expect(testClicks).toBe(0);
    } finally {
      dom.cleanup();
    }
  });

  it('builds Esc PauseModal (seed + 6-char hash + 4 buttons), 4 EndMatch metric cards, and MobileTerminalDrawer', () => {
    const dom = installMockDom();
    try {
      let resumed = 0;
      const pause = new PauseModal({
        seed: '2026-11-25',
        stateHash: 'abcdef1234',
        onResume: () => resumed++,
        onOpenCodex: () => undefined,
        onOpenSettings: () => undefined,
        onSurrenderToMenu: () => undefined,
      });
      pause.open();
      const root = dom.bodyChildren[0];
      const text = collectAllText(root);
      expect(text).toContain('2026-11-25');
      expect(text).toContain('#abcdef');
      const btns = findButtons(root);
      expect(btns).toHaveLength(4);
      btns[0]!.trigger('click');
      expect(resumed).toBe(1);

      const grid = buildEndMatchMetricsGrid({
        roomsCleared: 'P2 · 3/5',
        capturesCount: 7,
        peakStress: 88,
        seed: '9911',
      });
      const gText = collectAllText(grid);
      expect(gText).toContain('P2 · 3/5');
      expect(gText).toContain('%88');

      const drawer = new MobileTerminalDrawer();
      const logs = Array.from({ length: 30 }, (_, i) => `Kayıt #${i + 1}`);
      drawer.update(logs);
      const list = drawer.el.children[0] as unknown as { children: unknown[]; style: Record<string, string> };
      expect(list.children).toHaveLength(25);
      expect(list.style['display']).toBe('none');
      (drawer.el.children[1] as unknown as { trigger: (t: string) => void }).trigger('click');
      expect(list.style['display']).toBe('flex');
    } finally {
      dom.cleanup();
    }
  });
});

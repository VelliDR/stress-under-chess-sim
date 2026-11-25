// src/render/speechOverlay.ts
// S.U.C.S. — Tahta Üstü Sinematik Diyalog Katmanları & Zengin Tipografi Motoru:
//   1. Taş Üstü Konuşma Balonu (Tactical Barks: 90ms pop-in, 14ms/harf, 2.2s, 180ms fade, Akıllı Kenar Hizalama)
//   2. 'Son Söz' Asılı Ölüm Balonu (5x5 kafatası ikonu, koyu kızıl çerçeve, 1.4s ömür + son 300ms TV paraziti)
//   3. Büyükusta-OS CRT Müdahale Bandı (140ms letterbox, 90ms glitch, 20ms/harf + 110ms es)
//   4. {shake} / {wave} / {pop} Satır İçi Duygu Tipografisi

import type { Coord, VisibleState } from '../engine/types';
import {
  type DefeatReason,
  enrichNarrativeMarkup,
  getDefeatBanner,
  getLivePatchQuote,
  getRoomIntroQuote,
  getVictoryQuote,
  type LivePatchId,
  type NarrativeTone,
  type TerminalLogEntry,
} from '../data/narrative';
import type { BoardLayout } from './canvasRenderer';

export type RichTextEffect = 'normal' | 'shake' | 'wave' | 'pop';

export interface RichTextGlyph {
  readonly char: string;
  readonly effect: RichTextEffect;
  readonly charIndex: number;
}

export interface ParsedRichText {
  readonly plainText: string;
  readonly glyphs: readonly RichTextGlyph[];
}

export interface BubblePlacement {
  readonly boxX: number;
  readonly boxY: number;
  readonly boxW: number;
  readonly boxH: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly tailDir: 'down' | 'up';
}

export type SpeechEmotion =
  | 'normal'
  | 'panic'
  | 'ocakli'
  | 'meczup'
  | 'gulyabani';

export interface ActiveBarkBubble {
  speaker: string;
  coord: Coord;
  emotion: SpeechEmotion;
  parsed: ParsedRichText;
  ageMs: number;
  revealCount: number;
  revealAccumMs: number;
  charRevealTimesMs: number[];
  holdMs: number;
  fadeMs: number;
  popInMs: number;
  dismissing: boolean;
  entrySnapshot: TerminalLogEntry;
  reResolve?: (tone: NarrativeTone) => string | null;
}

export interface ActiveLastWordsBubble {
  speaker: string;
  coord: Coord;
  parsed: ParsedRichText;
  ageMs: number;
  totalMs: number; // Adaptive 3200-5600 ms (last 300 ms TV static overlay, text remains readable)
  charRevealTimesMs: number[];
  reResolve?: (tone: NarrativeTone) => string | null;
}

/**
 * Karakter sayısına göre insanın rahat okuyabileceği adaptif gösterim süresi (ms).
 */
export function computeAdaptiveDurationMs(charCount: number, kind: 'bark' | 'lastWords'): number {
  const n = Math.max(0, charCount);
  if (kind === 'lastWords') {
    return Math.max(3200, Math.min(5600, 2000 + n * 55));
  }
  return Math.max(2800, Math.min(5200, 1700 + n * 45));
}

export type CrtQuoteSource =
  | { kind: 'ROOM_INTRO'; roomId: string; seed: number }
  | { kind: 'LIVE_PATCH'; patchId: LivePatchId; turnNumber: number }
  | { kind: 'DEFEAT'; reason: DefeatReason; seed: number; turnNumber: number }
  | { kind: 'VICTORY'; isSecretCore: boolean; seed: number };

export interface ActiveCrtBand {
  speaker: string;
  mode: 'green' | 'crimson';
  parsed: ParsedRichText;
  ageMs: number;
  revealCount: number;
  revealAccumMs: number;
  pauseLeftMs: number;
  charRevealTimesMs: number[];
  lastBeepedCharIndex: number;
  barSlideMs: number;
  glitchMs: number;
  holdAfterTypeMs: number;
  fadeMs: number;
  totalMs: number;
  quoteSource?: CrtQuoteSource;
}

export interface SpeechOverlayOptions {
  onTypewriterChar?: (charIndex: number) => void;
  onArchiveBark?: (entry: TerminalLogEntry) => void;
}

const VALID_TAGS: readonly RichTextEffect[] = ['shake', 'wave', 'pop'];

// 5x5 Piksel Kafatası Matrisi (Son Söz balonu sol köşesi)
const MINI_SKULL_5X5: readonly string[] = [
  '.XXX.',
  'XXXXX',
  'X.X.X',
  '.XXX.',
  '.X.X.',
];

/**
 * 3.1 Satır İçi Duygu Çözümleyicisi:
 * `{shake}...{/shake}`, `{wave}...{/wave}`, `{pop}...{/pop}` etiketlerini piksel glif dizisine ayırır.
 */
export function parseRichText(markup: string): ParsedRichText {
  const glyphs: RichTextGlyph[] = [];
  let plain = '';
  const effectStack: RichTextEffect[] = ['normal'];
  let i = 0;

  while (i < markup.length) {
    if (markup[i] === '{') {
      const closeIdx = markup.indexOf('}', i + 1);
      if (closeIdx > i + 1) {
        const token = markup.slice(i + 1, closeIdx);
        if (token.startsWith('/')) {
          const tagName = token.slice(1) as RichTextEffect;
          if (VALID_TAGS.includes(tagName) && effectStack.length > 1) {
            effectStack.pop();
            i = closeIdx + 1;
            continue;
          }
        } else if (VALID_TAGS.includes(token as RichTextEffect)) {
          effectStack.push(token as RichTextEffect);
          i = closeIdx + 1;
          continue;
        }
      }
    }

    const ch = markup[i]!;
    const currentEffect = effectStack[effectStack.length - 1] ?? 'normal';
    glyphs.push({
      char: ch,
      effect: currentEffect,
      charIndex: glyphs.length,
    });
    plain += ch;
    i++;
  }

  return { plainText: plain, glyphs };
}

/**
 * 3.1 Karakter bazlı duygu animasyon ofsetini döndürür.
 */
export function computeGlyphTransform(
  glyph: RichTextGlyph,
  timeMs: number,
  revealElapsedMs: number,
): { dx: number; dy: number; scale: number; tintColor: string | null } {
  if (glyph.effect === 'shake') {
    const tick = Math.floor(timeMs / 48);
    const hash = (glyph.charIndex * 17 + tick * 13 + glyph.char.charCodeAt(0)) >>> 0;
    const dx = (hash % 3) - 1;
    const dy = ((hash >> 2) % 3) - 1;
    return { dx, dy, scale: 1, tintColor: '#fca5a5' };
  }
  if (glyph.effect === 'wave') {
    const dy = Math.sin(timeMs * 0.011 + glyph.charIndex * 0.65) * 1.5;
    return { dx: 0, dy, scale: 1, tintColor: '#86efac' };
  }
  if (glyph.effect === 'pop') {
    const scale =
      revealElapsedMs >= 0 && revealElapsedMs < 80
        ? 1.25 - 0.25 * (revealElapsedMs / 80)
        : 1;
    return { dx: 0, dy: 0, scale, tintColor: '#fde047' };
  }
  return { dx: 0, dy: 0, scale: 1, tintColor: null };
}

/**
 * Konuşma balonu için Akıllı Kenar Hizalama hesaplar:
 * - Üst sıradaki taşlarda (veya kenara taşacaksa) balonu aşağı açar (`tailDir = 'up'`)
 * - Sağ/sol kenarda gövdeyi tahta içine kaydırır ama ok ucunu taşın merkezinde tutar!
 */
export function computeSmartBubblePlacement(opts: {
  anchorX: number;
  anchorY: number;
  tileSize: number;
  boxW: number;
  boxH: number;
  boardLeft: number;
  boardTop: number;
  boardRight: number;
  boardBottom: number;
  gridY: number;
}): BubblePlacement {
  const {
    anchorX,
    anchorY,
    tileSize,
    boxW,
    boxH,
    boardLeft,
    boardTop,
    boardRight,
    boardBottom,
    gridY,
  } = opts;
  const gap = 6;
  const tileCenterX = anchorX + tileSize * 0.5;
  const clampedBoxX = Math.max(
    boardLeft + 4,
    Math.min(boardRight - boxW - 4, tileCenterX - boxW * 0.5),
  );
  const pointerX = Math.max(clampedBoxX + 6, Math.min(clampedBoxX + boxW - 6, tileCenterX));

  const preferredTop = anchorY - gap - boxH;
  const openBelow = gridY === 0 || preferredTop < boardTop + 2;

  if (openBelow) {
    const clampedBelowY = Math.min(boardBottom - boxH - 4, anchorY + tileSize + gap);
    return {
      boxX: Math.round(clampedBoxX),
      boxY: Math.round(clampedBelowY),
      boxW: Math.round(boxW),
      boxH: Math.round(boxH),
      pointerX: Math.round(pointerX),
      pointerY: Math.round(clampedBelowY),
      tailDir: 'up',
    };
  }

  return {
    boxX: Math.round(clampedBoxX),
    boxY: Math.round(preferredTop),
    boxW: Math.round(boxW),
    boxH: Math.round(boxH),
    pointerX: Math.round(pointerX),
    pointerY: Math.round(preferredTop + boxH),
    tailDir: 'down',
  };
}

function resolveBarkEmotion(entry: TerminalLogEntry): SpeechEmotion {
  if (entry.pieceType === 'OCAKLI') return 'ocakli';
  if (entry.pieceType === 'MECZUP') return 'meczup';
  if (entry.pieceType === 'GULYABANI') return 'gulyabani';
  if (entry.severity === 'panic' || entry.severity === 'warn') return 'panic';
  return 'normal';
}

function getBorderColorForEmotion(emotion: SpeechEmotion, timeMs: number): string {
  switch (emotion) {
    case 'ocakli':
      return Math.floor(timeMs / 260) % 2 === 0 ? '#fbbf24' : '#2dd4bf';
    case 'meczup':
      return '#e879f9';
    case 'gulyabani':
      return '#10b981';
    case 'panic':
      return Math.floor(timeMs / 220) % 2 === 0 ? '#f59e0b' : '#f43f5e';
    default:
      return '#94a3b8';
  }
}

function computeSpeechBubbleDimensions(
  plainText: string,
  speaker: string,
  boardPixelW: number,
  extraLeftPad = 0,
): { boxW: number; boxH: number; lines: string[]; maxCharsPerLine: number } {
  const maxBoxW = Math.max(196, Math.min(324, Math.round(boardPixelW * 0.64)));
  const maxCharsPerLine = Math.max(22, Math.floor((maxBoxW - 22 - extraLeftPad) / 7.3));
  const words = plainText.split(' ');
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (line.length === 0) {
      line = w;
    } else if (line.length + 1 + w.length <= maxCharsPerLine) {
      line += ' ' + w;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line.length > 0) lines.push(line);
  if (lines.length === 0) lines.push('');

  const longest = Math.max(speaker.length + 3, ...lines.map((l) => l.length));
  const boxW = Math.min(maxBoxW, Math.max(150, longest * 7.4 + 24 + extraLeftPad));
  const boxH = 22 + lines.length * 16 + 10;
  return { boxW, boxH, lines, maxCharsPerLine };
}

/**
 * Tahta Üstü Konuşma Balonları, Adaptif Süreli Son Söz Kutusu ve Büyükusta-OS CRT Bandı Yöneticisi.
 * Tıklama geçirgendir (`pointer-events: none` eşleniği olarak Canvas üzerinde yalnızca son katmanda çizilir).
 */
export class SpeechOverlay {
  private activeBark: ActiveBarkBubble | null = null;
  private activeLastWords: ActiveLastWordsBubble | null = null;
  private queuedLastWords: ActiveLastWordsBubble | null = null;
  private activeCrtBand: ActiveCrtBand | null = null;
  private readonly options: SpeechOverlayOptions;
  private currentTone: NarrativeTone = 'unfiltered';

  public constructor(options: SpeechOverlayOptions = {}) {
    this.options = options;
  }

  public setTone(tone: NarrativeTone): void {
    this.currentTone = tone;
    if (this.activeCrtBand?.quoteSource !== undefined) {
      const resolved = this.resolveCrtSourceText(this.activeCrtBand.quoteSource, tone);
      if (resolved.length > 0) {
        const parsed = parseRichText(enrichNarrativeMarkup(resolved));
        this.activeCrtBand.parsed = parsed;
        this.activeCrtBand.revealCount = Math.min(
          parsed.glyphs.length,
          Math.max(this.activeCrtBand.revealCount, 1),
        );
      }
    }
    if (this.activeBark?.reResolve !== undefined) {
      const next = this.activeBark.reResolve(tone);
      if (next !== null) {
        this.activeBark.parsed = parseRichText(enrichNarrativeMarkup(next));
        this.activeBark.revealCount = this.activeBark.parsed.glyphs.length;
      }
    }
    if (this.activeLastWords?.reResolve !== undefined) {
      const next = this.activeLastWords.reResolve(tone);
      if (next !== null) {
        this.activeLastWords.parsed = parseRichText(enrichNarrativeMarkup(next));
      }
    }
  }

  public getTone(): NarrativeTone {
    return this.currentTone;
  }

  public clear(): void {
    this.activeBark = null;
    this.activeLastWords = null;
    this.queuedLastWords = null;
    this.activeCrtBand = null;
  }

  /**
   * Yeni hamlede sahnede kalan balonu arşiv callback'ine aktarır ve kapatır.
   * `force=false` iken yeni açılmış (<1600ms) balonu düşman hamlesinde anında silmez.
   */
  public archiveActiveBark(force = true): void {
    if (this.activeBark !== null) {
      if (!force && this.activeBark.ageMs < 1600) {
        return;
      }
      this.options.onArchiveBark?.(this.activeBark.entrySnapshot);
      this.activeBark = null;
    }
  }

  public getActiveBark(): Readonly<ActiveBarkBubble> | null {
    return this.activeBark;
  }

  public getActiveLastWords(): Readonly<ActiveLastWordsBubble> | null {
    return this.activeLastWords;
  }

  public getActiveCrtBand(): Readonly<ActiveCrtBand> | null {
    return this.activeCrtBand;
  }

  /**
   * Katman 1 — Taş Üstü Konuşma Balonu (Max 1 aktif balon; öncekini arşive gönderir).
   */
  public showBark(
    entry: TerminalLogEntry,
    coord: Coord,
    reResolve?: (tone: NarrativeTone) => string | null,
  ): void {
    this.archiveActiveBark();
    const markup = entry.richText ?? enrichNarrativeMarkup(entry.text);
    const parsed = parseRichText(markup);
    this.activeBark = {
      speaker: entry.speaker,
      coord: { x: coord.x, y: coord.y },
      emotion: resolveBarkEmotion(entry),
      parsed,
      ageMs: 0,
      revealCount: parsed.glyphs.length > 0 ? 1 : 0,
      revealAccumMs: 0,
      charRevealTimesMs: new Array(parsed.glyphs.length).fill(-1),
      popInMs: 90,
      holdMs: computeAdaptiveDurationMs(parsed.plainText.length, 'bark'),
      fadeMs: 240,
      dismissing: false,
      entrySnapshot: entry,
      reResolve,
    };
    if (this.activeBark.charRevealTimesMs.length > 0) {
      this.activeBark.charRevealTimesMs[0] = 0;
    }
  }

  /**
   * Katman 2 — 'Son Söz' Asılı Ölüm Balonu (adaptif 3.2–5.6 sn ömür; peş peşe ölümlerde kuyruklar).
   */
  public showLastWords(
    entry: TerminalLogEntry,
    coord: Coord,
    reResolve?: (tone: NarrativeTone) => string | null,
  ): void {
    const markup = entry.richText ?? enrichNarrativeMarkup(entry.text);
    const parsed = parseRichText(markup);
    const charRevealTimesMs = new Array<number>(parsed.glyphs.length).fill(0);
    const nextBubble: ActiveLastWordsBubble = {
      speaker: entry.speaker,
      coord: { x: coord.x, y: coord.y },
      parsed,
      ageMs: 0,
      totalMs: computeAdaptiveDurationMs(parsed.plainText.length, 'lastWords'),
      charRevealTimesMs,
      reResolve,
    };
    if (this.activeLastWords !== null && this.activeLastWords.ageMs < 2000) {
      this.queuedLastWords = nextBubble;
      this.activeLastWords.totalMs = Math.min(
        this.activeLastWords.totalMs,
        Math.max(2400, this.activeLastWords.ageMs + 1100),
      );
      return;
    }
    this.queuedLastWords = null;
    this.activeLastWords = nextBubble;
  }

  /**
   * Katman 3 — Büyükusta-OS CRT Müdahale Bandı (140ms letterbox, 90ms glitch, 20ms/harf + 110ms es).
   */
  public showCrtBand(opts: {
    speaker?: string;
    text: string;
    mode?: 'green' | 'crimson';
    quoteSource?: CrtQuoteSource;
  }): void {
    const markup = enrichNarrativeMarkup(opts.text);
    const parsed = parseRichText(markup);
    const typeDurationEstimate = parsed.glyphs.length * 20;
    const band: ActiveCrtBand = {
      speaker: opts.speaker ?? 'BÜYÜKUSTA-OS',
      mode: opts.mode ?? 'green',
      parsed,
      ageMs: 0,
      revealCount: parsed.glyphs.length > 0 ? 1 : 0,
      revealAccumMs: 0,
      pauseLeftMs: 0,
      charRevealTimesMs: new Array(parsed.glyphs.length).fill(-1),
      lastBeepedCharIndex: -1,
      barSlideMs: 140,
      glitchMs: 90,
      holdAfterTypeMs: 3400,
      fadeMs: 240,
      totalMs: 140 + typeDurationEstimate + 3400 + 240,
      quoteSource: opts.quoteSource,
    };
    if (band.charRevealTimesMs.length > 0) {
      band.charRevealTimesMs[0] = 0;
      this.options.onTypewriterChar?.(0);
      band.lastBeepedCharIndex = 0;
    }
    this.activeCrtBand = band;
  }

  public update(dtMs: number): void {
    const dt = Math.max(0, dtMs);
    if (dt <= 0) return;

    // 1) Taş Üstü Balon (14ms/harf hızlı daktilo + 2200ms kalış + 180ms süzülme)
    if (this.activeBark !== null) {
      const b = this.activeBark;
      b.ageMs += dt;
      if (b.revealCount < b.parsed.glyphs.length) {
        b.revealAccumMs += dt;
        while (b.revealAccumMs >= 14 && b.revealCount < b.parsed.glyphs.length) {
          b.revealAccumMs -= 14;
          b.charRevealTimesMs[b.revealCount] = b.ageMs;
          b.revealCount++;
        }
      }
      const typingEndMs = b.popInMs + b.parsed.glyphs.length * 14;
      const totalLifeMs = typingEndMs + b.holdMs + b.fadeMs;
      if (b.ageMs >= totalLifeMs) {
        this.activeBark = null;
      }
    }

    // 2) Son Söz Balonu (adaptif 3.2–5.6 sn ömür; peş peşe ölümlerde kuyruktan sıradakini açar)
    if (this.activeLastWords !== null) {
      this.activeLastWords.ageMs += dt;
      if (this.activeLastWords.ageMs >= this.activeLastWords.totalMs) {
        this.activeLastWords = this.queuedLastWords;
        this.queuedLastWords = null;
      }
    }

    // 3) Büyükusta-OS CRT Bandı (20ms/harf, noktalama ',' '.' '...' de 110ms es, her 3 harfte beep)
    if (this.activeCrtBand !== null) {
      const c = this.activeCrtBand;
      c.ageMs += dt;

      if (c.ageMs > 70 && c.revealCount < c.parsed.glyphs.length) {
        let stepDt = dt;
        while (stepDt > 0 && c.revealCount < c.parsed.glyphs.length) {
          if (c.pauseLeftMs > 0) {
            const pUsed = Math.min(c.pauseLeftMs, stepDt);
            c.pauseLeftMs -= pUsed;
            stepDt -= pUsed;
            continue;
          }
          c.revealAccumMs += stepDt;
          stepDt = 0;
          while (c.revealAccumMs >= 20 && c.revealCount < c.parsed.glyphs.length) {
            c.revealAccumMs -= 20;
            const ch = c.parsed.glyphs[c.revealCount]!.char;
            c.charRevealTimesMs[c.revealCount] = c.ageMs;
            const charIdx = c.revealCount;
            c.revealCount++;
            if (charIdx > c.lastBeepedCharIndex) {
              c.lastBeepedCharIndex = charIdx;
              this.options.onTypewriterChar?.(charIdx);
            }
            const nextCh = c.parsed.glyphs[c.revealCount]?.char;
            if (ch === ',' || (ch === '.' && nextCh !== '.')) {
              c.pauseLeftMs = 110;
              break;
            }
          }
        }
      }

      if (c.revealCount >= c.parsed.glyphs.length) {
        // Adjust totalMs once typing finishes so hold time starts after last punctuation pause
        const finishAge = c.charRevealTimesMs[c.parsed.glyphs.length - 1] ?? c.ageMs;
        c.totalMs = Math.max(c.totalMs, finishAge + c.holdAfterTypeMs + c.fadeMs);
      }

      if (c.ageMs >= c.totalMs) {
        this.activeCrtBand = null;
      }
    }
  }

  public render(
    ctx: CanvasRenderingContext2D,
    layout: BoardLayout,
    state: VisibleState,
    timeMs: number,
    flipBoard: boolean,
    calmScreen = false,
  ): void {
    const { tileSize, offsetX, offsetY } = layout;
    const boardPixelW = state.width * tileSize;
    const boardPixelH = state.height * tileSize;

    // Katman 3: Büyükusta-OS CRT Müdahale Bandı (Letterbox + tarama çizgileri)
    if (this.activeCrtBand !== null) {
      this.renderCrtBand(ctx, this.activeCrtBand, offsetX, offsetY, boardPixelW, boardPixelH, timeMs, calmScreen);
    }

    // Katman 2: 'Son Söz' Asılı Ölüm Balonu (Enkazın üzerinde 1.4 sn asılı)
    if (this.activeLastWords !== null) {
      this.renderLastWordsBubble(ctx, this.activeLastWords, state, layout, timeMs, flipBoard);
    }

    // Katman 1: Taş Üstü Konuşma Balonu
    if (this.activeBark !== null) {
      this.renderBarkBubble(ctx, this.activeBark, state, layout, timeMs, flipBoard);
    }
  }

  private resolveCrtSourceText(src: CrtQuoteSource, tone: NarrativeTone): string {
    switch (src.kind) {
      case 'ROOM_INTRO':
        return getRoomIntroQuote(src.roomId, tone, src.seed);
      case 'LIVE_PATCH':
        return getLivePatchQuote(src.patchId, tone, src.turnNumber);
      case 'DEFEAT':
        return getDefeatBanner(src.reason, tone, src.seed, src.turnNumber);
      case 'VICTORY':
        return getVictoryQuote(src.isSecretCore, tone, src.seed);
    }
  }

  private renderBarkBubble(
    ctx: CanvasRenderingContext2D,
    b: ActiveBarkBubble,
    state: VisibleState,
    layout: BoardLayout,
    timeMs: number,
    flipBoard: boolean,
  ): void {
    const { tileSize, offsetX, offsetY } = layout;
    const boardW = state.width * tileSize;
    const boardH = state.height * tileSize;
    const gx = flipBoard ? state.width - 1 - b.coord.x : b.coord.x;
    const gy = flipBoard ? state.height - 1 - b.coord.y : b.coord.y;
    const anchorX = offsetX + gx * tileSize;
    const anchorY = offsetY + gy * tileSize;

    const dims = computeSpeechBubbleDimensions(b.parsed.plainText, b.speaker, boardW);
    const placement = computeSmartBubblePlacement({
      anchorX,
      anchorY,
      tileSize,
      boxW: dims.boxW,
      boxH: dims.boxH,
      boardLeft: offsetX,
      boardTop: offsetY,
      boardRight: offsetX + boardW,
      boardBottom: offsetY + boardH,
      gridY: gy,
    });

    const popProgress = Math.min(1, b.ageMs / b.popInMs);
    const scaleY = 0.2 + 0.8 * popProgress;
    const typingEndMs = b.popInMs + b.parsed.glyphs.length * 14;
    const fadeStartMs = typingEndMs + b.holdMs;
    const fadeProgress = b.ageMs > fadeStartMs ? Math.min(1, (b.ageMs - fadeStartMs) / b.fadeMs) : 0;
    const liftY = -8 * fadeProgress;
    const alpha = 1 - fadeProgress;
    if (alpha <= 0.01) return;

    const borderCol = getBorderColorForEmotion(b.emotion, timeMs);

    ctx.save();
    ctx.globalAlpha = alpha;
    const pivotY = placement.tailDir === 'down' ? placement.boxY + placement.boxH : placement.boxY;
    ctx.translate(0, liftY + pivotY);
    ctx.scale(1, scaleY);
    ctx.translate(0, -pivotY);

    // Kırpık köşeli %96 opak koyu arduvaz zemin & 2px piksel çerçeve + sert piksel gölge
    ctx.fillStyle = 'rgba(3, 5, 10, 0.85)';
    ctx.beginPath();
    ctx.rect(placement.boxX + 4, placement.boxY + 4, placement.boxW, placement.boxH);
    ctx.fill();

    ctx.fillStyle = '#0b111e';
    ctx.beginPath();
    ctx.rect(placement.boxX + 2, placement.boxY, placement.boxW - 4, placement.boxH);
    ctx.rect(placement.boxX, placement.boxY + 2, placement.boxW, placement.boxH - 4);
    ctx.fill();

    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 2;
    ctx.strokeRect(placement.boxX + 1, placement.boxY + 1, placement.boxW - 2, placement.boxH - 2);

    // 6x4px piksel ok ucu (taş yönünü gösterir)
    ctx.fillStyle = borderCol;
    ctx.beginPath();
    if (placement.tailDir === 'down') {
      ctx.rect(placement.pointerX - 3, placement.pointerY, 6, 2);
      ctx.rect(placement.pointerX - 1, placement.pointerY + 2, 2, 2);
    } else {
      ctx.rect(placement.pointerX - 1, placement.pointerY - 4, 2, 2);
      ctx.rect(placement.pointerX - 3, placement.pointerY - 2, 6, 2);
    }
    ctx.fill();

    // Konuşmacı başlığı & Satır içi animasyonlu daktilo metni (Piksel-sanat tipografi)
    ctx.font = `700 11px 'Pixelify Sans', 'Courier New', monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = borderCol;
    ctx.fillText(b.speaker, placement.boxX + 9, placement.boxY + 5);

    this.renderRichLines(
      ctx,
      b.parsed,
      dims.lines,
      b.revealCount,
      b.charRevealTimesMs,
      b.ageMs,
      timeMs,
      placement.boxX + 9,
      placement.boxY + 20,
      '#f8fafc',
      13,
    );

    ctx.restore();
  }

  private renderLastWordsBubble(
    ctx: CanvasRenderingContext2D,
    lw: ActiveLastWordsBubble,
    state: VisibleState,
    layout: BoardLayout,
    timeMs: number,
    flipBoard: boolean,
  ): void {
    const { tileSize, offsetX, offsetY } = layout;
    const boardW = state.width * tileSize;
    const boardH = state.height * tileSize;
    const gx = flipBoard ? state.width - 1 - lw.coord.x : lw.coord.x;
    const gy = flipBoard ? state.height - 1 - lw.coord.y : lw.coord.y;
    const anchorX = offsetX + gx * tileSize;
    const anchorY = offsetY + gy * tileSize;

    const dims = computeSpeechBubbleDimensions(lw.parsed.plainText, lw.speaker, boardW, 12);
    const placement = computeSmartBubblePlacement({
      anchorX,
      anchorY,
      tileSize,
      boxW: dims.boxW,
      boxH: dims.boxH,
      boardLeft: offsetX,
      boardTop: offsetY,
      boardRight: offsetX + boardW,
      boardBottom: offsetY + boardH,
      gridY: gy,
    });

    const staticWindowStart = lw.totalMs - 300;
    const inStatic = lw.ageMs >= staticWindowStart;
    const staticP = inStatic ? Math.min(1, (lw.ageMs - staticWindowStart) / 300) : 0;
    const alpha = inStatic ? Math.max(0.08, 1 - staticP * 0.88) : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Sert piksel gölge katmanı
    ctx.fillStyle = 'rgba(3, 5, 10, 0.85)';
    ctx.beginPath();
    ctx.rect(placement.boxX + 4, placement.boxY + 4, placement.boxW, placement.boxH);
    ctx.fill();

    ctx.fillStyle = '#1c070d';
    ctx.beginPath();
    ctx.rect(placement.boxX + 2, placement.boxY, placement.boxW - 4, placement.boxH);
    ctx.rect(placement.boxX, placement.boxY + 2, placement.boxW, placement.boxH - 4);
    ctx.fill();

    ctx.strokeStyle = '#dc2626';
    ctx.lineWidth = 2;
    ctx.strokeRect(placement.boxX + 1, placement.boxY + 1, placement.boxW - 2, placement.boxH - 2);

    // İnce okuma süresi ilerleme çizgisi (alt kenar — oyuncuya ne kadar zamanı kaldığını gösterir)
    const remainRatio = Math.max(0, Math.min(1, 1 - lw.ageMs / Math.max(1, lw.totalMs)));
    ctx.fillStyle = '#f87171';
    ctx.fillRect(placement.boxX + 2, placement.boxY + placement.boxH - 4, Math.round((placement.boxW - 4) * remainRatio), 2);

    // Sol üst köşede 5x5 piksel kafatası ikonu
    ctx.fillStyle = '#fecaca';
    ctx.beginPath();
    for (let r = 0; r < MINI_SKULL_5X5.length; r++) {
      const row = MINI_SKULL_5X5[r]!;
      for (let c = 0; c < row.length; c++) {
        if (row[c] === 'X') {
          ctx.rect(placement.boxX + 6 + c, placement.boxY + 7 + r, 1, 1);
        }
      }
    }
    ctx.fill();

    ctx.font = `700 11px 'Pixelify Sans', 'Courier New', monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#fca5a5';
    ctx.fillText(`† ${lw.speaker}`, placement.boxX + 16, placement.boxY + 5);

    this.renderRichLines(
      ctx,
      lw.parsed,
      dims.lines,
      lw.parsed.glyphs.length,
      lw.charRevealTimesMs,
      lw.ageMs,
      timeMs,
      placement.boxX + 9,
      placement.boxY + 20,
      '#fff1f2',
      13,
    );

    if (inStatic) {
      // Son 300 ms'de metni silmeden yarı saydam yatay parazit şeritleri ekler
      const sliceCount = 4;
      const sliceH = Math.ceil(placement.boxH / sliceCount);
      for (let s = 0; s < sliceCount; s++) {
        const shift = (s % 2 === 0 ? 1 : -1) * Math.round(staticP * 5);
        ctx.fillStyle = s % 2 === 0 ? 'rgba(220, 38, 38, 0.28)' : 'rgba(254, 202, 202, 0.16)';
        ctx.beginPath();
        ctx.rect(placement.boxX + shift, placement.boxY + s * sliceH, placement.boxW, 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  private renderCrtBand(
    ctx: CanvasRenderingContext2D,
    band: ActiveCrtBand,
    offsetX: number,
    offsetY: number,
    boardPixelW: number,
    boardPixelH: number,
    timeMs: number,
    calmScreen: boolean,
  ): void {
    const enterP = Math.min(1, band.ageMs / band.barSlideMs);
    const exitStart = band.totalMs - band.fadeMs;
    const exitP = band.ageMs > exitStart ? Math.min(1, (band.ageMs - exitStart) / band.fadeMs) : 0;
    const letterboxScale = enterP * (1 - exitP);
    if (letterboxScale <= 0.01) return;

    const barH = Math.max(10, Math.round(boardPixelH * 0.075 * letterboxScale));
    const accent = band.mode === 'crimson' ? '#f43f5e' : '#4ade80';
    const glitchDx =
      !calmScreen && band.ageMs < band.glitchMs
        ? Math.floor(band.ageMs / 24) % 2 === 0
          ? 2
          : -2
        : 0;

    ctx.save();
    ctx.globalAlpha = 1 - exitP;

    // Üst & alt siyah sinematik letterbox şeritleri
    ctx.fillStyle = '#020408';
    ctx.beginPath();
    ctx.rect(offsetX, offsetY, boardPixelW, barH);
    ctx.rect(offsetX, offsetY + boardPixelH - barH, boardPixelW, barH);
    ctx.fill();

    // Üst üçte birlik alanda Büyükusta-OS komuta bandı
    const bandTop = Math.round(offsetY + barH + 6);
    const bandW = Math.round(boardPixelW - 24);
    const bandX = Math.round(offsetX + 12 + glitchDx);
    const bandH = 54;

    if (!calmScreen && band.ageMs < band.glitchMs) {
      // 90ms yatay CRT RGB ayrışma çizgisi
      ctx.fillStyle = 'rgba(244, 63, 94, 0.35)';
      ctx.beginPath();
      ctx.rect(bandX - 2, bandTop, bandW, bandH);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(2, 8, 6, 0.94)';
    ctx.beginPath();
    ctx.rect(bandX, bandTop, bandW, bandH);
    ctx.fill();

    // 1px CRT tarama çizgileri (band içinde)
    ctx.fillStyle = band.mode === 'crimson' ? 'rgba(244, 63, 94, 0.14)' : 'rgba(74, 222, 128, 0.14)';
    ctx.beginPath();
    for (let sy = bandTop + 2; sy < bandTop + bandH; sy += 3) {
      ctx.rect(bandX + 1, sy, bandW - 2, 1);
    }
    ctx.fill();

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(bandX + 1, bandTop + 1, bandW - 2, bandH - 2);

    ctx.font = `700 11px 'Pixelify Sans', 'Courier New', monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = accent;
    ctx.fillText(`// ${band.speaker}`, bandX + 10, bandTop + 5);

    const maxChars = Math.max(26, Math.floor((bandW - 20) / 7.2));
    const revealedText = band.parsed.plainText.slice(0, band.revealCount);
    const wrapped = computeSpeechBubbleDimensions(revealedText, band.speaker, bandW + 40);
    const displayLines = wrapped.lines.slice(0, 2).map((l) => l.slice(0, maxChars));

    this.renderRichLines(
      ctx,
      band.parsed,
      displayLines,
      band.revealCount,
      band.charRevealTimesMs,
      band.ageMs,
      timeMs,
      bandX + 10,
      bandTop + 20,
      band.mode === 'crimson' ? '#fecdd3' : '#dcfce7',
      13,
    );

    ctx.restore();
  }

  private renderRichLines(
    ctx: CanvasRenderingContext2D,
    parsed: ParsedRichText,
    lines: readonly string[],
    revealCount: number,
    charRevealTimesMs: readonly number[],
    overlayAgeMs: number,
    timeMs: number,
    startX: number,
    startY: number,
    defaultColor: string,
    fontPx: number,
  ): void {
    const fallbackAdvance = Math.max(6, Math.round(fontPx * 0.6));
    const fontFamily = `'Pixelify Sans', 'Courier New', monospace`;
    const hasMeasure = typeof ctx.measureText === 'function';
    let globalCursor = 0;

    for (let li = 0; li < lines.length; li++) {
      const lineStr = lines[li]!;
      const lineY = startY + li * (fontPx + 4);
      let cursorX = startX;

      for (let ci = 0; ci < lineStr.length; ci++) {
        // Align cursor inside parsed.glyphs cleanly (spaces between wrapped lines match plainText)
        while (
          globalCursor < parsed.glyphs.length &&
          parsed.glyphs[globalCursor]!.char !== lineStr[ci]
        ) {
          globalCursor++;
        }
        const glyphIdx = Math.min(parsed.glyphs.length - 1, globalCursor);
        if (glyphIdx >= revealCount) return;

        const glyph = parsed.glyphs[glyphIdx] ?? {
          char: lineStr[ci]!,
          effect: 'normal' as const,
          charIndex: glyphIdx,
        };
        const revAt = charRevealTimesMs[glyphIdx] ?? -1;
        const revElapsed = revAt >= 0 ? Math.max(0, overlayAgeMs - revAt) : 100;
        const tr = computeGlyphTransform(glyph, timeMs, revElapsed);

        const fontSpec = `700 ${Math.round(fontPx * tr.scale)}px ${fontFamily}`;
        ctx.save();
        ctx.font = fontSpec;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = tr.tintColor ?? defaultColor;
        ctx.fillText(glyph.char, Math.round(cursorX + tr.dx), Math.round(lineY + tr.dy));
        const measured = hasMeasure ? ctx.measureText(glyph.char).width : 0;
        ctx.restore();

        if (measured > 0) {
          cursorX += measured;
        } else {
          cursorX += glyph.char === ' ' ? fallbackAdvance * 0.65 : fallbackAdvance;
        }
        globalCursor++;
      }
    }
  }
}

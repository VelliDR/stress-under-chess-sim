import { describe, expect, it } from 'vitest';
import {
  buildNarrativePieceMap,
  DEFEAT_BANNERS,
  enrichNarrativeMarkup,
  fnv1a32,
  getDefeatBanner,
  getLivePatchQuote,
  getMenuTickerQuotes,
  getPieceQuote,
  getRoomIntroQuote,
  getVictoryQuote,
  pickTerminalEntry,
  stripRichTags,
} from '../src/data/narrative';
import type { Piece, VisibleState } from '../src/engine/types';
import {
  computeAdaptiveDurationMs,
  computeGlyphTransform,
  computeSmartBubblePlacement,
  parseRichText,
  SpeechOverlay,
} from '../src/render/speechOverlay';

function makePiece(id: string, type: Piece['type'], x: number, y: number, side: 'PLAYER' | 'ENEMY' = 'PLAYER'): Piece {
  return {
    id,
    side,
    type,
    pos: { x, y },
    traits: [],
    shieldActive: false,
    frozenTurns: 0,
    hasMoved: false,
    aggro: 'ACTIVE',
    usedDashThisTurn: false,
    wasVisibleAtTurnStart: true,
  };
}

function makeMockCtx(): { ctx: CanvasRenderingContext2D; textCalls: string[]; rects: number } {
  const textCalls: string[] = [];
  let rects = 0;
  const mock: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'top',
    save: () => undefined,
    restore: () => undefined,
    translate: () => undefined,
    scale: () => undefined,
    beginPath: () => undefined,
    rect: () => {
      rects++;
    },
    fill: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    fillText: (txt: string) => {
      textCalls.push(txt);
    },
  };
  return { ctx: mock as unknown as CanvasRenderingContext2D, textCalls, rects };
}

describe('FAZ UI-4 — Dual-Tone Narrative, Inline Rich Text & SpeechOverlay', () => {
  it('guarantees FNV-1a determinism, dual-tone pools, SPEEDRUN defeat banners, and priority anti-spam order', () => {
    expect(fnv1a32('sucs-determinism')).toBe(fnv1a32('sucs-determinism'));

    const qUnf = getPieceQuote('PAWN', 'DISOBEY', 'unfiltered', '42:1');
    const qPol = getPieceQuote('PAWN', 'DISOBEY', 'polite', '42:1');
    expect(qUnf).toBeTruthy();
    expect(qPol).toBeTruthy();
    expect(qUnf).not.toBe(qPol);

    // Menu ticker flips cleanly between unfiltered and polite tones
    expect(getMenuTickerQuotes('unfiltered')).not.toEqual(getMenuTickerQuotes('polite'));

    // SPEEDRUN overrides defeat banner on turns <= 3
    expect(DEFEAT_BANNERS.SPEEDRUN.unfiltered).toContain(
      getDefeatBanner('KING_CAPTURED', 'unfiltered', 77, 2),
    );
    expect(DEFEAT_BANNERS.SPEEDRUN.polite).toContain(
      getDefeatBanner('PIT', 'polite', 77, 3),
    );

    // Anti-spam: 1 batch with OCAKLI_ULTIMATE + PIECE_DISOBEYED + PIECE_CAPTURED emits only 1 highest-priority entry
    const pieces = [
      makePiece('p_ocakli', 'SAINT_FAITH', 2, 4, 'PLAYER'),
      makePiece('p_pawn', 'PAWN', 1, 5, 'PLAYER'),
      makePiece('e_rook', 'ROOK', 5, 1, 'ENEMY'),
    ];
    const piecesById = buildNarrativePieceMap(pieces);
    const chosen = pickTerminalEntry(
      [
        { type: 'PIECE_DISOBEYED', pieceId: 'p_pawn', at: { x: 1, y: 5 } },
        { type: 'PIECE_CAPTURED', pieceId: 'e_rook', byPieceId: 'p_pawn', pos: { x: 5, y: 1 } },
        { type: 'FAITH_ULTIMATE_TRIGGERED', saintId: 'p_ocakli', pulseOrigin: { x: 2, y: 4 } },
      ],
      { seed: 101, turnNumber: 5, tone: 'unfiltered', piecesById },
    );
    expect(chosen).not.toBeNull();
    expect(chosen!.eventType).toBe('FAITH_ULTIMATE_TRIGGERED');
    expect(chosen!.layer).toBe('BARK');
    expect(chosen!.coord).toEqual({ x: 2, y: 4 });
    expect(chosen!.richText).toBeTruthy();

    // Death events route to LAST_WORDS layer
    const deathOnly = pickTerminalEntry(
      [{ type: 'PIECE_FELL_IN_PIT', pieceId: 'p_pawn', pos: { x: 3, y: 3 } }],
      { seed: 101, turnNumber: 6, tone: 'polite', piecesById },
    );
    expect(deathOnly?.layer).toBe('LAST_WORDS');
    expect(deathOnly?.coord).toEqual({ x: 3, y: 3 });

    // HALLUCINATION_DISPELLED routes to CRT_BAND layer
    const hal = pickTerminalEntry(
      [{ type: 'HALLUCINATION_DISPELLED', at: { x: 4, y: 4 } }],
      { seed: 9, turnNumber: 4, tone: 'unfiltered', piecesById },
    );
    expect(hal?.layer).toBe('CRT_BAND');
  });

  it('parses {shake}/{wave}/{pop} inline tags accurately and animates per-character transforms', () => {
    const sample = '{shake}PANİK{/shake} ve {wave}hardal gazı{/wave} sonra {pop}3 TUR{/pop}!';
    const parsed = parseRichText(sample);
    expect(parsed.plainText).toBe('PANİK ve hardal gazı sonra 3 TUR!');
    expect(stripRichTags(sample)).toBe(parsed.plainText);

    const shakeGlyph = parsed.glyphs[0]!;
    expect(shakeGlyph.effect).toBe('shake');
    const waveGlyph = parsed.glyphs.find((g) => g.effect === 'wave')!;
    expect(waveGlyph).toBeDefined();
    const popGlyph = parsed.glyphs.find((g) => g.effect === 'pop')!;
    expect(popGlyph).toBeDefined();

    const sTr = computeGlyphTransform(shakeGlyph, 120, 40);
    expect(Math.abs(sTr.dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(sTr.dy)).toBeLessThanOrEqual(1);

    const wTr0 = computeGlyphTransform(waveGlyph, 100, 40);
    const wTr1 = computeGlyphTransform(waveGlyph, 240, 40);
    expect(Math.abs(wTr0.dy)).toBeLessThanOrEqual(1.5001);
    expect(wTr0.dy).not.toBe(wTr1.dy);

    const popEarly = computeGlyphTransform(popGlyph, 100, 0);
    const popSettled = computeGlyphTransform(popGlyph, 200, 80);
    expect(popEarly.scale).toBeCloseTo(1.25, 2);
    expect(popSettled.scale).toBeCloseTo(1.0, 2);

    // Enrich automatically adds tags around critical keywords
    const auto = enrichNarrativeMarkup('3 tur içinde hardal gazı yüzünden PANİK başladı: S.U.C.S.');
    expect(auto).toContain('{pop}3 tur{/pop}');
    expect(auto).toContain('{shake}PANİK{/shake}');
    expect(auto).toContain('{wave}hardal gazı{/wave}');
  });

  it('aligns speech bubbles smartly on top row (flips down) and horizontal edges (pins pointer to piece center)', () => {
    const boardLayout = {
      boardLeft: 40,
      boardTop: 20,
      boardRight: 552,
      boardBottom: 532,
      tileSize: 64,
      boxW: 180,
      boxH: 48,
    };

    // Row 0 piece -> opens below with pointer pointing UP
    const topRow = computeSmartBubblePlacement({
      ...boardLayout,
      anchorX: 40 + 3 * 64,
      anchorY: 20,
      gridY: 0,
    });
    expect(topRow.tailDir).toBe('up');
    expect(topRow.boxY).toBeGreaterThanOrEqual(20 + 64);

    // Bottom-right corner piece -> opens above, clamps box inside right border, pointer stays near piece center
    const rightCol = computeSmartBubblePlacement({
      ...boardLayout,
      anchorX: 40 + 7 * 64, // tile center = 520
      anchorY: 20 + 7 * 64,
      gridY: 7,
    });
    expect(rightCol.tailDir).toBe('down');
    expect(rightCol.boxX + rightCol.boxW).toBeLessThanOrEqual(boardLayout.boardRight - 4);
    expect(rightCol.pointerX).toBeGreaterThan(rightCol.boxX + rightCol.boxW * 0.6);
  });

  it('manages max 1 active bark (archiving older), 1.4s Last Words TV static hang, and 20ms/110ms Büyükusta-OS CRT band with live tone switch', () => {
    const archived: string[] = [];
    const blippedIndices: number[] = [];
    const overlay = new SpeechOverlay({
      onArchiveBark: (entry) => archived.push(entry.speaker),
      onTypewriterChar: (idx) => blippedIndices.push(idx),
    });

    // 1) Bark typewriter (14ms/char), max 1 active bubble, archive on overwrite
    overlay.showBark(
      { speaker: 'PİYON-01', text: 'Gitmem!', severity: 'warn', eventType: 'PIECE_DISOBEYED', pieceType: 'PAWN' },
      { x: 1, y: 1 },
    );
    overlay.update(42);
    expect(overlay.getActiveBark()?.revealCount).toBeGreaterThanOrEqual(4);

    overlay.showBark(
      { speaker: 'MECZUP-02', text: 'DAVULA VUR!', severity: 'ultimate', eventType: 'MADNESS_ULTIMATE_TRIGGERED', pieceType: 'MECZUP' },
      { x: 2, y: 2 },
    );
    expect(archived).toEqual(['PİYON-01']);

    // 2) Last Words uses adaptive human-readable duration (>= 3200ms) and queues consecutive deaths
    expect(computeAdaptiveDurationMs(14, 'lastWords')).toBeGreaterThanOrEqual(3200);
    expect(computeAdaptiveDurationMs(60, 'lastWords')).toBeGreaterThanOrEqual(5000);
    overlay.showLastWords(
      { speaker: 'AT-04', text: 'Nalım kırıldı.', severity: 'info', eventType: 'PIECE_CAPTURED' },
      { x: 4, y: 4 },
    );
    overlay.update(2500); // Still clearly readable at 2.5s
    expect(overlay.getActiveLastWords()).not.toBeNull();
    overlay.update(900); // Gone after adaptive 3.2s total
    expect(overlay.getActiveLastWords()).toBeNull();

    // Consecutive death queues cleanly instead of instantly erasing the first quote
    overlay.showLastWords(
      { speaker: 'PİYON-01', text: 'İlk düşen benim!', severity: 'info', eventType: 'PIECE_CAPTURED' },
      { x: 2, y: 2 },
    );
    overlay.update(500);
    overlay.showLastWords(
      { speaker: 'AT-02', text: 'Ben de geldim!', severity: 'info', eventType: 'PIECE_CAPTURED' },
      { x: 3, y: 3 },
    );
    expect(overlay.getActiveLastWords()?.speaker).toBe('PİYON-01');
    overlay.update(2200);
    expect(overlay.getActiveLastWords()?.speaker).toBe('AT-02');
    overlay.clear();

    // 3) CRT Band: 20ms/char + 110ms punctuation pause on ',' / '.' + live tone toggle
    const introUnf = getRoomIntroQuote('act3-2', 'unfiltered', 7);
    const introPol = getRoomIntroQuote('act3-2', 'polite', 7);
    expect(introUnf).not.toBe(introPol);

    overlay.setTone('unfiltered');
    overlay.showCrtBand({
      speaker: 'BÜYÜKUSTA-OS',
      text: 'Merhaba, denek.',
      mode: 'green',
      quoteSource: { kind: 'ROOM_INTRO', roomId: 'act3-2', seed: 7 },
    });
    // Live switching tone to 'polite' immediately updates the active CRT band text!
    overlay.setTone('polite');
    expect(overlay.getActiveCrtBand()?.parsed.plainText).toBe(introPol);

    // Advance typewriter and ensure canvas render draws cleanly in headless mock context
    overlay.update(450);
    expect(blippedIndices.length).toBeGreaterThan(2);

    const mock = makeMockCtx();
    const fakeState = { width: 8, height: 8 } as unknown as VisibleState;
    expect(() =>
      overlay.render(
        mock.ctx,
        { cssWidth: 640, cssHeight: 560, dpr: 2, tileSize: 64, offsetX: 30, offsetY: 20, labelMargin: 24 },
        fakeState,
        450,
        false,
        false,
      ),
    ).not.toThrow();
    expect(mock.textCalls.length).toBeGreaterThan(0);

    // Patch quote also resolves cleanly
    expect(getLivePatchQuote('PATCH_01_PANIC', 'unfiltered', 4)).toContain('PATCH_01');
    expect(getVictoryQuote(false, 'polite', 1)).toContain('SİMÜLASYON');
  });
});

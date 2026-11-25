// src/render/tileSprites32.ts
// S.U.C.S. — 32x32 Zemin, Tuzak, Bakır Kablo, 3 Fazlı Kazık ve 4 Karelik Miasma Çizicileri
// Tüm 32x32 yüzeyler doğal 1x boyutta SpriteCache'e pişirilir veya doğrudan fallback olarak çizilir.

import { coordEquals } from '../engine/board';
import type { Coord, PendingSpawn, Side, TileState, TileTrap, VisibleState } from '../engine/types';
import {
  drawPixelGrid,
  fillTilePixel32,
  FLAME_FRAMES_32,
  MICRO_PIXEL_ICONS,
  tilePixelHash,
} from './pixelArt';
import {
  bakeMatrixToContext,
  RenderTheme,
  Surface2DContext,
  TILE_PX,
  TileCacheQuery,
  TrapCacheQuery,
} from './spriteCache';

const PIXEL_FONT_STACK = "'Pixelify Sans', 'Courier New', monospace";

export interface ThemePalette {
  stoneLight: string;
  stoneDark: string;
  stoneHiLight: string;
  stoneHiDark: string;
  stoneShLight: string;
  stoneShDark: string;
  stoneSpeckLight: string;
  stoneSpeckDark: string;
  wallTop: string;
  wallBevel: string;
  wallSide: string;
  wallMortar: string;
  wallBorder: string;
  pitCore: string;
  pitRim: string;
  pitStep1: string;
  pitStep2: string;
  iceLight: string;
  iceDark: string;
  iceBevel: string;
  iceShade: string;
  iceSheen: string;
  watchGold: string;
  watchDark: string;
  watchHi: string;
  fogUnexpEven: string;
  fogUnexpOdd: string;
  fogVeil: string;
  fogVeilCheck: string;
  miasmaFill: string;
  miasmaRimTop: string;
  miasmaRimBot: string;
  miasmaBubbleA: string;
  miasmaBubbleB: string;
  shieldA: string;
  shieldB: string;
}

export const THEME_PALETTES: Readonly<Record<RenderTheme, ThemePalette>> = {
  default: {
    stoneLight: '#2c3445',
    stoneDark: '#222836',
    stoneHiLight: '#3a4459',
    stoneHiDark: '#2d3547',
    stoneShLight: '#202634',
    stoneShDark: '#181d28',
    stoneSpeckLight: '#434f66',
    stoneSpeckDark: '#353e52',
    wallTop: '#5c677d',
    wallBevel: '#8c98b0',
    wallSide: '#363e4f',
    wallMortar: '#222834',
    wallBorder: '#151922',
    pitCore: '#04060a',
    pitRim: '#64748b',
    pitStep1: '#1e293b',
    pitStep2: '#111827',
    iceLight: '#1e6e94',
    iceDark: '#185c7d',
    iceBevel: '#38bdf8',
    iceShade: '#0c4a6e',
    iceSheen: '#e0f2fe',
    watchGold: '#f59e0b',
    watchDark: '#b45309',
    watchHi: '#fde047',
    fogUnexpEven: '#080b12',
    fogUnexpOdd: '#0a0e17',
    fogVeil: 'rgba(7, 10, 18, 0.48)',
    fogVeilCheck: 'rgba(7, 10, 18, 0.30)',
    miasmaFill: 'rgba(74, 222, 128, 0.42)',
    miasmaRimTop: 'rgba(74, 222, 128, 0.56)',
    miasmaRimBot: 'rgba(22, 163, 74, 0.48)',
    miasmaBubbleA: '#bbf7d0',
    miasmaBubbleB: '#4ade80',
    shieldA: 'rgba(56, 189, 248, 0.90)',
    shieldB: 'rgba(125, 211, 252, 0.72)',
  },
  crt: {
    stoneLight: '#12261e',
    stoneDark: '#0c1c16',
    stoneHiLight: '#1c3b2f',
    stoneHiDark: '#142d23',
    stoneShLight: '#0a1612',
    stoneShDark: '#060f0c',
    stoneSpeckLight: '#22c55e',
    stoneSpeckDark: '#15803d',
    wallTop: '#1e3a2f',
    wallBevel: '#4ade80',
    wallSide: '#0f241c',
    wallMortar: '#07140f',
    wallBorder: '#030a07',
    pitCore: '#020604',
    pitRim: '#22c55e',
    pitStep1: '#0b2218',
    pitStep2: '#05140d',
    iceLight: '#0f4c3a',
    iceDark: '#0a3a2c',
    iceBevel: '#4ade80',
    iceShade: '#064e3b',
    iceSheen: '#dcfce7',
    watchGold: '#facc15',
    watchDark: '#ca8a04',
    watchHi: '#fef08a',
    fogUnexpEven: '#030a06',
    fogUnexpOdd: '#050e09',
    fogVeil: 'rgba(2, 12, 7, 0.52)',
    fogVeilCheck: 'rgba(4, 20, 12, 0.34)',
    miasmaFill: 'rgba(34, 197, 94, 0.36)',
    miasmaRimTop: 'rgba(74, 222, 128, 0.65)',
    miasmaRimBot: 'rgba(22, 163, 74, 0.55)',
    miasmaBubbleA: '#dcfce7',
    miasmaBubbleB: '#22c55e',
    shieldA: 'rgba(74, 222, 128, 0.92)',
    shieldB: 'rgba(134, 239, 172, 0.75)',
  },
};

export function drawTile32ToSurface(
  ctx: Surface2DContext,
  query: TileCacheQuery,
  theme: RenderTheme,
): void {
  const isLight = query.parity === 0;
  const hash = tilePixelHash(query.parity, query.type.charCodeAt(0), 13);
  switch (query.type) {
    case 'PLAIN':
      drawPlainStone32(ctx, 0, 0, TILE_PX, isLight, hash, theme);
      break;
    case 'CRACKED':
      drawCracked32(ctx, 0, 0, TILE_PX, isLight, hash, theme);
      break;
    case 'WALL':
      drawWallMasonry32(ctx, 0, 0, TILE_PX, hash, theme);
      break;
    case 'PIT':
      drawPitChasm32(ctx, 0, 0, TILE_PX, hash, theme);
      break;
    case 'ICE':
      drawIceGlacier32(ctx, 0, 0, TILE_PX, isLight, theme);
      break;
    case 'WATCHTOWER':
      drawWatchtower32(ctx, 0, 0, TILE_PX, isLight, hash, theme);
      break;
    case 'BURNING':
      drawBurning32(ctx, 0, 0, TILE_PX, query.frame ?? 0);
      break;
  }
}

export function drawTrap32ToSurface(
  ctx: Surface2DContext,
  query: TrapCacheQuery,
  theme: RenderTheme,
): void {
  if (query.kind === 'PRESSURE_PLATE') {
    drawPressurePlate32(ctx, 0, 0, TILE_PX, query.active, theme);
    return;
  }
  if (query.kind === 'ARROW_EMITTER') {
    const dir = query.flipBoard
      ? {
          dx: query.dir.dx === 0 ? 0 : -query.dir.dx,
          dy: query.dir.dy === 0 ? 0 : -query.dir.dy,
        }
      : query.dir;
    drawArrowEmitter32(
      ctx,
      0,
      0,
      TILE_PX,
      dir.dx,
      dir.dy,
      query.flaming,
      query.depleted ?? false,
      theme,
    );
    return;
  }
  drawSpikes32(ctx, 0, 0, TILE_PX, query.phase, true);
}

export function drawMiasma32ToSurface(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  frame: number,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  ctx.fillStyle = tp.miasmaFill;
  ctx.fillRect(px, py, size, size);

  fillTilePixel32(ctx, px, py, size, 0, 0, 32, 2, tp.miasmaRimTop);
  fillTilePixel32(ctx, px, py, size, 0, 30, 32, 2, tp.miasmaRimBot);

  const f = ((frame % 4) + 4) % 4;
  for (let b = 0; b < 3; b++) {
    const bx = 5 + ((b * 9 + f * 3) % 21);
    const by = 26 - ((f * 5 + b * 7) % 20);
    fillTilePixel32(
      ctx,
      px,
      py,
      size,
      bx,
      by,
      3,
      3,
      b === 0 ? tp.miasmaBubbleA : tp.miasmaBubbleB,
    );
  }
}

export interface CopperWirePulse {
  readonly platePos: Coord;
  readonly emitterPos: Coord;
  /** Normalized signal travel progress 0..1 along L-shaped copper trace */
  readonly progress: number;
}

export interface CopperWireOptions {
  readonly selectedCoord: Coord | null;
  readonly inspectedCoord: Coord | null;
  readonly hoveredCoord: Coord | null;
  readonly flipBoard: boolean;
  readonly activePulses?: readonly CopperWirePulse[];
}

function mapGridCoord(coord: Coord, width: number, height: number, flip: boolean): Coord {
  if (!flip) return coord;
  return { x: width - 1 - coord.x, y: height - 1 - coord.y };
}

/**
 * Baskı plakaları ile bağlı duvar okları arasındaki ortogonal bakır bağlantı hatlarını çizer.
 * Hover, seçim veya inceleme sırasında hattı parlak kehribara (#FBBF24) yükseltir.
 */
export function drawCopperTrapWires(
  ctx: CanvasRenderingContext2D,
  state: VisibleState,
  offsetX: number,
  offsetY: number,
  tileSize: number,
  opts: CopperWireOptions,
): void {
  const emitters: Record<string, Coord> = {};
  const plates: Array<{ pos: Coord; targetIds: readonly string[] }> = [];

  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if ((state.fog[y]?.[x] ?? 'UNEXPLORED') === 'UNEXPLORED') continue;
      const tile = state.tiles[y]?.[x];
      if (tile === null || tile === undefined || tile.trap === undefined) continue;
      if (tile.trap.kind === 'ARROW_EMITTER') {
        emitters[tile.trap.id] = { x, y };
      } else if (tile.trap.kind === 'PRESSURE_PLATE') {
        plates.push({ pos: { x, y }, targetIds: tile.trap.targetIds });
      }
    }
  }

  if (plates.length === 0) return;

  ctx.save();
  for (let i = 0; i < plates.length; i++) {
    const plate = plates[i]!;
    const plateFocused =
      (opts.hoveredCoord !== null && coordEquals(opts.hoveredCoord, plate.pos)) ||
      (opts.selectedCoord !== null && coordEquals(opts.selectedCoord, plate.pos)) ||
      (opts.inspectedCoord !== null && coordEquals(opts.inspectedCoord, plate.pos));
    const pView = mapGridCoord(plate.pos, state.width, state.height, opts.flipBoard);
    const px = offsetX + (pView.x + 0.5) * tileSize;
    const py = offsetY + (pView.y + 0.5) * tileSize;

    for (let t = 0; t < plate.targetIds.length; t++) {
      const emPos = emitters[plate.targetIds[t]!];
      if (emPos === undefined) continue;
      const emFocused =
        (opts.hoveredCoord !== null && coordEquals(opts.hoveredCoord, emPos)) ||
        (opts.inspectedCoord !== null && coordEquals(opts.inspectedCoord, emPos));
      const active = plateFocused || emFocused;
      const eView = mapGridCoord(emPos, state.width, state.height, opts.flipBoard);
      const ex = offsetX + (eView.x + 0.5) * tileSize;
      const ey = offsetY + (eView.y + 0.5) * tileSize;

      ctx.strokeStyle = active ? '#fbbf24' : 'rgba(180, 83, 9, 0.52)';
      ctx.lineWidth = active ? Math.max(2.5, tileSize * 0.055) : Math.max(1.5, tileSize * 0.032);
      ctx.setLineDash(active ? [5, 3] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, ey);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      // Corner solder node for clean 16-bit circuit readability
      const nodeSize = Math.max(3, Math.round(tileSize * 0.08));
      ctx.fillStyle = active ? '#fde047' : '#b45309';
      ctx.beginPath();
      ctx.rect(Math.round(px - nodeSize * 0.5), Math.round(ey - nodeSize * 0.5), nodeSize, nodeSize);
      ctx.fill();

      // Optional animated copper signal spark along wire
      if (opts.activePulses !== undefined) {
        for (let pIdx = 0; pIdx < opts.activePulses.length; pIdx++) {
          const pulse = opts.activePulses[pIdx]!;
          if (!coordEquals(pulse.platePos, plate.pos) || !coordEquals(pulse.emitterPos, emPos)) {
            continue;
          }
          const seg1Len = Math.abs(ey - py);
          const seg2Len = Math.abs(ex - px);
          const totalLen = Math.max(1, seg1Len + seg2Len);
          const dist = Math.max(0, Math.min(1, pulse.progress)) * totalLen;
          const sx = dist <= seg1Len ? px : px + ((ex - px) * (dist - seg1Len)) / Math.max(1, seg2Len);
          const sy = dist <= seg1Len ? py + ((ey - py) * dist) / Math.max(1, seg1Len) : ey;
          const spark = Math.max(4, Math.round(tileSize * 0.14));
          ctx.fillStyle = '#fef08a';
          ctx.beginPath();
          ctx.rect(Math.round(sx - spark * 0.5), Math.round(sy - spark * 0.5), spark, spark);
          ctx.fill();
        }
      }
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
}

// ============================================================================
// 32x32 AUXILIARY & FOG SURFACE BAKERS
// ============================================================================

export function bakeUnexploredTile32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  parity: 0 | 1,
  variant: number,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  ctx.fillStyle = parity === 0 ? tp.fogUnexpEven : tp.fogUnexpOdd;
  ctx.fillRect(px, py, size, size);

  const v = ((variant % 4) + 4) % 4;
  const mx1 = 4 + v * 5;
  const my1 = 6 + ((v * 7) % 16);
  const mx2 = 24 - v * 4;
  const my2 = 22 - ((v * 5) % 14);
  const mistA = theme === 'crt' ? 'rgba(74, 222, 128, 0.12)' : 'rgba(100, 116, 139, 0.14)';
  const mistB = theme === 'crt' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(148, 163, 184, 0.10)';
  const weave = theme === 'crt' ? 'rgba(20, 83, 45, 0.22)' : 'rgba(51, 65, 85, 0.16)';

  fillTilePixel32(ctx, px, py, size, mx1, my1, 4, 2, mistA);
  fillTilePixel32(ctx, px, py, size, mx2, my2, 3, 1, mistB);
  fillTilePixel32(ctx, px, py, size, 1, 1, 1, 1, weave);
  fillTilePixel32(ctx, px, py, size, 16, 16, 1, 1, weave);
}

export function bakeExploredVeil32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  ctx.fillStyle = tp.fogVeil;
  ctx.fillRect(px, py, size, size);

  for (let gy = 0; gy < 32; gy += 2) {
    const startX = (gy >> 1) % 2 === 0 ? 0 : 2;
    for (let gx = startX; gx < 32; gx += 4) {
      fillTilePixel32(ctx, px, py, size, gx, gy, 2, 2, tp.fogVeilCheck);
    }
  }
}

export function bakeWallSouthShadow32(
  ctx: Surface2DContext,
  theme: RenderTheme,
): void {
  const col = theme === 'crt' ? 'rgba(2, 10, 6, 0.44)' : 'rgba(4, 6, 12, 0.36)';
  fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 0, 32, 6, col);
}

export function bakeFogFrontier32(
  ctx: Surface2DContext,
  edge: 'N' | 'S' | 'W' | 'E',
  theme: RenderTheme,
): void {
  const col = theme === 'crt' ? 'rgba(74, 222, 128, 0.18)' : 'rgba(56, 189, 248, 0.16)';
  if (edge === 'N') fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 0, 32, 2, col);
  else if (edge === 'S') fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 30, 32, 2, col);
  else if (edge === 'W') fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 0, 2, 32, col);
  else fillTilePixel32(ctx, 0, 0, TILE_PX, 30, 0, 2, 32, col);
}

export function bakeShieldOverlay32(
  ctx: Surface2DContext,
  silenced: boolean,
  theme: RenderTheme,
): void {
  const color = silenced ? 'rgba(148, 163, 184, 0.58)' : THEME_PALETTES[theme].shieldA;
  if (silenced) {
    for (let x = 7; x <= 23; x += 4) {
      fillTilePixel32(ctx, 0, 0, TILE_PX, x, 2, 2, 1, color);
      fillTilePixel32(ctx, 0, 0, TILE_PX, x, 26, 2, 1, color);
    }
    for (let y = 6; y <= 22; y += 4) {
      fillTilePixel32(ctx, 0, 0, TILE_PX, 3, y, 1, 2, color);
      fillTilePixel32(ctx, 0, 0, TILE_PX, 28, y, 1, 2, color);
    }
    return;
  }
  fillTilePixel32(ctx, 0, 0, TILE_PX, 8, 1, 16, 1, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 8, 27, 16, 1, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 2, 6, 1, 17, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 29, 6, 1, 17, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 2, 3, 1, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 24, 2, 3, 1, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 3, 3, 2, 3, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 27, 3, 2, 3, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 26, 3, 1, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 24, 26, 3, 1, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 3, 23, 2, 3, color);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 27, 23, 2, 3, color);
}

export function bakeFrozenCage32(ctx: Surface2DContext): void {
  fillTilePixel32(ctx, 0, 0, TILE_PX, 4, 4, 24, 21, 'rgba(125, 211, 252, 0.34)');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 7, 2, 18, 2, 'rgba(186, 230, 253, 0.42)');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 4, 4, 24, 1, '#bae6fd');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 4, 24, 24, 1, '#7dd3fc');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 4, 4, 1, 21, '#bae6fd');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 27, 4, 1, 21, '#7dd3fc');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 6, 7, 4, 1, '#f0f9ff');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 6, 8, 2, 3, '#f0f9ff');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 20, 18, 4, 1, '#e0f2fe');
}

export function bakeComposureBar32(
  ctx: Surface2DContext,
  composure: 0 | 1 | 2,
  blinkOn: boolean,
): void {
  const notchPositions = [5, 13, 21] as const;
  const activeColor = composure === 2 ? '#f59e0b' : blinkOn ? '#ef4444' : '#fca5a5';
  for (let n = 0; n < 3; n++) {
    const nx = notchPositions[n]!;
    fillTilePixel32(ctx, 0, 0, TILE_PX, nx - 1, 27, 8, 4, '#04070d');
    fillTilePixel32(
      ctx,
      0,
      0,
      TILE_PX,
      nx,
      28,
      6,
      2,
      n < composure ? activeColor : '#1e293b',
    );
  }
  if (composure === 0) {
    // Breakdown (Composure = 0): soğuk gri-mavi kilit çizgisi (4, 28) 24x3 bandında
    fillTilePixel32(ctx, 0, 0, TILE_PX, 4, 29, 24, 1, '#64748b');
    fillTilePixel32(ctx, 0, 0, TILE_PX, 13, 28, 6, 2, '#38bdf8');
  }
}

/**
 * 32x32 karenin tabanında 24x24 taş altında oturan basamaklı koyu oval zemin gölgesi.
 */
export function bakePieceShadow32(ctx: Surface2DContext): void {
  fillTilePixel32(ctx, 0, 0, TILE_PX, 7, 23, 18, 4, 'rgba(4, 6, 12, 0.34)');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 24, 22, 2, 'rgba(4, 6, 12, 0.34)');
  fillTilePixel32(ctx, 0, 0, TILE_PX, 8, 24, 16, 2, 'rgba(4, 6, 12, 0.56)');
}

/**
 * Sol-Üst (1, 1) konumu için 7x7 3 noktalı Ocaklı/Meczup aura şarj rozeti.
 */
export function bakeAuraBadge7(
  ctx: Surface2DContext,
  aspect: 'FAITH' | 'MADNESS',
  charge: 1 | 2 | 3,
): void {
  const dotColor = aspect === 'FAITH' ? '#fbbf24' : '#f43f5e';
  const rimColor = aspect === 'FAITH' ? '#451a03' : '#4c0519';
  ctx.fillStyle = '#04070d';
  ctx.fillRect(0, 0, 7, 7);
  ctx.fillStyle = rimColor;
  ctx.fillRect(1, 1, 5, 5);
  const dotYs = [1, 3, 5] as const;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i < charge ? dotColor : '#1e293b';
    ctx.fillRect(2, dotYs[i]!, 3, 1);
  }
}

/**
 * Stres >= 75 (PANİK ATAK!) durumunda tahtanın 4 köşesinde nabız atan pikselli kızıl vignette.
 */
export function bakePanicCorner32(
  ctx: Surface2DContext,
  corner: 'TL' | 'TR' | 'BL' | 'BR',
  pulseOn: boolean,
): void {
  const outer = pulseOn ? 'rgba(220, 38, 38, 0.56)' : 'rgba(153, 27, 27, 0.34)';
  const inner = pulseOn ? 'rgba(248, 113, 113, 0.72)' : 'rgba(220, 38, 38, 0.42)';
  if (corner === 'TL') {
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 0, 20, 3, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 0, 3, 20, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 0, 10, 2, inner);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 0, 2, 10, inner);
  } else if (corner === 'TR') {
    fillTilePixel32(ctx, 0, 0, TILE_PX, 12, 0, 20, 3, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 29, 0, 3, 20, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 22, 0, 10, 2, inner);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 30, 0, 2, 10, inner);
  } else if (corner === 'BL') {
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 29, 20, 3, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 12, 3, 20, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 30, 10, 2, inner);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, 22, 2, 10, inner);
  } else {
    fillTilePixel32(ctx, 0, 0, TILE_PX, 12, 29, 20, 3, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 29, 12, 3, 20, outer);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 22, 30, 10, 2, inner);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 30, 22, 2, 10, inner);
  }
}

export function bakeFrameBorder32(
  ctx: Surface2DContext,
  kind: 'BONUS_DASH_0' | 'BONUS_DASH_1' | 'BOSS_0' | 'BOSS_1',
): void {
  const isBoss = kind.startsWith('BOSS');
  const phase = kind.endsWith('0');
  const color = isBoss
    ? phase
      ? '#f59e0b'
      : '#c084fc'
    : phase
      ? '#fde047'
      : '#f59e0b';
  for (let i = 1; i <= 28; i += 4) {
    fillTilePixel32(ctx, 0, 0, TILE_PX, i, 1, 2, 1, color);
    fillTilePixel32(ctx, 0, 0, TILE_PX, i, 30, 2, 1, color);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 1, i, 1, 2, color);
    fillTilePixel32(ctx, 0, 0, TILE_PX, 30, i, 1, 2, color);
  }
}

export function bakeAuraPips32(
  ctx: Surface2DContext,
  faithCount: number,
  madnessCount: number,
): void {
  for (let c = 0; c < Math.min(3, faithCount); c++) {
    const py = 9 + c * 5;
    fillTilePixel32(ctx, 0, 0, TILE_PX, 0, py - 1, 4, 4, '#04070d');
    fillTilePixel32(ctx, 0, 0, TILE_PX, 1, py, 2, 2, '#fbbf24');
  }
  const offsetX = faithCount > 0 ? 3 : 0;
  for (let c = 0; c < Math.min(3, madnessCount); c++) {
    const py = 9 + c * 5;
    fillTilePixel32(ctx, 0, 0, TILE_PX, offsetX, py - 1, 4, 4, '#04070d');
    fillTilePixel32(ctx, 0, 0, TILE_PX, offsetX + 1, py, 2, 2, '#f43f5e');
  }
}

export function bakeSilhouetteMarker32(
  ctx: Surface2DContext,
  side: Side,
  pulse: boolean,
  theme: RenderTheme,
): void {
  const isEnemy = side === 'ENEMY';
  const accent = isEnemy
    ? theme === 'crt'
      ? '#fb7185'
      : '#ef4444'
    : theme === 'crt'
      ? '#4ade80'
      : '#38bdf8';

  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 5, 5, 2, accent);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 5, 2, 5, accent);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 22, 5, 5, 2, accent);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 25, 5, 2, 5, accent);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 25, 5, 2, accent);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 22, 2, 5, accent);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 22, 25, 5, 2, accent);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 25, 22, 2, 5, accent);

  const pal = isEnemy
    ? { O: '#450a0a', H: pulse ? '#fecaca' : '#f87171', A: accent, D: '#991b1b' }
    : { O: '#082f49', H: pulse ? '#e0f2fe' : '#7dd3fc', A: accent, D: '#0284c7' };
  const rows = MICRO_PIXEL_ICONS.QUESTION;
  const dy = pulse ? 7 : 9;
  for (let r = 0; r < 8; r++) {
    const line = rows[r]!;
    for (let c = 0; c < 8; c++) {
      const ch = line[c]!;
      if (ch === '.' || ch === ' ') continue;
      const col = pal[ch as keyof typeof pal];
      if (!col) continue;
      fillTilePixel32(ctx, 0, 0, TILE_PX, 8 + c * 2, dy + r * 2, 2, 2, col);
    }
  }
}

export function bakeAggroBadge10(
  ctx: Surface2DContext,
  aggro: 'SLEEPING' | 'ALERTED',
): void {
  ctx.fillStyle = aggro === 'ALERTED' ? '#f59e0b' : '#0f172a';
  ctx.fillRect(0, 0, 10, 10);
  if (aggro === 'ALERTED') {
    ctx.fillStyle = '#451a03';
    ctx.fillRect(1, 1, 8, 8);
  }
  const icon = aggro === 'ALERTED' ? MICRO_PIXEL_ICONS.ALERT : MICRO_PIXEL_ICONS.SLEEP_Z;
  const pal =
    aggro === 'ALERTED'
      ? { O: '#451a03', H: '#fef08a', A: '#f59e0b', D: '#b45309' }
      : { O: '#1e293b', H: '#cbd5e1', A: '#94a3b8', D: '#64748b' };
  bakeMatrixToContext(ctx, icon, pal, 10, 10);
}

export function bakeHazardSkull14(ctx: Surface2DContext): void {
  ctx.fillStyle = '#fde047';
  ctx.fillRect(0, 0, 14, 14);
  ctx.fillStyle = '#991b1b';
  ctx.fillRect(1, 1, 12, 12);
  const rows = MICRO_PIXEL_ICONS.SKULL;
  const pal = { O: '#450a0a', H: '#fef2f2', A: '#fca5a5', D: '#dc2626' };
  bakeMatrixToContext(ctx, rows, pal, 14, 14);
}

export function bakePendingSpawn32(ctx: Surface2DContext, pulse: boolean): void {
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 5, 22, 22, 'rgba(16, 185, 129, 0.18)');
  const border = pulse ? '#34d399' : '#a78bfa';
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 5, 22, 1, border);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 26, 22, 1, border);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 5, 5, 1, 22, border);
  fillTilePixel32(ctx, 0, 0, TILE_PX, 26, 5, 1, 22, border);

  const pal = { O: '#064e3b', A: '#34d399', H: '#a7f3d0', D: '#059669' };
  const icon = MICRO_PIXEL_ICONS.SPAWN;
  for (let r = 0; r < 8; r++) {
    const line = icon[r]!;
    for (let c = 0; c < 8; c++) {
      const ch = line[c]!;
      if (ch === '.' || ch === ' ') continue;
      fillTilePixel32(ctx, 0, 0, TILE_PX, 12 + c, 7 + r, 1, 1, pal[ch as keyof typeof pal]!);
    }
  }
}

// ============================================================================
// 32x32 TERRAIN & TRAP PAINTERS
// ============================================================================

export function drawPlainStone32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  isLight: boolean,
  hash: number,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  const base = isLight ? tp.stoneLight : tp.stoneDark;
  const hi = isLight ? tp.stoneHiLight : tp.stoneHiDark;
  const sh = isLight ? tp.stoneShLight : tp.stoneShDark;
  const speck = isLight ? tp.stoneSpeckLight : tp.stoneSpeckDark;

  ctx.fillStyle = base;
  ctx.fillRect(px, py, size, size);

  fillTilePixel32(ctx, px, py, size, 0, 0, 31, 1, hi);
  fillTilePixel32(ctx, px, py, size, 0, 1, 1, 30, hi);
  fillTilePixel32(ctx, px, py, size, 0, 31, 32, 1, sh);
  fillTilePixel32(ctx, px, py, size, 31, 0, 1, 31, sh);

  fillTilePixel32(ctx, px, py, size, 2, 15, 28, 1, sh);
  fillTilePixel32(ctx, px, py, size, 2, 16, 10, 1, hi);
  fillTilePixel32(ctx, px, py, size, 15, 2, 1, 13, sh);

  const variant = hash % 3;
  if (variant === 0) {
    fillTilePixel32(ctx, px, py, size, 7, 9, 4, 1, sh);
    fillTilePixel32(ctx, px, py, size, 20, 22, 3, 1, speck);
  } else if (variant === 1) {
    fillTilePixel32(ctx, px, py, size, 21, 7, 3, 1, speck);
    fillTilePixel32(ctx, px, py, size, 8, 23, 2, 1, sh);
  } else {
    fillTilePixel32(ctx, px, py, size, 5, 5, 2, 1, speck);
    fillTilePixel32(ctx, px, py, size, 23, 25, 2, 1, sh);
  }
}

export function drawCracked32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  isLight: boolean,
  hash: number,
  theme: RenderTheme,
): void {
  drawPlainStone32(ctx, px, py, size, isLight, hash, theme);
  const edge = theme === 'crt' ? '#22c55e' : '#475569';
  const dustLight = theme === 'crt' ? '#4ade80' : '#94a3b8';
  const dustDark = theme === 'crt' ? '#14532d' : '#1e293b';

  // Keskin koyu yarık ağı
  fillTilePixel32(ctx, px, py, size, 4, 4, 4, 2, '#090d16');
  fillTilePixel32(ctx, px, py, size, 8, 6, 4, 3, '#05070c');
  fillTilePixel32(ctx, px, py, size, 12, 9, 6, 3, '#05070c');
  fillTilePixel32(ctx, px, py, size, 18, 12, 4, 5, '#05070c');
  fillTilePixel32(ctx, px, py, size, 22, 17, 6, 4, '#090d16');
  fillTilePixel32(ctx, px, py, size, 12, 12, 2, 7, '#05070c');
  fillTilePixel32(ctx, px, py, size, 7, 19, 5, 4, '#090d16');
  fillTilePixel32(ctx, px, py, size, 18, 7, 5, 3, '#090d16');

  // Yarık kenar vurgusu
  fillTilePixel32(ctx, px, py, size, 13, 8, 4, 1, edge);
  fillTilePixel32(ctx, px, py, size, 19, 14, 1, 3, edge);

  // Toz kırıntıları (Bölüm 1.4)
  fillTilePixel32(ctx, px, py, size, 9, 11, 2, 1, dustLight);
  fillTilePixel32(ctx, px, py, size, 15, 16, 1, 1, dustLight);
  fillTilePixel32(ctx, px, py, size, 24, 14, 2, 1, dustDark);
  fillTilePixel32(ctx, px, py, size, 6, 24, 2, 1, dustLight);
  fillTilePixel32(ctx, px, py, size, 21, 23, 1, 2, dustDark);
}

export function drawWallMasonry32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  hash: number,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  ctx.fillStyle = tp.wallTop;
  ctx.fillRect(px, py, size, size);

  fillTilePixel32(ctx, px, py, size, 0, 0, 32, 2, tp.wallBorder);
  fillTilePixel32(ctx, px, py, size, 0, 0, 2, 32, tp.wallBorder);
  fillTilePixel32(ctx, px, py, size, 30, 0, 2, 32, tp.wallBorder);
  fillTilePixel32(ctx, px, py, size, 0, 30, 32, 2, tp.wallBorder);

  fillTilePixel32(ctx, px, py, size, 2, 2, 28, 2, tp.wallBevel);
  fillTilePixel32(ctx, px, py, size, 2, 4, 2, 16, tp.stoneHiLight);
  fillTilePixel32(ctx, px, py, size, 4, 4, 26, 16, tp.wallTop);

  fillTilePixel32(ctx, px, py, size, 2, 10, 28, 1, tp.wallMortar);
  fillTilePixel32(ctx, px, py, size, 2, 11, 28, 1, tp.wallBevel);
  const j1 = hash % 2 === 0 ? 14 : 18;
  const j2 = hash % 2 === 0 ? 20 : 10;
  fillTilePixel32(ctx, px, py, size, j1, 4, 2, 6, tp.wallMortar);
  fillTilePixel32(ctx, px, py, size, j2, 12, 2, 8, tp.wallMortar);

  fillTilePixel32(ctx, px, py, size, 2, 20, 28, 2, tp.wallMortar);
  fillTilePixel32(ctx, px, py, size, 2, 22, 28, 8, tp.wallSide);
  fillTilePixel32(ctx, px, py, size, 2, 22, 28, 1, tp.stoneHiLight);
  fillTilePixel32(ctx, px, py, size, 2, 26, 28, 1, tp.wallMortar);
  fillTilePixel32(ctx, px, py, size, 10, 22, 2, 4, tp.wallMortar);
  fillTilePixel32(ctx, px, py, size, 22, 22, 2, 4, tp.wallMortar);
  fillTilePixel32(ctx, px, py, size, 16, 26, 2, 4, tp.wallMortar);
}

export function drawPitChasm32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  hash: number,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  ctx.fillStyle = tp.pitCore;
  ctx.fillRect(px, py, size, size);

  fillTilePixel32(ctx, px, py, size, 0, 0, 32, 2, tp.pitStep1);
  fillTilePixel32(ctx, px, py, size, 4, 0, 6, 2, tp.pitRim);
  fillTilePixel32(ctx, px, py, size, 20, 0, 6, 2, tp.pitRim);
  fillTilePixel32(ctx, px, py, size, 0, 30, 32, 2, tp.pitStep1);
  fillTilePixel32(ctx, px, py, size, 0, 0, 2, 32, tp.pitStep1);
  fillTilePixel32(ctx, px, py, size, 30, 0, 2, 32, tp.pitStep1);

  fillTilePixel32(ctx, px, py, size, 2, 2, 28, 4, tp.pitStep1);
  fillTilePixel32(ctx, px, py, size, 2, 6, 28, 4, tp.pitStep2);
  fillTilePixel32(ctx, px, py, size, 4, 10, 24, 3, '#080c14');

  const c1 = 8 + (hash % 5);
  const c2 = 20 + ((hash >>> 3) % 5);
  fillTilePixel32(ctx, px, py, size, c1, 2, 2, 6, tp.pitCore);
  fillTilePixel32(ctx, px, py, size, c2, 2, 2, 7, tp.pitCore);

  fillTilePixel32(ctx, px, py, size, 4, 4, 2, 2, tp.pitRim);
  fillTilePixel32(ctx, px, py, size, 26, 4, 2, 2, tp.pitRim);
  fillTilePixel32(ctx, px, py, size, 10, 18, 2, 1, tp.pitStep2);
  fillTilePixel32(ctx, px, py, size, 20, 22, 2, 1, tp.pitStep2);
}

export function drawIceGlacier32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  isLight: boolean,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  ctx.fillStyle = isLight ? tp.iceLight : tp.iceDark;
  ctx.fillRect(px, py, size, size);

  fillTilePixel32(ctx, px, py, size, 0, 0, 32, 2, tp.iceBevel);
  fillTilePixel32(ctx, px, py, size, 0, 2, 2, 28, tp.iceBevel);
  fillTilePixel32(ctx, px, py, size, 0, 30, 32, 2, tp.iceShade);
  fillTilePixel32(ctx, px, py, size, 30, 2, 2, 28, tp.iceShade);
  fillTilePixel32(ctx, px, py, size, 4, 2, 10, 1, tp.iceSheen);

  for (let i = 0; i < 6; i++) {
    fillTilePixel32(ctx, px, py, size, 5 + i, 10 - i, 1, 1, tp.iceSheen);
  }
  for (let i = 0; i < 16; i++) {
    fillTilePixel32(
      ctx,
      px,
      py,
      size,
      8 + i,
      24 - i,
      1,
      1,
      i % 3 === 0 ? '#ffffff' : tp.iceBevel,
    );
  }
  for (let i = 0; i < 5; i++) {
    fillTilePixel32(ctx, px, py, size, 21 + i, 26 - i, 1, 1, tp.iceBevel);
  }
}

export function drawWatchtower32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  isLight: boolean,
  hash: number,
  theme: RenderTheme,
): void {
  const tp = THEME_PALETTES[theme];
  drawPlainStone32(ctx, px, py, size, isLight, hash, theme);

  fillTilePixel32(ctx, px, py, size, 2, 2, 28, 28, 'rgba(245, 158, 11, 0.14)');
  fillTilePixel32(ctx, px, py, size, 2, 2, 28, 2, tp.watchGold);
  fillTilePixel32(ctx, px, py, size, 2, 28, 28, 2, tp.watchDark);
  fillTilePixel32(ctx, px, py, size, 2, 2, 2, 28, tp.watchGold);
  fillTilePixel32(ctx, px, py, size, 28, 2, 2, 28, tp.watchDark);

  fillTilePixel32(ctx, px, py, size, 2, 2, 4, 4, tp.watchHi);
  fillTilePixel32(ctx, px, py, size, 26, 2, 4, 4, tp.watchHi);
  fillTilePixel32(ctx, px, py, size, 2, 26, 4, 4, tp.watchGold);
  fillTilePixel32(ctx, px, py, size, 26, 26, 4, 4, tp.watchGold);

  fillTilePixel32(ctx, px, py, size, 14, 10, 4, 2, 'rgba(253, 224, 71, 0.55)');
  fillTilePixel32(ctx, px, py, size, 14, 20, 4, 2, 'rgba(253, 224, 71, 0.55)');
  fillTilePixel32(ctx, px, py, size, 10, 14, 2, 4, 'rgba(253, 224, 71, 0.55)');
  fillTilePixel32(ctx, px, py, size, 20, 14, 2, 4, 'rgba(253, 224, 71, 0.55)');
  fillTilePixel32(ctx, px, py, size, 14, 14, 4, 4, 'rgba(254, 240, 138, 0.72)');

  const pal = { O: '#451a03', A: tp.watchGold, H: tp.watchHi, D: tp.watchDark };
  const icon = MICRO_PIXEL_ICONS.TOWER;
  for (let r = 0; r < 8; r++) {
    const line = icon[r]!;
    for (let c = 0; c < 8; c++) {
      const ch = line[c]!;
      if (ch === '.' || ch === ' ') continue;
      fillTilePixel32(ctx, px, py, size, 20 + c, 4 + r, 1, 1, pal[ch as keyof typeof pal]!);
    }
  }
}

export function drawBurning32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  frameIdx: number,
): void {
  ctx.fillStyle = '#291009';
  ctx.fillRect(px, py, size, size);

  fillTilePixel32(ctx, px, py, size, 0, 0, 32, 2, '#f97316');
  fillTilePixel32(ctx, px, py, size, 0, 30, 32, 2, '#c2410c');
  fillTilePixel32(ctx, px, py, size, 0, 2, 2, 28, '#ea580c');
  fillTilePixel32(ctx, px, py, size, 30, 2, 2, 28, '#c2410c');
  fillTilePixel32(ctx, px, py, size, 4, 24, 24, 4, '#431407');
  fillTilePixel32(ctx, px, py, size, 8, 26, 6, 2, '#ea580c');
  fillTilePixel32(ctx, px, py, size, 18, 26, 6, 2, '#f97316');

  const frame = FLAME_FRAMES_32[((frameIdx % 3) + 3) % 3]!;
  const pal = {
    O: '#7c2d12',
    R: '#f97316',
    Y: '#facc15',
    W: '#fef9c3',
  };
  if (px === 0 && py === 0 && size === TILE_PX) {
    bakeMatrixToContext(ctx, frame, pal, TILE_PX, TILE_PX);
  } else {
    drawPixelGrid(ctx as CanvasRenderingContext2D, frame, pal, px, py, size, size);
  }
}

export function drawPressurePlate32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  ready: boolean,
  theme: RenderTheme,
): void {
  const glow = theme === 'crt' ? '#facc15' : '#fde047';
  const yShift = ready ? 0 : 1;
  fillTilePixel32(ctx, px, py, size, 6, 6, 20, 20, '#1c1917');
  fillTilePixel32(ctx, px, py, size, 8, 8 + yShift, 16, 15, ready ? '#92400e' : '#44403c');
  fillTilePixel32(ctx, px, py, size, 10, 10 + yShift, 12, 11, ready ? '#b45309' : '#57534e');
  fillTilePixel32(ctx, px, py, size, 8, 8 + yShift, 16, 2, ready ? '#f59e0b' : '#78716c');
  fillTilePixel32(ctx, px, py, size, 14, 14 + yShift, 4, 4, ready ? glow : '#a8a29e');
}

export function drawArrowEmitter32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  dx: number,
  dy: number,
  flaming: boolean,
  empty: boolean,
  theme: RenderTheme,
): void {
  const accent = empty ? '#64748b' : flaming ? '#f97316' : theme === 'crt' ? '#4ade80' : '#fbbf24';
  const core = empty ? '#334155' : flaming ? '#fef08a' : '#e2e8f0';

  fillTilePixel32(ctx, px, py, size, 10, 10, 12, 12, '#1e293b');
  fillTilePixel32(ctx, px, py, size, 12, 12, 8, 8, accent);
  fillTilePixel32(ctx, px, py, size, 14, 14, 4, 4, core);

  if (dx === 1) {
    fillTilePixel32(ctx, px, py, size, 22, 12, 8, 8, '#0f172a');
    fillTilePixel32(ctx, px, py, size, 22, 14, 8, 4, accent);
    fillTilePixel32(ctx, px, py, size, 28, 15, 3, 2, core);
  } else if (dx === -1) {
    fillTilePixel32(ctx, px, py, size, 2, 12, 8, 8, '#0f172a');
    fillTilePixel32(ctx, px, py, size, 2, 14, 8, 4, accent);
    fillTilePixel32(ctx, px, py, size, 1, 15, 3, 2, core);
  } else if (dy === 1) {
    fillTilePixel32(ctx, px, py, size, 12, 22, 8, 8, '#0f172a');
    fillTilePixel32(ctx, px, py, size, 14, 22, 4, 8, accent);
    fillTilePixel32(ctx, px, py, size, 15, 28, 2, 3, core);
  } else {
    fillTilePixel32(ctx, px, py, size, 12, 2, 8, 8, '#0f172a');
    fillTilePixel32(ctx, px, py, size, 14, 2, 4, 8, accent);
    fillTilePixel32(ctx, px, py, size, 15, 1, 2, 3, core);
  }
}

export function drawSpikes32(
  ctx: Surface2DContext,
  px: number,
  py: number,
  size: number,
  phase: 0 | 1 | 2,
  blink: boolean,
): void {
  const holes: readonly [number, number][] = [
    [6, 6],
    [20, 6],
    [6, 20],
    [20, 20],
  ];
  for (let i = 0; i < holes.length; i++) {
    const [hx, hy] = holes[i]!;
    fillTilePixel32(ctx, px, py, size, hx, hy, 6, 6, '#090d16');
    if (phase === 1) {
      fillTilePixel32(ctx, px, py, size, hx + 2, hy + 2, 2, 2, blink ? '#facc15' : '#f59e0b');
      fillTilePixel32(ctx, px, py, size, hx + 2, hy, 2, 2, '#f59e0b');
    } else if (phase === 2) {
      fillTilePixel32(ctx, px, py, size, hx + 1, hy - 2, 4, 6, '#94a3b8');
      fillTilePixel32(ctx, px, py, size, hx + 2, hy - 4, 2, 8, '#e2e8f0');
      fillTilePixel32(ctx, px, py, size, hx + 2, hy - 4, 2, 2, '#ef4444');
    }
  }
}

// ============================================================================
// PUBLIC DIRECT DRAW FUNCTIONS (HEADLESS FALLBACK + SHARED ART)
// ============================================================================

export function drawUnexploredTile(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  gridX: number,
  gridY: number,
  timeMs = 0,
  theme: RenderTheme = 'default',
): void {
  const parity = ((gridX + gridY) & 1) as 0 | 1;
  const h = tilePixelHash(gridX, gridY, 7);
  const frame = Math.floor((timeMs * 0.0014 + (h & 7)) % 4);
  bakeUnexploredTile32(ctx, px, py, size, parity, frame, theme);
}

export function drawExploredVeil(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  theme: RenderTheme = 'default',
): void {
  bakeExploredVeil32(ctx, px, py, size, theme);
}

export function drawTileTerrain(
  ctx: CanvasRenderingContext2D,
  tile: TileState,
  px: number,
  py: number,
  size: number,
  gridX: number,
  gridY: number,
  timeMs = 0,
  flipBoard = false,
  theme: RenderTheme = 'default',
): void {
  const isLight = (gridX + gridY) % 2 === 0;
  const hash = tilePixelHash(gridX, gridY, 13);

  ctx.save();
  switch (tile.type) {
    case 'PLAIN':
      drawPlainStone32(ctx, px, py, size, isLight, hash, theme);
      break;
    case 'WALL':
      drawWallMasonry32(ctx, px, py, size, hash, theme);
      break;
    case 'PIT':
      drawPitChasm32(ctx, px, py, size, hash, theme);
      break;
    case 'ICE':
      drawIceGlacier32(ctx, px, py, size, isLight, theme);
      break;
    case 'WATCHTOWER':
      drawWatchtower32(ctx, px, py, size, isLight, hash, theme);
      break;
    case 'BURNING': {
      const frameIdx = Math.floor((timeMs / 150 + gridX * 2 + gridY * 3) % FLAME_FRAMES_32.length);
      drawBurning32(ctx, px, py, size, frameIdx);
      if (tile.burnTurns > 0) {
        drawBurnCounter(ctx, px, py, size, tile.burnTurns);
      }
      break;
    }
    case 'CRACKED':
      drawCracked32(ctx, px, py, size, isLight, hash, theme);
      break;
  }

  if (tile.trap !== undefined) {
    drawTileTrapOverlay(ctx, tile.trap, px, py, size, timeMs, flipBoard, theme);
  }

  if (tile.gas?.kind === 'MIASMA') {
    const mFrame = Math.floor((timeMs / 240 + gridX * 3 + gridY * 5) % 4);
    drawMiasma32ToSurface(ctx, px, py, size, mFrame, theme);
  }
  ctx.restore();
}

export function drawBurnCounter(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  burnTurns: number,
): void {
  const boxSize = Math.max(10, Math.floor((size / TILE_PX) * 9));
  const bx = Math.floor(px + (size / TILE_PX) * 2);
  const by = Math.floor(py + size - boxSize - (size / TILE_PX) * 2);
  ctx.font = `700 ${Math.max(9, Math.round(size * 0.21))}px ${PIXEL_FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#0f172a';
  ctx.strokeText(String(burnTurns), bx + boxSize * 0.5, by + boxSize * 0.53);
  ctx.fillStyle = '#fef08a';
  ctx.fillText(String(burnTurns), bx + boxSize * 0.5, by + boxSize * 0.53);
}

function drawTileTrapOverlay(
  ctx: CanvasRenderingContext2D,
  trap: TileTrap,
  px: number,
  py: number,
  size: number,
  timeMs: number,
  flipBoard: boolean,
  theme: RenderTheme,
): void {
  if (trap.kind === 'PRESSURE_PLATE') {
    drawPressurePlate32(ctx, px, py, size, trap.cooldown <= 0, theme);
    return;
  }
  if (trap.kind === 'ARROW_EMITTER') {
    const dx = flipBoard ? (trap.dir.dx === 0 ? 0 : -trap.dir.dx) : trap.dir.dx;
    const dy = flipBoard ? (trap.dir.dy === 0 ? 0 : -trap.dir.dy) : trap.dir.dy;
    drawArrowEmitter32(ctx, px, py, size, dx, dy, trap.flaming, trap.ammo === 0, theme);
    return;
  }
  const blink = Math.floor(timeMs / 240) % 2 === 0;
  drawSpikes32(ctx, px, py, size, trap.phase, blink);
}

export function drawSilhouetteMarker(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  side: Side,
  timeMs = 0,
  theme: RenderTheme = 'default',
): void {
  const pulse = Math.floor(timeMs / 320) % 2 === 0;
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(size / TILE_PX, size / TILE_PX);
  bakeSilhouetteMarker32(ctx, side, pulse, theme);
  ctx.restore();
}

export function drawPendingSpawnMarker(
  ctx: CanvasRenderingContext2D,
  spawn: PendingSpawn,
  px: number,
  py: number,
  size: number,
  timeMs = 0,
): void {
  const pulse = Math.floor(timeMs / 280) % 2 === 0;
  const pad = Math.floor(size * 0.16);
  const inner = Math.floor(size - pad * 2);

  ctx.save();
  ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
  ctx.fillRect(px + pad, py + pad, inner, inner);

  ctx.strokeStyle = pulse ? '#34d399' : '#a78bfa';
  ctx.lineWidth = Math.max(2, Math.floor(size * 0.04));
  ctx.strokeRect(px + pad + 0.5, py + pad + 0.5, inner - 1, inner - 1);

  const iconS = Math.floor(size * 0.42);
  drawPixelGrid(
    ctx,
    MICRO_PIXEL_ICONS.SPAWN,
    { O: '#064e3b', A: '#34d399', H: '#a7f3d0', D: '#059669' },
    Math.floor(px + (size - iconS) * 0.5),
    Math.floor(py + size * 0.16),
    iconS,
    iconS,
  );

  ctx.fillStyle = '#ecfdf5';
  ctx.font = `700 ${Math.max(10, Math.round(size * 0.24))}px ${PIXEL_FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(spawn.turnsRemaining), px + size * 0.5, py + size * 0.72);
  ctx.restore();
}

export function drawHazardSkullIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
): void {
  const box = Math.max(14, Math.floor(r * 2));
  const x0 = Math.floor(cx - box * 0.5);
  const y0 = Math.floor(cy - box * 0.5);
  ctx.save();
  ctx.fillStyle = '#fde047';
  ctx.fillRect(x0 - 2, y0 - 2, box + 4, box + 4);
  ctx.fillStyle = '#991b1b';
  ctx.fillRect(x0 - 1, y0 - 1, box + 2, box + 2);
  drawPixelGrid(
    ctx,
    MICRO_PIXEL_ICONS.SKULL,
    { O: '#450a0a', H: '#fef2f2', A: '#fca5a5', D: '#dc2626' },
    x0,
    y0,
    box,
    box,
  );
  ctx.restore();
}

export function drawHallucinationMarker(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  timeMs = 0,
  theme: RenderTheme = 'default',
): void {
  const glitchPhase = Math.floor(timeMs / 105) % 4;
  const unit = size / TILE_PX;
  const glitchX = (glitchPhase === 1 ? 1 : glitchPhase === 3 ? -1 : 0) * unit;
  ctx.save();
  ctx.globalAlpha = glitchPhase === 2 ? 0.68 : 0.9;
  drawSilhouetteMarker(ctx, Math.round(px + glitchX), py, size, 'ENEMY', timeMs, theme);
  ctx.restore();
}

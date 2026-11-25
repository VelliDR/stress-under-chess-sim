import { Piece, PieceType, Side, TraitId } from '../engine/types';
import {
  BADGE_SPRITES_7,
  getBadgeSpec7,
  getPieceSpec24,
  PIECE_SPRITES_24,
  resolvePiecePalette24,
  traitToBadgeKind,
} from './pieceSprites24';
import { drawPixelGrid, MICRO_PIXEL_ICONS } from './pixelArt';
import {
  BADGE_PX,
  PIECE_IN_TILE_OFFSET_X,
  PIECE_IN_TILE_OFFSET_Y,
  PIECE_PX,
  RenderTheme,
  SpriteAtlasProviders,
  TILE_PX,
} from './spriteCache';
import {
  bakeAggroBadge10,
  bakeAuraBadge7,
  bakeAuraPips32,
  bakeComposureBar32,
  bakeExploredVeil32,
  bakeFogFrontier32,
  bakeFrameBorder32,
  bakeFrozenCage32,
  bakeHazardSkull14,
  bakePanicCorner32,
  bakePendingSpawn32,
  bakePieceShadow32,
  bakeShieldOverlay32,
  bakeSilhouetteMarker32,
  bakeUnexploredTile32,
  bakeWallSouthShadow32,
  drawBurnCounter,
  drawCopperTrapWires,
  drawExploredVeil,
  drawHallucinationMarker,
  drawHazardSkullIcon,
  drawMiasma32ToSurface,
  drawPendingSpawnMarker,
  drawSilhouetteMarker,
  drawTile32ToSurface,
  drawTileTerrain,
  drawTrap32ToSurface,
  drawUnexploredTile,
  THEME_PALETTES,
} from './tileSprites32';

export interface PieceDrawOptions {
  x: number;
  y: number;
  size: number;
  scale?: number;
  alpha?: number;
  rotation?: number;
  flashAlpha?: number;
  isSelected?: boolean;
  isBonusDash?: boolean;
  showAggroBadge?: boolean;
  timeMs?: number;
  theme?: RenderTheme;
}

const TRAIT_META: Readonly<Record<TraitId, { bg: string; fg: string; hi: string; dark: string }>> = {
  SHIELDED: { bg: '#0c4a6e', fg: '#38bdf8', hi: '#e0f2fe', dark: '#0369a1' },
  FROST_TOUCH: { bg: '#164e63', fg: '#67e8f9', hi: '#ecfeff', dark: '#0e7490' },
  EXPLOSIVE: { bg: '#7c2d12', fg: '#fb923c', hi: '#fef08a', dark: '#9a3412' },
  SCOUT: { bg: '#713f12', fg: '#facc15', hi: '#fef9c3', dark: '#a16207' },
  SHADOW_WALKER: { bg: '#3b0764', fg: '#c084fc', hi: '#f3e8ff', dark: '#6b21a8' },
  PUSHER: { bg: '#4c1d95', fg: '#d8b4fe', hi: '#ffffff', dark: '#6d28d9' },
  DASH_ON_REVEAL: { bg: '#78350f', fg: '#fde047', hi: '#ffffff', dark: '#b45309' },
};

/**
 * Factory creating SpriteAtlasProviders consumed by SpriteCache (24x24 pieces + 32x32 tiles + 7x7 badges).
 */
export function createDefaultSpriteAtlasProviders(): SpriteAtlasProviders {
  return {
    getPieceSpec: (type, theme, isBoss) => getPieceSpec24(type, theme, isBoss === true),
    drawTile: (ctx, query, theme) => drawTile32ToSurface(ctx, query, theme),
    drawTrap: (ctx, query, theme) => drawTrap32ToSurface(ctx, query, theme),
    drawMiasma: (ctx, frame, theme) => drawMiasma32ToSurface(ctx, 0, 0, TILE_PX, frame, theme),
    getBadgeSpec: (kind, theme) => getBadgeSpec7(kind, theme),
  };
}

/**
 * Draws a 24x24 pixel-art chess piece inside a 32x32 tile (headless/direct fallback path).
 */
export function drawPieceSprite(
  ctx: CanvasRenderingContext2D,
  piece: Piece,
  opts: PieceDrawOptions,
): void {
  const {
    x,
    y,
    size,
    scale = 1,
    alpha = 1,
    rotation = 0,
    flashAlpha = 0,
    isBonusDash = false,
    showAggroBadge = false,
    timeMs = 0,
    theme = 'default',
  } = opts;

  const unit = size / TILE_PX;
  const cx = x + size * 0.5;
  const cy = y + size * 0.5;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.translate(cx, cy);
  if (rotation !== 0) ctx.rotate(rotation);
  if (scale !== 1) ctx.scale(scale, scale);

  const pxOrigin = -size * 0.5;
  const pyOrigin = -size * 0.5;
  const composure = piece.composure ?? 3;
  const silenced = piece.type !== 'CHIMERA' && (piece.silencedTurns ?? 0) > 0;
  const berserkActive = piece.berserkReady === true && !silenced;

  const isSleeping = showAggroBadge && piece.side === 'ENEMY' && piece.aggro === 'SLEEPING';
  const canBob = piece.frozenTurns === 0 && !isSleeping && composure > 0;
  const bobSpeed = opts.isSelected || isBonusDash ? 260 : 580;
  const idPhase = (piece.id.charCodeAt(piece.id.length - 1) || 0) * 130;
  const bobTexels = canBob && Math.floor((timeMs + idPhase) / bobSpeed) % 2 === 1 ? -1 : 0;
  const slumpTexels = composure === 0 && piece.frozenTurns === 0 ? 2 : 0;
  const jitterTexels =
    composure === 1 && piece.frozenTurns === 0
      ? Math.floor((timeMs + idPhase) / 95) % 2 === 0
        ? 1
        : -1
      : 0;

  // Ground dark oval shadow
  ctx.save();
  ctx.translate(pxOrigin, pyOrigin);
  ctx.scale(unit, unit);
  bakePieceShadow32(ctx);
  ctx.restore();

  if (isBonusDash) {
    ctx.save();
    ctx.translate(pxOrigin, pyOrigin);
    ctx.scale(unit, unit);
    bakeFrameBorder32(ctx, Math.floor(timeMs / 180) % 2 === 0 ? 'BONUS_DASH_0' : 'BONUS_DASH_1');
    ctx.restore();
  }
  if (piece.isBoss) {
    ctx.save();
    ctx.translate(pxOrigin, pyOrigin);
    ctx.scale(unit, unit);
    bakeFrameBorder32(ctx, Math.floor(timeMs / 350) % 2 === 0 ? 'BOSS_0' : 'BOSS_1');
    ctx.restore();
  }

  const spec = getPieceSpec24(piece.type, theme, piece.isBoss === true);
  const resolvedPalette = resolvePiecePalette24(
    spec.palette,
    piece.side,
    theme,
    piece.absorbedForms?.[0]?.sourceType,
    piece.absorbedForms?.[1]?.sourceType,
  );

  const destX = Math.round(pxOrigin + (PIECE_IN_TILE_OFFSET_X + jitterTexels) * unit);
  const destY = Math.round(pyOrigin + (PIECE_IN_TILE_OFFSET_Y + bobTexels + slumpTexels) * unit);
  const destS = Math.round(PIECE_PX * unit);
  drawPixelGrid(ctx, spec.matrix, resolvedPalette, destX, destY, destS, destS);

  if (piece.shieldActive) {
    ctx.save();
    ctx.translate(pxOrigin, pyOrigin);
    ctx.scale(unit, unit);
    bakeShieldOverlay32(ctx, silenced, theme);
    ctx.restore();
  }

  if (piece.frozenTurns > 0) {
    ctx.save();
    ctx.translate(pxOrigin, pyOrigin);
    ctx.scale(unit, unit);
    bakeFrozenCage32(ctx);
    ctx.restore();
  }

  if (flashAlpha > 0.01) {
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.85, flashAlpha)})`;
    ctx.fillRect(destX, destY, destS, destS);
  }

  // Sol-Üst (1, 1): FROZEN / NAZAR / SHIELD veya 7x7 Aura şarj göstergesi
  const bSize = Math.round(BADGE_PX * unit);
  const hasFaithWard =
    piece.type === 'SAINT_FAITH' ||
    (piece.type === 'CHIMERA' &&
      (piece.absorbedForms ?? []).some((f) => f.saintEcho === 'FAITH_WARD'));
  const hasTopLeftBadge =
    piece.frozenTurns > 0 ||
    (piece.shieldActive && !silenced && (hasFaithWard || piece.traits.includes('SHIELDED')));

  if (piece.shieldActive && !silenced && (hasFaithWard || piece.traits.includes('SHIELDED')) && piece.frozenTurns === 0) {
    const tlKind = hasFaithWard ? 'NAZAR' : 'SHIELD';
    const tlSpec = getBadgeSpec7(tlKind, theme);
    drawPixelGrid(ctx, tlSpec.matrix, tlSpec.palette, Math.round(pxOrigin + unit), Math.round(pyOrigin + unit), bSize, bSize);
  }

  // Sağ-Üst (24, 1): AGIZ_BAGLAMA veya CINNET
  const hasTopRightStatus = silenced || berserkActive;
  if (berserkActive) {
    const cinSpec = getBadgeSpec7('CINNET', theme);
    drawPixelGrid(ctx, cinSpec.matrix, cinSpec.palette, Math.round(pxOrigin + 24 * unit), Math.round(pyOrigin + unit), bSize, bSize);
  }

  // Alt-Köşe Rozetler (1, 20) / (24, 20): Diğer aktif mutasyonlar
  const bottomTraits = piece.traits.filter((t) => !(t === 'SHIELDED' && piece.shieldActive && !silenced));
  const cornerSlots: readonly [number, number][] = [
    [1, 20],
    [24, 20],
    [1, 11],
  ];
  for (let i = 0; i < Math.min(3, bottomTraits.length); i++) {
    const trait = bottomTraits[i]!;
    const [cxOff, cyOff] = cornerSlots[i]!;
    const dimmed = silenced || (trait === 'SHIELDED' && !piece.shieldActive);
    const badgeSpec = getBadgeSpec7(traitToBadgeKind(trait, piece.type), theme);
    ctx.save();
    if (dimmed) ctx.globalAlpha *= 0.45;
    drawPixelGrid(
      ctx,
      badgeSpec.matrix,
      badgeSpec.palette,
      Math.round(pxOrigin + cxOff * unit),
      Math.round(pyOrigin + cyOff * unit),
      bSize,
      bSize,
    );
    ctx.restore();
  }

  // Dayanıklılık Barı (4, 28) 24x3
  if (composure < 3) {
    ctx.save();
    ctx.translate(pxOrigin, pyOrigin);
    ctx.scale(unit, unit);
    bakeComposureBar32(ctx, composure as 0 | 1 | 2, Math.floor(timeMs / 200) % 2 === 0);
    ctx.restore();
  }

  const fCharge = piece.faithCharge ?? 0;
  const mCharge = piece.madnessCharge ?? 0;
  if (fCharge > 0 || mCharge > 0) {
    ctx.save();
    ctx.translate(pxOrigin, pyOrigin);
    ctx.scale(unit, unit);
    if (!hasTopLeftBadge && (fCharge > 0) !== (mCharge > 0)) {
      ctx.translate(1, 1);
      bakeAuraBadge7(
        ctx,
        fCharge > 0 ? 'FAITH' : 'MADNESS',
        Math.min(3, Math.max(1, fCharge > 0 ? fCharge : mCharge)) as 1 | 2 | 3,
      );
    } else {
      bakeAuraPips32(ctx, fCharge, mCharge);
    }
    ctx.restore();
  }

  if (silenced) {
    const badgeSpec = getBadgeSpec7('AGIZ_BAGLAMA', theme);
    drawPixelGrid(
      ctx,
      badgeSpec.matrix,
      badgeSpec.palette,
      Math.round(pxOrigin + 24 * unit),
      Math.round(pyOrigin + unit),
      bSize,
      bSize,
    );
  }

  if (showAggroBadge && piece.side === 'ENEMY' && piece.aggro !== 'ACTIVE') {
    const iconSize = Math.round(10 * unit);
    const bx = Math.round(pxOrigin + 21 * unit);
    const bob =
      piece.aggro === 'ALERTED'
        ? Math.floor(Math.sin(timeMs * 0.014) * 2)
        : Math.floor(Math.sin(timeMs * 0.004) * 1.5);
    const by = Math.round(pyOrigin + (hasTopRightStatus ? 10 : 1) * unit + bob);
    drawPixelAggroBadge(ctx, bx + iconSize * 0.5, by + iconSize * 0.5, iconSize, piece.aggro);
  }

  ctx.restore();
}

function drawPixelAggroBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  boxSize: number,
  aggro: 'SLEEPING' | 'ALERTED',
): void {
  ctx.save();
  const bx = Math.floor(x - boxSize * 0.5);
  const by = Math.floor(y - boxSize * 0.5);
  if (aggro === 'ALERTED') {
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(bx - 1, by - 1, boxSize + 2, boxSize + 2);
    ctx.fillStyle = '#451a03';
    ctx.fillRect(bx, by, boxSize, boxSize);
    drawPixelGrid(
      ctx,
      MICRO_PIXEL_ICONS.ALERT,
      { O: '#451a03', H: '#fef08a', A: '#f59e0b', D: '#b45309' },
      bx,
      by,
      boxSize,
      boxSize,
    );
  } else {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(bx - 1, by - 1, boxSize + 2, boxSize + 2);
    drawPixelGrid(
      ctx,
      MICRO_PIXEL_ICONS.SLEEP_Z,
      { O: '#1e293b', H: '#cbd5e1', A: '#94a3b8', D: '#64748b' },
      bx,
      by,
      boxSize,
      boxSize,
    );
  }
  ctx.restore();
}

export function drawTraitBadge(
  ctx: CanvasRenderingContext2D,
  trait: TraitId,
  cx: number,
  cy: number,
  r: number,
  dimmed = false,
): void {
  const palette = TRAIT_META[trait];
  const s = Math.max(7, Math.floor(r * 2));
  const x0 = Math.floor(cx - s * 0.5);
  const y0 = Math.floor(cy - s * 0.5);
  ctx.save();
  if (dimmed) ctx.globalAlpha *= 0.45;
  ctx.fillStyle = '#070a12';
  ctx.fillRect(x0 - 1, y0 - 1, s + 2, s + 2);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(x0, y0, s, s);
  drawPixelGrid(
    ctx,
    MICRO_PIXEL_ICONS[trait],
    { O: '#070a12', A: palette.fg, H: palette.hi, D: palette.dark },
    x0,
    y0,
    s,
    s,
  );
  ctx.restore();
}

/**
 * 24x24 (veya 32x32) tek bir taşı DOM `<canvas>` elemanı olarak çizer (Menü, Manga Seçimi, Ordu Kurucu & Rehber için).
 */
export function createPieceIconCanvas(
  pieceType: PieceType,
  side: Side,
  sizePx = 32,
  theme: RenderTheme = 'default',
  isBoss = false,
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = PIECE_PX;
  canvas.height = PIECE_PX;
  canvas.style.width = `${sizePx}px`;
  canvas.style.height = `${sizePx}px`;
  canvas.style.imageRendering = 'pixelated';
  canvas.className = 'sucs-sprite-preview';
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    const spec = getPieceSpec24(pieceType, theme, isBoss);
    const pal = resolvePiecePalette24(spec.palette, side, theme);
    drawPixelGrid(ctx, spec.matrix, pal, 0, 0, PIECE_PX, PIECE_PX);
  }
  return canvas;
}

export {
  BADGE_SPRITES_7,
  PIECE_SPRITES_24,
  THEME_PALETTES,
  bakeAggroBadge10,
  bakeAuraBadge7,
  bakeAuraPips32,
  bakeComposureBar32,
  bakeExploredVeil32,
  bakeFogFrontier32,
  bakeFrameBorder32,
  bakeFrozenCage32,
  bakeHazardSkull14,
  bakePanicCorner32,
  bakePendingSpawn32,
  bakePieceShadow32,
  bakeShieldOverlay32,
  bakeSilhouetteMarker32,
  bakeUnexploredTile32,
  bakeWallSouthShadow32,
  drawBurnCounter,
  drawCopperTrapWires,
  drawExploredVeil,
  drawHallucinationMarker,
  drawHazardSkullIcon,
  drawPendingSpawnMarker,
  drawSilhouetteMarker,
  drawTileTerrain,
  drawUnexploredTile,
  traitToBadgeKind,
};
export type { ThemePalette } from './tileSprites32';

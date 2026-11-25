import { coordEquals } from '../engine/board';
import { LegalAbility } from '../engine/traits';
import { AbilityId, Coord, LegalMove, Piece, VisibleState } from '../engine/types';
import { FxRenderSnapshot } from './fxQueue';
import { computeAmbientPieceVisual, interpolateHexColor } from './juiceEngine';
import { tilePixelHash } from './pixelArt';
import {
  BADGE_PX,
  canCreateCacheSurface,
  drawCachedPieceInTile,
  RenderTheme,
  SpriteCache,
  TILE_PX,
} from './spriteCache';
import { drawCopperTrapWires } from './tileSprites32';
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
  createDefaultSpriteAtlasProviders,
  drawBurnCounter,
  drawExploredVeil,
  drawHallucinationMarker,
  drawHazardSkullIcon,
  drawPendingSpawnMarker,
  drawPieceSprite,
  drawSilhouetteMarker,
  drawTileTerrain,
  drawUnexploredTile,
  traitToBadgeKind,
} from './sprites';

export interface BoardSafeInsets {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

export interface BoardLayout {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  tileSize: number;
  offsetX: number;
  offsetY: number;
  labelMargin: number;
}

export interface IntentArrow {
  from: Coord;
  to: Coord;
  pieceId: string;
  isAttack: boolean;
}

export interface CanvasRenderOptions {
  selectedCoord: Coord | null;
  inspectedCoord: Coord | null;
  hoveredCoord: Coord | null;
  legalMoves: readonly LegalMove[];
  legalAbilities: readonly LegalAbility[];
  activeAbility: AbilityId | null;
  intentArrows?: readonly IntentArrow[];
  showIntentArrows?: boolean;
  /** Highlighted walkable rows during SKIRMISH_DEPLOY secret placement. */
  deployZoneRows?: readonly number[];
  /** Rotates board view 180 degrees so GUEST (ENEMY) sees their army at the bottom. */
  flipBoard?: boolean;
  /** Optional last visible move trail (strictly filtered through VisibleState). */
  lastVisibleMove?: { from: Coord; to: Coord } | null;
  /** Optional squares currently threatened by visible enemy pieces (100% fair). */
  threatCoords?: readonly Coord[];
  showThreatOverlay?: boolean;
  /** Toggle lethal hazard warning skulls (defaults to true). */
  showLethalWarnings?: boolean;
  /** Live stress score (0..100) driving PANIC corner vignette at >= 75. */
  stressScore?: number;
  /** Accessibility mode reducing harsh flashes & glitch shifts. */
  calmScreen?: boolean;
  /** Optional post-pass overlay callback (Phase 4 speech bubbles & CRT band). */
  postRenderOverlay?: (
    ctx: CanvasRenderingContext2D,
    layout: BoardLayout,
    state: VisibleState,
    timeMs: number,
    flipBoard: boolean,
  ) => void;
  fx?: FxRenderSnapshot;
  timeMs?: number;
  theme?: RenderTheme;
}

export interface PointerHandlers {
  onTileTap: (coord: Coord) => void;
  onTileHover: (coord: Coord | null) => void;
  onPointerActivity?: () => void;
}

/**
 * Pure geometry solver computing crisp square tile size and centered board origin.
 * DPR-aware physical integer snapping: guarantees `tileSize * dpr` is an exact multiple of 32
 * (zero mixels on physical pixels) while unlocking intermediate CSS steps on 2x/4x HiDPI screens.
 */
export function computeBoardLayout(
  cssWidth: number,
  cssHeight: number,
  boardWidth: number,
  boardHeight: number,
  dpr = 1,
  safeInsets?: BoardSafeInsets,
): BoardLayout {
  const safeW = Math.max(120, cssWidth);
  const safeH = Math.max(120, cssHeight);
  const safeCols = Math.max(1, boardWidth);
  const safeRows = Math.max(1, boardHeight);
  const safeDpr = Math.max(1, dpr);
  const labelMargin = safeW < 380 ? 18 : 24;
  const padding = 8;
  const insetTop = Math.max(0, safeInsets?.top ?? 0);
  const insetRight = Math.max(0, safeInsets?.right ?? 0);
  const insetBottom = Math.max(0, safeInsets?.bottom ?? 0);
  const insetLeft = Math.max(0, safeInsets?.left ?? 0);

  const availW = Math.max(40, safeW - labelMargin - padding * 2 - insetLeft - insetRight);
  const availH = Math.max(40, safeH - labelMargin - padding * 2 - insetTop - insetBottom);
  const rawTile = Math.floor(Math.min(availW / safeCols, availH / safeRows));

  // 24x24 Taş + 32x32 Kare Hibriti: Fiziksel piksellerde sıfır mixel için 32'nin tam katı.
  // 2x veya 4x HiDPI ekranlarda 16 CSS px adımı fiziksel olarak 32/64 px'e karşılık gelir (sıfır mixel!).
  const tileStep = safeDpr === 2 || safeDpr === 4 ? TILE_PX / 2 : TILE_PX;
  const tileSize =
    rawTile >= TILE_PX
      ? Math.max(TILE_PX, Math.floor(rawTile / tileStep) * tileStep)
      : Math.max(16, rawTile);

  const totalBoardW = tileSize * safeCols;
  const totalBoardH = tileSize * safeRows;
  const innerW = safeW - insetLeft - insetRight;
  const innerH = safeH - insetTop - insetBottom;
  const offsetX = Math.floor(insetLeft + (innerW - totalBoardW + labelMargin) / 2);
  const offsetY = Math.floor(insetTop + (innerH - totalBoardH - labelMargin) / 2);

  return {
    cssWidth: safeW,
    cssHeight: safeH,
    dpr: safeDpr,
    tileSize,
    offsetX,
    offsetY,
    labelMargin,
  };
}

/**
 * Converts a canonical board Coord to screen grid Coord (or inverse — self-inverting).
 */
export function mapBoardCoord(
  coord: Coord,
  boardWidth: number,
  boardHeight: number,
  flipBoard: boolean,
): Coord {
  if (!flipBoard) return coord;
  return {
    x: boardWidth - 1 - coord.x,
    y: boardHeight - 1 - coord.y,
  };
}

/**
 * Maps canvas-local CSS pixel coordinates to a canonical board Coord, or null if outside the grid.
 * When `flipBoard` is true (GUEST view), automatically un-flips back to canonical engine coordinates.
 */
export function localPointToTile(
  layout: BoardLayout,
  localX: number,
  localY: number,
  boardWidth: number,
  boardHeight: number,
  flipBoard = false,
): Coord | null {
  const gx = Math.floor((localX - layout.offsetX) / layout.tileSize);
  const gy = Math.floor((localY - layout.offsetY) / layout.tileSize);
  if (gx < 0 || gx >= boardWidth || gy < 0 || gy >= boardHeight) {
    return null;
  }
  return mapBoardCoord({ x: gx, y: gy }, boardWidth, boardHeight, flipBoard);
}

/**
 * Layered HiDPI HTML5 Canvas 2D renderer.
 * Architectural invariant: strictly consumes VisibleState (never raw GameState)
 * and uses Pointer Events exclusively for mouse + touch input.
 */
export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly spriteCache: SpriteCache | null;
  private theme: RenderTheme = 'default';
  private layout: BoardLayout;
  private safeInsets: BoardSafeInsets = {};
  private boardWidth = 8;
  private boardHeight = 8;
  private flipBoard = false;
  private handlers: PointerHandlers | null = null;
  private activePointerId: number | null = null;
  private lastHoverCoord: Coord | null = null;

  private readonly handlePointerDown: (e: PointerEvent) => void;
  private readonly handlePointerMove: (e: PointerEvent) => void;
  private readonly handlePointerUp: (e: PointerEvent) => void;
  private readonly handlePointerLeave: (e: PointerEvent) => void;

  public constructor(
    canvas: HTMLCanvasElement,
    ctxOverride?: CanvasRenderingContext2D,
    options?: { spriteCache?: SpriteCache | null; theme?: RenderTheme },
  ) {
    this.canvas = canvas;
    const ctx = ctxOverride ?? canvas.getContext('2d');
    if (ctx === null) {
      throw new Error('Could not initialize 2D canvas context');
    }
    this.ctx = ctx;
    this.theme = options?.theme ?? 'default';
    if (options?.spriteCache !== undefined) {
      this.spriteCache = options.spriteCache;
    } else if (canCreateCacheSurface()) {
      this.spriteCache = new SpriteCache(createDefaultSpriteAtlasProviders(), {
        theme: this.theme,
      });
      this.spriteCache.warmup();
    } else {
      this.spriteCache = null;
    }
    this.layout = computeBoardLayout(640, 640, 8, 8, 1);

    this.handlePointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.handlers?.onPointerActivity?.();
      this.activePointerId = e.pointerId;
      const coord = this.eventToTile(e);
      this.emitHoverIfChanged(coord);
    };

    this.handlePointerMove = (e: PointerEvent): void => {
      const coord = this.eventToTile(e);
      this.emitHoverIfChanged(coord);
    };

    this.handlePointerUp = (e: PointerEvent): void => {
      if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
      this.activePointerId = null;
      const coord = this.eventToTile(e);
      if (coord !== null) {
        this.handlers?.onTileTap(coord);
      }
    };

    this.handlePointerLeave = (): void => {
      this.activePointerId = null;
      this.emitHoverIfChanged(null);
    };
  }

  public bindPointerEvents(handlers: PointerHandlers): void {
    this.unbindPointerEvents();
    this.handlers = handlers;
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerLeave);
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave);
  }

  public unbindPointerEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerLeave);
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    this.handlers = null;
  }

  public destroy(): void {
    this.unbindPointerEvents();
  }

  public resize(
    cssWidth: number,
    cssHeight: number,
    dpr = 1,
    safeInsets?: BoardSafeInsets,
  ): void {
    const safeDpr = Math.max(1, dpr);
    const targetW = Math.max(1, Math.round(cssWidth * safeDpr));
    const targetH = Math.max(1, Math.round(cssHeight * safeDpr));
    if (safeInsets !== undefined) {
      this.safeInsets = safeInsets;
    }

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this.layout = computeBoardLayout(
      cssWidth,
      cssHeight,
      this.boardWidth,
      this.boardHeight,
      safeDpr,
      this.safeInsets,
    );
  }

  public setFlipBoard(flip: boolean): void {
    this.flipBoard = flip;
  }

  public setTheme(theme: RenderTheme): void {
    if (this.theme === theme) return;
    this.theme = theme;
    if (this.spriteCache !== null) {
      this.spriteCache.setTheme(theme);
      this.spriteCache.warmup();
    }
  }

  public getTheme(): RenderTheme {
    return this.theme;
  }

  public getSpriteCache(): SpriteCache | null {
    return this.spriteCache;
  }

  public getLayout(): BoardLayout {
    return this.layout;
  }

  /**
   * Renders the full layered tactical board strictly from `VisibleState`.
   */
  public render(state: VisibleState, options: CanvasRenderOptions): void {
    const flip = options.flipBoard ?? this.flipBoard;
    this.flipBoard = flip;
    if (options.theme !== undefined) {
      this.setTheme(options.theme);
    }
    const theme = this.theme;
    const cache = this.spriteCache;
    const canBlit = cache !== null && typeof this.ctx.drawImage === 'function';

    if (state.width !== this.boardWidth || state.height !== this.boardHeight) {
      this.boardWidth = state.width;
      this.boardHeight = state.height;
      this.layout = computeBoardLayout(
        this.layout.cssWidth,
        this.layout.cssHeight,
        state.width,
        state.height,
        this.layout.dpr,
        this.safeInsets,
      );
    }

    const ctx = this.ctx;
    const { cssWidth, cssHeight, dpr, tileSize, offsetX, offsetY } = this.layout;
    const timeMs = options.timeMs ?? 0;
    const fx = options.fx;
    const shakeX = fx?.shakeOffset.x ?? 0;
    const shakeY = fx?.shakeOffset.y ?? 0;
    const camFx = fx?.cameraFx;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    // Layer 0: Tam ekran düşük kontrastlı pikselli zindan taş zemini (tahta ızgarasıyla 1:1 kilitli)
    ctx.fillStyle = theme === 'crt' ? '#030906' : '#070a10';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    if (canBlit) {
      const bgSurf = cache.getOrBakeAuxSurface(
        'ambient_dungeon_floor_64',
        TILE_PX * 2,
        TILE_PX * 2,
        (sCtx) => bakeAmbientDungeonFloor64(sCtx, theme),
      );
      const step = tileSize * 2;
      const startX = offsetX - Math.ceil((offsetX + step) / step) * step;
      const startY = offsetY - Math.ceil((offsetY + step) / step) * step;
      for (let by = startY; by < cssHeight + step; by += step) {
        for (let bx = startX; bx < cssWidth + step; bx += step) {
          ctx.drawImage(bgSurf, Math.round(bx), Math.round(by), step, step);
        }
      }
      // Hafif kenar karartma vinyeti (piksel zindan derinliği, 0 fillRect)
      const vigSurf = cache.getOrBakeAuxSurface(
        'ambient_vignette_64',
        64,
        64,
        (sCtx) => bakePixelVignette64(sCtx, theme),
      );
      ctx.drawImage(vigSurf, 0, 0, cssWidth, cssHeight);
    }

    ctx.translate(Math.round(shakeX), Math.round(shakeY));
    if (camFx !== undefined && camFx.zoomScale > 1.001 && camFx.zoomTarget !== null) {
      const zt = mapBoardCoord(
        { x: camFx.zoomTarget.x - 0.5, y: camFx.zoomTarget.y - 0.5 },
        state.width,
        state.height,
        flip,
      );
      const zx = offsetX + (zt.x + 0.5) * tileSize;
      const zy = offsetY + (zt.y + 0.5) * tileSize;
      ctx.translate(zx, zy);
      ctx.scale(camFx.zoomScale, camFx.zoomScale);
      ctx.translate(-zx, -zy);
    }

    const boardPixelW = state.width * tileSize;
    const boardPixelH = state.height * tileSize;
    const pxU = Math.max(1, Math.round(tileSize / TILE_PX));

    // Stepped pixel-art stone border & tactical brass corner rivets (tahta piksel ağırlığına kilitli)
    ctx.fillStyle = '#05070c';
    ctx.fillRect(offsetX - pxU * 3, offsetY - pxU * 3, boardPixelW + pxU * 6, boardPixelH + pxU * 6);
    ctx.fillStyle =
      state.viewer === 'OMNISCIENT'
        ? '#4f46e5'
        : theme === 'crt'
          ? '#166534'
          : '#2c374c';
    ctx.fillRect(offsetX - pxU * 2, offsetY - pxU * 2, boardPixelW + pxU * 4, boardPixelH + pxU * 4);
    ctx.fillStyle = theme === 'crt' ? '#05150c' : '#111622';
    ctx.fillRect(offsetX - pxU, offsetY - pxU, boardPixelW + pxU * 2, boardPixelH + pxU * 2);
    // Corner pixel rivets
    ctx.fillStyle =
      state.viewer === 'OMNISCIENT'
        ? '#a5b4fc'
        : theme === 'crt'
          ? '#4ade80'
          : '#64748b';
    const riv = Math.max(2, pxU * 2);
    ctx.fillRect(offsetX - pxU * 2, offsetY - pxU * 2, riv, riv);
    ctx.fillRect(offsetX + boardPixelW + pxU * 2 - riv, offsetY - pxU * 2, riv, riv);
    ctx.fillRect(offsetX - pxU * 2, offsetY + boardPixelH + pxU * 2 - riv, riv, riv);
    ctx.fillRect(offsetX + boardPixelW + pxU * 2 - riv, offsetY + boardPixelH + pxU * 2 - riv, riv, riv);

    // Coordinate labels (files A..I along bottom, ranks 1..9 along left; flipped when flipBoard=true)
    this.drawCoordinateLabels(ctx, state.width, state.height, offsetX, offsetY, tileSize, flip);

    // =========================================================================
    // GEÇİŞ 1 — ZEMİNLER (32x32 önbellekli zemin + 2.5D duvar güney gölgesi)
    // =========================================================================
    const shadowBandH = Math.max(3, Math.floor((tileSize / 16) * 3));
    for (let y = 0; y < state.height; y++) {
      const fogRow = state.fog[y];
      const tileRow = state.tiles[y];
      for (let x = 0; x < state.width; x++) {
        const vis = fogRow?.[x] ?? 'UNEXPLORED';
        const tile = tileRow?.[x] ?? null;
        if (vis === 'UNEXPLORED' || tile === null) continue;

        const viewPos = mapBoardCoord({ x, y }, state.width, state.height, flip);
        const rOff = fx?.roomTileOffsets?.[`${x},${y}`];
        const px = offsetX + viewPos.x * tileSize;
        const py = offsetY + viewPos.y * tileSize + (rOff ? Math.round((rOff.dyTexels * tileSize) / TILE_PX) : 0);

        if (rOff !== undefined && rOff.alpha < 1) {
          ctx.save();
          ctx.globalAlpha *= rOff.alpha;
        }
        if (canBlit) {
          const parity = ((x + y) & 1) as 0 | 1;
          const burnFrame =
            tile.type === 'BURNING' ? Math.floor((timeMs / 150 + x * 2 + y * 3) % 3) : 0;
          const tileSurf = cache.getTileSprite({
            type: tile.type,
            parity,
            frame: burnFrame,
          });
          if (rOff !== undefined && rOff.scale < 0.999) {
            const scaled = Math.max(2, Math.round(tileSize * rOff.scale));
            const pad = Math.round((tileSize - scaled) * 0.5);
            ctx.drawImage(tileSurf, Math.round(px + pad), Math.round(py + pad), scaled, scaled);
          } else {
            ctx.drawImage(tileSurf, Math.round(px), Math.round(py), tileSize, tileSize);
          }

          if (tile.type === 'BURNING' && tile.burnTurns > 0) {
            drawBurnCounter(ctx, px, py, tileSize, tile.burnTurns);
          }
        } else {
          drawTileTerrain(ctx, tile, px, py, tileSize, x, y, timeMs, flip, theme);
        }
        if (rOff !== undefined && rOff.alpha < 1) {
          ctx.restore();
        }

        // 2.5D Duvar güney gölgesi
        if (tile.type !== 'WALL') {
          const northCanon = mapBoardCoord(
            { x: viewPos.x, y: viewPos.y - 1 },
            state.width,
            state.height,
            flip,
          );
          if (northCanon.y >= 0 && northCanon.y < state.height) {
            const northVis = state.fog[northCanon.y]?.[northCanon.x] ?? 'UNEXPLORED';
            const northTile = state.tiles[northCanon.y]?.[northCanon.x] ?? null;
            if (northVis !== 'UNEXPLORED' && northTile?.type === 'WALL') {
              if (canBlit) {
                const shadowSurf = cache.getOrBakeAuxSurface(
                  'wall_shadow',
                  TILE_PX,
                  TILE_PX,
                  (sCtx) => bakeWallSouthShadow32(sCtx, theme),
                );
                ctx.drawImage(shadowSurf, Math.round(px), Math.round(py), tileSize, tileSize);
              } else {
                ctx.fillStyle = 'rgba(4, 6, 12, 0.36)';
                ctx.fillRect(px, py, tileSize, shadowBandH);
              }
            }
          }
        }
      }
    }

    // =========================================================================
    // GEÇİŞ 2 — KABLOLAR VE TUZAKLAR (Bakır hatlar + 32x32 tuzaklar)
    // =========================================================================
    this.drawTileStains(ctx, state, fx, offsetX, offsetY, tileSize, flip);
    this.drawTrapWires(ctx, state, options, offsetX, offsetY, tileSize, flip);
    if (canBlit) {
      for (let y = 0; y < state.height; y++) {
        const fogRow = state.fog[y];
        const tileRow = state.tiles[y];
        for (let x = 0; x < state.width; x++) {
          const vis = fogRow?.[x] ?? 'UNEXPLORED';
          const tile = tileRow?.[x] ?? null;
          if (vis === 'UNEXPLORED' || tile === null || tile.trap === undefined) continue;
          const viewPos = mapBoardCoord({ x, y }, state.width, state.height, flip);
          const px = offsetX + viewPos.x * tileSize;
          const py = offsetY + viewPos.y * tileSize;
          const trapSurf = cache.getTrapSprite(
            tile.trap.kind === 'PRESSURE_PLATE'
              ? { kind: 'PRESSURE_PLATE', active: tile.trap.cooldown <= 0 }
              : tile.trap.kind === 'ARROW_EMITTER'
                ? {
                    kind: 'ARROW_EMITTER',
                    dir: tile.trap.dir,
                    flaming: tile.trap.flaming,
                    flipBoard: flip,
                    depleted: tile.trap.ammo === 0,
                  }
                : { kind: 'SPIKES', phase: tile.trap.phase },
          );
          ctx.drawImage(trapSurf, Math.round(px), Math.round(py), tileSize, tileSize);
        }
      }
    }

    // =========================================================================
    // GEÇİŞ 3 — TAKTİK ÖNİZLEMELER (5x5 Auralar, Hamleler, Yalpalama, Niyet)
    // =========================================================================
    this.drawSaintAuras(ctx, state, offsetX, offsetY, tileSize, timeMs, flip);
    this.drawTileHighlights(ctx, state, options, offsetX, offsetY, tileSize, timeMs, flip);
    this.drawRoutePreviews(ctx, state, options, offsetX, offsetY, tileSize, timeMs, flip);
    if (options.showIntentArrows && options.intentArrows !== undefined) {
      this.drawIntentArrows(ctx, state, options.intentArrows, offsetX, offsetY, tileSize, flip);
    }

    // =========================================================================
    // GEÇİŞ 4 — TAŞLAR VE GÖLGE (Yerde koyu oval gölge + 24x24 taş gövdesi)
    // =========================================================================
    const showAggro = state.mode === 'CAMPAIGN' || state.viewer === 'OMNISCIENT';
    const stressScore = options.stressScore ?? 0;
    const threatSet = new Set<string>(
      (options.threatCoords ?? []).map((c) => `${c.x},${c.y}`),
    );

    // 4a. Hareket Hayalet İzleri (Rook 2, Queen 3, Meczup 2, Buz 4)
    if (fx?.ghostTrails !== undefined && canBlit) {
      for (let i = 0; i < fx.ghostTrails.length; i++) {
        const tr = fx.ghostTrails[i]!;
        const vx = flip ? state.width - 1 - tr.x : tr.x;
        const vy = flip ? state.height - 1 - tr.y : tr.y;
        const tpx = offsetX + vx * tileSize;
        const tpy = offsetY + vy * tileSize;
        const maskSurf = cache.getPieceSilhouetteMaskSprite(
          { type: tr.piece.type, side: tr.piece.side, isBoss: tr.piece.isBoss === true },
          `trail:${tr.tint ?? 'default'}`,
          tr.tint ?? '#94a3b8',
        );
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(0.6, tr.alpha));
        drawCachedPieceInTile(ctx, maskSurf, tpx, tpy, tileSize, 0, 0);
        ctx.restore();
      }
    }

    if (fx !== undefined) {
      for (let i = 0; i < fx.ghostPieces.length; i++) {
        const ghost = fx.ghostPieces[i]!;
        const vx = flip ? state.width - 1 - ghost.x : ghost.x;
        const vy = flip ? state.height - 1 - ghost.y : ghost.y;
        const px = offsetX + vx * tileSize;
        const py = offsetY + vy * tileSize;
        if (canBlit) {
          this.drawPieceBodyFromCache(ctx, cache, ghost.piece, {
            px,
            py,
            tileSize,
            scaleX: ghost.scale,
            scaleY: ghost.scale,
            alpha: ghost.alpha,
            rotation: ghost.rotation,
            flashAlpha: 0,
            isSelected: false,
            isHovered: false,
            isBonusDash: false,
            showAggroBadge: showAggro,
            timeMs,
            stressScore,
            underThreat: false,
            onCracked: false,
          });
        } else {
          drawPieceSprite(ctx, ghost.piece, {
            x: px,
            y: py,
            size: tileSize,
            scale: ghost.scale,
            alpha: ghost.alpha,
            rotation: ghost.rotation,
            showAggroBadge: showAggro,
            timeMs,
            theme,
          });
        }
      }
    }

    for (let i = 0; i < state.pieces.length; i++) {
      const piece = state.pieces[i]!;
      const override = fx?.pieceOverrides[piece.id];
      const gx = override !== undefined ? override.x : piece.pos.x;
      const gy = override !== undefined ? override.y : piece.pos.y;
      const vx = flip ? state.width - 1 - gx : gx;
      const vy = flip ? state.height - 1 - gy : gy;
      const px = offsetX + vx * tileSize;
      const py = offsetY + vy * tileSize;
      const shx =
        override?.shadowX !== undefined
          ? offsetX + (flip ? state.width - 1 - override.shadowX : override.shadowX) * tileSize
          : px;
      const shy =
        override?.shadowY !== undefined
          ? offsetY + (flip ? state.height - 1 - override.shadowY : override.shadowY) * tileSize
          : py;
      const isSelected =
        options.selectedCoord !== null && coordEquals(piece.pos, options.selectedCoord);
      const isHovered =
        options.hoveredCoord !== null && coordEquals(piece.pos, options.hoveredCoord);
      const isBonusDash = state.bonusMovePieceId === piece.id;
      const underThreat = threatSet.has(`${piece.pos.x},${piece.pos.y}`);
      const standingTile = state.tiles[piece.pos.y]?.[piece.pos.x];
      const onCracked = standingTile?.type === 'CRACKED';

      if (canBlit) {
        this.drawPieceBodyFromCache(ctx, cache, piece, {
          px,
          py,
          shadowPx: shx,
          shadowPy: shy,
          dxTexels: override?.dxTexels ?? 0,
          dyTexels: override?.dyTexels ?? 0,
          tileSize,
          scaleX: override?.scaleX ?? override?.scale ?? 1,
          scaleY: override?.scaleY ?? override?.scale ?? 1,
          alpha: override?.alpha ?? 1,
          rotation: override?.rotation ?? 0,
          flashAlpha: override?.flashAlpha ?? 0,
          auraBoostAlpha: override?.auraBoostAlpha ?? 0,
          greenTintAlpha: override?.greenTintAlpha ?? 0,
          isSelected,
          isHovered,
          isBonusDash,
          showAggroBadge: showAggro,
          timeMs,
          stressScore,
          underThreat,
          onCracked,
        });
      } else {
        drawPieceSprite(ctx, piece, {
          x: px,
          y: py,
          size: tileSize,
          scale: override?.scale ?? 1,
          alpha: override?.alpha ?? 1,
          rotation: override?.rotation ?? 0,
          flashAlpha: override?.flashAlpha ?? 0,
          isSelected,
          isBonusDash,
          showAggroBadge: showAggro,
          timeMs,
          theme,
        });
      }
    }

    // =========================================================================
    // GEÇİŞ 5 — ZEHİRLİ SİS (MIASMA), KEŞFEDİLMİŞ ÖRTÜ VE TAŞ ÜSTÜ UI ROZETLERİ
    // =========================================================================
    for (let y = 0; y < state.height; y++) {
      const fogRow = state.fog[y];
      const tileRow = state.tiles[y];
      for (let x = 0; x < state.width; x++) {
        const vis = fogRow?.[x] ?? 'UNEXPLORED';
        const tile = tileRow?.[x] ?? null;
        if (vis === 'UNEXPLORED' || tile === null) continue;
        const viewPos = mapBoardCoord({ x, y }, state.width, state.height, flip);
        const px = offsetX + viewPos.x * tileSize;
        const py = offsetY + viewPos.y * tileSize;

        if (canBlit) {
          if (tile.gas?.kind === 'MIASMA') {
            const mFrame = Math.floor((timeMs / 240 + x * 3 + y * 5) % 4);
            ctx.drawImage(
              cache.getMiasmaSprite(mFrame),
              Math.round(px),
              Math.round(py),
              tileSize,
              tileSize,
            );
          }
          if (vis === 'EXPLORED') {
            const veilSurf = cache.getOrBakeAuxSurface(
              'fog_explored',
              TILE_PX,
              TILE_PX,
              (sCtx) => bakeExploredVeil32(sCtx, 0, 0, TILE_PX, theme),
            );
            ctx.drawImage(veilSurf, Math.round(px), Math.round(py), tileSize, tileSize);
          }
        } else if (vis === 'EXPLORED') {
          drawExploredVeil(ctx, px, py, tileSize, theme);
        }
      }
    }

    if (canBlit) {
      for (let i = 0; i < state.pieces.length; i++) {
        const piece = state.pieces[i]!;
        const override = fx?.pieceOverrides[piece.id];
        const gx = override !== undefined ? override.x : piece.pos.x;
        const gy = override !== undefined ? override.y : piece.pos.y;
        const vx = flip ? state.width - 1 - gx : gx;
        const vy = flip ? state.height - 1 - gy : gy;
        const px = offsetX + vx * tileSize;
        const py = offsetY + vy * tileSize;
        this.drawPieceUiFromCache(ctx, cache, piece, {
          px,
          py,
          tileSize,
          scaleX: override?.scaleX ?? override?.scale ?? 1,
          scaleY: override?.scaleY ?? override?.scale ?? 1,
          alpha: override?.alpha ?? 1,
          rotation: override?.rotation ?? 0,
          showAggroBadge: showAggro,
          timeMs,
          theme,
        });
      }
    }

    // =========================================================================
    // GEÇİŞ 6 — SAVAŞ SİSİ, RADAR, FX, PANİK VİGNETTE & SİNEMATİK KATMAN
    // =========================================================================
    const fogEdgeW = Math.max(1, Math.floor(tileSize / 16));
    for (let y = 0; y < state.height; y++) {
      const fogRow = state.fog[y];
      const tileRow = state.tiles[y];
      for (let x = 0; x < state.width; x++) {
        const vis = fogRow?.[x] ?? 'UNEXPLORED';
        const tile = tileRow?.[x] ?? null;
        const vp = mapBoardCoord({ x, y }, state.width, state.height, flip);
        const px = offsetX + vp.x * tileSize;
        const py = offsetY + vp.y * tileSize;

        if (vis === 'UNEXPLORED' || tile === null) {
          if (canBlit) {
            const parity = ((x + y) & 1) as 0 | 1;
            const h = tilePixelHash(x, y, 7);
            const variant = Math.floor((timeMs * 0.0014 + (h & 7)) % 4);
            const unexpSurf = cache.getOrBakeAuxSurface(
              `fog_unexp:${parity}:${variant}`,
              TILE_PX,
              TILE_PX,
              (sCtx) => bakeUnexploredTile32(sCtx, 0, 0, TILE_PX, parity, variant, theme),
            );
            ctx.drawImage(unexpSurf, Math.round(px), Math.round(py), tileSize, tileSize);
          } else {
            drawUnexploredTile(ctx, px, py, tileSize, x, y, timeMs, theme);
          }
          continue;
        }

        if (vis === 'VISIBLE') {
          const dirs: readonly [number, number, 'N' | 'S' | 'W' | 'E'][] = [
            [0, -1, 'N'],
            [0, 1, 'S'],
            [-1, 0, 'W'],
            [1, 0, 'E'],
          ];
          for (let d = 0; d < dirs.length; d++) {
            const [dx, dy, edge] = dirs[d]!;
            const nx = vp.x + dx;
            const ny = vp.y + dy;
            if (nx < 0 || nx >= state.width || ny < 0 || ny >= state.height) continue;
            const nc = mapBoardCoord({ x: nx, y: ny }, state.width, state.height, flip);
            if ((state.fog[nc.y]?.[nc.x] ?? 'UNEXPLORED') === 'UNEXPLORED') {
              if (canBlit) {
                const edgeSurf = cache.getOrBakeAuxSurface(
                  `fog_edge:${edge}`,
                  TILE_PX,
                  TILE_PX,
                  (sCtx) => bakeFogFrontier32(sCtx, edge, theme),
                );
                ctx.drawImage(edgeSurf, Math.round(px), Math.round(py), tileSize, tileSize);
              } else {
                ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
                if (dy === -1) ctx.fillRect(px, py, tileSize, fogEdgeW);
                else if (dy === 1) ctx.fillRect(px, py + tileSize - fogEdgeW, tileSize, fogEdgeW);
                else if (dx === -1) ctx.fillRect(px, py, fogEdgeW, tileSize);
                else if (dx === 1) ctx.fillRect(px + tileSize - fogEdgeW, py, fogEdgeW, tileSize);
              }
            }
          }
        }
      }
    }

    // Pending Necromancer Spawns
    for (let i = 0; i < state.pendingSpawns.length; i++) {
      const sp = state.pendingSpawns[i]!;
      const vp = mapBoardCoord(sp.pos, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      if (canBlit) {
        const pulse = Math.floor(timeMs / 280) % 2 === 0;
        const spSurf = cache.getOrBakeAuxSurface(
          `pending_spawn:${pulse ? 1 : 0}`,
          TILE_PX,
          TILE_PX,
          (sCtx) => bakePendingSpawn32(sCtx, pulse),
        );
        ctx.drawImage(spSurf, Math.round(px), Math.round(py), tileSize, tileSize);
        ctx.save();
        ctx.fillStyle = '#ecfdf5';
        ctx.font = `700 ${Math.max(10, Math.round(tileSize * 0.24))}px 'Pixelify Sans', 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(sp.turnsRemaining), px + tileSize * 0.5, py + tileSize * 0.72);
        ctx.restore();
      } else {
        drawPendingSpawnMarker(ctx, sp, px, py, tileSize, timeMs);
      }
    }

    // Radar '?' Silhouettes & PANIC Hallucinations (2.5 sn'de bir 1px yatay RGB kayması)
    for (let i = 0; i < state.silhouettes.length; i++) {
      const sil = state.silhouettes[i]!;
      const vp = mapBoardCoord(sil.pos, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      if (canBlit) {
        const pulse = Math.floor(timeMs / 320) % 2 === 0;
        const silSurf = cache.getOrBakeAuxSurface(
          `sil:${sil.side}:${pulse ? 1 : 0}`,
          TILE_PX,
          TILE_PX,
          (sCtx) => bakeSilhouetteMarker32(sCtx, sil.side, pulse, theme),
        );
        ctx.drawImage(silSurf, Math.round(px), Math.round(py), tileSize, tileSize);
      } else {
        drawSilhouetteMarker(ctx, px, py, tileSize, sil.side, timeMs, theme);
      }
    }

    const hallucinations = state.hallucinationSilhouettes ?? [];
    for (let i = 0; i < hallucinations.length; i++) {
      const hPos = hallucinations[i]!;
      const vp = mapBoardCoord(hPos, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      if (canBlit) {
        const cycleMs = timeMs % 2500;
        const inGlitch = !options.calmScreen && cycleMs < 240;
        const glitchPhase = inGlitch ? Math.floor(cycleMs / 60) % 4 : 0;
        const unit = tileSize / TILE_PX;
        const glitchX = Math.round((glitchPhase === 1 ? 1 : glitchPhase === 3 ? -1 : 0) * unit);
        const pulse = Math.floor(timeMs / 320) % 2 === 0;
        const halSurf = cache.getOrBakeAuxSurface(
          `sil:ENEMY:${pulse ? 1 : 0}`,
          TILE_PX,
          TILE_PX,
          (sCtx) => bakeSilhouetteMarker32(sCtx, 'ENEMY', pulse, theme),
        );
        ctx.save();
        ctx.globalAlpha = glitchPhase === 2 ? 0.68 : 0.92;
        ctx.drawImage(halSurf, Math.round(px + glitchX), Math.round(py), tileSize, tileSize);
        ctx.restore();
      } else {
        drawHallucinationMarker(ctx, px, py, tileSize, timeMs, theme);
      }
    }

    // FX Shockwaves, Arrow Projectiles, Particles, Ulti Sinematikleri & Floating Texts
    if (fx !== undefined) {
      this.drawFxOverlays(ctx, state, fx, offsetX, offsetY, tileSize, flip);
      this.drawParticles(ctx, state, fx, offsetX, offsetY, tileSize, flip);
      this.drawFloatingTexts(ctx, state, fx, offsetX, offsetY, tileSize, flip);
    }

    // Ocaklı Ulti Odak Karartması (%35 tahta dışı) & Şah Killcam Gri-Kan Tonu & Ekran Flaşı / CRT Kapanış
    if (camFx !== undefined) {
      if (camFx.dimBoardOutsideAlpha > 0.01) {
        ctx.save();
        ctx.fillStyle = `rgba(2, 4, 10, ${camFx.dimBoardOutsideAlpha})`;
        ctx.beginPath();
        ctx.rect(0, 0, cssWidth, offsetY);
        ctx.rect(0, offsetY + boardPixelH, cssWidth, Math.max(0, cssHeight - offsetY - boardPixelH));
        ctx.rect(0, offsetY, offsetX, boardPixelH);
        ctx.rect(offsetX + boardPixelW, offsetY, Math.max(0, cssWidth - offsetX - boardPixelW), boardPixelH);
        ctx.fill();
        ctx.restore();
      }
      if (camFx.grayscaleProgress > 0.01) {
        ctx.save();
        ctx.fillStyle = `rgba(30, 8, 12, ${0.46 * camFx.grayscaleProgress})`;
        ctx.beginPath();
        ctx.rect(offsetX, offsetY, boardPixelW, boardPixelH);
        ctx.fill();
        ctx.restore();
      }
      if (camFx.screenFlashColor !== null && camFx.screenFlashAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = camFx.screenFlashAlpha;
        ctx.fillStyle = camFx.screenFlashColor;
        ctx.beginPath();
        ctx.rect(0, 0, cssWidth, cssHeight);
        ctx.fill();
        ctx.restore();
      } else if (camFx.borderFlashColor !== null && camFx.borderFlashAlpha > 0.01) {
        ctx.save();
        ctx.strokeStyle = camFx.borderFlashColor;
        ctx.globalAlpha = camFx.borderFlashAlpha;
        ctx.lineWidth = Math.max(6, Math.round(tileSize * 0.14));
        ctx.strokeRect(offsetX, offsetY, boardPixelW, boardPixelH);
        ctx.restore();
      }
      if (camFx.crtShutdownProgress > 0.01) {
        const halfClose = (boardPixelH * 0.48) * camFx.crtShutdownProgress;
        ctx.save();
        ctx.fillStyle = '#020307';
        ctx.beginPath();
        ctx.rect(offsetX, offsetY, boardPixelW, halfClose);
        ctx.rect(offsetX, offsetY + boardPixelH - halfClose, boardPixelW, halfClose);
        ctx.fill();
        ctx.fillStyle = `rgba(248, 250, 252, ${0.75 * (1 - camFx.crtShutdownProgress * 0.5)})`;
        ctx.beginPath();
        ctx.rect(offsetX, offsetY + boardPixelH * 0.5 - 1, boardPixelW, 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // PANİK ATAK! (Stres >= 75) Köşe Kızıl Vignette
    if (canBlit && (options.stressScore ?? 0) >= 75) {
      const pulseOn = options.calmScreen ? false : Math.floor(timeMs / 360) % 2 === 0;
      const corners: ReadonlyArray<{ corner: 'TL' | 'TR' | 'BL' | 'BR'; x: number; y: number }> = [
        { corner: 'TL', x: offsetX, y: offsetY },
        { corner: 'TR', x: offsetX + boardPixelW - tileSize, y: offsetY },
        { corner: 'BL', x: offsetX, y: offsetY + boardPixelH - tileSize },
        { corner: 'BR', x: offsetX + boardPixelW - tileSize, y: offsetY + boardPixelH - tileSize },
      ];
      for (const c of corners) {
        const pSurf = cache.getOrBakeAuxSurface(
          `panic:${c.corner}:${pulseOn ? 1 : 0}`,
          TILE_PX,
          TILE_PX,
          (sCtx) => bakePanicCorner32(sCtx, c.corner, pulseOn),
        );
        ctx.drawImage(pSurf, Math.round(c.x), Math.round(c.y), tileSize, tileSize);
      }
    }

    // Faz 4 Sinematik Balonlar & Büyükusta-OS CRT Bandı Kancası
    options.postRenderOverlay?.(ctx, this.layout, state, timeMs, flip);

    ctx.restore();
  }

  private computePieceMotionOffsets(
    piece: Piece,
    isSelected: boolean,
    isHovered: boolean,
    isBonusDash: boolean,
    showAggroBadge: boolean,
    timeMs: number,
    stressScore = 0,
    underThreat = false,
  ): {
    jitterTexels: number;
    bobTexels: number;
    slumpTexels: number;
    hoverLiftTexels: number;
    ambient: ReturnType<typeof computeAmbientPieceVisual>;
  } {
    const composure = piece.composure ?? 3;
    const isSleeping = showAggroBadge && piece.side === 'ENEMY' && piece.aggro === 'SLEEPING';
    const ambient = computeAmbientPieceVisual(piece, timeMs, stressScore, underThreat);
    const canBob = piece.frozenTurns === 0 && !isSleeping && composure > 0;
    const fastBob = (isSelected || isBonusDash) && Math.floor(timeMs / 260) % 2 === 1 ? -1 : 0;
    const bobTexels = canBob ? (isSelected || isBonusDash ? fastBob : ambient.bobTexels) : 0;
    const slumpTexels = composure === 0 && piece.frozenTurns === 0 ? 2 : 0;
    const hoverLiftTexels = isHovered && piece.frozenTurns === 0 && !isSleeping ? -2 : 0;
    return {
      jitterTexels: ambient.jitterTexels,
      bobTexels,
      slumpTexels,
      hoverLiftTexels,
      ambient,
    };
  }

  /** Geçiş 4 — Taş gövdesi, yerde koyu oval gölge, Squash & Stretch ve beyaz silüet flaşı */
  private drawPieceBodyFromCache(
    ctx: CanvasRenderingContext2D,
    cache: SpriteCache,
    piece: Piece,
    opts: {
      px: number;
      py: number;
      shadowPx?: number;
      shadowPy?: number;
      dxTexels?: number;
      dyTexels?: number;
      tileSize: number;
      scaleX: number;
      scaleY: number;
      alpha: number;
      rotation: number;
      flashAlpha: number;
      auraBoostAlpha?: number;
      greenTintAlpha?: number;
      isSelected: boolean;
      isHovered: boolean;
      isBonusDash: boolean;
      showAggroBadge: boolean;
      timeMs: number;
      stressScore?: number;
      underThreat?: boolean;
      onCracked?: boolean;
    },
  ): void {
    const { px, py, tileSize, scaleX, scaleY, alpha, rotation, flashAlpha, timeMs } = opts;
    const unit = tileSize / TILE_PX;
    const composure = piece.composure ?? 3;
    const silenced = piece.type !== 'CHIMERA' && (piece.silencedTurns ?? 0) > 0;
    const { jitterTexels, bobTexels, slumpTexels, hoverLiftTexels, ambient } =
      this.computePieceMotionOffsets(
        piece,
        opts.isSelected,
        opts.isHovered,
        opts.isBonusDash,
        opts.showAggroBadge,
        timeMs,
        opts.stressScore ?? 0,
        opts.underThreat ?? false,
      );

    // Yerdeki koyu oval gölge (At sıçrayışında zeminde düz çizgide kalır; yükselince küçülür)
    const shadowSurf = cache.getOrBakeAuxSurface('piece_shadow_32', TILE_PX, TILE_PX, bakePieceShadow32);
    const totalLiftTexels = hoverLiftTexels + (opts.dyTexels ?? 0);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha)) * (totalLiftTexels < -1 ? 0.68 : 1);
    ctx.drawImage(
      shadowSurf,
      Math.round(opts.shadowPx ?? px),
      Math.round(opts.shadowPy ?? py),
      tileSize,
      tileSize,
    );
    ctx.restore();

    const needsTransform = scaleX !== 1 || scaleY !== 1 || rotation !== 0;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

    let baseX = px;
    let baseY = py;
    if (needsTransform) {
      ctx.translate(px + tileSize * 0.5, py + tileSize * 0.5);
      if (rotation !== 0) ctx.rotate(rotation);
      if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
      baseX = -tileSize * 0.5;
      baseY = -tileSize * 0.5;
    }

    if (opts.isBonusDash) {
      const fKind = Math.floor(timeMs / 180) % 2 === 0 ? 'BONUS_DASH_0' : 'BONUS_DASH_1';
      const fSurf = cache.getOrBakeAuxSurface(`frame:${fKind}`, TILE_PX, TILE_PX, (sCtx) =>
        bakeFrameBorder32(sCtx, fKind),
      );
      ctx.drawImage(fSurf, Math.round(baseX), Math.round(baseY), tileSize, tileSize);
    }

    if (piece.isBoss) {
      const fKind = Math.floor(timeMs / 350) % 2 === 0 ? 'BOSS_0' : 'BOSS_1';
      const fSurf = cache.getOrBakeAuxSurface(`frame:${fKind}`, TILE_PX, TILE_PX, (sCtx) =>
        bakeFrameBorder32(sCtx, fKind),
      );
      ctx.drawImage(fSurf, Math.round(baseX), Math.round(baseY), tileSize, tileSize);
    }

    if ((opts.auraBoostAlpha ?? 0) > 0.05) {
      ctx.save();
      ctx.strokeStyle = piece.type === 'SAINT_FAITH' ? '#2dd4bf' : '#f43f5e';
      ctx.globalAlpha *= opts.auraBoostAlpha!;
      ctx.lineWidth = Math.max(2, unit * 1.5);
      ctx.strokeRect(Math.round(baseX + unit), Math.round(baseY + unit), tileSize - 2 * unit, tileSize - 2 * unit);
      ctx.restore();
    }

    // 24x24 Taş gövdesi — (4, 2) ofsetiyle 1:1 sıfır mixel
    const pieceSurf = cache.getPieceSprite({
      type: piece.type,
      side: piece.side,
      isBoss: piece.isBoss === true,
      ...(piece.type === 'CHIMERA'
        ? {
            slot1Type: piece.absorbedForms?.[0]?.sourceType,
            slot2Type: piece.absorbedForms?.[1]?.sourceType,
          }
        : {}),
    });
    const dxTexels = jitterTexels + Math.round(opts.dxTexels ?? 0);
    const dyTexels = bobTexels + slumpTexels + hoverLiftTexels + Math.round(opts.dyTexels ?? 0);
    drawCachedPieceInTile(ctx, pieceSurf, baseX, baseY, tileSize, dxTexels, dyTexels);

    // Breakdown (Composure = 0), Zehir Boğulma yeşil tınısı, veya Susturma maskesi
    if ((opts.greenTintAlpha ?? 0) > 0.01) {
      const grnSurf = cache.getPieceSilhouetteMaskSprite(
        { type: piece.type, side: piece.side, isBoss: piece.isBoss === true },
        'miasma_choke',
        'rgba(74, 222, 128, 0.72)',
      );
      drawCachedPieceInTile(ctx, grnSurf, baseX, baseY, tileSize, dxTexels, dyTexels);
    } else if (composure === 0) {
      const brkSurf = cache.getPieceSilhouetteMaskSprite(
        { type: piece.type, side: piece.side, isBoss: piece.isBoss === true },
        'breakdown',
        'rgba(71, 85, 105, 0.58)',
      );
      drawCachedPieceInTile(ctx, brkSurf, baseX, baseY, tileSize, dxTexels, dyTexels);
    } else if (silenced) {
      const silMask = cache.getPieceSilhouetteMaskSprite(
        { type: piece.type, side: piece.side, isBoss: piece.isBoss === true },
        'silenced',
        'rgba(100, 116, 139, 0.48)',
      );
      drawCachedPieceInTile(ctx, silMask, baseX, baseY, tileSize, dxTexels, dyTexels);
    }

    // Hit-stop saf beyaz (#FFFFFF) silüet flaşı
    if (flashAlpha > 0.01) {
      const flashSurf = cache.getPieceWhiteFlashSprite({
        type: piece.type,
        side: piece.side,
        isBoss: piece.isBoss === true,
      });
      ctx.save();
      ctx.globalAlpha *= Math.min(0.92, flashAlpha);
      drawCachedPieceInTile(ctx, flashSurf, baseX, baseY, tileSize, dxTexels, dyTexels);
      ctx.restore();
    }

    // 2.1 Taşa Özgü Sürekli İmzalar (beginPath + rect ile 0 ek fillRect çağrısı)
    this.drawAmbientPieceSignatures(ctx, piece, baseX + dxTexels * unit, baseY + dyTexels * unit, unit, timeMs, ambient, opts.onCracked === true);

    ctx.restore();
  }

  private drawAmbientPieceSignatures(
    ctx: CanvasRenderingContext2D,
    piece: Piece,
    bx: number,
    by: number,
    unit: number,
    timeMs: number,
    ambient: ReturnType<typeof computeAmbientPieceVisual>,
    onCracked: boolean,
  ): void {
    // 1) Şah stres/tehdit altında 2x2 mavi ter damlası (1.5 sn döngü)
    if (ambient.sweatProgress !== null) {
      const sy = by + (8 + ambient.sweatProgress * 6) * unit;
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.rect(Math.round(bx + 10 * unit), Math.round(sy), Math.max(2, Math.round(2 * unit)), Math.max(2, Math.round(2 * unit)));
      ctx.fill();
    }

    // 2) Ocaklı tütsüsünden zikzak yükselen 1-2px turkuaz duman (8px yükseklik)
    if (piece.type === 'SAINT_FAITH' && (piece.silencedTurns ?? 0) === 0) {
      const rise = ambient.smokePhase * 8;
      const zigX = Math.sin(ambient.smokePhase * Math.PI * 3) * 1.6;
      const pSz = Math.max(1, Math.round(1.5 * unit));
      ctx.fillStyle = '#2dd4bf';
      ctx.beginPath();
      ctx.rect(Math.round(bx + (23 + zigX) * unit), Math.round(by + (14 - rise) * unit), pSz, pSz);
      ctx.rect(Math.round(bx + (24 - zigX) * unit), Math.round(by + (11 - rise * 0.7) * unit), pSz, pSz);
      ctx.fill();
    }

    // 3) Meczup kızıl göz parlaması + kalp atışı
    if (piece.type === 'SAINT_MADNESS' && ambient.eyeGlintAlpha > 0.1) {
      ctx.fillStyle = '#f43f5e';
      ctx.beginPath();
      ctx.rect(Math.round(bx + 15 * unit), Math.round(by + 9 * unit), Math.max(2, Math.round(2 * unit)), Math.max(2, Math.round(2 * unit)));
      ctx.fill();
    }

    // 4) Gulyabani kılık yuvası zümrüt sporları
    if (ambient.sporePhase !== null) {
      const spY = by + (22 - ambient.sporePhase * 7) * unit;
      const spX = bx + (9 + Math.sin(ambient.sporePhase * 6) * 2) * unit;
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.rect(Math.round(spX), Math.round(spY), Math.max(1, Math.round(1.5 * unit)), Math.max(1, Math.round(1.5 * unit)));
      ctx.fill();
    }

    // 5) Çatlak zemin (CRACKED) üstünde taş varken her 500 ms'de 1px toz kırıntısı düşer
    if (onCracked) {
      const crumblePhase = (timeMs % 500) / 500;
      ctx.fillStyle = '#64748b';
      ctx.beginPath();
      ctx.rect(Math.round(bx + (8 + Math.floor(crumblePhase * 3) * 6) * unit), Math.round(by + (24 + crumblePhase * 5) * unit), Math.max(1, Math.round(unit)), Math.max(1, Math.round(unit)));
      ctx.fill();
    }
  }

  /** Geçiş 5 — Taş üstü 7x7 köşe rozetleri (1,1)/(24,1)/(1,20)/(24,20) ve (4,28) Dayanıklılık barı */
  private drawPieceUiFromCache(
    ctx: CanvasRenderingContext2D,
    cache: SpriteCache,
    piece: Piece,
    opts: {
      px: number;
      py: number;
      tileSize: number;
      scaleX: number;
      scaleY: number;
      alpha: number;
      rotation: number;
      showAggroBadge: boolean;
      timeMs: number;
      theme: RenderTheme;
    },
  ): void {
    const { px, py, tileSize, scaleX, scaleY, alpha, rotation, timeMs, theme } = opts;
    const unit = tileSize / TILE_PX;
    const composure = piece.composure ?? 3;
    const silenced = piece.type !== 'CHIMERA' && (piece.silencedTurns ?? 0) > 0;
    const berserkActive = piece.berserkReady === true && !silenced;

    const needsTransform = scaleX !== 1 || scaleY !== 1 || rotation !== 0;
    ctx.save();
    if (alpha < 1) ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

    let baseX = px;
    let baseY = py;
    if (needsTransform) {
      ctx.translate(px + tileSize * 0.5, py + tileSize * 0.5);
      if (rotation !== 0) ctx.rotate(rotation);
      if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
      baseX = -tileSize * 0.5;
      baseY = -tileSize * 0.5;
    }

    // Kalkan sekizgen çerçevesi
    if (piece.shieldActive) {
      const sSurf = cache.getOrBakeAuxSurface(
        silenced ? 'shield_silenced' : 'shield_active',
        TILE_PX,
        TILE_PX,
        (sCtx) => bakeShieldOverlay32(sCtx, silenced, theme),
      );
      ctx.drawImage(sSurf, Math.round(baseX), Math.round(baseY), tileSize, tileSize);
    }

    // Donma buz kafesi
    if (piece.frozenTurns > 0) {
      const iceSurf = cache.getOrBakeAuxSurface('frozen_cage', TILE_PX, TILE_PX, bakeFrozenCage32);
      ctx.drawImage(iceSurf, Math.round(baseX), Math.round(baseY), tileSize, tileSize);
    }

    const badgeSize = Math.round(BADGE_PX * unit);

    // 1) Sol-Üst (1, 1) 7x7 Rozet: FROZEN > NAZAR/SHIELD > 3-noktalı Aura Şarjı
    const hasFaithWard =
      piece.type === 'SAINT_FAITH' ||
      (piece.type === 'CHIMERA' &&
        (piece.absorbedForms ?? []).some((f) => f.saintEcho === 'FAITH_WARD'));
    const hasTopLeftShield =
      piece.shieldActive && !silenced && (hasFaithWard || piece.traits.includes('SHIELDED'));

    if (piece.frozenTurns > 0) {
      const fxPos = Math.round(baseX + unit);
      const fyPos = Math.round(baseY + unit);
      ctx.drawImage(cache.getBadgeSprite('FROZEN'), fxPos, fyPos, badgeSize, badgeSize);
      ctx.font = `700 ${Math.max(8, Math.round(tileSize * 0.19))}px 'Pixelify Sans', 'Courier New', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#070a12';
      ctx.strokeText(String(piece.frozenTurns), fxPos + badgeSize + 3 * unit, fyPos + badgeSize * 0.5);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(piece.frozenTurns), fxPos + badgeSize + 3 * unit, fyPos + badgeSize * 0.5);
    } else if (hasTopLeftShield) {
      const tlKind = hasFaithWard ? 'NAZAR' : 'SHIELD';
      ctx.drawImage(
        cache.getBadgeSprite(tlKind),
        Math.round(baseX + unit),
        Math.round(baseY + unit),
        badgeSize,
        badgeSize,
      );
    }

    const fCharge = piece.faithCharge ?? 0;
    const mCharge = piece.madnessCharge ?? 0;
    if (fCharge > 0 || mCharge > 0) {
      if (piece.frozenTurns === 0 && !hasTopLeftShield && (fCharge > 0) !== (mCharge > 0)) {
        const aspect = fCharge > 0 ? 'FAITH' : 'MADNESS';
        const charge = Math.min(3, Math.max(1, fCharge > 0 ? fCharge : mCharge)) as 1 | 2 | 3;
        const auraSurf = cache.getOrBakeAuxSurface(
          `aura7:${aspect}:${charge}`,
          BADGE_PX,
          BADGE_PX,
          (sCtx) => bakeAuraBadge7(sCtx, aspect, charge),
        );
        ctx.drawImage(
          auraSurf,
          Math.round(baseX + unit),
          Math.round(baseY + unit),
          badgeSize,
          badgeSize,
        );
      } else {
        const pipsSurf = cache.getOrBakeAuxSurface(
          `pips:${fCharge}:${mCharge}`,
          TILE_PX,
          TILE_PX,
          (sCtx) => bakeAuraPips32(sCtx, fCharge, mCharge),
        );
        ctx.drawImage(pipsSurf, Math.round(baseX), Math.round(baseY), tileSize, tileSize);
      }
    }

    // 2) Sağ-Üst (24, 1) 7x7 Rozet: AGIZ_BAGLAMA (+ kalan tur) veya CINNET alev kıvılcımı
    const hasTopRightStatus = silenced || berserkActive;
    if (silenced) {
      const sxPos = Math.round(baseX + 24 * unit);
      const syPos = Math.round(baseY + unit);
      ctx.drawImage(cache.getBadgeSprite('AGIZ_BAGLAMA'), sxPos, syPos, badgeSize, badgeSize);
      ctx.font = `700 ${Math.max(8, Math.round(tileSize * 0.18))}px 'Pixelify Sans', 'Courier New', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#070a12';
      ctx.strokeText(String(piece.silencedTurns ?? 1), sxPos + badgeSize * 0.5, syPos + badgeSize + 3 * unit);
      ctx.fillStyle = '#fecaca';
      ctx.fillText(String(piece.silencedTurns ?? 1), sxPos + badgeSize * 0.5, syPos + badgeSize + 3 * unit);
    }

    if (berserkActive) {
      const bx = Math.round(baseX + 24 * unit);
      const by = Math.round(baseY + (silenced ? 10 : 1) * unit);
      ctx.drawImage(cache.getBadgeSprite('CINNET'), bx, by, badgeSize, badgeSize);
    }

    // 3) Alt-Köşe Rozetler (1, 20) / (24, 20): Diğer aktif mutasyonlar (yüz/taç ve (4,28) barı ile çakışmaz)
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
      const bSurf = cache.getBadgeSprite(traitToBadgeKind(trait, piece.type));
      ctx.save();
      if (dimmed) ctx.globalAlpha *= 0.45;
      ctx.drawImage(
        bSurf,
        Math.round(baseX + cxOff * unit),
        Math.round(baseY + cyOff * unit),
        badgeSize,
        badgeSize,
      );
      ctx.restore();
    }

    // 4) Dayanıklılık Barı (4, 28) 24x3: 3 iken gizli, 2 kehribar, 1 yanıp sönen kızıl, 0 kilitli
    if (composure < 3) {
      const blinkOn = composure === 1 && Math.floor(timeMs / 200) % 2 === 0;
      const compSurf = cache.getOrBakeAuxSurface(
        `comp:${composure}:${blinkOn ? 1 : 0}`,
        TILE_PX,
        TILE_PX,
        (sCtx) => bakeComposureBar32(sCtx, composure as 0 | 1 | 2, blinkOn),
      );
      ctx.drawImage(compSurf, Math.round(baseX), Math.round(baseY), tileSize, tileSize);
    }

    // 5) Sefer Düşman Aggro Z / ! rozeti
    if (opts.showAggroBadge && piece.side === 'ENEMY' && piece.aggro !== 'ACTIVE') {
      const aggSurf = cache.getOrBakeAuxSurface(`aggro:${piece.aggro}`, 10, 10, (sCtx) =>
        bakeAggroBadge10(sCtx, piece.aggro as 'SLEEPING' | 'ALERTED'),
      );
      const bobY =
        piece.aggro === 'ALERTED'
          ? Math.floor(Math.sin(timeMs * 0.014) * 2)
          : Math.floor(Math.sin(timeMs * 0.004) * 1.5);
      const size10 = Math.round(10 * unit);
      ctx.drawImage(
        aggSurf,
        Math.round(baseX + 21 * unit),
        Math.round(baseY + ((hasTopRightStatus ? 10 : 1) + bobY) * unit),
        size10,
        size10,
      );
    }

    ctx.restore();
  }

  private drawTileStains(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    fx: FxRenderSnapshot | undefined,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    flip: boolean,
  ): void {
    const stains = fx?.tileStains ?? [];
    for (let i = 0; i < stains.length; i++) {
      const st = stains[i]!;
      const vp = mapBoardCoord({ x: st.x, y: st.y }, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      const alpha = Math.max(0, 1 - st.ageMs / st.lifeMs) * 0.55;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = st.color;
      ctx.beginPath();
      ctx.rect(Math.round(px + tileSize * 0.25), Math.round(py + tileSize * 0.35), Math.round(tileSize * 0.5), Math.round(tileSize * 0.38));
      ctx.fill();
      ctx.restore();
    }
  }

  private drawTrapWires(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    options: CanvasRenderOptions,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    flip: boolean,
  ): void {
    drawCopperTrapWires(ctx, state, offsetX, offsetY, tileSize, {
      selectedCoord: options.selectedCoord,
      inspectedCoord: options.inspectedCoord,
      hoveredCoord: options.hoveredCoord,
      flipBoard: flip,
    });
  }

  private drawSaintAuras(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    timeMs: number,
    flip: boolean,
  ): void {
    for (let i = 0; i < state.pieces.length; i++) {
      const piece = state.pieces[i]!;
      if (piece.type !== 'SAINT_FAITH' && piece.type !== 'SAINT_MADNESS') continue;
      if ((piece.silencedTurns ?? 0) > 0) continue;

      const vp = mapBoardCoord(piece.pos, state.width, state.height, flip);
      const minX = Math.max(0, vp.x - 2);
      const maxX = Math.min(state.width - 1, vp.x + 2);
      const minY = Math.max(0, vp.y - 2);
      const maxY = Math.min(state.height - 1, vp.y + 2);

      const rx = offsetX + minX * tileSize;
      const ry = offsetY + minY * tileSize;
      const rw = (maxX - minX + 1) * tileSize;
      const rh = (maxY - minY + 1) * tileSize;

      ctx.save();
      if (piece.type === 'SAINT_FAITH') {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.05)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.56)';
        ctx.lineWidth = Math.max(1.5, Math.floor(tileSize * 0.035));
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -(timeMs * 0.015);
        ctx.strokeRect(rx + 1.5, ry + 1.5, rw - 3, rh - 3);
      } else {
        const j = Math.floor(timeMs / 110) % 2 === 0 ? 1 : -1;
        ctx.fillStyle = 'rgba(147, 51, 234, 0.06)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle =
          Math.floor(timeMs / 180) % 2 === 0
            ? 'rgba(244, 63, 94, 0.58)'
            : 'rgba(147, 51, 234, 0.58)';
        ctx.lineWidth = Math.max(1.5, Math.floor(tileSize * 0.035));
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(rx + 1.5 + j * 0.5, ry + 1.5, rw - 3, rh - 3);
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  private drawFxOverlays(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    fx: FxRenderSnapshot,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    flip: boolean,
  ): void {
    const shockwaves = fx.shockwaves ?? [];
    for (let i = 0; i < shockwaves.length; i++) {
      const sw = shockwaves[i]!;
      const vp = mapBoardCoord({ x: sw.x, y: sw.y }, state.width, state.height, flip);
      const cx = offsetX + (vp.x + 0.5) * tileSize;
      const cy = offsetY + (vp.y + 0.5) * tileSize;
      const halfSpan = (0.5 + sw.maxRadiusTiles * sw.progress) * tileSize;
      const alpha = Math.max(0, 1 - sw.progress);

      ctx.save();
      ctx.globalAlpha = alpha * 0.85;
      ctx.strokeStyle = sw.color;
      ctx.lineWidth = Math.max(3, tileSize * 0.08);
      ctx.strokeRect(cx - halfSpan, cy - halfSpan, halfSpan * 2, halfSpan * 2);
      ctx.fillStyle = 'rgba(254, 249, 195, 0.16)';
      ctx.fillRect(cx - halfSpan, cy - halfSpan, halfSpan * 2, halfSpan * 2);
      ctx.restore();
    }

    const beams = fx.arrowBeams ?? [];
    for (let i = 0; i < beams.length; i++) {
      const beam = beams[i]!;
      const vf = mapBoardCoord(beam.from, state.width, state.height, flip);
      const vt = mapBoardCoord(beam.to, state.width, state.height, flip);
      const x0 = offsetX + (vf.x + 0.5) * tileSize;
      const y0 = offsetY + (vf.y + 0.5) * tileSize;
      const x1 = offsetX + (vt.x + 0.5) * tileSize;
      const y1 = offsetY + (vt.y + 0.5) * tileSize;
      const curX = x0 + (x1 - x0) * beam.progress;
      const curY = y0 + (y1 - y0) * beam.progress;
      const tailP = Math.max(0, beam.progress - 0.32);
      const tailX = x0 + (x1 - x0) * tailP;
      const tailY = y0 + (y1 - y0) * tailP;

      ctx.save();
      ctx.strokeStyle = beam.flaming ? '#f97316' : '#fde047';
      ctx.lineWidth = Math.max(3, tileSize * 0.075);
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(curX, curY);
      ctx.stroke();

      ctx.fillStyle = beam.flaming ? '#fef08a' : '#ffffff';
      const tip = Math.max(4, Math.floor(tileSize * 0.1));
      ctx.fillRect(curX - tip * 0.5, curY - tip * 0.5, tip, tip);
      ctx.restore();
    }

    // Bakır Kablo Kehribar Sinyal Kıvılcımları
    const signals = fx.signalSparks ?? [];
    for (let i = 0; i < signals.length; i++) {
      const sp = signals[i]!;
      const vp = mapBoardCoord(
        { x: sp.from.x, y: sp.from.y },
        state.width,
        state.height,
        flip,
      );
      const sx = offsetX + (vp.x + 0.5) * tileSize;
      const sy = offsetY + (vp.y + 0.5) * tileSize;
      ctx.save();
      ctx.fillStyle = sp.color;
      const box = Math.max(4, Math.round(tileSize * 0.14));
      ctx.beginPath();
      ctx.rect(Math.round(sx - box * 0.5), Math.round(sy - box * 0.5), box, box);
      ctx.fill();
      ctx.restore();
    }

    // Speedlines (Fil ışık şeridi & Cinnet Zinciri beyaz çarpma çizgisi)
    const speedlines = fx.speedlines ?? [];
    for (let i = 0; i < speedlines.length; i++) {
      const sl = speedlines[i]!;
      const ax = offsetX + ((flip ? state.width - sl.from.x : sl.from.x) * tileSize);
      const ay = offsetY + ((flip ? state.height - sl.from.y : sl.from.y) * tileSize);
      const bx = offsetX + ((flip ? state.width - sl.to.x : sl.to.x) * tileSize);
      const by = offsetY + ((flip ? state.height - sl.to.y : sl.to.y) * tileSize);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - sl.ageMs / sl.lifeMs);
      ctx.strokeStyle = sl.color;
      ctx.lineWidth = Math.max(2, tileSize * 0.08);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
    }

    // 4-Yönlü Darbe Yıldız Flaşları
    const stars = fx.starFlashes ?? [];
    for (let i = 0; i < stars.length; i++) {
      const sf = stars[i]!;
      const vx = flip ? state.width - sf.x : sf.x;
      const vy = flip ? state.height - sf.y : sf.y;
      const cx = Math.round(offsetX + vx * tileSize);
      const cy = Math.round(offsetY + vy * tileSize);
      const p = sf.ageMs / sf.lifeMs;
      const span = Math.round(sf.sizeTiles * tileSize * (1 - p * 0.45));
      const thick = Math.max(2, Math.round(tileSize * 0.09 * (1 - p)));
      ctx.save();
      ctx.fillStyle = sf.color;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.beginPath();
      ctx.rect(cx - span, cy - thick * 0.5, span * 2, thick);
      ctx.rect(cx - thick * 0.5, cy - span, thick, span * 2);
      ctx.fill();
      ctx.restore();
    }

    // Ocaklı Ulti Nazar Kilidi
    if (fx.nazarLock !== undefined && fx.nazarLock !== null) {
      const nl = fx.nazarLock;
      const vx = flip ? state.width - nl.x : nl.x;
      const vy = flip ? state.height - nl.y : nl.y;
      const cx = Math.round(offsetX + vx * tileSize);
      const cy = Math.round(offsetY + vy * tileSize);
      const r = Math.max(5, tileSize * 0.19);
      ctx.save();
      ctx.fillStyle = '#0284c7';
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Meczup Ultisi Dikey Kızıl Alev Çizgileri
    const streaks = fx.flameStreaks ?? [];
    for (let i = 0; i < streaks.length; i++) {
      const fs = streaks[i]!;
      const vp = mapBoardCoord({ x: fs.x, y: fs.y }, state.width, state.height, flip);
      const fxX = Math.round(offsetX + vp.x * tileSize);
      const fxY = Math.round(offsetY + vp.y * tileSize);
      ctx.save();
      ctx.fillStyle = '#f43f5e';
      ctx.globalAlpha = 0.72;
      ctx.beginPath();
      ctx.rect(fxX + tileSize * 0.2, fxY + tileSize * 0.15, 2, tileSize * 0.65);
      ctx.rect(fxX + tileSize * 0.76, fxY + tileSize * 0.1, 2, tileSize * 0.7);
      ctx.fill();
      ctx.restore();
    }

    // 2P Uzak Hamle Çıkış Halkası
    const rRings = fx.remoteSignalRings ?? [];
    for (let i = 0; i < rRings.length; i++) {
      const rr = rRings[i]!;
      const vx = flip ? state.width - rr.x : rr.x;
      const vy = flip ? state.height - rr.y : rr.y;
      const cx = Math.round(offsetX + vx * tileSize);
      const cy = Math.round(offsetY + vy * tileSize);
      const p = rr.ageMs / rr.lifeMs;
      const half = Math.round(tileSize * (0.28 + p * 0.36));
      ctx.save();
      ctx.strokeStyle = rr.color;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.lineWidth = Math.max(2, tileSize * 0.06);
      ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
      ctx.restore();
    }

    // Şah Düşüşü İkiye Bölünen Çatlak Taç
    if (fx.splitCrown !== undefined && fx.splitCrown !== null) {
      const sc = fx.splitCrown;
      const vx = flip ? state.width - sc.x : sc.x;
      const vy = flip ? state.height - sc.y : sc.y;
      const cx = Math.round(offsetX + vx * tileSize);
      const cy = Math.round(offsetY + vy * tileSize);
      const leapY = -Math.sin(Math.min(1, sc.progress * 1.15) * Math.PI) * (tileSize * 0.35) + sc.progress * (tileSize * 0.25);
      const splitDx = sc.progress * tileSize * 0.24;
      const cw = Math.max(4, Math.round(tileSize * 0.12));
      ctx.save();
      ctx.fillStyle = sc.color;
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, sc.progress - 0.65) * 2.8);
      ctx.beginPath();
      ctx.rect(Math.round(cx - splitDx - cw), Math.round(cy + leapY), cw, cw);
      ctx.rect(Math.round(cx + splitDx), Math.round(cy + leapY), cw, cw);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawSkullMarker(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
  ): void {
    const cache = this.spriteCache;
    if (cache !== null && typeof ctx.drawImage === 'function') {
      const box = Math.max(14, Math.round(r * 2));
      const skullSurf = cache.getOrBakeAuxSurface('hazard_skull_14', 14, 14, bakeHazardSkull14);
      ctx.drawImage(
        skullSurf,
        Math.round(cx - box * 0.5),
        Math.round(cy - box * 0.5),
        box,
        box,
      );
      return;
    }
    drawHazardSkullIcon(ctx, cx, cy, r);
  }

  private drawCoordinateLabels(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    flip: boolean,
  ): void {
    ctx.save();
    ctx.fillStyle = '#7c8ca6';
    ctx.font = `700 ${Math.max(11, Math.min(14, Math.round(tileSize * 0.24)))}px 'Pixelify Sans', 'Courier New', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const boardPixelH = height * tileSize;
    for (let x = 0; x < width; x++) {
      const canonicalX = flip ? width - 1 - x : x;
      const label = String.fromCharCode(65 + canonicalX);
      ctx.fillText(label, offsetX + (x + 0.5) * tileSize, offsetY + boardPixelH + 14);
    }

    for (let y = 0; y < height; y++) {
      const canonicalY = flip ? height - 1 - y : y;
      const rank = String(height - canonicalY);
      ctx.fillText(rank, offsetX - 13, offsetY + (y + 0.5) * tileSize);
    }
    ctx.restore();
  }

  private drawTileHighlights(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    options: CanvasRenderOptions,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    timeMs: number,
    flip: boolean,
  ): void {
    const pulse = 0.72 + 0.28 * Math.sin(timeMs * 0.007);

    // Last visible move golden pixel trail (strictly filtered through VisibleState)
    if (options.lastVisibleMove !== undefined && options.lastVisibleMove !== null) {
      const trailCoords = [options.lastVisibleMove.from, options.lastVisibleMove.to];
      for (let i = 0; i < trailCoords.length; i++) {
        const tc = trailCoords[i]!;
        if ((state.fog[tc.y]?.[tc.x] ?? 'UNEXPLORED') === 'UNEXPLORED') continue;
        const vp = mapBoardCoord(tc, state.width, state.height, flip);
        const px = offsetX + vp.x * tileSize;
        const py = offsetY + vp.y * tileSize;
        ctx.fillStyle = i === 1 ? 'rgba(250, 204, 21, 0.16)' : 'rgba(250, 204, 21, 0.09)';
        ctx.fillRect(px + 2, py + 2, tileSize - 4, tileSize - 4);
        ctx.strokeStyle = i === 1 ? 'rgba(250, 204, 21, 0.58)' : 'rgba(250, 204, 21, 0.32)';
        ctx.lineWidth = Math.max(1.5, Math.floor(tileSize * 0.032));
        ctx.strokeRect(px + 2.5, py + 2.5, tileSize - 5, tileSize - 5);
      }
    }

    // Fair enemy threat danger notches (strictly from currently VISIBLE opponent pieces)
    if (options.showThreatOverlay && options.threatCoords !== undefined && options.threatCoords.length > 0) {
      const notch = Math.max(5, Math.floor(tileSize * 0.17));
      const seenThreat: Record<string, true> = {};
      for (let i = 0; i < options.threatCoords.length; i++) {
        const threatCoord: Coord = options.threatCoords[i]!;
        const key = `${threatCoord.x},${threatCoord.y}`;
        if (seenThreat[key]) continue;
        seenThreat[key] = true;
        if ((state.fog[threatCoord.y]?.[threatCoord.x] ?? 'UNEXPLORED') === 'UNEXPLORED') continue;
        const vp = mapBoardCoord(threatCoord, state.width, state.height, flip);
        const px = offsetX + vp.x * tileSize;
        const py = offsetY + vp.y * tileSize;
        ctx.fillStyle = 'rgba(239, 68, 68, 0.10)';
        ctx.fillRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
        // Pixel corner warning triangle (top-left)
        ctx.fillStyle = 'rgba(248, 113, 113, 0.78)';
        ctx.fillRect(px + 2, py + 2, notch, Math.max(2, Math.floor(notch * 0.4)));
        ctx.fillRect(px + 2, py + 2, Math.max(2, Math.floor(notch * 0.4)), notch);
      }
    }

    // Optional Skirmish secret deployment zone highlight (walkable squares in deploy rows)
    if (options.deployZoneRows !== undefined && options.deployZoneRows.length > 0) {
      for (let r = 0; r < options.deployZoneRows.length; r++) {
        const ry = options.deployZoneRows[r]!;
        if (ry < 0 || ry >= state.height) continue;
        for (let x = 0; x < state.width; x++) {
          const tile = state.tiles[ry]?.[x];
          if (tile === undefined || tile === null || tile.type === 'WALL' || tile.type === 'PIT') {
            continue;
          }
          const vp = mapBoardCoord({ x, y: ry }, state.width, state.height, flip);
          const px = offsetX + vp.x * tileSize;
          const py = offsetY + vp.y * tileSize;
          ctx.fillStyle = 'rgba(52, 211, 153, 0.14)';
          ctx.fillRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
          ctx.strokeStyle = 'rgba(52, 211, 153, 0.55)';
          ctx.lineWidth = 1.4;
          ctx.strokeRect(px + 2, py + 2, tileSize - 4, tileSize - 4);
        }
      }
    }

    // Selected tile highlight
    if (options.selectedCoord !== null) {
      const vp = mapBoardCoord(options.selectedCoord, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
      ctx.fillRect(px, py, tileSize, tileSize);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = Math.max(2, tileSize * 0.05);
      ctx.strokeRect(px + 1.5, py + 1.5, tileSize - 3, tileSize - 3);
    }

    // Inspected tile highlight (distinct amber corner brackets when different from selection)
    if (
      options.inspectedCoord !== null &&
      (options.selectedCoord === null || !coordEquals(options.inspectedCoord, options.selectedCoord))
    ) {
      const vp = mapBoardCoord(options.inspectedCoord, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      drawCornerBrackets(ctx, px + 3, py + 3, tileSize - 6, tileSize * 0.2, '#fbbf24', 2);
    }

    // Legal moves (shown clearly unless an explicit ability mode is toggled on)
    const showMoves = options.activeAbility === null;
    const showLethal = options.showLethalWarnings !== false;
    const lethalPulse4Fps = Math.floor(timeMs / 250) % 2 === 0;
    if (showMoves) {
      for (let i = 0; i < options.legalMoves.length; i++) {
        const move = options.legalMoves[i]!;
        const vp = mapBoardCoord(move.to, state.width, state.height, flip);
        const px = offsetX + vp.x * tileSize;
        const py = offsetY + vp.y * tileSize;
        const cx = px + tileSize * 0.5;
        const cy = py + tileSize * 0.5;
        const waveDist = Math.abs(move.to.x - move.from.x) + Math.abs(move.to.y - move.from.y);
        const waveFactor = 0.88 + 0.14 * Math.sin(timeMs * 0.008 - waveDist * 0.52);

        if (move.isHazardous && showLethal) {
          ctx.fillStyle = `rgba(239, 68, 68, ${0.24 * pulse})`;
          ctx.fillRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = Math.max(2, tileSize * 0.045);
          ctx.strokeRect(px + 2, py + 2, tileSize - 4, tileSize - 4);
          this.drawSkullMarker(ctx, cx, cy, tileSize * (lethalPulse4Fps ? 0.25 : 0.21));
        } else if (move.resolution.captured) {
          ctx.fillStyle = 'rgba(239, 68, 68, 0.24)';
          ctx.fillRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
          drawCornerBrackets(ctx, px + 4, py + 4, tileSize - 8, tileSize * 0.24, '#f87171', 2.4);
        } else if (move.resolution.brokeShield) {
          ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
          ctx.fillRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
          drawCornerBrackets(ctx, px + 4, py + 4, tileSize - 8, tileSize * 0.24, '#38bdf8', 2.4);
        } else if (move.resolution.slid) {
          const u = Math.max(2, Math.round(tileSize / TILE_PX));
          const half = Math.max(u * 2, Math.round(tileSize * 0.16 * waveFactor / u) * u);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
          ctx.fillRect(px + u, py + u, tileSize - u * 2, tileSize - u * 2);
          ctx.strokeStyle = '#7dd3fc';
          ctx.lineWidth = u;
          ctx.strokeRect(
            Math.round(cx - half),
            Math.round(cy - half),
            half * 2,
            half * 2,
          );
        } else {
          // Keskin piksel elmas hamle işareti (pürüzsüz ctx.arc yerine sıfır mixel)
          const u = Math.max(2, Math.round(tileSize / TILE_PX));
          const stepPulse = Math.floor(timeMs / 280 + waveDist) % 2 === 0 ? 1 : 0;
          const r = u * (2 + stepPulse);
          const rx = Math.round(cx);
          const ry = Math.round(cy);
          ctx.fillStyle = 'rgba(5, 8, 16, 0.85)';
          ctx.beginPath();
          ctx.rect(rx - r - u, ry - u, (r + u) * 2, u * 2);
          ctx.rect(rx - u, ry - r - u, u * 2, (r + u) * 2);
          ctx.rect(rx - r, ry - r, r * 2, r * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(52, 211, 153, 0.92)';
          ctx.beginPath();
          ctx.rect(rx - r, ry - u, r * 2, u * 2);
          ctx.rect(rx - u, ry - r, u * 2, r * 2);
          ctx.fill();
        }
      }
    }

    // Legal active abilities (PUSH / BREAK_WALL)
    for (let i = 0; i < options.legalAbilities.length; i++) {
      const ab = options.legalAbilities[i]!;
      const isPrimary = options.activeAbility === ab.ability;
      const overlapsMove = options.legalMoves.some((m) => coordEquals(m.to, ab.target));
      if (!isPrimary && overlapsMove && options.activeAbility === null) continue;
      if (options.activeAbility !== null && !isPrimary) continue;

      const vp = mapBoardCoord(ab.target, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      const color = ab.ability === 'PUSH' ? '#c084fc' : '#f59e0b';
      const fill = ab.ability === 'PUSH' ? 'rgba(192, 132, 252, 0.26)' : 'rgba(245, 158, 11, 0.28)';
      const u = Math.max(2, Math.round(tileSize / TILE_PX));

      ctx.fillStyle = fill;
      ctx.fillRect(px + u, py + u, tileSize - u * 2, tileSize - u * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = u;
      ctx.strokeRect(px + u, py + u, tileSize - u * 2, tileSize - u * 2);

      const abFontPx = Math.max(11, Math.round(tileSize * 0.22));
      ctx.fillStyle = '#05070c';
      ctx.fillRect(px + Math.round(tileSize * 0.2), py + u * 2, Math.round(tileSize * 0.6), abFontPx + 2);
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${abFontPx}px 'Pixelify Sans', 'Courier New', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        ab.ability === 'PUSH' ? 'İT' : 'KIR',
        Math.round(px + tileSize * 0.5),
        Math.round(py + u * 2 + (abFontPx + 2) * 0.5),
      );
    }

    // Hovered tile crisp outline
    if (options.hoveredCoord !== null) {
      const vp = mapBoardCoord(options.hoveredCoord, state.width, state.height, flip);
      const px = offsetX + vp.x * tileSize;
      const py = offsetY + vp.y * tileSize;
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.55)';
      ctx.lineWidth = 1.6;
      ctx.strokeRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
    }
  }

  private drawRoutePreviews(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    options: CanvasRenderOptions,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    timeMs: number,
    flip: boolean,
  ): void {
    const dashOffset = -(timeMs * 0.03) % 24;
    const mapPath = (path: readonly Coord[]): Coord[] =>
      path.map((c) => mapBoardCoord(c, state.width, state.height, flip));

    if (options.activeAbility === null) {
      const hoveredMove =
        options.hoveredCoord !== null
          ? options.legalMoves.find((m) => coordEquals(m.to, options.hoveredCoord!))
          : undefined;

      for (let i = 0; i < options.legalMoves.length; i++) {
        const move = options.legalMoves[i]!;
        if (!move.resolution.slid) continue;
        const isHovered = hoveredMove === move;
        const viewPath = mapPath(move.resolution.path);
        if (viewPath.length < 2) continue;

        this.drawDashedPolyline(
          ctx,
          viewPath,
          offsetX,
          offsetY,
          tileSize,
          move.isHazardous
            ? isHovered
              ? '#ef4444'
              : 'rgba(239, 68, 68, 0.45)'
            : isHovered
              ? '#38bdf8'
              : 'rgba(56, 189, 248, 0.4)',
          isHovered ? Math.max(3, tileSize * 0.068) : Math.max(1.6, tileSize * 0.036),
          dashOffset,
        );

        const end = viewPath[viewPath.length - 1]!;
        const ex = offsetX + (end.x + 0.5) * tileSize;
        const ey = offsetY + (end.y + 0.5) * tileSize;

        if (move.resolution.fellInPit || move.resolution.endsOnBurning) {
          this.drawSkullMarker(ctx, ex, ey, tileSize * (isHovered ? 0.25 : 0.17));
        } else if (isHovered && move.resolution.finalPos !== null) {
          ctx.fillStyle = move.resolution.captured ? '#f87171' : '#38bdf8';
          ctx.beginPath();
          ctx.arc(ex, ey, tileSize * 0.14, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 45° Curved Stress Drift preview arrows (purple-orange dashed curve)
      for (let i = 0; i < options.legalMoves.length; i++) {
        const move = options.legalMoves[i]!;
        if (move.isDrifted !== true || move.resolution.slid) continue;
        const isHovered = hoveredMove !== undefined && coordEquals(hoveredMove.to, move.to);
        const viewPath = mapPath(move.resolution.path);
        if (viewPath.length < 3) continue;
        this.drawDashedPolyline(
          ctx,
          viewPath,
          offsetX,
          offsetY,
          tileSize,
          isHovered ? '#fb923c' : 'rgba(192, 132, 252, 0.55)',
          isHovered ? Math.max(2.8, tileSize * 0.062) : Math.max(1.6, tileSize * 0.036),
          dashOffset,
        );
      }

      if (hoveredMove !== undefined && hoveredMove.resolution.brokeShield && !hoveredMove.resolution.slid) {
        const viewPath = mapPath(hoveredMove.resolution.path);
        if (viewPath.length >= 2) {
          this.drawDashedPolyline(
            ctx,
            viewPath,
            offsetX,
            offsetY,
            tileSize,
            '#38bdf8',
            Math.max(2.4, tileSize * 0.055),
            dashOffset,
          );
        }
      }
    }

    const hoveredAbility =
      options.hoveredCoord !== null
        ? options.legalAbilities.find(
            (a) =>
              coordEquals(a.target, options.hoveredCoord!) &&
              (options.activeAbility === null || options.activeAbility === a.ability),
          )
        : undefined;

    if (hoveredAbility?.ability === 'PUSH' && hoveredAbility.pushPreview !== undefined) {
      const pp = hoveredAbility.pushPreview;
      if (!pp.blocked) {
        const rawPath: Coord[] =
          pp.slidePath.length > 0
            ? [hoveredAbility.target, ...pp.slidePath]
            : [hoveredAbility.target, pp.dest];
        const pushPath = mapPath(rawPath);
        this.drawDashedPolyline(
          ctx,
          pushPath,
          offsetX,
          offsetY,
          tileSize,
          pp.fellInPit ? '#ef4444' : '#c084fc',
          Math.max(3, tileSize * 0.065),
          dashOffset,
        );
        const end = pushPath[pushPath.length - 1]!;
        if (pp.fellInPit) {
          this.drawSkullMarker(
            ctx,
            offsetX + (end.x + 0.5) * tileSize,
            offsetY + (end.y + 0.5) * tileSize,
            tileSize * 0.24,
          );
        }
      }
    }
  }

  private drawDashedPolyline(
    ctx: CanvasRenderingContext2D,
    path: readonly Coord[],
    offsetX: number,
    offsetY: number,
    tileSize: number,
    color: string,
    lineWidth: number,
    dashOffset: number,
  ): void {
    if (path.length < 2) return;
    const u = Math.max(2, Math.round(tileSize / TILE_PX));
    const snappedWidth = Math.max(u, Math.round(lineWidth / u) * u);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = snappedWidth;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.setLineDash([u * 4, u * 3]);
    ctx.lineDashOffset = Math.round(dashOffset / u) * u;

    ctx.beginPath();
    for (let i = 0; i < path.length; i++) {
      const pt = path[i]!;
      const px = Math.round(offsetX + (pt.x + 0.5) * tileSize);
      const py = Math.round(offsetY + (pt.y + 0.5) * tileSize);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const prev = path[path.length - 2]!;
    const end = path[path.length - 1]!;
    const angle = Math.atan2(end.y - prev.y, end.x - prev.x);
    const tipX = Math.round(offsetX + (end.x + 0.5) * tileSize);
    const tipY = Math.round(offsetY + (end.y + 0.5) * tileSize);
    const headLen = Math.round((tileSize * 0.2) / u) * u;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      Math.round(tipX - headLen * Math.cos(angle - Math.PI / 6)),
      Math.round(tipY - headLen * Math.sin(angle - Math.PI / 6)),
    );
    ctx.lineTo(
      Math.round(tipX - headLen * Math.cos(angle + Math.PI / 6)),
      Math.round(tipY - headLen * Math.sin(angle + Math.PI / 6)),
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawIntentArrows(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    arrows: readonly IntentArrow[],
    offsetX: number,
    offsetY: number,
    tileSize: number,
    flip: boolean,
  ): void {
    for (let i = 0; i < arrows.length; i++) {
      const arrow = arrows[i]!;
      this.drawDashedPolyline(
        ctx,
        [
          mapBoardCoord(arrow.from, state.width, state.height, flip),
          mapBoardCoord(arrow.to, state.width, state.height, flip),
        ],
        offsetX,
        offsetY,
        tileSize,
        arrow.isAttack ? 'rgba(248, 113, 113, 0.8)' : 'rgba(251, 191, 36, 0.72)',
        Math.max(2.2, tileSize * 0.05),
        0,
      );
    }
  }

  private drawParticles(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    fx: FxRenderSnapshot,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    flip: boolean,
  ): void {
    const unit = tileSize / TILE_PX;
    for (let i = 0; i < fx.particles.length; i++) {
      const p = fx.particles[i]!;
      const vx = flip ? state.width - p.x : p.x;
      const vy = flip ? state.height - p.y : p.y;
      const px = offsetX + vx * tileSize;
      const py = offsetY + vy * tileSize - (p.z ?? 0) * tileSize;
      const progress = p.lifeMs > 0 ? p.ageMs / p.lifeMs : 1;

      let fillCol = p.color;
      if (p.colorMid !== undefined && p.colorEnd !== undefined) {
        fillCol =
          progress < 0.45
            ? interpolateHexColor(p.color, p.colorMid, progress / 0.45)
            : interpolateHexColor(p.colorMid, p.colorEnd, (progress - 0.45) / 0.55);
      }

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));

      if (p.shape === 'ring') {
        const half = Math.floor(tileSize * (0.2 + progress * 0.56));
        ctx.strokeStyle = fillCol;
        ctx.lineWidth = Math.max(2, Math.floor(tileSize * 0.055 * (1 - progress * 0.5)));
        ctx.strokeRect(Math.floor(px - half), Math.floor(py - half), half * 2, half * 2);
      } else if (p.shape === 'shard') {
        const s = Math.max(2, Math.round(p.size * tileSize));
        ctx.fillStyle = '#070a12';
        ctx.fillRect(Math.floor(px - s * 0.6) - 1, Math.floor(py - s * 0.6) - 1, Math.round(s * 1.2) + 2, Math.round(s * 1.2) + 2);
        ctx.fillStyle = fillCol;
        ctx.fillRect(Math.floor(px - s * 0.6), Math.floor(py - s * 0.6), Math.round(s * 1.2), Math.round(s * 1.2));
      } else if (p.shape === 'pixel' || p.shape === 'smoke' || p.shape === 'sweat') {
        const ps = Math.max(1, Math.round((p.pxSize ?? 2) * unit));
        ctx.fillStyle = fillCol;
        ctx.fillRect(Math.floor(px - ps * 0.5), Math.floor(py - ps * 0.5), ps, ps);
      } else {
        const s = Math.max(2, Math.round(p.size * tileSize * 1.15));
        ctx.fillStyle = fillCol;
        ctx.fillRect(Math.floor(px - s * 0.5), Math.floor(py - s * 0.5), s, s);
      }

      ctx.restore();
    }
  }

  private drawFloatingTexts(
    ctx: CanvasRenderingContext2D,
    state: VisibleState,
    fx: FxRenderSnapshot,
    offsetX: number,
    offsetY: number,
    tileSize: number,
    flip: boolean,
  ): void {
    for (let i = 0; i < fx.floatingTexts.length; i++) {
      const ft = fx.floatingTexts[i]!;
      const progress = ft.lifeMs > 0 ? ft.ageMs / ft.lifeMs : 1;
      const alpha = progress < 0.72 ? 1 : Math.max(0, (1 - progress) / 0.28);
      const vx = flip ? state.width - ft.x : ft.x;
      // Offset floating combat callouts below the tile center so they do not collide with upward-opening speech bubbles or [!] badges
      const baseVy = flip ? state.height - ft.y - (ft.ageMs / 1000) * 1.15 : ft.y;
      const antiOverlapOffset = ft.text.includes('UYANDI')
        ? tileSize * 0.64
        : baseVy < 2.2
          ? tileSize * 0.56
          : tileSize * 0.36;
      const px = Math.round(offsetX + vx * tileSize);
      const py = Math.round(offsetY + baseVy * tileSize + antiOverlapOffset);

      ctx.save();
      ctx.globalAlpha = alpha;
      const u = Math.max(2, Math.round(tileSize / TILE_PX));
      const fontSize = Math.max(12, Math.round(tileSize * 0.23));
      ctx.font = `700 ${fontSize}px 'Pixelify Sans', 'Courier New', monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const padX = u * 3;
      const textW = typeof ctx.measureText === 'function' ? ctx.measureText(ft.text).width : ft.text.length * 7;
      const pillW = Math.round(textW + padX * 2);
      const pillH = fontSize + u * 3;
      const bx = Math.round(px - pillW / 2);
      const by = Math.round(py - pillH / 2);
      ctx.fillStyle = '#04060c';
      ctx.fillRect(bx + u, by + u, pillW, pillH);
      ctx.fillStyle = 'rgba(7, 10, 18, 0.94)';
      ctx.fillRect(bx, by, pillW, pillH);
      ctx.strokeStyle = ft.color;
      ctx.lineWidth = u;
      ctx.strokeRect(bx, by, pillW, pillH);
      ctx.fillStyle = '#04060c';
      ctx.fillText(ft.text, px + 1, py + 1);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, px, py);
      ctx.restore();
    }
  }

  private eventToTile(e: PointerEvent): Coord | null {
    const rect = this.canvas.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    return localPointToTile(
      this.layout,
      localX,
      localY,
      this.boardWidth,
      this.boardHeight,
      this.flipBoard,
    );
  }

  private emitHoverIfChanged(coord: Coord | null): void {
    const same =
      (coord === null && this.lastHoverCoord === null) ||
      (coord !== null &&
        this.lastHoverCoord !== null &&
        coordEquals(coord, this.lastHoverCoord));
    if (!same) {
      this.lastHoverCoord = coord;
      this.handlers?.onTileHover(coord);
    }
  }
}

function drawCornerBrackets(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  arm: number,
  color: string,
  lineWidth: number,
): void {
  const rx = Math.round(x);
  const ry = Math.round(y);
  const rs = Math.round(size);
  const ra = Math.round(arm);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2, Math.round(lineWidth));
  ctx.lineCap = 'square';
  ctx.beginPath();
  // Top-left
  ctx.moveTo(rx, ry + ra);
  ctx.lineTo(rx, ry);
  ctx.lineTo(rx + ra, ry);
  // Top-right
  ctx.moveTo(rx + rs - ra, ry);
  ctx.lineTo(rx + rs, ry);
  ctx.lineTo(rx + rs, ry + ra);
  // Bottom-right
  ctx.moveTo(rx + rs, ry + rs - ra);
  ctx.lineTo(rx + rs, ry + rs);
  ctx.lineTo(rx + rs - ra, ry + rs);
  // Bottom-left
  ctx.moveTo(rx + ra, ry + rs);
  ctx.lineTo(rx, ry + rs);
  ctx.lineTo(rx, ry + rs - ra);
  ctx.stroke();
  ctx.restore();
}

/**
 * Tam ekran tahta çevresini saran düşük kontrastlı 64x64 (2x2 taş döşeme) pikselli zindan zemini.
 * SpriteCache içinde tek sefer pişirilir ve tahta koordinatlarıyla 1:1 hizalanır (sıfır mixel).
 */
function bakeAmbientDungeonFloor64(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  theme: RenderTheme,
): void {
  const isCrt = theme === 'crt';
  const baseA = isCrt ? '#040b07' : '#090d16';
  const baseB = isCrt ? '#050e09' : '#0b101b';
  const mortar = isCrt ? '#020604' : '#05080f';
  const hi = isCrt ? '#091b10' : '#101727';
  const speck = isCrt ? '#0c2416' : '#141d30';

  for (let sy = 0; sy < 2; sy++) {
    for (let sx = 0; sx < 2; sx++) {
      const ox = sx * 32;
      const oy = sy * 32;
      ctx.fillStyle = ((sx + sy) & 1) === 0 ? baseA : baseB;
      ctx.fillRect(ox, oy, 32, 32);

      // İnce 1px zindan taş derzi
      ctx.fillStyle = mortar;
      ctx.fillRect(ox, oy, 32, 1);
      ctx.fillRect(ox, oy, 1, 32);
      // Üst/sol çok hafif taş pah parlaması
      ctx.fillStyle = hi;
      ctx.fillRect(ox + 1, oy + 1, 30, 1);
      ctx.fillRect(ox + 1, oy + 1, 1, 30);

      // Kırık taş dikişi + deterministik 1px pikselli doku benekleri
      ctx.fillStyle = mortar;
      ctx.fillRect(ox + 1, oy + 16, 31, 1);
      const splitX = ((sx + sy) & 1) === 0 ? 14 : 20;
      ctx.fillRect(ox + splitX, oy + 1, 1, 15);
      ctx.fillRect(ox + (31 - splitX), oy + 17, 1, 15);

      ctx.fillStyle = speck;
      for (let i = 0; i < 6; i++) {
        const h = tilePixelHash(sx * 11 + i, sy * 17 + i * 3, 29);
        const px = 2 + (h % 28);
        const py = 2 + ((h >> 5) % 28);
        ctx.fillRect(ox + px, oy + py, 1, 1);
      }
    }
  }
}

/**
 * 64x64 düşük çözünürlüklü piksel-dither vinyet maskesi (kenarlara doğru karanlık derinlik).
 */
function bakePixelVignette64(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  theme: RenderTheme,
): void {
  const darkCol = theme === 'crt' ? 'rgba(1, 5, 3, 0.42)' : 'rgba(3, 5, 10, 0.46)';
  const deepCol = theme === 'crt' ? 'rgba(1, 5, 3, 0.72)' : 'rgba(3, 5, 10, 0.76)';
  for (let y = 0; y < 64; y++) {
    const dy = Math.abs((y + 0.5) / 32 - 1);
    for (let x = 0; x < 64; x++) {
      const dx = Math.abs((x + 0.5) / 32 - 1);
      const dist = Math.max(dx, dy * 0.95);
      if (dist > 0.92) {
        ctx.fillStyle = deepCol;
        ctx.fillRect(x, y, 1, 1);
      } else if (dist > 0.76 && ((x + y) & 1) === 0) {
        ctx.fillStyle = darkCol;
        ctx.fillRect(x, y, 1, 1);
      } else if (dist > 0.84) {
        ctx.fillStyle = darkCol;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

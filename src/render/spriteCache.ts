// src/render/spriteCache.ts
// S.U.C.S. — 24x24 Taş + 32x32 Kare Hibriti için OffscreenCanvas Önbellek Motoru
// Tüm sprite'lar doğal 1x çözünürlükte tek sefer pişirilir; ana döngüde sıfır fillRect, yalnızca drawImage.

import type { CardinalDir, PieceType, Side, SpikePhase, TileType } from '../engine/types';
import {
  GUISE_SLOT_COLORS,
  TEAM_ACCENT_BY_THEME,
  TEAM_SHADES_BY_THEME,
} from './pieceSprites24';

export const TILE_PX = 32;
export const PIECE_PX = 24;
export const BADGE_PX = 7;

/** 32x32 kare içinde 24x24 taşın sıfır-mixel hizalama ofsetleri */
export const PIECE_IN_TILE_OFFSET_X = 4; // (32 - 24) / 2
export const PIECE_IN_TILE_OFFSET_Y = 2; // Alt 6px Composure barı ve gölge için ayrılır

export type RenderTheme = 'default' | 'crt';
export type PixelMatrix = readonly string[];
export type PaletteMap = Readonly<Record<string, string>>;

export type CachedSurface = OffscreenCanvas | HTMLCanvasElement;
export type Surface2DContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export interface SurfaceHandle {
  readonly surface: CachedSurface;
  readonly ctx: Surface2DContext;
}

export type SurfaceFactory = (width: number, height: number) => SurfaceHandle;

export interface PieceSpriteSpec {
  readonly matrix: PixelMatrix;
  readonly palette: PaletteMap;
}

export interface PieceCacheQuery {
  readonly type: PieceType;
  readonly side: Side;
  readonly isBoss?: boolean;
  /** Yalnızca CHIMERA (Gulyabani) için çalınan 1. ve 2. kılık tipleri */
  readonly slot1Type?: Exclude<PieceType, 'CHIMERA'>;
  readonly slot2Type?: Exclude<PieceType, 'CHIMERA'>;
}

export interface TileCacheQuery {
  readonly type: TileType;
  /** Dama tahtası paritesi: (x + y) & 1 */
  readonly parity: 0 | 1;
  /** BURNING gibi animasyonlu zeminler için kare indeksi (0..2) */
  readonly frame?: number;
}

export type TrapCacheQuery =
  | { readonly kind: 'PRESSURE_PLATE'; readonly active: boolean }
  | {
      readonly kind: 'ARROW_EMITTER';
      readonly dir: CardinalDir;
      readonly flaming: boolean;
      readonly flipBoard?: boolean;
      readonly depleted?: boolean;
    }
  | { readonly kind: 'SPIKES'; readonly phase: SpikePhase };

export type BadgeKind =
  | 'NAZAR'
  | 'SHIELD'
  | 'AGIZ_BAGLAMA'
  | 'CINNET'
  | 'FROST_TOUCH'
  | 'EXPLOSIVE'
  | 'SCOUT'
  | 'SHADOW_WALKER'
  | 'PUSHER'
  | 'DASH_ON_REVEAL'
  | 'FROZEN';

export interface SpriteAtlasProviders {
  readonly getPieceSpec: (type: PieceType, theme: RenderTheme, isBoss?: boolean) => PieceSpriteSpec;
  readonly drawTile: (ctx: Surface2DContext, query: TileCacheQuery, theme: RenderTheme) => void;
  readonly drawTrap: (ctx: Surface2DContext, query: TrapCacheQuery, theme: RenderTheme) => void;
  readonly drawMiasma: (ctx: Surface2DContext, frame: number, theme: RenderTheme) => void;
  readonly getBadgeSpec: (kind: BadgeKind, theme: RenderTheme) => PieceSpriteSpec;
}

export interface SpriteCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly staticCount: number;
  readonly dynamicCount: number;
  readonly evictions: number;
}

/** Ortamda OffscreenCanvas veya DOM Canvas oluşturulabilirliğini kontrol eder */
export function canCreateCacheSurface(): boolean {
  return typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
}

/** Tarayıcıda OffscreenCanvas, desteklenmiyorsa HTMLCanvasElement üretir */
export function defaultSurfaceFactory(width: number, height: number): SurfaceHandle {
  if (typeof OffscreenCanvas !== 'undefined') {
    const offscreen = new OffscreenCanvas(width, height);
    const ctx = offscreen.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      return { surface: offscreen, ctx };
    }
  }

  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      return { surface: canvas, ctx };
    }
  }

  throw new Error('SpriteCache: 2D Canvas veya OffscreenCanvas ortamı bulunamadı.');
}

/** Matrisi 1:1 doğal piksel olarak yüzeyin ortasına (veya (0,0)'a) pişirir */
export function bakeMatrixToContext(
  ctx: Surface2DContext,
  matrix: PixelMatrix,
  palette: PaletteMap,
  targetWidth: number,
  targetHeight: number,
  resolveDynamic?: (token: string) => string,
): void {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  // Geçici 16x16 matris gelirse bile 1:1 ölçekle ortalar — SIFIR mixel!
  const offsetX = Math.floor((targetWidth - cols) / 2);
  const offsetY = Math.floor((targetHeight - rows) / 2);

  for (let row = 0; row < rows; row++) {
    const line = matrix[row];
    if (!line) continue;
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (!ch || ch === '.' || ch === ' ') continue;
      const raw = palette[ch];
      if (!raw) continue;
      const color = resolveDynamic ? resolveDynamic(raw) : raw;
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(offsetX + col, offsetY + row, 1, 1);
    }
  }
}

export class SpriteCache {
  private readonly providers: SpriteAtlasProviders;
  private readonly createSurface: SurfaceFactory;
  private readonly maxDynamicEntries: number;

  private theme: RenderTheme = 'default';
  /** Sabit zemin, tuzak, rozet ve standart taşlar (tahliye edilmez) */
  private readonly staticMap = new Map<string, CachedSurface>();
  /** Gulyabani kılık kombinasyonları gibi yüksek kardinaliteli yüzeyler (LRU sınırlı) */
  private readonly dynamicMap = new Map<string, CachedSurface>();
  /** Yardımcı 1x katman yüzeyleri (sis, kalkan/donma kafesi, silüet, bar) */
  private readonly auxMap = new Map<string, CachedSurface>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    providers: SpriteAtlasProviders,
    options?: {
      surfaceFactory?: SurfaceFactory;
      maxDynamicEntries?: number;
      theme?: RenderTheme;
    },
  ) {
    this.providers = providers;
    this.createSurface = options?.surfaceFactory ?? defaultSurfaceFactory;
    this.maxDynamicEntries = options?.maxDynamicEntries ?? 128;
    if (options?.theme) {
      this.theme = options.theme;
    }
  }

  public getTheme(): RenderTheme {
    return this.theme;
  }

  /** Perde 4 CRT geçişi gibi tema değişikliklerinde önbelleği temizler */
  public setTheme(nextTheme: RenderTheme): void {
    if (this.theme === nextTheme) return;
    this.theme = nextTheme;
    this.clear();
  }

  public clear(): void {
    this.staticMap.clear();
    this.dynamicMap.clear();
    this.auxMap.clear();
  }

  public getStats(): SpriteCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      staticCount: this.staticMap.size,
      dynamicCount: this.dynamicMap.size,
      evictions: this.evictions,
    };
  }

  /**
   * Açılışta en sık kullanılan 32x32 zeminleri ve 24x24 temel taşları tek seferde pişirir.
   * İlk karedeki olası mikro takılmayı (cold-start stutter) tamamen önler.
   */
  public warmup(): void {
    const baseTiles: readonly TileType[] = ['PLAIN', 'WALL', 'PIT', 'ICE', 'WATCHTOWER', 'CRACKED'];
    const parities: readonly (0 | 1)[] = [0, 1];
    for (const type of baseTiles) {
      for (const parity of parities) {
        this.getTileSprite({ type, parity });
      }
    }
    for (let f = 0; f < 3; f++) {
      this.getTileSprite({ type: 'BURNING', parity: 0, frame: f });
      this.getTileSprite({ type: 'BURNING', parity: 1, frame: f });
    }
    for (let f = 0; f < 4; f++) {
      this.getMiasmaSprite(f);
    }

    const phases: readonly SpikePhase[] = [0, 1, 2];
    for (const phase of phases) {
      this.getTrapSprite({ kind: 'SPIKES', phase });
    }
    this.getTrapSprite({ kind: 'PRESSURE_PLATE', active: true });
    this.getTrapSprite({ kind: 'PRESSURE_PLATE', active: false });
    const emitterDirs: readonly CardinalDir[] = [
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
    ];
    for (const dir of emitterDirs) {
      this.getTrapSprite({ kind: 'ARROW_EMITTER', dir, flaming: false });
    }

    const standardPieces: readonly PieceType[] = [
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
    const sides: readonly Side[] = ['PLAYER', 'ENEMY'];
    for (const type of standardPieces) {
      for (const side of sides) {
        this.getPieceSprite({ type, side });
      }
      this.getPieceWhiteFlashSprite({ type, side: 'PLAYER' });
    }
    this.getPieceSprite({ type: 'KING', side: 'ENEMY', isBoss: true });
    this.getPieceWhiteFlashSprite({ type: 'KING', side: 'ENEMY', isBoss: true });

    const badges: readonly BadgeKind[] = [
      'NAZAR',
      'SHIELD',
      'AGIZ_BAGLAMA',
      'CINNET',
      'FROST_TOUCH',
      'EXPLOSIVE',
      'SCOUT',
      'SHADOW_WALKER',
      'PUSHER',
      'DASH_ON_REVEAL',
      'FROZEN',
    ];
    for (const badge of badges) {
      this.getBadgeSprite(badge);
    }
  }

  /**
   * Belirli bir taşın 24x24 silüet maskesini tek renk tonuyla (flaş, susturma grisi, çöküş) pişirir.
   */
  public getPieceSilhouetteMaskSprite(
    query: Pick<PieceCacheQuery, 'type' | 'side' | 'isBoss'>,
    maskTag: string,
    fillColor: string,
  ): CachedSurface {
    const bossTag = query.isBoss && query.type === 'KING' ? ':boss' : '';
    const key = `pm:${maskTag}:${this.theme}:${query.type}${bossTag}`;
    const cached = this.readStatic(key);
    if (cached) return cached;

    const handle = this.createSurface(PIECE_PX, PIECE_PX);
    const spec = this.providers.getPieceSpec(query.type, this.theme, query.isBoss);
    bakeMatrixToContext(handle.ctx, spec.matrix, spec.palette, PIECE_PX, PIECE_PX, () => fillColor);
    return this.writeStatic(key, handle.surface);
  }

  /**
   * Hit-stop darbe flaşı için her taşın saf beyaz (#FFFFFF) silüet kopyasını
   * tek seferde pişirip önbellekte saklar; çarpışma anında sıfır ekstra piksel döngüsü harcar.
   */
  public getPieceWhiteFlashSprite(query: Pick<PieceCacheQuery, 'type' | 'side' | 'isBoss'>): CachedSurface {
    return this.getPieceSilhouetteMaskSprite(query, 'flash', '#ffffff');
  }

  public getPieceSprite(query: PieceCacheQuery): CachedSurface {
    const bossTag = query.isBoss && query.type === 'KING' ? ':boss' : '';
    const isDynamic =
      query.type === 'CHIMERA' &&
      (query.slot1Type !== undefined || query.slot2Type !== undefined);
    const key = isDynamic
      ? `p:${this.theme}:${query.type}:${query.side}:${query.slot1Type ?? '_'}:${query.slot2Type ?? '_'}`
      : `p:${this.theme}:${query.type}:${query.side}${bossTag}`;

    const cached = isDynamic ? this.readDynamic(key) : this.readStatic(key);
    if (cached) return cached;

    const handle = this.createSurface(PIECE_PX, PIECE_PX);
    const spec = this.providers.getPieceSpec(query.type, this.theme, query.isBoss);
    const teamColor = TEAM_ACCENT_BY_THEME[this.theme][query.side];
    const teamShades = TEAM_SHADES_BY_THEME[this.theme][query.side];

    bakeMatrixToContext(handle.ctx, spec.matrix, spec.palette, PIECE_PX, PIECE_PX, (token) => {
      if (token === 'TEAM') return teamColor;
      if (token === 'TEAM_LIGHT') return teamShades.light;
      if (token === 'TEAM_DARK') return teamShades.dark;
      if (token === 'TEAM_DEEP') return teamShades.deep;
      if (token === 'SLOT1') return GUISE_SLOT_COLORS[query.slot1Type ?? 'EMPTY'];
      if (token === 'SLOT2') return GUISE_SLOT_COLORS[query.slot2Type ?? 'EMPTY'];
      return token;
    });

    return isDynamic ? this.writeDynamic(key, handle.surface) : this.writeStatic(key, handle.surface);
  }

  public getTileSprite(query: TileCacheQuery): CachedSurface {
    const frame = query.type === 'BURNING' ? ((query.frame ?? 0) % 3 + 3) % 3 : 0;
    const key = `t:${this.theme}:${query.type}:${query.parity}:${frame}`;
    const cached = this.readStatic(key);
    if (cached) return cached;

    const handle = this.createSurface(TILE_PX, TILE_PX);
    this.providers.drawTile(handle.ctx, { ...query, frame }, this.theme);
    return this.writeStatic(key, handle.surface);
  }

  public getTrapSprite(query: TrapCacheQuery): CachedSurface {
    let normalized: TrapCacheQuery = query;
    let key: string;

    if (query.kind === 'ARROW_EMITTER') {
      // 2P Misafir ekranında ctx.rotate yerine ters yönlü önbellek anahtarına yönlendir (-0 engellenir)
      const dir: CardinalDir = query.flipBoard
        ? ({
            dx: query.dir.dx === 0 ? 0 : -query.dir.dx,
            dy: query.dir.dy === 0 ? 0 : -query.dir.dy,
          } as CardinalDir)
        : query.dir;
      const depleted = query.depleted ?? false;
      normalized = {
        kind: 'ARROW_EMITTER',
        dir,
        flaming: query.flaming,
        flipBoard: false,
        depleted,
      };
      key = `tr:${this.theme}:arrow:${dir.dx},${dir.dy}:${query.flaming ? 1 : 0}:${depleted ? 1 : 0}`;
    } else if (query.kind === 'PRESSURE_PLATE') {
      key = `tr:${this.theme}:plate:${query.active ? 1 : 0}`;
    } else {
      key = `tr:${this.theme}:spikes:${query.phase}`;
    }

    const cached = this.readStatic(key);
    if (cached) return cached;

    const handle = this.createSurface(TILE_PX, TILE_PX);
    this.providers.drawTrap(handle.ctx, normalized, this.theme);
    return this.writeStatic(key, handle.surface);
  }

  public getMiasmaSprite(frame: number): CachedSurface {
    const normalizedFrame = ((frame % 4) + 4) % 4;
    const key = `g:${this.theme}:miasma:${normalizedFrame}`;
    const cached = this.readStatic(key);
    if (cached) return cached;

    const handle = this.createSurface(TILE_PX, TILE_PX);
    this.providers.drawMiasma(handle.ctx, normalizedFrame, this.theme);
    return this.writeStatic(key, handle.surface);
  }

  public getBadgeSprite(kind: BadgeKind): CachedSurface {
    const key = `b:${this.theme}:${kind}`;
    const cached = this.readStatic(key);
    if (cached) return cached;

    const handle = this.createSurface(BADGE_PX, BADGE_PX);
    const spec = this.providers.getBadgeSpec(kind, this.theme);
    bakeMatrixToContext(handle.ctx, spec.matrix, spec.palette, BADGE_PX, BADGE_PX);
    return this.writeStatic(key, handle.surface);
  }

  /**
   * 32x32 ve 24x24 sistemle uyumlu sabit katman yüzeyleri (sis, kalkan kafesi, buz kafesi, barlar)
   * için genel amaçlı önbellek okuyucu/pişirici.
   */
  public getOrBakeAuxSurface(
    auxKey: string,
    width: number,
    height: number,
    drawFn: (ctx: Surface2DContext) => void,
  ): CachedSurface {
    const key = `aux:${this.theme}:${auxKey}`;
    const found = this.auxMap.get(key);
    if (found) {
      this.hits++;
      return found;
    }
    this.misses++;
    const handle = this.createSurface(width, height);
    drawFn(handle.ctx);
    this.auxMap.set(key, handle.surface);
    return handle.surface;
  }

  private readStatic(key: string): CachedSurface | undefined {
    const found = this.staticMap.get(key);
    if (found) {
      this.hits++;
      return found;
    }
    this.misses++;
    return undefined;
  }

  private writeStatic(key: string, surface: CachedSurface): CachedSurface {
    this.staticMap.set(key, surface);
    return surface;
  }

  private readDynamic(key: string): CachedSurface | undefined {
    const found = this.dynamicMap.get(key);
    if (found) {
      // LRU yenileme: son kullanılanı Map sonuna taşı
      this.dynamicMap.delete(key);
      this.dynamicMap.set(key, found);
      this.hits++;
      return found;
    }
    this.misses++;
    return undefined;
  }

  private writeDynamic(key: string, surface: CachedSurface): CachedSurface {
    if (this.dynamicMap.size >= this.maxDynamicEntries) {
      const oldestKey = this.dynamicMap.keys().next().value;
      if (oldestKey !== undefined) {
        this.dynamicMap.delete(oldestKey);
        this.evictions++;
      }
    }
    this.dynamicMap.set(key, surface);
    return surface;
  }
}

/**
 * canvasRenderer.ts içinde 32x32 kare üzerine 24x24 taşı sıfır-mixel çizen yardımcı.
 * tileScreenSize tercihen 32'nin tam katı (ör. 32, 64, 96 px) olmalıdır.
 */
export function drawCachedPieceInTile(
  ctx: CanvasRenderingContext2D,
  pieceSurface: CachedSurface,
  tileScreenX: number,
  tileScreenY: number,
  tileScreenSize: number,
  offsetTexelsX = 0,
  offsetTexelsY = 0,
): void {
  const unit = tileScreenSize / TILE_PX;
  const dx = Math.round(tileScreenX + (PIECE_IN_TILE_OFFSET_X + offsetTexelsX) * unit);
  const dy = Math.round(tileScreenY + (PIECE_IN_TILE_OFFSET_Y + offsetTexelsY) * unit);
  const size = Math.round(PIECE_PX * unit);
  ctx.drawImage(pieceSurface, dx, dy, size, size);
}

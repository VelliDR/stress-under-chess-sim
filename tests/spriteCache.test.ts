import { describe, expect, it } from 'vitest';
import { createEmptyFog, createEmptyTiles, createTile } from '../src/engine/board';
import type { PieceType, VisibleState } from '../src/engine/types';
import {
  BADGE_PX,
  canCreateCacheSurface,
  CachedSurface,
  defaultSurfaceFactory,
  drawCachedPieceInTile,
  PIECE_IN_TILE_OFFSET_X,
  PIECE_IN_TILE_OFFSET_Y,
  PIECE_PX,
  SpriteAtlasProviders,
  SpriteCache,
  Surface2DContext,
  SurfaceFactory,
  TILE_PX,
} from '../src/render/spriteCache';
import { createDefaultSpriteAtlasProviders } from '../src/render/sprites';
import {
  drawCopperTrapWires,
  drawCracked32,
  drawMiasma32ToSurface,
  drawPressurePlate32,
  drawSpikes32,
} from '../src/render/tileSprites32';

interface RecordedSurface {
  width: number;
  height: number;
  pixels: Map<string, string>;
}

function makeSurfaceRecorder(): {
  factory: SurfaceFactory;
  surfaces: RecordedSurface[];
} {
  const surfaces: RecordedSurface[] = [];
  const factory: SurfaceFactory = (width, height) => {
    const pixels = new Map<string, string>();
    const surface: RecordedSurface = { width, height, pixels };
    surfaces.push(surface);
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      save: () => undefined,
      restore: () => undefined,
      fillRect: (x: number, y: number, w: number, h: number) => {
        for (let py = y; py < y + h; py++) {
          for (let px = x; px < x + w; px++) {
            pixels.set(`${px},${py}`, String(ctx.fillStyle));
          }
        }
      },
      strokeRect: () => undefined,
    };
    return {
      surface: surface as unknown as CachedSurface,
      ctx: ctx as unknown as Surface2DContext,
    };
  };
  return { factory, surfaces };
}

describe('SpriteCache & 32x32 Tile/Trap/Miasma Engine (FAZ UI-1)', () => {
  it('supports OffscreenCanvas primary path, HTMLCanvasElement fallback, and throws cleanly if headless', () => {
    const g = globalThis as unknown as {
      OffscreenCanvas?: unknown;
      document?: unknown;
    };
    const origOffscreen = g.OffscreenCanvas;
    const origDoc = g.document;

    try {
      // 1) Headless (neither OffscreenCanvas nor document)
      delete g.OffscreenCanvas;
      delete g.document;
      expect(canCreateCacheSurface()).toBe(false);
      expect(() => defaultSurfaceFactory(32, 32)).toThrow();

      // 2) HTMLCanvasElement fallback when OffscreenCanvas is absent
      let createdTag = '';
      let assignedW = 0;
      let assignedH = 0;
      const fakeCtx = { imageSmoothingEnabled: true };
      g.document = {
        createElement: (tag: string) => {
          createdTag = tag;
          const el = {
            set width(v: number) {
              assignedW = v;
            },
            get width() {
              return assignedW;
            },
            set height(v: number) {
              assignedH = v;
            },
            get height() {
              return assignedH;
            },
            getContext: (kind: string) => (kind === '2d' ? fakeCtx : null),
          };
          return el;
        },
      };

      expect(canCreateCacheSurface()).toBe(true);
      const htmlHandle = defaultSurfaceFactory(32, 32);
      expect(createdTag).toBe('canvas');
      expect(assignedW).toBe(32);
      expect(assignedH).toBe(32);
      expect((htmlHandle.ctx as { imageSmoothingEnabled: boolean }).imageSmoothingEnabled).toBe(false);

      // 3) OffscreenCanvas primary path when available
      class MockOffscreenCanvas {
        public readonly width: number;
        public readonly height: number;
        public readonly ctx = { imageSmoothingEnabled: true };
        public constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        public getContext(kind: string) {
          return kind === '2d' ? this.ctx : null;
        }
      }
      g.OffscreenCanvas = MockOffscreenCanvas;
      const offHandle = defaultSurfaceFactory(24, 24);
      expect(offHandle.surface).toBeInstanceOf(MockOffscreenCanvas);
      expect((offHandle.ctx as { imageSmoothingEnabled: boolean }).imageSmoothingEnabled).toBe(false);
    } finally {
      if (origOffscreen !== undefined) g.OffscreenCanvas = origOffscreen;
      else delete g.OffscreenCanvas;
      if (origDoc !== undefined) g.document = origDoc;
      else delete g.document;
    }
  });

  it('tracks hits/misses with zero redundant bakes after warmup and enforces 1:1 natural dimensions', () => {
    const { factory, surfaces } = makeSurfaceRecorder();
    const cache = new SpriteCache(createDefaultSpriteAtlasProviders(), { surfaceFactory: factory });

    cache.warmup();
    const warmedStats = cache.getStats();
    const bakedAfterWarmup = surfaces.length;
    expect(bakedAfterWarmup).toBe(warmedStats.staticCount);
    expect(warmedStats.hits).toBe(0);
    expect(warmedStats.misses).toBe(bakedAfterWarmup);
    expect(bakedAfterWarmup).toBeGreaterThanOrEqual(55);

    // Every baked surface is strictly natural 1x (32x32, 24x24, or 7x7)
    for (const s of surfaces) {
      const okDim =
        (s.width === TILE_PX && s.height === TILE_PX) ||
        (s.width === PIECE_PX && s.height === PIECE_PX) ||
        (s.width === BADGE_PX && s.height === BADGE_PX);
      expect(okDim).toBe(true);
    }

    // Re-fetching tiles, 3-phase spikes, plates, 4-dir emitters, 4-frame miasma, pieces, and flashes hits 100% cache
    cache.getTileSprite({ type: 'PLAIN', parity: 0 });
    cache.getTileSprite({ type: 'CRACKED', parity: 1 });
    cache.getTileSprite({ type: 'BURNING', parity: 0, frame: 2 });
    cache.getTrapSprite({ kind: 'SPIKES', phase: 0 });
    cache.getTrapSprite({ kind: 'SPIKES', phase: 1 });
    cache.getTrapSprite({ kind: 'SPIKES', phase: 2 });
    cache.getTrapSprite({ kind: 'PRESSURE_PLATE', active: true });
    cache.getTrapSprite({ kind: 'ARROW_EMITTER', dir: { dx: 0, dy: -1 }, flaming: false });
    cache.getMiasmaSprite(3);
    cache.getPieceSprite({ type: 'SAINT_FAITH', side: 'PLAYER' });
    cache.getPieceSprite({ type: 'SAINT_MADNESS', side: 'ENEMY' });
    cache.getPieceWhiteFlashSprite({ type: 'KING', side: 'ENEMY', isBoss: true });
    cache.getBadgeSprite('NAZAR');

    expect(surfaces.length).toBe(bakedAfterWarmup);
    expect(cache.getStats().hits).toBe(13);
    expect(cache.getStats().misses).toBe(bakedAfterWarmup);
  });

  it('bakes pure #ffffff hit-stop silhouette flashes and centers 16x16 legacy matrices 1:1 in 24x24', () => {
    const { factory, surfaces } = makeSurfaceRecorder();
    const customProviders: SpriteAtlasProviders = {
      ...createDefaultSpriteAtlasProviders(),
      getPieceSpec: (type, theme, isBoss) => {
        if (type === 'PAWN') {
          // Simulate a 16x16 legacy sprite matrix — must center at (4, 4) without stretching!
          const row = '........OOOOOOOO';
          return {
            matrix: Array.from({ length: 16 }, () => row),
            palette: { O: '#070a12' },
          };
        }
        return createDefaultSpriteAtlasProviders().getPieceSpec(type, theme, isBoss);
      },
    };

    const cache = new SpriteCache(customProviders, { surfaceFactory: factory });
    const pawnFlash = cache.getPieceWhiteFlashSprite({ type: 'PAWN', side: 'PLAYER' });
    const recorded = surfaces.find((s) => (s as unknown as CachedSurface) === pawnFlash)!;

    expect(recorded.width).toBe(24);
    expect(recorded.height).toBe(24);
    // 16x16 centered in 24x24 -> y in [4..19], x in [4..19], with first 8 cols '.' and last 8 cols 'O' -> x in [12..19]
    expect(recorded.pixels.get('0,0')).toBeUndefined();
    expect(recorded.pixels.get('11,4')).toBeUndefined();
    expect(recorded.pixels.get('12,4')).toBe('#ffffff');
    expect(recorded.pixels.get('19,19')).toBe('#ffffff');
    expect(recorded.pixels.get('20,19')).toBeUndefined();
    expect(recorded.pixels.size).toBe(16 * 8);
  });

  it('manages CHIMERA 2-slot guises via true LRU eviction (refreshes MRU on cache hit)', () => {
    const { factory } = makeSurfaceRecorder();
    const cache = new SpriteCache(createDefaultSpriteAtlasProviders(), {
      surfaceFactory: factory,
      maxDynamicEntries: 2,
    });

    const a = cache.getPieceSprite({
      type: 'CHIMERA',
      side: 'PLAYER',
      slot1Type: 'KNIGHT',
      slot2Type: 'ROOK',
    });
    const b = cache.getPieceSprite({
      type: 'CHIMERA',
      side: 'PLAYER',
      slot1Type: 'BISHOP',
      slot2Type: 'PAWN',
    });

    // Touch A again so B becomes the least-recently-used entry
    const aAgain = cache.getPieceSprite({
      type: 'CHIMERA',
      side: 'PLAYER',
      slot1Type: 'KNIGHT',
      slot2Type: 'ROOK',
    });
    expect(aAgain).toBe(a);

    // Inserting C must evict B, keeping A alive in cache
    const c = cache.getPieceSprite({
      type: 'CHIMERA',
      side: 'PLAYER',
      slot1Type: 'QUEEN',
      slot2Type: 'SAINT_FAITH',
    });
    expect(c).not.toBe(a);
    expect(cache.getStats().dynamicCount).toBe(2);
    expect(cache.getStats().evictions).toBe(1);

    const hitsBefore = cache.getStats().hits;
    const aStillCached = cache.getPieceSprite({
      type: 'CHIMERA',
      side: 'PLAYER',
      slot1Type: 'KNIGHT',
      slot2Type: 'ROOK',
    });
    expect(aStillCached).toBe(a);
    expect(cache.getStats().hits).toBe(hitsBefore + 1);

    // B was evicted so fetching it again allocates a fresh surface
    const bRebaked = cache.getPieceSprite({
      type: 'CHIMERA',
      side: 'PLAYER',
      slot1Type: 'BISHOP',
      slot2Type: 'PAWN',
    });
    expect(bRebaked).not.toBe(b);
  });

  it('maps 2P flipBoard emitter keys symmetrically across all 4 cardinal directions without -0', () => {
    const { factory } = makeSurfaceRecorder();
    const cache = new SpriteCache(createDefaultSpriteAtlasProviders(), { surfaceFactory: factory });

    const pairs: Array<[{ dx: number; dy: number }, { dx: number; dy: number }]> = [
      [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }],
      [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }],
      [{ dx: 0, dy: 1 }, { dx: 0, dy: -1 }],
      [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }],
    ];

    for (const [normalDir, oppositeDir] of pairs) {
      const normal = cache.getTrapSprite({
        kind: 'ARROW_EMITTER',
        dir: normalDir as { dx: 1; dy: 0 },
        flaming: true,
        flipBoard: false,
      });
      const flipped = cache.getTrapSprite({
        kind: 'ARROW_EMITTER',
        dir: oppositeDir as { dx: 1; dy: 0 },
        flaming: true,
        flipBoard: true,
      });
      expect(flipped).toBe(normal);
    }
  });

  it('clears static, dynamic, and aux pools on theme change to crt and bakes CRT palette colors', () => {
    const { factory, surfaces } = makeSurfaceRecorder();
    const cache = new SpriteCache(createDefaultSpriteAtlasProviders(), { surfaceFactory: factory });
    cache.warmup();
    cache.getPieceSprite({ type: 'CHIMERA', side: 'ENEMY', slot1Type: 'ROOK' as Exclude<PieceType, 'CHIMERA'> });
    cache.getOrBakeAuxSurface('test_aux', 32, 32, (sCtx) => {
      sCtx.fillStyle = '#123456';
      sCtx.fillRect(0, 0, 1, 1);
    });
    expect(cache.getStats().staticCount).toBeGreaterThan(0);
    expect(cache.getStats().dynamicCount).toBe(1);

    // Same theme -> no-op
    cache.setTheme('default');
    expect(cache.getStats().staticCount).toBeGreaterThan(0);

    // Switch to Act 4 CRT theme -> wipes all pools
    cache.setTheme('crt');
    expect(cache.getTheme()).toBe('crt');
    expect(cache.getStats().staticCount).toBe(0);
    expect(cache.getStats().dynamicCount).toBe(0);

    const crtRook = cache.getPieceSprite({ type: 'ROOK', side: 'PLAYER' });
    const rec = surfaces.find((s) => (s as unknown as CachedSurface) === crtRook)!;
    const colors = new Set(rec.pixels.values());
    expect(colors.has('#4ade80')).toBe(true);
  });

  it('draws 32x32 CRACKED dust crumbs, 4-frame Miasma, 3-phase Spikes, plates, and copper wires cleanly', () => {
    const crackedRec = makeSurfaceRecorder();
    const { ctx: cCtx } = crackedRec.factory(32, 32);
    drawCracked32(cCtx, 0, 0, 32, true, 13, 'default');
    const cColors = new Set(crackedRec.surfaces[0]!.pixels.values());
    expect(cColors.has('#05070c')).toBe(true);
    expect(cColors.has('#94a3b8')).toBe(true); // dust crumbs

    // 4-frame Miasma differs across frames and uses 42% translucent fill
    const miasmaFrames = [0, 1, 2, 3].map((f) => {
      const rec = makeSurfaceRecorder();
      const { ctx } = rec.factory(32, 32);
      drawMiasma32ToSurface(ctx, 0, 0, 32, f, 'default');
      return rec.surfaces[0]!.pixels;
    });
    expect(miasmaFrames[0]!.get('0,0')).toBe('rgba(74, 222, 128, 0.56)');
    expect(miasmaFrames[0]!.get('0,15')).toBe('rgba(74, 222, 128, 0.42)');
    expect(miasmaFrames[0]).not.toEqual(miasmaFrames[1]);
    expect(miasmaFrames[1]).not.toEqual(miasmaFrames[2]);

    // 3-phase Spikes
    const spikeColors = ([0, 1, 2] as const).map((phase) => {
      const rec = makeSurfaceRecorder();
      const { ctx } = rec.factory(32, 32);
      drawSpikes32(ctx, 0, 0, 32, phase, true);
      return new Set(rec.surfaces[0]!.pixels.values());
    });
    expect(spikeColors[0]!.has('#090d16')).toBe(true);
    expect(spikeColors[1]!.has('#facc15')).toBe(true);
    expect(spikeColors[2]!.has('#e2e8f0')).toBe(true);

    // Pressure plate active vs cooldown visual state
    const plateReady = makeSurfaceRecorder();
    drawPressurePlate32(plateReady.factory(32, 32).ctx, 0, 0, 32, true, 'default');
    const plateCool = makeSurfaceRecorder();
    drawPressurePlate32(plateCool.factory(32, 32).ctx, 0, 0, 32, false, 'default');
    expect(plateReady.surfaces[0]!.pixels).not.toEqual(plateCool.surfaces[0]!.pixels);

    // Copper trap wires highlight focused plates/emitters in #fbbf24 without fillRect
    const tiles = createEmptyTiles(4, 4, 'PLAIN');
    tiles[2]![1] = {
      ...createTile('PLAIN'),
      trap: { kind: 'PRESSURE_PLATE', id: 'pl_1', targetIds: ['em_1'], cooldown: 0, maxCooldown: 1 },
    };
    tiles[0]![3] = {
      ...createTile('WALL'),
      trap: {
        kind: 'ARROW_EMITTER',
        id: 'em_1',
        dir: { dx: 0, dy: 1 },
        ammo: null,
        flaming: false,
        piercing: false,
      },
    };
    const state: VisibleState = {
      viewer: 'PLAYER',
      width: 4,
      height: 4,
      tiles,
      fog: createEmptyFog(4, 4, 'VISIBLE'),
      pieces: [],
      silhouettes: [],
      pendingSpawns: [],
      turn: 'PLAYER',
      turnNumber: 1,
      mode: 'SANDBOX',
      factions: { PLAYER: 'NONE', ENEMY: 'NONE' },
      bonusMovePieceId: null,
      winner: null,
    };

    const strokeStyles: string[] = [];
    let fillRectCount = 0;
    const wireCtx = {
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      save: () => undefined,
      restore: () => undefined,
      setLineDash: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      rect: () => undefined,
      fill: () => undefined,
      fillRect: () => {
        fillRectCount++;
      },
      stroke: () => {
        strokeStyles.push(wireCtx.strokeStyle);
      },
    };

    drawCopperTrapWires(wireCtx as unknown as CanvasRenderingContext2D, state, 0, 0, 64, {
      selectedCoord: null,
      inspectedCoord: null,
      hoveredCoord: { x: 1, y: 2 },
      flipBoard: false,
    });
    expect(strokeStyles).toContain('#fbbf24');
    expect(fillRectCount).toBe(0);

    // Verify drawCachedPieceInTile keeps 1:1 (4, 2) offset contract
    expect(PIECE_IN_TILE_OFFSET_X).toBe(4);
    expect(PIECE_IN_TILE_OFFSET_Y).toBe(2);
    const blits: Array<{ dx: number; dy: number; dw: number; dh: number }> = [];
    const blitCtx = {
      drawImage: (_img: unknown, dx: number, dy: number, dw: number, dh: number) => {
        blits.push({ dx, dy, dw, dh });
      },
    } as unknown as CanvasRenderingContext2D;
    drawCachedPieceInTile(blitCtx, {} as CachedSurface, 0, 0, 32);
    expect(blits[0]).toEqual({ dx: 4, dy: 2, dw: 24, dh: 24 });
  });
});

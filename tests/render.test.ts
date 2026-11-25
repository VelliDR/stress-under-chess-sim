import { describe, expect, it } from 'vitest';
import {
  generateDeterministicNoiseSamples,
  SfxKind,
  SynthSfx,
} from '../src/audio/synthSfx';
import {
  buildNarrativePieceMap,
  DEFEAT_BANNERS,
  getDefeatBanner,
  getLivePatchQuote,
  getRoomIntroQuote,
  getVictoryQuote,
  pickTerminalEntry,
} from '../src/data/narrative';
import { getLegalMoves, validateMapConnectivity } from '../src/engine/board';
import { computeStateHash } from '../src/engine/prng';
import { stepGame } from '../src/engine/reducer';
import { getLegalAbilities } from '../src/engine/traits';
import { GameEvent, Piece } from '../src/engine/types';
import {
  computeHallucinations,
  getOmniscientVisibleState,
  getVisibleState,
  getVisibleStateForPerspective,
} from '../src/engine/visibility';
import {
  CanvasRenderer,
  computeBoardLayout,
  localPointToTile,
} from '../src/render/canvasRenderer';
import { FxQueue } from '../src/render/fxQueue';
import {
  BADGE_SPRITES_7,
  FLAME_FRAMES_32,
  FLAME_PIXEL_FRAMES,
  getPieceSpec24,
  MICRO_PIXEL_ICONS,
  PIECE_PIXEL_SPRITES,
  PIECE_SPRITES_24,
  PLAYER_PALETTE,
} from '../src/render/pixelArt';
import {
  BADGE_PX,
  CachedSurface,
  drawCachedPieceInTile,
  PIECE_IN_TILE_OFFSET_X,
  PIECE_IN_TILE_OFFSET_Y,
  PIECE_PX,
  SpriteCache,
  Surface2DContext,
  SurfaceFactory,
  TILE_PX,
} from '../src/render/spriteCache';
import { createDefaultSpriteAtlasProviders } from '../src/render/sprites';
import { getSandboxPreset, SANDBOX_PRESETS } from '../src/ui/sandboxPresets';

function makeMockCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  transformCalls: number[][];
  textCalls: string[];
} {
  const transformCalls: number[][] = [];
  const textCalls: string[] = [];
  const gradientStub = {
    addColorStop: () => undefined,
  };

  const mock: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    lineDashOffset: 0,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: () => undefined,
    restore: () => undefined,
    setTransform: (...args: number[]) => {
      transformCalls.push(args);
    },
    translate: () => undefined,
    rotate: () => undefined,
    scale: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    quadraticCurveTo: () => undefined,
    bezierCurveTo: () => undefined,
    arc: () => undefined,
    ellipse: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    setLineDash: () => undefined,
    fillText: (text: string) => {
      textCalls.push(text);
    },
    strokeText: () => undefined,
    createLinearGradient: () => gradientStub,
    createRadialGradient: () => gradientStub,
  };

  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    transformCalls,
    textCalls,
  };
}

function makeMockCanvasElement(): HTMLCanvasElement {
  const listeners: Record<string, Set<EventListener>> = {};
  const mock = {
    width: 0,
    height: 0,
    style: { touchAction: '' },
    addEventListener: (type: string, fn: EventListener) => {
      if (listeners[type] === undefined) listeners[type] = new Set();
      listeners[type]!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners[type]?.delete(fn);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 }),
  };
  return mock as unknown as HTMLCanvasElement;
}

describe('FxQueue — Sequential Event Animations & Determinism', () => {
  const samplePiece: Piece = {
    id: 'p_rook',
    side: 'PLAYER',
    type: 'ROOK',
    pos: { x: 2, y: 5 },
    traits: ['SHIELDED'],
    shieldActive: true,
    frozenTurns: 0,
    hasMoved: true,
    aggro: 'ACTIVE',
    usedDashThisTurn: false,
    wasVisibleAtTurnStart: true,
  };

  it('plays MOVE -> SLIDE -> SHIELD_BROKEN sequentially with ordered SFX, shake, particles, and floating text', () => {
    const playedSfx: SfxKind[] = [];
    const fx = new FxQueue((k) => playedSfx.push(k), 'det-seed-1');

    const events: GameEvent[] = [
      { type: 'PIECE_MOVED', pieceId: 'p_rook', from: { x: 2, y: 5 }, to: { x: 2, y: 4 } },
      {
        type: 'PIECE_SLID',
        pieceId: 'p_rook',
        path: [
          { x: 2, y: 4 },
          { x: 2, y: 3 },
          { x: 2, y: 2 },
        ],
        to: { x: 2, y: 2 },
      },
      { type: 'SHIELD_BROKEN', pieceId: 'e_guard', pos: { x: 2, y: 1 }, source: 'ATTACK' },
    ];

    fx.enqueue(events, [samplePiece]);
    expect(fx.hasActiveSteps()).toBe(true);

    // Mid-way through MOVE (duration 145ms)
    fx.update(72);
    expect(playedSfx).toEqual(['move']);
    const snap1 = fx.getSnapshot();
    const override1 = snap1.pieceOverrides['p_rook'];
    expect(override1).toBeDefined();
    expect(override1!.y).toBeLessThan(5);
    expect(override1!.y).toBeGreaterThan(4);

    // Advance into SLIDE (duration 195ms for 3 waypoints)
    fx.update(100);
    expect(playedSfx).toEqual(['move', 'slide']);

    // Advance through SLIDE into SHIELD_BROKEN
    fx.update(200);
    expect(playedSfx).toEqual(['move', 'slide', 'shieldBreak']);
    const snap3 = fx.getSnapshot();
    expect(snap3.floatingTexts.some((t) => t.text === 'KALKAN KIRILDI!')).toBe(true);
    expect(snap3.particles.length).toBeGreaterThan(10);
    expect(Math.abs(snap3.shakeOffset.x) + Math.abs(snap3.shakeOffset.y)).toBeGreaterThan(0);

    // Drain remaining animations cleanly
    for (let i = 0; i < 20; i++) {
      fx.update(80);
    }
    expect(fx.isAnimating()).toBe(false);
  });

  it('tracks ghost shrinking piece on PIECE_FELL_IN_PIT and removes ghost after death step', () => {
    const fx = new FxQueue(null, 'pit-seed');
    const events: GameEvent[] = [
      {
        type: 'PIECE_FELL_IN_PIT',
        pieceId: 'p_rook',
        pos: { x: 7, y: 2 },
        pieceType: 'ROOK',
        side: 'PLAYER',
      },
    ];

    fx.enqueue(events, [samplePiece]);
    fx.update(130); // halfway through 260ms fall
    const midSnap = fx.getSnapshot();
    expect(midSnap.ghostPieces).toHaveLength(1);
    expect(midSnap.ghostPieces[0]!.scale).toBeLessThan(0.8);
    expect(midSnap.ghostPieces[0]!.rotation).toBeGreaterThan(0);
    expect(midSnap.floatingTexts.some((t) => t.text === 'ÇUKURA DÜŞTÜ!')).toBe(true);

    fx.update(200);
    expect(fx.getSnapshot().ghostPieces).toHaveLength(0);
  });

  it('completes animations twice as fast at 2x speed and resets cleanly on skipAll', () => {
    const fx1 = new FxQueue(null, 'spd');
    const fx2 = new FxQueue(null, 'spd');
    fx2.setSpeed(2);

    const events: GameEvent[] = [
      { type: 'WALL_DESTROYED', pos: { x: 2, y: 5 }, byPieceId: 'p_rook' },
    ];
    fx1.enqueue(events, [samplePiece]);
    fx2.enqueue(events, [samplePiece]);

    fx1.update(120);
    fx2.update(120);

    // WALL_DESTROY is 220ms: at 1x still active (120 < 220), at 2x finished (240 >= 220)
    expect(fx1.hasActiveSteps()).toBe(true);
    expect(fx2.hasActiveSteps()).toBe(false);

    fx1.skipAll();
    expect(fx1.isAnimating()).toBe(false);
  });

  it('suppresses FX for events occurring strictly inside UNEXPLORED fog (no information leak)', () => {
    const state = getSandboxPreset('fog-ambush').build();
    const playerView = getVisibleState(state, 'PLAYER');
    // (7, 0) is unexplored for PLAYER in fog-ambush
    expect(playerView.fog[0]![7]).toBe('UNEXPLORED');

    const played: SfxKind[] = [];
    const fx = new FxQueue((k) => played.push(k), 'fog-filter');
    fx.enqueue(
      [
        { type: 'TILE_IGNITED', pos: { x: 7, y: 0 }, burnTurns: 2 },
        { type: 'TURN_CHANGED', nextTurn: 'ENEMY', turnNumber: 2 },
      ],
      playerView.pieces,
      playerView,
      playerView,
    );

    fx.update(100);
    expect(played).toEqual(['turnChange']);
  });

  it('produces identical particle and shake snapshots for identical seeds (zero Math.random)', () => {
    const a = new FxQueue(null, 'same-seed');
    const b = new FxQueue(null, 'same-seed');
    const ev: GameEvent[] = [
      { type: 'SHIELD_BROKEN', pieceId: 'p_rook', pos: { x: 3, y: 3 }, source: 'ATTACK' },
    ];
    a.enqueue(ev, [samplePiece]);
    b.enqueue(ev, [samplePiece]);
    a.update(50);
    b.update(50);

    expect(a.getSnapshot()).toEqual(b.getSnapshot());
  });
});

describe('CanvasRenderer — HiDPI Layout, Coordinate Mapping & Full Layered Render', () => {
  it('computes accurate tile layout and maps pointer coordinates cleanly across aspect ratios', () => {
    const layout = computeBoardLayout(640, 560, 9, 8, 2);
    expect(layout.dpr).toBe(2);
    expect(layout.tileSize).toBeGreaterThanOrEqual(48);

    // Top-left tile (0, 0)
    expect(localPointToTile(layout, layout.offsetX + 1, layout.offsetY + 1, 9, 8)).toEqual({
      x: 0,
      y: 0,
    });

    // Bottom-right tile (8, 7)
    expect(
      localPointToTile(
        layout,
        layout.offsetX + 8.5 * layout.tileSize,
        layout.offsetY + 7.5 * layout.tileSize,
        9,
        8,
      ),
    ).toEqual({ x: 8, y: 7 });

    // Outside margins -> null
    expect(localPointToTile(layout, layout.offsetX - 5, layout.offsetY + 10, 9, 8)).toBeNull();
    expect(
      localPointToTile(
        layout,
        layout.offsetX + 9 * layout.tileSize + 2,
        layout.offsetY + 10,
        9,
        8,
      ),
    ).toBeNull();
  });

  it('renders a complete VisibleState with HiDPI scaling, fog, silhouettes, slide/hazard previews, and FX without error', () => {
    const canvas = makeMockCanvasElement();
    const { ctx, transformCalls, textCalls } = makeMockCanvasContext();
    const renderer = new CanvasRenderer(canvas, ctx);
    renderer.resize(640, 580, 2);

    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(1160);

    const state = getSandboxPreset('tactical-lab').build();
    const visible = getVisibleStateForPerspective(state, 'PLAYER');

    // Select Queen at (7, 6) which has a lethal ICE -> PIT move preview at (7, 5)
    const queen = visible.pieces.find((p) => p.id === 'p_queen')!;
    const queenMoves = getLegalMoves(visible, queen);
    expect(queenMoves.some((m) => m.isHazardous && m.resolution.fellInPit)).toBe(true);

    // Also include abilities from p_pusher at (5, 4)
    const pusher = visible.pieces.find((p) => p.id === 'p_pusher')!;
    const pushAbilities = getLegalAbilities(visible, pusher);

    const fx = new FxQueue(null, 'render-test');
    fx.enqueue(
      [{ type: 'SHIELD_BROKEN', pieceId: 'e_guard', pos: { x: 4, y: 2 }, source: 'ATTACK' }],
      visible.pieces,
    );
    fx.update(40);

    renderer.render(visible, {
      selectedCoord: queen.pos,
      inspectedCoord: { x: 4, y: 5 },
      hoveredCoord: { x: 7, y: 5 },
      legalMoves: queenMoves,
      legalAbilities: pushAbilities,
      activeAbility: null,
      intentArrows: [{ from: { x: 4, y: 2 }, to: { x: 4, y: 3 }, pieceId: 'e_guard', isAttack: true }],
      showIntentArrows: true,
      fx: fx.getSnapshot(),
      timeMs: 1200,
    });

    // Verified HiDPI transform applied
    expect(transformCalls[0]).toEqual([2, 0, 0, 2, 0, 0]);
    // Verified coordinate labels & floating text drawn
    expect(textCalls).toContain('A');
    expect(textCalls).toContain('KALKAN KIRILDI!');
  });
});

describe('SynthSfx — Headless Safety & Deterministic Noise', () => {
  it('gracefully no-ops in headless Node, clamps volume, and synthesizes deterministic noise', () => {
    const sfx = new SynthSfx(1.5, false);
    expect(sfx.getVolume()).toBe(1);
    sfx.setVolume(-0.4);
    expect(sfx.getVolume()).toBe(0);
    sfx.setVolume(0.7);
    sfx.setMuted(true);
    expect(sfx.isMuted()).toBe(true);

    const allKinds: SfxKind[] = [
      'move',
      'slide',
      'capture',
      'shieldBreak',
      'pitFall',
      'burn',
      'ignite',
      'extinguish',
      'freeze',
      'push',
      'wallDestroy',
      'alert',
      'spawn',
      'promote',
      'turnChange',
      'victory',
      'defeat',
      'uiSelect',
      'uiInvalid',
    ];
    sfx.setMuted(false);
    for (const kind of allKinds) {
      expect(() => sfx.play(kind)).not.toThrow();
    }

    const n1 = generateDeterministicNoiseSamples(64, 'sfx-test');
    const n2 = generateDeterministicNoiseSamples(64, 'sfx-test');
    expect(Array.from(n1)).toEqual(Array.from(n2));
    expect(n1.every((v) => v >= -1 && v <= 1)).toBe(true);
  });
});

describe('Sandbox Presets, Omniscient View & Undo Round-Trip', () => {
  it('guarantees BFS connectivity on every Sandbox preset', () => {
    for (const preset of SANDBOX_PRESETS) {
      const state = preset.build();
      const playerKing = state.pieces.find((p) => p.side === 'PLAYER' && p.type === 'KING');
      const enemyKing = state.pieces.find((p) => p.side === 'ENEMY' && p.type === 'KING');
      expect(playerKing).toBeDefined();
      expect(enemyKing).toBeDefined();

      const check = validateMapConnectivity(state.tiles, [playerKing!.pos], enemyKing!.pos);
      expect(check.connected).toBe(true);
    }
  });

  it('supports Turn 1 PUSHER -> ICE -> PIT combo, SIEGE BREAK_WALL, Omniscient view, and exact JSON Undo', () => {
    const state0 = getSandboxPreset('tactical-lab').build();
    const hash0 = computeStateHash(state0);
    const snapshot0 = JSON.parse(JSON.stringify(state0));

    // Omniscient view exposes every piece and marks every square VISIBLE
    const omni = getOmniscientVisibleState(state0);
    expect(omni.viewer).toBe('OMNISCIENT');
    expect(omni.pieces.length).toBe(state0.pieces.length);
    expect(omni.fog.every((row) => row.every((v) => v === 'VISIBLE'))).toBe(true);

    // 1) Push e_bait at (6, 4) east onto ICE (7, 4) -> PIT (8, 4)!
    const pushStep = stepGame(state0, {
      type: 'USE_ABILITY',
      pieceId: 'p_pusher',
      ability: 'PUSH',
      target: { x: 6, y: 4 },
    });
    expect(pushStep.error).toBeUndefined();
    expect(pushStep.events.some((e) => e.type === 'PIECE_PUSHED')).toBe(true);
    expect(pushStep.events.some((e) => e.type === 'PIECE_SLID')).toBe(true);
    expect(pushStep.events.some((e) => e.type === 'PIECE_FELL_IN_PIT' && e.pieceId === 'e_bait')).toBe(
      true,
    );
    expect(pushStep.nextState.pieces.find((p) => p.id === 'e_bait')).toBeUndefined();

    // 2) Undo restores exact hash
    expect(computeStateHash(snapshot0)).toBe(hash0);

    // 3) SIEGE_ENGINEERS Rook at (2, 6) breaks WALL at (2, 5)
    const siegeStep = stepGame(state0, {
      type: 'USE_ABILITY',
      pieceId: 'p_rook',
      ability: 'BREAK_WALL',
      target: { x: 2, y: 5 },
    });
    expect(siegeStep.error).toBeUndefined();
    expect(siegeStep.nextState.tiles[5]![2]!.type).toBe('PLAIN');
    expect(siegeStep.events.some((e) => e.type === 'WALL_DESTROYED')).toBe(true);
  });
});

describe('Pixel-Art Sprite Atlas & Tactical Overlays', () => {
  it('validates strict 16x16 piece sprites, 8x8 micro-icons, 16x16 flame frames, and renders threat + last-move overlays', () => {
    const validPieceKeys = new Set(['.', ' ', ...Object.keys(PLAYER_PALETTE)]);
    for (const [name, grid] of Object.entries(PIECE_PIXEL_SPRITES)) {
      expect(grid.length, `${name} height`).toBe(16);
      for (const row of grid) {
        expect(row.length, `${name} row width`).toBe(16);
        for (const ch of row) {
          expect(validPieceKeys.has(ch), `${name} key '${ch}'`).toBe(true);
        }
      }
    }

    for (const [name, grid] of Object.entries(MICRO_PIXEL_ICONS)) {
      expect(grid.length, `${name} icon height`).toBe(8);
      for (const row of grid) {
        expect(row.length, `${name} icon width`).toBe(8);
      }
    }

    expect(FLAME_PIXEL_FRAMES).toHaveLength(3);
    for (const frame of FLAME_PIXEL_FRAMES) {
      expect(frame).toHaveLength(16);
      for (const row of frame) {
        expect(row).toHaveLength(16);
      }
    }

    const state = getSandboxPreset('tactical-lab').build();
    const visible = getVisibleState(state, 'PLAYER');
    const canvas = makeMockCanvasElement();
    const { ctx } = makeMockCanvasContext();
    const renderer = new CanvasRenderer(canvas, ctx);
    renderer.resize(640, 580, 2);

    expect(() =>
      renderer.render(visible, {
        selectedCoord: { x: 4, y: 7 },
        inspectedCoord: { x: 4, y: 3 },
        hoveredCoord: { x: 4, y: 5 },
        legalMoves: [],
        legalAbilities: [],
        activeAbility: null,
        lastVisibleMove: { from: { x: 4, y: 7 }, to: { x: 4, y: 6 } },
        threatCoords: [
          { x: 4, y: 4 },
          { x: 5, y: 4 },
        ],
        showThreatOverlay: true,
        timeMs: 650,
      }),
    ).not.toThrow();

    expect((ctx as unknown as { imageSmoothingEnabled: boolean }).imageSmoothingEnabled).toBe(false);
    renderer.destroy();
  });

  it('generates deterministic PANIC hallucinations strictly in VisibleState, renders all 3 V3 Chaos Lab presets with flipBoard & FX/SFX, and drives dual-tone narrative.ts', () => {
    // 1) PANIC Hallucination Fog determinism & isolation
    const labGas = getSandboxPreset('gas-arrow-lab').build();
    expect(computeHallucinations(labGas, 'PLAYER', 50)).toEqual([]);
    const h1 = computeHallucinations(labGas, 'PLAYER', 82);
    const h2 = computeHallucinations(labGas, 'PLAYER', 82);
    expect(h1).toEqual(h2);
    expect(h1.length).toBeGreaterThanOrEqual(2);
    expect(h1.length).toBeLessThanOrEqual(3);
    for (const c of h1) {
      expect(labGas.fog.PLAYER[c.y]![c.x]).not.toBe('VISIBLE');
      expect(labGas.tiles[c.y]![c.x]!.type).not.toBe('WALL');
      expect(labGas.tiles[c.y]![c.x]!.type).not.toBe('PIT');
    }
    const visWithPanic = getVisibleState(labGas, 'PLAYER', { stressScore: 85 });
    expect(visWithPanic.hallucinationSilhouettes).toEqual(h1);
    // AI / default getVisibleState gets zero hallucinations
    expect(getVisibleState(labGas, 'ENEMY').hallucinationSilhouettes).toEqual([]);

    // 2) Render all 3 V3 Chaos Lab scenes in both normal and flipBoard=true + V3 FX & SFX
    const v3Presets = ['gas-arrow-lab', 'saint-silence-lab', 'chimera-drift-lab'] as const;
    const canvas = makeMockCanvasElement();
    const { ctx } = makeMockCanvasContext();
    const renderer = new CanvasRenderer(canvas, ctx);
    renderer.resize(700, 620, 2);

    const playedSfx: SfxKind[] = [];
    const fx = new FxQueue((k) => playedSfx.push(k));
    const sfx = new SynthSfx();

    for (const id of v3Presets) {
      const state = getSandboxPreset(id).build();
      const vis = getVisibleState(state, 'PLAYER', { stressScore: 80 });
      const driftPiece = vis.pieces.find((p) => p.composure === 1 && p.type === 'ROOK');
      const moves = driftPiece ? getLegalMoves(vis, driftPiece) : [];

      for (const flip of [false, true]) {
        expect(() =>
          renderer.render(vis, {
            selectedCoord: driftPiece ? driftPiece.pos : { x: 3, y: 5 },
            inspectedCoord: { x: 3, y: 5 },
            hoveredCoord: moves[0]?.to ?? { x: 0, y: 3 },
            legalMoves: moves,
            legalAbilities: [],
            activeAbility: null,
            flipBoard: flip,
            fx: fx.getSnapshot(),
            timeMs: 480,
          }),
        ).not.toThrow();
      }
    }

    // Trigger V3 FX queue batch (gas blast, arrow, 7x7 faith shockwave, chimera, hallucination dispel)
    const saintState = getSandboxPreset('saint-silence-lab').build();
    const prevV = getOmniscientVisibleState(saintState);
    const v3Events: GameEvent[] = [
      { type: 'PLATE_TRIGGERED', plateId: 'pl_1', at: { x: 3, y: 5 }, triggeredByPieceId: 'p_king' },
      { type: 'ARROW_FIRED', emitterId: 'em_1', from: { x: 0, y: 3 }, path: [{ x: 1, y: 3 }, { x: 2, y: 3 }], flaming: true },
      { type: 'GAS_CHAIN_DETONATED', origin: { x: 2, y: 3 }, tiles: [{ x: 2, y: 3 }, { x: 3, y: 3 }] },
      { type: 'TILE_COLLAPSED', at: { x: 5, y: 2 }, reason: 'BLAST' },
      { type: 'SPIKES_PHASE_CHANGED', changes: [{ at: { x: 6, y: 4 }, phase: 2 }] },
      {
        type: 'FAITH_ULTIMATE_TRIGGERED',
        saintId: 'p_ocakli',
        shieldedTargetId: 'p_devoted',
        pulseOrigin: { x: 2, y: 4 },
        pulseRadius: 3,
        cleansedAllyIds: ['p_debuffed'],
        silencedEnemyIds: ['e_shield_bomb'],
      },
      { type: 'MADNESS_ULTIMATE_TRIGGERED', saintId: 'p_meczup', targetId: 'p_berserker', at: { x: 4, y: 5 } },
      { type: 'CHIMERA_EVOLVED', chimeraId: 'e_gulyabani', absorbedType: 'KNIGHT' },
      { type: 'HALLUCINATION_DISPELLED', at: { x: 0, y: 0 } },
    ];
    fx.enqueue(v3Events, prevV.pieces, prevV, prevV);
    fx.update(100);
    expect(() => renderer.render(prevV, {
      selectedCoord: null,
      inspectedCoord: null,
      hoveredCoord: null,
      legalMoves: [],
      legalAbilities: [],
      activeAbility: null,
      fx: fx.getSnapshot(),
      timeMs: 600,
    })).not.toThrow();
    fx.update(4000);
    expect(playedSfx).toContain('gasBlast');
    expect(playedSfx).toContain('faithUltimate');
    expect(playedSfx).toContain('madnessUltimate');
    expect(playedSfx).toContain('chimeraEvolve');
    expect(playedSfx).toContain('hallucinationDispel');
    for (const k of playedSfx) {
      expect(() => sfx.play(k)).not.toThrow();
    }
    renderer.destroy();

    // 3) Dual-tone narrative.ts (v2_yama.md) priority anti-spam & engine/folklore bridging
    const piecesById = buildNarrativePieceMap(saintState.pieces);
    const entryPolite = pickTerminalEntry(v3Events, {
      seed: 42,
      turnNumber: 4,
      tone: 'polite',
      piecesById,
    });
    const entryUnfiltered = pickTerminalEntry(v3Events, {
      seed: 42,
      turnNumber: 4,
      tone: 'unfiltered',
      piecesById,
    });
    expect(entryPolite?.severity).toBe('ultimate');
    expect(entryPolite?.speaker).toContain('OCAKLI');
    expect(entryUnfiltered?.text).not.toBe(entryPolite?.text);
    expect(getRoomIntroQuote('act3-2', 'polite', 7)).toContain('Ocaklı');
    expect(getLivePatchQuote('PATCH_204_MIASMA', 'polite', 3)).toContain('PATCH_204');
    expect(DEFEAT_BANNERS.SPEEDRUN.polite).toContain(getDefeatBanner('KING_CAPTURED', 'polite', 1, 2));
    expect(getVictoryQuote(true, 'polite', 1)).toContain('KERNEL_KING');
  });
});

describe('24x24 Piece + 32x32 Tile Hybrid & SpriteCache Offscreen Engine', () => {
  interface MockSurface {
    width: number;
    height: number;
    pixels: Map<string, string>;
  }

  function makeMockSurfaceFactory(): {
    factory: SurfaceFactory;
    surfaces: MockSurface[];
  } {
    const surfaces: MockSurface[] = [];
    const factory: SurfaceFactory = (width, height) => {
      const pixels = new Map<string, string>();
      const surface: MockSurface = { width, height, pixels };
      surfaces.push(surface);
      const ctx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        imageSmoothingEnabled: false,
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

  it('validates strict 24x24 piece matrices, 7x7 badges, and 32x32 flame frames with complete palette coverage', () => {
    expect(TILE_PX).toBe(32);
    expect(PIECE_PX).toBe(24);
    expect(BADGE_PX).toBe(7);
    expect(PIECE_IN_TILE_OFFSET_X).toBe(4);
    expect(PIECE_IN_TILE_OFFSET_Y).toBe(2);

    const pieceEntries = Object.entries(PIECE_SPRITES_24);
    expect(pieceEntries).toHaveLength(10);
    for (const [name, grid] of pieceEntries) {
      expect(grid.length, `${name} height`).toBe(24);
      const spec = getPieceSpec24(name === 'BOSS_KING' ? 'KING' : (name as Piece['type']), 'default', name === 'BOSS_KING');
      for (const row of grid) {
        expect(row.length, `${name} width`).toBe(24);
        for (const ch of row) {
          if (ch !== '.' && ch !== ' ') {
            expect(spec.palette[ch], `${name} missing token '${ch}'`).toBeDefined();
          }
        }
      }
    }

    const badgeEntries = Object.entries(BADGE_SPRITES_7);
    expect(badgeEntries).toHaveLength(11);
    for (const [name, spec] of badgeEntries) {
      expect(spec.matrix.length, `${name} height`).toBe(7);
      for (const row of spec.matrix) {
        expect(row.length, `${name} width`).toBe(7);
        for (const ch of row) {
          if (ch !== '.' && ch !== ' ') {
            expect(spec.palette[ch], `${name} badge token '${ch}'`).toBeDefined();
          }
        }
      }
    }

    expect(FLAME_FRAMES_32).toHaveLength(3);
    for (const frame of FLAME_FRAMES_32) {
      expect(frame).toHaveLength(32);
      for (const row of frame) {
        expect(row).toHaveLength(32);
      }
    }
  });

  it('snaps board tiles to exact multiples of 32 (zero mixel) and aligns 24x24 piece blits cleanly', () => {
    const layout640 = computeBoardLayout(640, 560, 9, 8, 2);
    expect(layout640.tileSize).toBe(64);

    const layoutLarge = computeBoardLayout(920, 820, 8, 8, 1);
    expect(layoutLarge.tileSize).toBe(96);

    const layoutCompact = computeBoardLayout(390, 390, 9, 9, 2);
    expect(layoutCompact.tileSize).toBe(32);

    const drawCalls: Array<{ x: number; y: number; w: number; h: number }> = [];
    const spyCtx = {
      drawImage: (_surf: unknown, x: number, y: number, w: number, h: number) => {
        drawCalls.push({ x, y, w, h });
      },
    } as unknown as CanvasRenderingContext2D;

    const fakeSurf = {} as CachedSurface;
    drawCachedPieceInTile(spyCtx, fakeSurf, 100, 200, 64);
    expect(drawCalls[0]).toEqual({ x: 108, y: 204, w: 48, h: 48 });

    drawCachedPieceInTile(spyCtx, fakeSurf, 100, 200, 96, 1, -1);
    expect(drawCalls[1]).toEqual({ x: 115, y: 203, w: 72, h: 72 });
  });

  it('bakes sprites at 1x, caches CHIMERA guises with LRU eviction, flips emitter keys, switches themes, and uses drawImage without per-tile fillRect', () => {
    const { factory } = makeMockSurfaceFactory();
    const cache = new SpriteCache(createDefaultSpriteAtlasProviders(), {
      surfaceFactory: factory,
      maxDynamicEntries: 2,
    });

    cache.warmup();
    const afterWarmup = cache.getStats();
    expect(afterWarmup.staticCount).toBeGreaterThanOrEqual(40);
    expect(afterWarmup.misses).toBeGreaterThan(0);

    // Second fetch of warmed sprites hits 100% cache with zero misses
    cache.getPieceSprite({ type: 'SAINT_FAITH', side: 'PLAYER' });
    cache.getTileSprite({ type: 'CRACKED', parity: 1 });
    cache.getMiasmaSprite(2);
    cache.getBadgeSprite('NAZAR');
    expect(cache.getStats().hits).toBe(4);

    // Dynamic CHIMERA guise slots LRU eviction check (maxDynamicEntries = 2)
    cache.getPieceSprite({ type: 'CHIMERA', side: 'PLAYER', slot1Type: 'KNIGHT', slot2Type: 'ROOK' });
    cache.getPieceSprite({ type: 'CHIMERA', side: 'PLAYER', slot1Type: 'BISHOP', slot2Type: 'PAWN' });
    cache.getPieceSprite({ type: 'CHIMERA', side: 'PLAYER', slot1Type: 'QUEEN', slot2Type: 'KING' });
    expect(cache.getStats().dynamicCount).toBe(2);
    expect(cache.getStats().evictions).toBe(1);

    // flipBoard negates emitter barrel direction inside the cache key without ctx.rotate
    const emNormal = cache.getTrapSprite({
      kind: 'ARROW_EMITTER',
      dir: { dx: 1, dy: 0 },
      flaming: true,
      flipBoard: false,
    });
    const emFlipped = cache.getTrapSprite({
      kind: 'ARROW_EMITTER',
      dir: { dx: -1, dy: 0 },
      flaming: true,
      flipBoard: true,
    });
    expect(emFlipped).toBe(emNormal);

    // Theme switching to 'crt' clears stale surfaces & updates team accent palette
    cache.setTheme('crt');
    expect(cache.getTheme()).toBe('crt');
    expect(cache.getStats().staticCount).toBe(0);
    expect(cache.getStats().dynamicCount).toBe(0);
    cache.warmup();

    // Full CanvasRenderer integration with SpriteCache: verify drawImage blits tiles + pieces + badges cleanly
    // AND assert fixed constant fillRect count (border frame only -> zero per-tile/per-piece fillRect)!
    const drawImageCalls: Array<{ w: number; h: number }> = [];
    let fillRectCount = 0;
    const { ctx } = makeMockCanvasContext();
    (ctx as unknown as Record<string, unknown>)['fillRect'] = () => {
      fillRectCount++;
    };
    (ctx as unknown as Record<string, unknown>)['drawImage'] = (
      _img: unknown,
      _dx: number,
      _dy: number,
      dw: number,
      dh: number,
    ) => {
      drawImageCalls.push({ w: dw, h: dh });
    };

    const renderer = new CanvasRenderer(makeMockCanvasElement(), ctx, {
      spriteCache: cache,
      theme: 'crt',
    });
    renderer.resize(700, 620, 2);

    const chimeraLab = getSandboxPreset('chimera-drift-lab').build();
    const saintLab = getSandboxPreset('saint-silence-lab').build();
    const combinedState = {
      ...getSandboxPreset('gas-arrow-lab').build(),
      pieces: [...chimeraLab.pieces, ...saintLab.pieces.slice(0, 3)],
    };
    const visible = getOmniscientVisibleState({
      ...combinedState,
      pieces: combinedState.pieces.map((p, idx) => ({ ...p, id: `${p.id}_${idx}` })),
    });

    renderer.render(visible, {
      selectedCoord: null,
      inspectedCoord: null,
      hoveredCoord: null,
      legalMoves: [],
      legalAbilities: [],
      activeAbility: null,
      timeMs: 420,
      theme: 'crt',
    });

    // At tileSize=64 (2x), 32x32 tiles blit at 64x64, 24x24 pieces at 48x48, 7x7 badges at 14x14!
    expect(drawImageCalls.some((c) => c.w === 64 && c.h === 64)).toBe(true);
    expect(drawImageCalls.some((c) => c.w === 48 && c.h === 48)).toBe(true);
    expect(drawImageCalls.some((c) => c.w === 14 && c.h === 14)).toBe(true);
    // Only fixed Layer 0 backdrop + 4 frame rects + 4 corner rivets (+ 5x5 aura tint fill) = <= 12 fillRect calls total
    // even with 72 tiles, traps, miasma, and 10+ pieces!
    expect(fillRectCount).toBeLessThanOrEqual(12);
    renderer.destroy();
  });

  it('verifies FAZ UI-2 24x24 special unit palettes, exact 7x7 corner badge offsets (zero face/composure overlap), Breakdown/Silence veils, and PANIC vignette', () => {
    // Verify Ocakli, Meczup, and Gulyabani 24x24 palette identity
    const ocakli = getPieceSpec24('SAINT_FAITH', 'default');
    expect(Object.values(ocakli.palette)).toContain('#0284c7'); // Nazar blue
    expect(Object.values(ocakli.palette)).toContain('#2dd4bf'); // Üzerlik turquoise smoke
    expect(Object.values(ocakli.palette)).toContain('#fbbf24'); // Brass/Gold rim

    const meczup = getPieceSpec24('SAINT_MADNESS', 'default');
    expect(Object.values(meczup.palette)).toContain('#f43f5e'); // Neon crimson eye
    expect(Object.values(meczup.palette)).toContain('#94a3b8'); // Broken iron chain
    expect(Object.values(meczup.palette)).toContain('#e7e5e4'); // Deli Davulu drum skin

    const gulyabani = getPieceSpec24('CHIMERA', 'default');
    expect(Object.values(gulyabani.palette)).toContain('#050b08'); // Obsidian
    expect(Object.values(gulyabani.palette)).toContain('#10b981'); // Moss emerald
    expect(Object.values(gulyabani.palette)).toContain('#fef3c7'); // Bone horns/claws
    expect(Object.values(gulyabani.palette)).toContain('SLOT1');
    expect(Object.values(gulyabani.palette)).toContain('SLOT2');

    // Verify 6-pass badge coordinates on a single 64px tile (2x scale) at (offsetX, offsetY)
    const { factory } = makeMockSurfaceFactory();
    const cache = new SpriteCache(createDefaultSpriteAtlasProviders(), { surfaceFactory: factory });
    cache.warmup();

    const drawCalls: Array<{ dx: number; dy: number; dw: number; dh: number }> = [];
    let fillRectCount = 0;
    const { ctx } = makeMockCanvasContext();
    (ctx as unknown as Record<string, unknown>)['fillRect'] = () => {
      fillRectCount++;
    };
    (ctx as unknown as Record<string, unknown>)['drawImage'] = (
      _img: unknown,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) => {
      drawCalls.push({ dx, dy, dw, dh });
    };

    const renderer = new CanvasRenderer(makeMockCanvasElement(), ctx, { spriteCache: cache });
    renderer.resize(700, 620, 2);
    const layout = renderer.getLayout();
    expect(layout.tileSize).toBe(64);

    const baseState = getSandboxPreset('saint-silence-lab').build();
    const testPiece: Piece = {
      id: 'p_badge_test',
      side: 'PLAYER',
      type: 'KNIGHT',
      pos: { x: 0, y: 0 },
      traits: ['SHIELDED', 'FROST_TOUCH', 'EXPLOSIVE'],
      shieldActive: true,
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE',
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: true,
      composure: 0,
      silencedTurns: 2,
      berserkReady: false,
    };
    const visible = getOmniscientVisibleState({
      ...baseState,
      pieces: [testPiece],
    });

    renderer.render(visible, {
      selectedCoord: null,
      inspectedCoord: null,
      hoveredCoord: null,
      legalMoves: [],
      legalAbilities: [],
      activeAbility: null,
      stressScore: 85,
      timeMs: 300,
    });

    const ox = layout.offsetX;
    const oy = layout.offsetY;
    // Breakdown (composure === 0) slumps 2px down -> (4, 2 + 2) -> (ox + 8, oy + 8) at 2x
    expect(drawCalls.some((c) => c.dw === 48 && c.dh === 48 && c.dx === ox + 8 && c.dy === oy + 8)).toBe(true);
    // Top-right (24, 1) -> (ox + 48, oy + 2) for AGIZ_BAGLAMA 7x7 badge (14x14 at 2x)
    expect(drawCalls.some((c) => c.dw === 14 && c.dh === 14 && c.dx === ox + 48 && c.dy === oy + 2)).toBe(true);
    // Bottom-corner traits (1, 20) & (24, 20) -> (ox + 2, oy + 40) & (ox + 48, oy + 40)
    expect(drawCalls.some((c) => c.dw === 14 && c.dh === 14 && c.dx === ox + 2 && c.dy === oy + 40)).toBe(true);
    expect(drawCalls.some((c) => c.dw === 14 && c.dh === 14 && c.dx === ox + 48 && c.dy === oy + 40)).toBe(true);
    // Zero per-tile/per-piece fillRect loops (only fixed backdrop + border + rivets = 8)
    expect(fillRectCount).toBeLessThanOrEqual(12);

    // Also verify standard composure=3 unsilenced piece sits at exact (4, 2) -> (ox + 8, oy + 4) with top-left (1, 1) SHIELD badge
    drawCalls.length = 0;
    const healthyPiece: Piece = {
      ...testPiece,
      composure: 3,
      silencedTurns: 0,
    };
    renderer.render(getOmniscientVisibleState({ ...baseState, pieces: [healthyPiece] }), {
      selectedCoord: null,
      inspectedCoord: null,
      hoveredCoord: null,
      legalMoves: [],
      legalAbilities: [],
      activeAbility: null,
      timeMs: 300,
    });
    expect(drawCalls.some((c) => c.dw === 48 && c.dh === 48 && c.dx === ox + 8 && c.dy === oy + 4)).toBe(true);
    expect(drawCalls.some((c) => c.dw === 14 && c.dh === 14 && c.dx === ox + 2 && c.dy === oy + 2)).toBe(true);
    expect(drawCalls.some((c) => c.dw === 14 && c.dh === 14 && c.dx === ox + 2 && c.dy === oy + 40)).toBe(true);
    expect(drawCalls.some((c) => c.dw === 14 && c.dh === 14 && c.dx === ox + 48 && c.dy === oy + 40)).toBe(true);
    renderer.destroy();
  });
});

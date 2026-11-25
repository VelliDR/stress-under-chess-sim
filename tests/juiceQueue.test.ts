import { describe, expect, it } from 'vitest';
import { SynthSfx, type SfxKind } from '../src/audio/synthSfx';
import type { GameEvent, Piece, PieceType } from '../src/engine/types';
import { FxQueue } from '../src/render/fxQueue';
import {
  computeAmbientPieceVisual,
  computeBfsDominoWaves,
  evaluatePieceChoreography,
  interpolateHexColor,
  JuiceEngine,
  PARTICLE_POOL_SIZE,
} from '../src/render/juiceEngine';

function makePiece(
  id: string,
  type: PieceType,
  x: number,
  y: number,
  side: 'PLAYER' | 'ENEMY' = 'PLAYER',
  extra: Partial<Piece> = {},
): Piece {
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
    ...extra,
  };
}

describe('FAZ UI-3 — JuiceEngine, 200-Slot Pool, Choreography, Hit-Stop & Tempo Rules', () => {
  it('enforces a fixed 200-element particle pool without exceeding capacity and bounces deterministically', () => {
    const a = new JuiceEngine('pool-seed');
    const b = new JuiceEngine('pool-seed');
    expect(a.poolCapacity).toBe(200);
    expect(PARTICLE_POOL_SIZE).toBe(200);

    for (let i = 0; i < 250; i++) {
      a.spawnParticle({
        x: 3.5,
        y: 3.5,
        z: 0.1,
        vx: (i % 7) - 3,
        vy: ((i * 3) % 5) - 2,
        vz: 2.0,
        gravity: 9.0,
        bounceFactor: 0.45,
        pxSize: 2,
        color: '#ffffff',
        colorMid: '#f97316',
        colorEnd: '#1e293b',
        lifeMs: 400,
        shape: 'pixel',
      });
      b.spawnParticle({
        x: 3.5,
        y: 3.5,
        z: 0.1,
        vx: (i % 7) - 3,
        vy: ((i * 3) % 5) - 2,
        vz: 2.0,
        gravity: 9.0,
        bounceFactor: 0.45,
        pxSize: 2,
        color: '#ffffff',
        colorMid: '#f97316',
        colorEnd: '#1e293b',
        lifeMs: 400,
        shape: 'pixel',
      });
    }

    expect(a.getActiveParticleCount()).toBe(200);
    expect(a.getActiveParticles()).toHaveLength(200);

    a.update(180);
    b.update(180);
    expect(a.getActiveParticles().length).toBe(b.getActiveParticles().length);
    expect(a.getActiveParticles()[0]!.x).toBe(b.getActiveParticles()[0]!.x);
    expect(interpolateHexColor('#ffffff', '#000000', 0.5)).toBe('#808080');
  });

  it('produces distinct choreographies for all 9 piece types including Knight shadow separation and Chimera tile stain', () => {
    const types: PieceType[] = [
      'PAWN',
      'KNIGHT',
      'ROOK',
      'BISHOP',
      'QUEEN',
      'KING',
      'SAINT_FAITH',
      'SAINT_MADNESS',
      'CHIMERA',
    ];

    for (const type of types) {
      const ant = evaluatePieceChoreography({
        pieceType: type,
        hasKnightGuise: false,
        elapsedMs: 15,
        durationMs: 200,
        path: [{ x: 1, y: 5 }, { x: 4, y: 2 }],
      });
      const mid = evaluatePieceChoreography({
        pieceType: type,
        hasKnightGuise: false,
        elapsedMs: 100,
        durationMs: 200,
        path: [{ x: 1, y: 5 }, { x: 4, y: 2 }],
      });
      const land = evaluatePieceChoreography({
        pieceType: type,
        hasKnightGuise: false,
        elapsedMs: 182,
        durationMs: 200,
        path: [{ x: 1, y: 5 }, { x: 4, y: 2 }],
      });

      if (type === 'KNIGHT') {
        // High parabolic arc raises Knight y above ground shadowY
        expect(mid.y).toBeLessThan(mid.shadowY - 0.3);
        expect(land.scaleX).toBeGreaterThan(1.05);
        expect(land.scaleY).toBeLessThan(0.95);
      } else if (type === 'ROOK') {
        expect(ant.dxTexels).not.toBe(0);
        expect(mid.trailTint).toBe('#94a3b8');
      } else if (type === 'BISHOP') {
        expect(Math.abs(mid.rotation)).toBeCloseTo(0.1047, 2);
      } else if (type === 'QUEEN') {
        expect(mid.trailTint).toBe('#fde047');
      } else if (type === 'KING') {
        expect(Math.abs(ant.rotation)).toBeGreaterThan(0);
      } else if (type === 'SAINT_FAITH') {
        expect(mid.dyTexels).toBe(-2);
        expect(mid.trailTint).toBe('#2dd4bf');
        expect(land.auraBoostAlpha).toBeGreaterThan(0);
      } else if (type === 'SAINT_MADNESS') {
        expect(Math.abs(ant.dxTexels)).toBeGreaterThan(0);
        expect(mid.trailTint).toBe('#f43f5e');
      } else if (type === 'CHIMERA') {
        expect(mid.stainColor).toBe('#064e3b');
        expect(land.slotGlowAlpha).toBeGreaterThan(0);
      } else if (type === 'PAWN') {
        expect(land.scaleY).toBeLessThan(1);
      }
    }

    // Staggered ambient piece signatures: King sweat under high stress, Ocaklı smoke, Gulyabani spores
    const king = makePiece('p_king', 'KING', 4, 7, 'PLAYER', { composure: 1 });
    const kAmb = computeAmbientPieceVisual(king, 200, 80, true);
    expect(kAmb.jitterTexels).not.toBe(0);

    const chimera = makePiece('e_ch', 'CHIMERA', 2, 2, 'ENEMY', {
      absorbedForms: [{ sourceType: 'KNIGHT', copiedTraits: [] }],
    });
    const knightGuiseJump = evaluatePieceChoreography({
      pieceType: 'CHIMERA',
      hasKnightGuise: true,
      elapsedMs: 100,
      durationMs: 200,
      path: [{ x: 2, y: 2 }, { x: 4, y: 3 }],
    });
    expect(knightGuiseJump.y).toBeLessThan(knightGuiseJump.shadowY - 0.25);
    expect(knightGuiseJump.trailTint).toBe('#10b981');
    const cAmb = computeAmbientPieceVisual(chimera, 150, 0, false);
    expect(Math.abs(cAmb.slotPulseAlpha)).toBeGreaterThanOrEqual(0);
  });

  it('freezes combat during 65ms Hit-Stop with pure white flash, 4-way star flash, and directional 2x2 palette burst', () => {
    const attacker = makePiece('p_rook', 'ROOK', 2, 4, 'PLAYER');
    const victim = makePiece('e_bishop', 'BISHOP', 5, 4, 'ENEMY');
    const fx = new FxQueue(null, 'hitstop-seed');

    const events: GameEvent[] = [
      {
        type: 'PIECE_CAPTURED',
        pieceId: 'e_bishop',
        byPieceId: 'p_rook',
        pos: { x: 5, y: 4 },
        pieceType: 'BISHOP',
        side: 'ENEMY',
      },
    ];

    fx.enqueue(events, [attacker, victim]);
    fx.update(30); // Inside 65ms Hit-Stop

    const snap = fx.getSnapshot();
    expect(snap.hitStopActive).toBe(true);
    expect(snap.pieceOverrides['e_bishop']?.flashAlpha).toBe(1);
    expect(snap.starFlashes?.length).toBe(1);
    expect(snap.particles.length).toBeGreaterThanOrEqual(12);
    expect(Math.abs(snap.shakeOffset.x) + Math.abs(snap.shakeOffset.y)).toBeGreaterThan(0);

    // Shield break on SAINT_FAITH triggers BONCUK ÇATLADI! + crystals
    const faithPiece = makePiece('p_faith', 'SAINT_FAITH', 3, 3, 'PLAYER', { shieldActive: true });
    const fx2 = new FxQueue(null, 'nazar-seed');
    fx2.enqueue(
      [{ type: 'SHIELD_BROKEN', pieceId: 'p_faith', pos: { x: 3, y: 3 }, source: 'ATTACK' }],
      [attacker, faithPiece],
    );
    fx2.update(25);
    expect(fx2.getSnapshot().floatingTexts.some((t) => t.text === 'BONCUK ÇATLADI!')).toBe(true);
    expect(fx2.getSnapshot().hitStopActive).toBe(true);
  });

  it('runs 45ms gas implosion followed by 25ms BFS domino waves across connected gas tiles', () => {
    const origin = { x: 3, y: 3 };
    const tiles = [
      { x: 3, y: 3 },
      { x: 4, y: 3 },
      { x: 5, y: 3 },
      { x: 6, y: 3 },
    ];
    const waves = computeBfsDominoWaves(origin, tiles);
    expect(waves.map((w) => w.delayMs)).toEqual([0, 25, 50, 75]);

    const fx = new FxQueue(null, 'gas-seed');
    fx.enqueue([{ type: 'GAS_CHAIN_DETONATED', origin, tiles }], []);

    // At 20ms (< 45ms implosion window): green gas implodes inward, no scorch stains yet
    fx.update(20);
    const snapImplode = fx.getSnapshot();
    expect(snapImplode.particles.some((p) => p.spiralTarget !== undefined && p.color === '#4ade80')).toBe(true);
    expect(snapImplode.tileStains?.length).toBe(0);

    // At 20 + 60 = 80ms (35ms into domino -> waves 0 and 1 (0ms, 25ms) detonated, wave 3 (75ms) pending)
    fx.update(60);
    const midStains = fx.getSnapshot().tileStains?.length ?? 0;
    expect(midStains).toBeGreaterThanOrEqual(2);
    expect(midStains).toBeLessThan(4);

    // At +60ms more (140ms): all 4 BFS tiles detonated
    fx.update(60);
    expect(fx.getSnapshot().tileStains?.length).toBe(4);
  });

  it('executes all 3 Signature Ultimates and the King Killcam (zoom + grayscale + splitting crown + CRT bar)', () => {
    const saintF = makePiece('p_f', 'SAINT_FAITH', 2, 4, 'PLAYER');
    const knightP = makePiece('p_k', 'KNIGHT', 3, 4, 'PLAYER');
    const chimeraE = makePiece('e_ch', 'CHIMERA', 4, 4, 'ENEMY', {
      absorbedForms: [{ sourceType: 'PAWN', copiedTraits: [] }, { sourceType: 'ROOK', copiedTraits: [] }],
    });
    const enemyS = makePiece('e_s', 'ROOK', 2, 2, 'ENEMY');
    const pieces = [saintF, knightP, chimeraE, enemyS];

    const fx = new FxQueue(null, 'ulti-seed');
    fx.enqueue(
      [
        {
          type: 'FAITH_ULTIMATE_TRIGGERED',
          saintId: 'p_f',
          shieldedTargetId: 'p_k',
          pulseOrigin: { x: 2, y: 4 },
          pulseRadius: 3,
          cleansedAllyIds: ['p_k'],
          silencedEnemyIds: ['e_s'],
        },
        {
          type: 'MADNESS_ULTIMATE_TRIGGERED',
          saintId: 'p_f',
          targetId: 'p_k',
          at: { x: 3, y: 4 },
        },
        {
          type: 'BERSERK_CHAIN_TRIGGERED',
          pieceId: 'p_k',
          at: { x: 3, y: 4 },
          kickedPieceId: 'e_s',
        },
        {
          type: 'CHIMERA_EVOLVED',
          chimeraId: 'e_ch',
          absorbedType: 'BISHOP',
          droppedType: 'PAWN',
        },
      ],
      pieces,
    );

    // Inspect Faith Ultimate mid-flight: outer dim + Nazar lock + EFSUN TUTMAZ! floating label
    fx.update(240);
    const sFaith = fx.getSnapshot();
    expect(sFaith.cameraFx?.dimBoardOutsideAlpha).toBeGreaterThan(0.1);
    expect(sFaith.nazarLock?.targetId).toBe('p_k');
    expect(sFaith.floatingTexts.some((ft) => ft.text === 'EFSUN TUTMAZ!')).toBe(true);

    // Advance into Chimera evolve (after Faith 680 + Madness 600 + Berserk 325 = 1605ms total)
    for (let i = 0; i < 8; i++) fx.update(200);
    expect(fx.getSnapshot().floatingTexts.some((ft) => ft.text === 'KILIK ÇALINDI!')).toBe(true);

    // King Fall Killcam + 2P Remote Signal
    const kingP = makePiece('p_king', 'KING', 4, 7, 'PLAYER');
    const fxKill = new FxQueue(null, 'killcam');
    fxKill.triggerRemoteSignal({ x: 1, y: 1 });
    expect(fxKill.getSnapshot().remoteSignalRings?.length).toBe(1);

    fxKill.enqueue(
      [
        {
          type: 'PIECE_CAPTURED',
          pieceId: 'p_king',
          byPieceId: 'e_s',
          pos: { x: 4, y: 7 },
          pieceType: 'KING',
          side: 'PLAYER',
        },
        { type: 'MATCH_ENDED', winner: 'ENEMY', reason: 'KING_CAPTURED' },
      ],
      [kingP, enemyS],
    );
    fxKill.update(100); // During 150ms King Hit-Stop
    const sKill = fxKill.getSnapshot();
    expect(sKill.hitStopActive).toBe(true);
    expect(sKill.cameraFx?.zoomScale).toBeCloseTo(1.08, 2);
    expect(sKill.splitCrown).not.toBeNull();
    expect(sKill.cameraFx?.grayscaleProgress).toBeGreaterThan(0);

    // Room Collapse & Drop transition helpers
    fxKill.skipAll();
    fxKill.triggerRoomTransition('COLLAPSE', 8, 8, [kingP]);
    fxKill.update(100);
    expect(Object.keys(fxKill.getSnapshot().roomTileOffsets ?? {}).length).toBe(64);
  });

  it('enforces all 4 Tempo & Accessibility Golden Rules (Combo -25%, 100ms Buffer, 2x Hit-Stop floor, Calm Screen)', () => {
    // 1) Combo 25% acceleration starting at 3rd step:
    // Queue 4 steps of equal action vs separate 1-step runs
    const r = makePiece('p_r', 'ROOK', 1, 5, 'PLAYER');
    const fxSingle = new FxQueue(null, 'c1');
    fxSingle.enqueue([{ type: 'WALL_DESTROYED', pos: { x: 3, y: 3 }, byPieceId: 'p_r' }], [r]);
    const singleWallMs = fxSingle.getRemainingDurationMs();

    const fxCombo = new FxQueue(null, 'c2');
    fxCombo.enqueue(
      [
        { type: 'PIECE_MOVED', pieceId: 'p_r', from: { x: 1, y: 5 }, to: { x: 1, y: 4 } },
        { type: 'PIECE_MOVED', pieceId: 'p_r', from: { x: 1, y: 4 }, to: { x: 1, y: 3 } },
        { type: 'WALL_DESTROYED', pos: { x: 3, y: 3 }, byPieceId: 'p_r' },
      ],
      [r],
    );
    // Advance past steps 0 and 1 (165 + 165 = 330ms) so only 3rd step (WALL_DESTROYED) remains
    fxCombo.update(330);
    const comboWallMs = fxCombo.getRemainingDurationMs();
    expect(comboWallMs).toBeLessThan(singleWallMs);
    expect(comboWallMs).toBeCloseTo(Math.round(singleWallMs * 0.75), 0);

    // 2) 100ms Input Buffer queues action in final 100ms and executes immediately on drain
    const fxBuf = new FxQueue(null, 'buf');
    fxBuf.enqueue([{ type: 'WALL_DESTROYED', pos: { x: 2, y: 2 }, byPieceId: 'p_r' }], [r]);
    fxBuf.update(140); // 80ms remaining (<= 100ms)
    expect(fxBuf.isInInputBufferWindow()).toBe(true);
    let firedCount = 0;
    const buffered = fxBuf.bufferInput(() => {
      firedCount++;
    });
    expect(buffered).toBe(true);
    expect(firedCount).toBe(0);
    fxBuf.update(85);
    expect(firedCount).toBe(1);

    // 3) 2x Speed reduces step durations ~45% BUT Hit-Stop & white flash stay >= 28ms (never 0)
    const fx2x = new FxQueue(null, 'fast');
    fx2x.setSpeed(2);
    const v = makePiece('e_v', 'PAWN', 4, 4, 'ENEMY');
    fx2x.enqueue(
      [
        {
          type: 'PIECE_CAPTURED',
          pieceId: 'e_v',
          byPieceId: 'p_r',
          pos: { x: 4, y: 4 },
          pieceType: 'PAWN',
          side: 'ENEMY',
        },
      ],
      [r, v],
    );
    fx2x.update(20); // Must still be frozen inside >=28ms Hit-Stop floor!
    expect(fx2x.getSnapshot().hitStopActive).toBe(true);
    expect(fx2x.getSnapshot().pieceOverrides['e_v']?.flashAlpha).toBe(1);

    // 4) Calm Screen cuts shake by 80% and redirects full-screen flashes to soft borders
    const fxLoud = new FxQueue(null, 'shake');
    const fxCalm = new FxQueue(null, 'shake');
    fxCalm.setCalmScreen(true);

    const mad = makePiece('p_m', 'SAINT_MADNESS', 2, 2, 'PLAYER');
    const ally = makePiece('p_a', 'KNIGHT', 3, 2, 'PLAYER');
    const ev: GameEvent[] = [
      { type: 'MADNESS_ULTIMATE_TRIGGERED', saintId: 'p_m', targetId: 'p_a', at: { x: 3, y: 2 } },
    ];
    fxLoud.enqueue(ev, [mad, ally]);
    fxCalm.enqueue(ev, [mad, ally]);
    fxLoud.update(16);
    fxCalm.update(16);

    const loudMag =
      Math.abs(fxLoud.getSnapshot().shakeOffset.x) + Math.abs(fxLoud.getSnapshot().shakeOffset.y);
    const calmMag =
      Math.abs(fxCalm.getSnapshot().shakeOffset.x) + Math.abs(fxCalm.getSnapshot().shakeOffset.y);
    expect(calmMag).toBeCloseTo(loudMag * 0.2, 2);
    expect(fxLoud.getSnapshot().cameraFx?.screenFlashAlpha).toBeGreaterThan(0);
    expect(fxCalm.getSnapshot().cameraFx?.screenFlashAlpha).toBe(0);
    expect(fxCalm.getSnapshot().cameraFx?.borderFlashAlpha).toBeGreaterThan(0);
  });

  it('synthesizes all FAZ UI-3 Section 6 SFX sounds including 45ms delayed gasBlast and every-3rd-char typewriter blip', () => {
    const startTimes: number[] = [];
    const mockNode = (): Record<string, unknown> => ({
      gain: { value: 1, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined, setTargetAtTime: () => undefined },
      frequency: { value: 440, setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      Q: { value: 1, setValueAtTime: () => undefined },
      type: 'sine',
      buffer: null,
      connect: () => undefined,
      start: (t = 0) => startTimes.push(t),
      stop: () => undefined,
    });
    const origCtx = (globalThis as Record<string, unknown>)['AudioContext'];
    (globalThis as Record<string, unknown>)['AudioContext'] = class {
      public currentTime = 10;
      public sampleRate = 22050;
      public state = 'running';
      public destination = {};
      public createGain = mockNode;
      public createOscillator = mockNode;
      public createBiquadFilter = mockNode;
      public createBufferSource = mockNode;
      public createBuffer = () => ({ getChannelData: () => new Float32Array(11025) });
      public resume = async () => undefined;
    };

    try {
      const sfx = new SynthSfx(0.7, false);
      const kinds: SfxKind[] = [
        'menuHover',
        'menuClick',
        'crtBoot',
        'typewriterBlip',
        'hitStopPunch',
        'killcamDrop',
        'roomCollapse',
        'roomDrop',
        'remoteSignal',
        'disobey',
        'plateClick',
        'arrowShot',
        'tileCollapse',
        'spikeTelegraph',
        'spikeStrike',
        'faithUltimate',
        'madnessUltimate',
        'chimeraEvolve',
      ];
      for (const k of kinds) {
        expect(() => sfx.play(k)).not.toThrow();
      }

      // gasBlast delays detonation boom by 45ms (10.045s) after 45ms silent implosion vacuum
      startTimes.length = 0;
      sfx.play('gasBlast');
      expect(startTimes.length).toBeGreaterThanOrEqual(2);
      expect(startTimes[0]).toBeCloseTo(10.045, 3);

      // Typewriter blip plays every 3rd character (indices 0, 3, 6 -> 3 plays across 0..6)
      startTimes.length = 0;
      for (let i = 0; i < 7; i++) {
        sfx.playTypewriterChar(i);
      }
      expect(startTimes.length).toBe(6); // 2 oscillators * 3 active indices (0, 3, 6)
    } finally {
      (globalThis as Record<string, unknown>)['AudioContext'] = origCtx;
    }
  });
});

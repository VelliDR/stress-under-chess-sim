// src/render/juiceEngine.ts
// S.U.C.S. — Prosedürel Animasyon, 200'lü Sabit Parçacık Havuzu (Object Pool),
// Hit-Stop, Hayalet İzler, Yönlü Kamera Sarsıntısı & Salt-Matematik Hareket Eğrileri.
// Sıfır DOM, sıfır Math.random() — tamamen deterministik PRNG ile çalışır.

import { nextRng, seedToRngState } from '../engine/prng';
import type { Coord, Piece, PieceType } from '../engine/types';
import { getPieceSpec24, resolvePiecePalette24 } from './pieceSprites24';
import type { RenderTheme } from './spriteCache';

export const PARTICLE_POOL_SIZE = 200;

export type ParticleShape = 'circle' | 'shard' | 'ring' | 'star4' | 'pixel' | 'smoke' | 'sweat';

export interface PooledParticle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  bounceFactor: number;
  pxSize: 1 | 2 | 3;
  size: number;
  color: string;
  colorMid?: string;
  colorEnd?: string;
  alpha: number;
  ageMs: number;
  lifeMs: number;
  shape: ParticleShape;
  spiralTarget?: Coord;
  spiralSpeed?: number;
}

export interface StarFlash {
  x: number;
  y: number;
  color: string;
  ageMs: number;
  lifeMs: number;
  sizeTiles: number;
}

export interface PieceGhostTrail {
  piece: Piece;
  x: number;
  y: number;
  tint?: string;
  alpha: number;
  ageMs: number;
  lifeMs: number;
  rotation?: number;
}

export interface TileStain {
  x: number;
  y: number;
  color: string;
  ageMs: number;
  lifeMs: number;
  kind: 'MOSS' | 'CRACK_CRUMB' | 'SCORCH';
}

export interface Speedline {
  from: Coord;
  to: Coord;
  color: string;
  ageMs: number;
  lifeMs: number;
}

export interface SignalSpark {
  from: Coord;
  to: Coord;
  progress: number;
  color: string;
}

export interface NazarLockOverlay {
  targetId: string;
  x: number;
  y: number;
  progress: number;
}

export interface FlameStreakOverlay {
  pieceId: string;
  x: number;
  y: number;
  progress: number;
}

export interface SplitCrownOverlay {
  x: number;
  y: number;
  color: string;
  progress: number;
}

export interface RemoteSignalRing {
  x: number;
  y: number;
  color: string;
  ageMs: number;
  lifeMs: number;
}

export interface CameraFxState {
  shakeOffset: Coord;
  zoomScale: number;
  zoomTarget: Coord | null;
  screenFlashColor: string | null;
  screenFlashAlpha: number;
  borderFlashColor: string | null;
  borderFlashAlpha: number;
  dimBoardOutsideAlpha: number;
  grayscaleProgress: number;
  crtShutdownProgress: number;
}

export interface PieceChoreographySample {
  x: number;
  y: number;
  shadowX: number;
  shadowY: number;
  dxTexels: number;
  dyTexels: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  auraBoostAlpha: number;
  slotGlowAlpha: number;
  trailTint: string | null;
  stainColor: string | null;
}

export interface AmbientPieceVisual {
  bobTexels: number;
  stretchScaleX: number;
  stretchScaleY: number;
  jitterTexels: number;
  eyeGlintAlpha: number;
  madnessHeartbeat: number;
  slotPulseAlpha: number;
  sweatProgress: number | null;
  smokePhase: number;
  sporePhase: number | null;
}

export interface BfsDominoNode {
  pos: Coord;
  wave: number;
  delayMs: number;
}

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

function easeInQuad(t: number): number {
  return t * t;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function samplePolylinePath(path: readonly Coord[], t: number): Coord {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1) return { x: path[0]!.x, y: path[0]!.y };
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (path.length - 1);
  const idx = Math.min(path.length - 2, Math.floor(scaled));
  const localT = scaled - idx;
  const a = path[idx]!;
  const b = path[idx + 1]!;
  return {
    x: a.x + (b.x - a.x) * localT,
    y: a.y + (b.y - a.y) * localT,
  };
}

/**
 * 2.4 BFS Domino Zinciri: Başlangıç karesinden dallanan gaz karelerini her dalgada 25 ms gecikmeyle sıralar.
 */
export function computeBfsDominoWaves(
  origin: Coord,
  tiles: readonly Coord[],
): BfsDominoNode[] {
  if (tiles.length === 0) return [];
  const key = (c: Coord): string => `${c.x},${c.y}`;
  const remaining = new Map<string, Coord>();
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    remaining.set(key(t), t);
  }

  const waveMap = new Map<string, number>();
  const queue: Array<{ pos: Coord; wave: number }> = [];

  // Seed wave 0 from origin (or nearest tile to origin)
  const oKey = key(origin);
  if (remaining.has(oKey)) {
    waveMap.set(oKey, 0);
    queue.push({ pos: origin, wave: 0 });
    remaining.delete(oKey);
  } else {
    queue.push({ pos: origin, wave: 0 });
  }

  const dirs: readonly Coord[] = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: 1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: 1 },
    { x: -1, y: -1 },
  ];

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    for (let d = 0; d < dirs.length; d++) {
      const nb: Coord = { x: cur.pos.x + dirs[d]!.x, y: cur.pos.y + dirs[d]!.y };
      const nbKey = key(nb);
      if (remaining.has(nbKey)) {
        const w = waveMap.has(oKey) ? cur.wave + 1 : cur.wave;
        waveMap.set(nbKey, w);
        queue.push({ pos: nb, wave: w });
        remaining.delete(nbKey);
      }
    }
  }

  // Fallback for disconnected fragments: assign Chebyshev wave distance
  for (const [k, pos] of remaining.entries()) {
    const dist = Math.max(Math.abs(pos.x - origin.x), Math.abs(pos.y - origin.y));
    waveMap.set(k, dist);
  }

  const result: BfsDominoNode[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]!;
    const wave = waveMap.get(key(t)) ?? 0;
    result.push({
      pos: { x: t.x, y: t.y },
      wave,
      delayMs: wave * 25,
    });
  }
  result.sort((a, b) => a.wave - b.wave);
  return result;
}

/**
 * Kurban taşın kendi 24x24 palet renklerini çıkartır (Standart yeme parçacıkları için).
 */
export function getPieceExplosionPalette(piece: Piece, theme: RenderTheme = 'default'): string[] {
  const spec = getPieceSpec24(piece.type, theme, piece.isBoss === true);
  const slot1 = piece.absorbedForms?.[0]?.sourceType;
  const slot2 = piece.absorbedForms?.[1]?.sourceType;
  const resolved = resolvePiecePalette24(spec.palette, piece.side, theme, slot1, slot2);
  const colors = Object.values(resolved).filter(
    (c) => c.startsWith('#') && c !== '#070a12' && c !== '#050b08' && c !== '#06040a',
  );
  if (colors.length === 0) {
    return piece.side === 'PLAYER' ? ['#38bdf8', '#e0f2fe', '#1d4ed8'] : ['#ef4444', '#fecaca', '#991b1b'];
  }
  return Array.from(new Set(colors)).slice(0, 6);
}

/**
 * Bölüm 2.2 — 9 Taşın Karakterine Göre Prosedürel Hareket Koreografisi (Kalkış / Yolculuk / İniş).
 * Tüm görsel ofsetler texel (32x32 ızgara birimi) ve ölçek olarak üretilir; taş oturunca 0'a kilitlenir.
 */
export function evaluatePieceChoreography(opts: {
  pieceType: PieceType;
  hasKnightGuise: boolean;
  elapsedMs: number;
  durationMs: number;
  path: readonly Coord[];
  isDrifted?: boolean;
  driftSign?: 1 | -1;
}): PieceChoreographySample {
  const { pieceType, hasKnightGuise, elapsedMs, durationMs, path, isDrifted, driftSign } = opts;
  const safeDur = Math.max(1, durationMs);
  const rawT = Math.max(0, Math.min(1, elapsedMs / safeDur));

  // Scale anticipation/landing budgets proportionally when durationMs is combo-accelerated
  const antRatioByType: Record<PieceType, number> = {
    PAWN: 0.19,
    KNIGHT: 0.22,
    ROOK: 0.24,
    BISHOP: 0.16,
    QUEEN: 0.18,
    KING: 0.2,
    SAINT_FAITH: 0.18,
    SAINT_MADNESS: 0.22,
    CHIMERA: 0.24,
  };
  const landRatioByType: Record<PieceType, number> = {
    PAWN: 0.18,
    KNIGHT: 0.16,
    ROOK: 0.15,
    BISHOP: 0.22,
    QUEEN: 0.16,
    KING: 0.18,
    SAINT_FAITH: 0.22,
    SAINT_MADNESS: 0.18,
    CHIMERA: 0.16,
  };

  const antEnd = antRatioByType[pieceType];
  const landStart = 1 - landRatioByType[pieceType];
  const travelSpan = Math.max(0.1, landStart - antEnd);

  const from = path[0] ?? { x: 0, y: 0 };
  const to = path[path.length - 1] ?? from;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ndx = dx / len;
  const ndy = dy / len;

  // Logical travel progress u in [0..1] (moves smoothly during travel, plus subtle early creep after antEnd)
  const travelT =
    rawT <= antEnd ? 0 : rawT >= landStart ? 1 : (rawT - antEnd) / travelSpan;
  const easedTravel =
    pieceType === 'ROOK'
      ? easeInQuad(Math.min(1, travelT * 1.05))
      : pieceType === 'QUEEN' || pieceType === 'BISHOP'
        ? easeOutCubic(travelT)
        : easeInOutQuad(travelT);

  const basePt = samplePolylinePath(path, easedTravel);
  let x = basePt.x;
  let y = basePt.y;
  const shadowX = basePt.x;
  const shadowY = basePt.y;

  let dxTexels = 0;
  let dyTexels = 0;
  let scaleX = 1;
  let scaleY = 1;
  let rotation = 0;
  let auraBoostAlpha = 0;
  let slotGlowAlpha = 0;
  let trailTint: string | null = null;
  let stainColor: string | null = null;

  // 45° Curved Stress Drift twist on tile 3+
  if (isDrifted && path.length >= 3 && rawT > antEnd && rawT < landStart) {
    const segScaled = easedTravel * (path.length - 1);
    if (segScaled >= 1.5) {
      rotation += (driftSign ?? 1) * 0.1745; // 10 degrees bend into 45° diagonal
      trailTint = '#c084fc';
    }
  }

  switch (pieceType) {
    case 'PAWN': {
      if (rawT <= antEnd) {
        const k = rawT / antEnd;
        dyTexels = 2 * Math.sin(k * Math.PI);
        scaleY = 1 - 0.1 * Math.sin(k * Math.PI);
      } else if (rawT < landStart) {
        const hop = Math.sin(travelT * Math.PI);
        dyTexels = -hop * 4;
      } else {
        const k = (rawT - landStart) / (1 - landStart);
        scaleY = 0.85 + 0.15 * easeOutCubic(k);
        scaleX = 1 + 0.08 * (1 - k);
      }
      break;
    }

    case 'KNIGHT': {
      if (rawT <= antEnd) {
        const k = Math.sin((rawT / antEnd) * Math.PI);
        dxTexels = -ndx * 2 * k;
        scaleX = 1 + 0.12 * k;
        scaleY = 1 - 0.14 * k;
      } else if (rawT < landStart) {
        // High parabolic leap over walls while shadow tracks straight along ground
        const arc = Math.sin(travelT * Math.PI);
        y -= arc * 0.56;
        dyTexels = -arc * 3;
        scaleX = 0.94;
        scaleY = 1.08;
      } else {
        // Hard 40ms squash on landing (smoothly holds wide squash before snapping back to 1.0)
        const k = (rawT - landStart) / (1 - landStart);
        const squash = 1 - k * k;
        scaleX = 1 + 0.25 * squash;
        scaleY = 1 - 0.22 * squash;
      }
      break;
    }

    case 'ROOK': {
      if (rawT <= antEnd) {
        const k = Math.sin((rawT / antEnd) * Math.PI);
        dxTexels = -ndx * 3 * k;
        dyTexels = -ndy * 3 * k;
        scaleY = 0.93;
      } else if (rawT < landStart) {
        trailTint = '#94a3b8';
      } else {
        const k = (rawT - landStart) / (1 - landStart);
        dyTexels = 2 * (1 - easeOutCubic(k));
        scaleY = 0.92 + 0.08 * k;
      }
      break;
    }

    case 'BISHOP': {
      const leanSign = dx >= 0 ? 1 : -1;
      const sixDeg = 0.1047 * leanSign;
      if (rawT <= antEnd) {
        rotation += sixDeg * (rawT / antEnd);
      } else if (rawT < landStart) {
        rotation += sixDeg;
      } else {
        const k = (rawT - landStart) / (1 - landStart);
        rotation += sixDeg * (1 - easeOutCubic(k));
      }
      break;
    }

    case 'QUEEN': {
      if (rawT <= antEnd) {
        dyTexels = -1.5 * (rawT / antEnd);
      } else if (rawT < landStart) {
        dyTexels = -2;
        trailTint = '#fde047';
      } else {
        const k = (rawT - landStart) / (1 - landStart);
        dyTexels = -2 * (1 - k);
      }
      break;
    }

    case 'KING': {
      if (rawT <= antEnd) {
        const k = rawT / antEnd;
        rotation += Math.sin(k * Math.PI * 2) * 0.05;
      } else if (rawT >= landStart) {
        const k = (rawT - landStart) / (1 - landStart);
        rotation += Math.sin(k * Math.PI * 2) * 0.03 * (1 - k);
      }
      break;
    }

    case 'SAINT_FAITH': {
      if (rawT <= antEnd) {
        dyTexels = -1 * (rawT / antEnd);
      } else if (rawT < landStart) {
        dyTexels = -2;
        trailTint = '#2dd4bf';
      } else {
        const k = (rawT - landStart) / (1 - landStart);
        dyTexels = -2 * (1 - k);
        auraBoostAlpha = Math.sin(k * Math.PI) * 0.85;
      }
      break;
    }

    case 'SAINT_MADNESS': {
      if (rawT <= antEnd) {
        const wave = Math.sin((rawT / antEnd) * Math.PI * 3);
        dxTexels = wave * 2;
      } else if (rawT < landStart) {
        // Slight perpendicular zigzag dash
        const zig = Math.sin(travelT * Math.PI * 3) * 0.11;
        x += -ndy * zig;
        y += ndx * zig;
        trailTint = '#f43f5e';
      }
      break;
    }

    case 'CHIMERA': {
      if (rawT <= antEnd) {
        const k = Math.sin((rawT / antEnd) * Math.PI);
        scaleY = 1 - 0.12 * k;
        dyTexels = 2 * k;
      } else if (rawT < landStart) {
        if (hasKnightGuise) {
          const arc = Math.sin(travelT * Math.PI);
          y -= arc * 0.48;
          dyTexels = -arc * 2;
          trailTint = '#10b981';
        } else {
          stainColor = '#064e3b';
        }
      } else {
        const k = (rawT - landStart) / (1 - landStart);
        slotGlowAlpha = Math.sin(k * Math.PI);
        scaleY = 0.92 + 0.08 * k;
      }
      break;
    }
  }

  return {
    x,
    y,
    shadowX,
    shadowY,
    dxTexels,
    dyTexels,
    scaleX,
    scaleY,
    rotation,
    auraBoostAlpha,
    slotGlowAlpha,
    trailTint,
    stainColor,
  };
}

/**
 * Bölüm 2.1 — Taşa özgü sürekli canlılık (staggered idle nefes + imzalar).
 */
export function computeAmbientPieceVisual(
  piece: Piece,
  timeMs: number,
  stressScore = 0,
  underThreat = false,
): AmbientPieceVisual {
  const hash = piece.id.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7);
  const phaseOffset = Math.abs(hash) % 2400;
  const cycleMs = 2400 + (Math.abs(hash) % 500); // 2.4–2.9s staggered cycle
  const composure = piece.composure ?? 3;
  const active = piece.frozenTurns === 0 && !(piece.side === 'ENEMY' && piece.aggro === 'SLEEPING');

  const breatheT = active ? ((timeMs + phaseOffset) % cycleMs) / cycleMs : 0;
  const breatheUp = breatheT >= 0.45 && breatheT <= 0.85 && composure > 0;
  const bobTexels = breatheUp ? -1 : 0;

  const jitterTexels =
    composure === 1 && piece.frozenTurns === 0
      ? Math.floor((timeMs + phaseOffset) / 95) % 2 === 0
        ? 1
        : -1
      : 0;

  // King under threat / high stress drips a 2x2 blue forehead sweat every 1.5s
  let sweatProgress: number | null = null;
  if (piece.type === 'KING' && piece.side === 'PLAYER' && (stressScore >= 55 || underThreat || composure <= 1)) {
    const swCycle = (timeMs + phaseOffset) % 1500;
    if (swCycle < 680) {
      sweatProgress = swCycle / 680;
    }
  }

  // Saint Madness irregular eye glint & ~700ms heartbeat
  const heartBeatCycle = ((timeMs + phaseOffset) % 700) / 700;
  const madnessHeartbeat = piece.type === 'SAINT_MADNESS' ? Math.max(0, 1 - Math.abs(heartBeatCycle - 0.2) * 4) : 0;
  const eyeGlintAlpha =
    piece.type === 'SAINT_MADNESS' && Math.floor((timeMs + phaseOffset) / 170) % 5 === 0 ? 0.95 : 0;

  // Chimera filled slot glow & periodic 1px emerald spores
  const hasGuise = (piece.absorbedForms?.length ?? 0) > 0;
  const slotPulseAlpha =
    piece.type === 'CHIMERA' && hasGuise ? 0.35 + 0.45 * Math.sin((timeMs + phaseOffset) * 0.004) : 0;
  const spCycle = (timeMs + phaseOffset) % 1600;
  const sporePhase = piece.type === 'CHIMERA' && hasGuise && spCycle < 720 ? spCycle / 720 : null;

  return {
    bobTexels,
    stretchScaleX: 1,
    stretchScaleY: 1,
    jitterTexels,
    eyeGlintAlpha,
    madnessHeartbeat,
    slotPulseAlpha,
    sweatProgress,
    smokePhase: ((timeMs + phaseOffset) % 1200) / 1200,
    sporePhase,
  };
}

function colorFromHex(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return [
      Number.isNaN(r) ? 255 : r,
      Number.isNaN(g) ? 255 : g,
      Number.isNaN(b) ? 255 : b,
    ];
  }
  return [255, 255, 255];
}

export function interpolateHexColor(aHex: string, bHex: string, t: number): string {
  const [ar, ag, ab] = colorFromHex(aHex);
  const [br, bg, bb] = colorFromHex(bHex);
  const cl = Math.max(0, Math.min(1, t));
  const r = Math.round(ar + (br - ar) * cl);
  const g = Math.round(ag + (bg - ag) * cl);
  const b = Math.round(ab + (bb - ab) * cl);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Sabit 200 elemanlı Object Pool + hayalet izler, darbe yıldızları ve yönlü kamera fiziği motoru.
 */
export class JuiceEngine {
  public readonly poolCapacity = PARTICLE_POOL_SIZE;
  private readonly pool: PooledParticle[];
  private readonly activeView: PooledParticle[] = [];

  private starFlashes: StarFlash[] = [];
  private ghostTrails: PieceGhostTrail[] = [];
  private tileStains: TileStain[] = [];
  private speedlines: Speedline[] = [];
  private remoteSignalRings: RemoteSignalRing[] = [];
  private signalSparks: SignalSpark[] = [];
  private nazarLock: NazarLockOverlay | null = null;
  private flameStreaks: FlameStreakOverlay[] = [];
  private splitCrown: SplitCrownOverlay | null = null;

  private calmScreen = false;
  private rngState: number;

  // Camera & Screen Overlay state
  private shakeIntensity = 0;
  private shakeDirX = 1;
  private shakeDirY = 0.3;
  private shakeTimeLeftMs = 0;
  private shakeDurationMs = 1;

  private zoomScale = 1;
  private zoomTarget: Coord | null = null;
  private zoomHoldMs = 0;
  private zoomDecayRate = 0.0025;

  private screenFlashColor: string | null = null;
  private screenFlashAlpha = 0;
  private screenFlashDurationMs = 1;
  private screenFlashLeftMs = 0;

  private borderFlashColor: string | null = null;
  private borderFlashAlpha = 0;
  private borderFlashDurationMs = 1;
  private borderFlashLeftMs = 0;

  private dimBoardOutsideAlpha = 0;
  private dimTargetAlpha = 0;

  private grayscaleProgress = 0;
  private grayscaleTarget = 0;
  private crtShutdownProgress = 0;
  private crtShutdownActive = false;

  public constructor(seed = 'tfc-fx-seed') {
    this.rngState = seedToRngState(seed);
    this.pool = new Array<PooledParticle>(PARTICLE_POOL_SIZE);
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.pool[i] = {
        active: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        gravity: 0,
        bounceFactor: 0,
        pxSize: 2,
        size: 0.08,
        color: '#ffffff',
        alpha: 1,
        ageMs: 0,
        lifeMs: 300,
        shape: 'pixel',
      };
    }
  }

  public setCalmScreen(enabled: boolean): void {
    this.calmScreen = enabled;
  }

  public isCalmScreen(): boolean {
    return this.calmScreen;
  }

  public nextFloat(): number {
    const step = nextRng(this.rngState);
    this.rngState = step.nextState;
    return step.value;
  }

  public reset(): void {
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.pool[i]!.active = false;
    }
    this.activeView.length = 0;
    this.starFlashes = [];
    this.ghostTrails = [];
    this.tileStains = [];
    this.speedlines = [];
    this.remoteSignalRings = [];
    this.signalSparks = [];
    this.nazarLock = null;
    this.flameStreaks = [];
    this.splitCrown = null;
    this.shakeIntensity = 0;
    this.shakeTimeLeftMs = 0;
    this.zoomScale = 1;
    this.zoomTarget = null;
    this.zoomHoldMs = 0;
    this.screenFlashColor = null;
    this.screenFlashAlpha = 0;
    this.screenFlashLeftMs = 0;
    this.borderFlashColor = null;
    this.borderFlashAlpha = 0;
    this.borderFlashLeftMs = 0;
    this.dimBoardOutsideAlpha = 0;
    this.dimTargetAlpha = 0;
    this.grayscaleProgress = 0;
    this.grayscaleTarget = 0;
    this.crtShutdownProgress = 0;
    this.crtShutdownActive = false;
  }

  public hasActiveEffects(): boolean {
    if (this.shakeTimeLeftMs > 0) return true;
    if (this.screenFlashLeftMs > 0 || this.borderFlashLeftMs > 0) return true;
    if (this.starFlashes.length > 0 || this.ghostTrails.length > 0) return true;
    if (this.tileStains.length > 0 || this.speedlines.length > 0) return true;
    if (this.remoteSignalRings.length > 0 || this.flameStreaks.length > 0) return true;
    if (this.nazarLock !== null || this.splitCrown !== null) return true;
    if (this.zoomScale > 1.001 || this.grayscaleProgress > 0.01) return true;
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      if (this.pool[i]!.active) return true;
    }
    return false;
  }

  public getActiveParticleCount(): number {
    let count = 0;
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      if (this.pool[i]!.active) count++;
    }
    return count;
  }

  public getActiveParticles(): readonly PooledParticle[] {
    this.activeView.length = 0;
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const slot = this.pool[i]!;
      if (slot.active) {
        this.activeView.push(slot);
      }
    }
    return this.activeView;
  }

  public spawnParticle(init: {
    x: number;
    y: number;
    z?: number;
    vx: number;
    vy: number;
    vz?: number;
    gravity?: number;
    bounceFactor?: number;
    pxSize?: 1 | 2 | 3;
    size?: number;
    color: string;
    colorMid?: string;
    colorEnd?: string;
    alpha?: number;
    lifeMs: number;
    shape: ParticleShape;
    spiralTarget?: Coord;
    spiralSpeed?: number;
  }): void {
    let targetIdx = -1;
    let oldestIdx = 0;
    let oldestRatio = -1;
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const slot = this.pool[i]!;
      if (!slot.active) {
        targetIdx = i;
        break;
      }
      const ratio = slot.lifeMs > 0 ? slot.ageMs / slot.lifeMs : 1;
      if (ratio > oldestRatio) {
        oldestRatio = ratio;
        oldestIdx = i;
      }
    }
    const slot = this.pool[targetIdx >= 0 ? targetIdx : oldestIdx]!;
    slot.active = true;
    slot.x = init.x;
    slot.y = init.y;
    slot.z = init.z ?? 0;
    slot.vx = init.vx;
    slot.vy = init.vy;
    slot.vz = init.vz ?? 0;
    slot.gravity = init.gravity ?? 0;
    slot.bounceFactor = init.bounceFactor ?? 0;
    slot.pxSize = init.pxSize ?? 2;
    slot.size = init.size ?? (slot.pxSize === 1 ? 0.05 : slot.pxSize === 3 ? 0.12 : 0.08);
    slot.color = init.color;
    slot.colorMid = init.colorMid;
    slot.colorEnd = init.colorEnd;
    slot.alpha = init.alpha ?? 1;
    slot.ageMs = 0;
    slot.lifeMs = Math.max(16, init.lifeMs);
    slot.shape = init.shape;
    slot.spiralTarget = init.spiralTarget ? { x: init.spiralTarget.x, y: init.spiralTarget.y } : undefined;
    slot.spiralSpeed = init.spiralSpeed;
  }

  public spawnRing(x: number, y: number, color: string, lifeMs = 320): void {
    this.spawnParticle({
      x,
      y,
      vx: 0,
      vy: 0,
      size: 0.25,
      color,
      alpha: 0.95,
      lifeMs,
      shape: 'ring',
    });
  }

  public spawnStarFlash(x: number, y: number, color = '#ffffff', sizeTiles = 0.68, lifeMs = 130): void {
    this.starFlashes.push({
      x,
      y,
      color,
      ageMs: 0,
      lifeMs,
      sizeTiles,
    });
  }

  public spawnGhostTrail(
    piece: Piece,
    x: number,
    y: number,
    tint?: string,
    lifeMs = 150,
    rotation = 0,
  ): void {
    this.ghostTrails.push({
      piece,
      x,
      y,
      tint,
      alpha: 0.56,
      ageMs: 0,
      lifeMs,
      rotation,
    });
  }

  public spawnTileStain(
    x: number,
    y: number,
    color: string,
    kind: 'MOSS' | 'CRACK_CRUMB' | 'SCORCH' = 'MOSS',
    lifeMs = 300,
  ): void {
    this.tileStains.push({
      x,
      y,
      color,
      ageMs: 0,
      lifeMs,
      kind,
    });
  }

  public spawnSpeedline(from: Coord, to: Coord, color = '#ffffff', lifeMs = 170): void {
    this.speedlines.push({
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      color,
      ageMs: 0,
      lifeMs,
    });
  }

  public spawnRemoteSignal(coord: Coord, color = '#f43f5e', lifeMs = 140): void {
    this.remoteSignalRings.push({
      x: coord.x + 0.5,
      y: coord.y + 0.5,
      color,
      ageMs: 0,
      lifeMs,
    });
  }

  public spawnBurst(
    x: number,
    y: number,
    count: number,
    color: string,
    shape: ParticleShape,
    maxSpeedTilesPerSec: number,
    baseLifeMs: number,
    opts?: {
      dirX?: number;
      dirY?: number;
      directionalBias?: number;
      pxSize?: 1 | 2 | 3;
      bounce?: boolean;
      colorMid?: string;
      colorEnd?: string;
    },
  ): void {
    const dirX = opts?.dirX ?? 0;
    const dirY = opts?.dirY ?? 0;
    const bias = opts?.directionalBias ?? 0;
    for (let i = 0; i < count; i++) {
      const angle = this.nextFloat() * Math.PI * 2;
      const speed = (0.35 + this.nextFloat() * 0.65) * maxSpeedTilesPerSec;
      const life = baseLifeMs * (0.7 + this.nextFloat() * 0.55);
      const vx = Math.cos(angle) * speed + dirX * bias * maxSpeedTilesPerSec;
      const vy = Math.sin(angle) * speed + dirY * bias * maxSpeedTilesPerSec;
      this.spawnParticle({
        x,
        y,
        z: opts?.bounce ? 0.08 + this.nextFloat() * 0.14 : 0,
        vx,
        vy,
        vz: opts?.bounce ? 1.8 + this.nextFloat() * 1.4 : 0,
        gravity: opts?.bounce ? 8.5 : 0,
        bounceFactor: opts?.bounce ? 0.45 : 0,
        pxSize: opts?.pxSize ?? (this.nextFloat() > 0.5 ? 2 : 1),
        color,
        colorMid: opts?.colorMid,
        colorEnd: opts?.colorEnd,
        lifeMs: life,
        shape,
      });
    }
  }

  /**
   * 2.3 — Yönlü Ekran Sarsıntısı: Saldırı/patlama vektörü doğrultusunda sönümlü itme (Calm Screen %80 kısar).
   */
  public triggerShake(intensity: number, durationMs: number, dirX = 1, dirY = 0.25): void {
    const scaled = this.calmScreen ? intensity * 0.2 : intensity;
    const norm = Math.hypot(dirX, dirY) || 1;
    this.shakeIntensity = Math.max(this.shakeIntensity, scaled);
    this.shakeDirX = dirX / norm;
    this.shakeDirY = dirY / norm;
    this.shakeDurationMs = Math.max(this.shakeTimeLeftMs, durationMs);
    this.shakeTimeLeftMs = this.shakeDurationMs;
  }

  /**
   * 2.6 Kural 4 — Sakin Ekran: Tam ekran flaşlarını yumuşak kenar çerçevesine çevirir.
   */
  public triggerScreenFlash(color: string, alpha: number, durationMs: number): void {
    if (this.calmScreen) {
      this.borderFlashColor = color;
      this.borderFlashAlpha = Math.min(0.65, alpha);
      this.borderFlashDurationMs = durationMs;
      this.borderFlashLeftMs = durationMs;
      return;
    }
    this.screenFlashColor = color;
    this.screenFlashAlpha = Math.min(0.85, alpha);
    this.screenFlashDurationMs = durationMs;
    this.screenFlashLeftMs = durationMs;
  }

  public setBoardOutsideDim(targetAlpha: number): void {
    this.dimTargetAlpha = Math.max(0, Math.min(0.6, targetAlpha));
  }

  public triggerKillcam(target: Coord, zoomScale = 1.08, holdMs = 480): void {
    this.zoomTarget = { x: target.x + 0.5, y: target.y + 0.5 };
    this.zoomScale = zoomScale;
    this.zoomHoldMs = holdMs;
    this.grayscaleTarget = 1;
    this.splitCrown = {
      x: target.x + 0.5,
      y: target.y + 0.35,
      color: '#facc15',
      progress: 0,
    };
  }

  public setCrtShutdown(active: boolean): void {
    this.crtShutdownActive = active;
  }

  public setNazarLock(overlay: NazarLockOverlay | null): void {
    this.nazarLock = overlay;
  }

  public addFlameStreak(streak: FlameStreakOverlay): void {
    this.flameStreaks.push(streak);
  }

  public clearFlameStreaks(): void {
    this.flameStreaks = [];
  }

  public setSignalSparks(sparks: SignalSpark[]): void {
    this.signalSparks = sparks;
  }

  public update(dtMs: number): void {
    const dt = Math.max(0, dtMs);
    if (dt <= 0) return;
    const sec = dt / 1000;

    // 1. Update fixed 200-slot Particle Pool in-place
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const p = this.pool[i]!;
      if (!p.active) continue;
      p.ageMs += dt;
      if (p.ageMs >= p.lifeMs) {
        p.active = false;
        continue;
      }
      const progress = p.ageMs / p.lifeMs;
      if (p.spiralTarget !== undefined) {
        const dx = p.spiralTarget.x - p.x;
        const dy = p.spiralTarget.y - p.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.02) {
          const pull = (p.spiralSpeed ?? 4.8) * sec;
          const tangentX = -dy / dist;
          const tangentY = dx / dist;
          p.x += (dx / dist) * pull + tangentX * pull * 0.55;
          p.y += (dy / dist) * pull + tangentY * pull * 0.55;
        }
      } else {
        p.x += p.vx * sec;
        p.y += p.vy * sec;
        p.vx *= Math.pow(0.08, sec);
        p.vy *= Math.pow(0.08, sec);
      }

      if (p.gravity > 0) {
        p.z += p.vz * sec;
        p.vz -= p.gravity * sec;
        if (p.z < 0) {
          p.z = 0;
          if (p.bounceFactor > 0.05) {
            p.vz = Math.abs(p.vz) * p.bounceFactor;
            p.bounceFactor = 0; // bounce once cleanly
          } else {
            p.vz = 0;
          }
        }
      }

      p.alpha = Math.max(0, 1 - progress);
    }

    // 2. Update StarFlashes, GhostTrails, TileStains, Speedlines, RemoteRings
    for (let i = this.starFlashes.length - 1; i >= 0; i--) {
      const sf = this.starFlashes[i]!;
      sf.ageMs += dt;
      if (sf.ageMs >= sf.lifeMs) this.starFlashes.splice(i, 1);
    }
    for (let i = this.ghostTrails.length - 1; i >= 0; i--) {
      const gt = this.ghostTrails[i]!;
      gt.ageMs += dt;
      if (gt.ageMs >= gt.lifeMs) this.ghostTrails.splice(i, 1);
      else gt.alpha = 0.55 * (1 - gt.ageMs / gt.lifeMs);
    }
    for (let i = this.tileStains.length - 1; i >= 0; i--) {
      const st = this.tileStains[i]!;
      st.ageMs += dt;
      if (st.ageMs >= st.lifeMs) this.tileStains.splice(i, 1);
    }
    for (let i = this.speedlines.length - 1; i >= 0; i--) {
      const sl = this.speedlines[i]!;
      sl.ageMs += dt;
      if (sl.ageMs >= sl.lifeMs) this.speedlines.splice(i, 1);
    }
    for (let i = this.remoteSignalRings.length - 1; i >= 0; i--) {
      const rr = this.remoteSignalRings[i]!;
      rr.ageMs += dt;
      if (rr.ageMs >= rr.lifeMs) this.remoteSignalRings.splice(i, 1);
    }

    // 3. Camera Shake, Zoom, Flashes, Dim, Grayscale, Crown
    if (this.shakeTimeLeftMs > 0) {
      this.shakeTimeLeftMs = Math.max(0, this.shakeTimeLeftMs - dt);
      if (this.shakeTimeLeftMs === 0) {
        this.shakeIntensity = 0;
      }
    }

    if (this.screenFlashLeftMs > 0) {
      this.screenFlashLeftMs = Math.max(0, this.screenFlashLeftMs - dt);
    }
    if (this.borderFlashLeftMs > 0) {
      this.borderFlashLeftMs = Math.max(0, this.borderFlashLeftMs - dt);
    }

    if (this.dimBoardOutsideAlpha < this.dimTargetAlpha) {
      this.dimBoardOutsideAlpha = Math.min(this.dimTargetAlpha, this.dimBoardOutsideAlpha + sec * 3.2);
    } else if (this.dimBoardOutsideAlpha > this.dimTargetAlpha) {
      this.dimBoardOutsideAlpha = Math.max(this.dimTargetAlpha, this.dimBoardOutsideAlpha - sec * 2.8);
    }

    if (this.zoomHoldMs > 0) {
      this.zoomHoldMs = Math.max(0, this.zoomHoldMs - dt);
    } else if (this.zoomScale > 1) {
      this.zoomScale = Math.max(1, this.zoomScale - dt * this.zoomDecayRate);
      if (this.zoomScale <= 1.001) {
        this.zoomScale = 1;
        this.zoomTarget = null;
      }
    }

    if (this.grayscaleTarget > this.grayscaleProgress) {
      this.grayscaleProgress = Math.min(1, this.grayscaleProgress + dt / 350);
    } else if (this.grayscaleTarget < this.grayscaleProgress) {
      this.grayscaleProgress = Math.max(0, this.grayscaleProgress - dt / 250);
    }

    if (this.splitCrown !== null) {
      this.splitCrown.progress = Math.min(1, this.splitCrown.progress + dt / 460);
      if (this.splitCrown.progress >= 1 && !this.crtShutdownActive) {
        this.splitCrown = null;
      }
    }

    if (this.crtShutdownActive) {
      this.crtShutdownProgress = Math.min(1, this.crtShutdownProgress + dt / 240);
    } else if (this.crtShutdownProgress > 0) {
      this.crtShutdownProgress = Math.max(0, this.crtShutdownProgress - dt / 180);
    }
  }

  public getCameraFxState(): CameraFxState {
    let shakeOffset: Coord = { x: 0, y: 0 };
    if (this.shakeTimeLeftMs > 0 && this.shakeIntensity > 0) {
      const progress = 1 - this.shakeTimeLeftMs / this.shakeDurationMs;
      const decay = Math.max(0, 1 - progress);
      const dampedWave = 0.65 + 0.35 * Math.cos(progress * Math.PI * 5);
      const amp = this.shakeIntensity * decay * dampedWave;
      const orthoJitter = (this.nextFloat() * 2 - 1) * this.shakeIntensity * decay * 0.25;
      shakeOffset = {
        x: this.shakeDirX * amp - this.shakeDirY * orthoJitter,
        y: this.shakeDirY * amp + this.shakeDirX * orthoJitter,
      };
    }

    const sfRatio = this.screenFlashLeftMs > 0 ? this.screenFlashLeftMs / this.screenFlashDurationMs : 0;
    const bfRatio = this.borderFlashLeftMs > 0 ? this.borderFlashLeftMs / this.borderFlashDurationMs : 0;

    return {
      shakeOffset,
      zoomScale: this.zoomScale,
      zoomTarget: this.zoomTarget,
      screenFlashColor: sfRatio > 0 ? this.screenFlashColor : null,
      screenFlashAlpha: sfRatio > 0 ? this.screenFlashAlpha * sfRatio : 0,
      borderFlashColor: bfRatio > 0 ? this.borderFlashColor : null,
      borderFlashAlpha: bfRatio > 0 ? this.borderFlashAlpha * bfRatio : 0,
      dimBoardOutsideAlpha: this.dimBoardOutsideAlpha,
      grayscaleProgress: this.grayscaleProgress,
      crtShutdownProgress: this.crtShutdownProgress,
    };
  }

  public getStarFlashes(): readonly StarFlash[] {
    return this.starFlashes;
  }

  public getGhostTrails(): readonly PieceGhostTrail[] {
    return this.ghostTrails;
  }

  public getTileStains(): readonly TileStain[] {
    return this.tileStains;
  }

  public getSpeedlines(): readonly Speedline[] {
    return this.speedlines;
  }

  public getRemoteSignalRings(): readonly RemoteSignalRing[] {
    return this.remoteSignalRings;
  }

  public getSignalSparks(): readonly SignalSpark[] {
    return this.signalSparks;
  }

  public getNazarLock(): NazarLockOverlay | null {
    return this.nazarLock;
  }

  public getFlameStreaks(): readonly FlameStreakOverlay[] {
    return this.flameStreaks;
  }

  public getSplitCrown(): SplitCrownOverlay | null {
    return this.splitCrown;
  }
}

import type { SfxKind } from '../audio/synthSfx';
import type { Coord, GameEvent, Piece, PieceType, VisibleState } from '../engine/types';
import {
  type BfsDominoNode,
  type CameraFxState,
  computeBfsDominoWaves,
  evaluatePieceChoreography,
  type FlameStreakOverlay,
  getPieceExplosionPalette,
  JuiceEngine,
  type NazarLockOverlay,
  type PieceGhostTrail,
  type PooledParticle,
  type RemoteSignalRing,
  samplePolylinePath,
  type SignalSpark,
  type SplitCrownOverlay,
  type Speedline,
  type StarFlash,
  type TileStain,
} from './juiceEngine';

export interface PieceVisualOverride {
  x: number;
  y: number;
  scale: number;
  scaleX?: number;
  scaleY?: number;
  alpha: number;
  rotation: number;
  flashAlpha: number;
  dxTexels?: number;
  dyTexels?: number;
  shadowX?: number;
  shadowY?: number;
  auraBoostAlpha?: number;
  greenTintAlpha?: number;
  slotGlowAlpha?: number;
}

export interface GhostPieceVisual {
  piece: Piece;
  x: number;
  y: number;
  scale: number;
  alpha: number;
  rotation: number;
}

export type FxParticle = PooledParticle;

export interface FloatingText {
  x: number;
  y: number;
  text: string;
  color: string;
  ageMs: number;
  lifeMs: number;
}

export interface FxShockwave {
  x: number;
  y: number;
  maxRadiusTiles: number;
  progress: number;
  color: string;
}

export interface FxArrowBeam {
  from: Coord;
  to: Coord;
  progress: number;
  flaming: boolean;
}

export interface RoomTileAnimOffset {
  scale: number;
  dyTexels: number;
  alpha: number;
}

export interface FxRenderSnapshot {
  pieceOverrides: Record<string, PieceVisualOverride>;
  ghostPieces: GhostPieceVisual[];
  particles: readonly FxParticle[];
  floatingTexts: readonly FloatingText[];
  shockwaves?: readonly FxShockwave[];
  arrowBeams?: readonly FxArrowBeam[];
  starFlashes?: readonly StarFlash[];
  ghostTrails?: readonly PieceGhostTrail[];
  tileStains?: readonly TileStain[];
  speedlines?: readonly Speedline[];
  signalSparks?: readonly SignalSpark[];
  nazarLock?: NazarLockOverlay | null;
  flameStreaks?: readonly FlameStreakOverlay[];
  splitCrown?: SplitCrownOverlay | null;
  remoteSignalRings?: readonly RemoteSignalRing[];
  roomTileOffsets?: Record<string, RoomTileAnimOffset>;
  cameraFx?: CameraFxState;
  hitStopActive?: boolean;
  shakeOffset: Coord;
  isAnimating: boolean;
}

type AnimationStepKind =
  | 'MOVE'
  | 'SLIDE'
  | 'PUSH'
  | 'SHIELD_BREAK'
  | 'CAPTURE'
  | 'PIT_FALL'
  | 'BURN'
  | 'FREEZE'
  | 'IGNITE_GROUP'
  | 'EXTINGUISH_GROUP'
  | 'WALL_DESTROY'
  | 'ALERT'
  | 'SPAWN'
  | 'PROMOTE'
  | 'TURN_CHANGE'
  | 'MATCH_END'
  | 'GAS_BLAST'
  | 'PLATE_TRIGGER'
  | 'ARROW_SHOT'
  | 'TILE_COLLAPSE'
  | 'SPIKES_TICK'
  | 'FAITH_ULTIMATE'
  | 'MADNESS_ULTIMATE'
  | 'BERSERK_CHAIN'
  | 'CHIMERA_EVOLVE'
  | 'PSYCH_FX'
  | 'DISOBEY'
  | 'COMPOSURE_CRACK'
  | 'HALLUCINATION_DISPEL'
  | 'ROOM_COLLAPSE'
  | 'ROOM_DROP';

interface AnimationStep {
  kind: AnimationStepKind;
  durationMs: number;
  elapsedMs: number;
  started: boolean;
  comboAccelerated?: boolean;
  hitStopMs?: number;
  pieceId?: string;
  piece?: Piece;
  attackerId?: string;
  attackerPos?: Coord;
  attackDir?: Coord;
  path?: Coord[];
  isDrifted?: boolean;
  driftSign?: 1 | -1;
  pos?: Coord;
  positions?: Coord[];
  secondaryPositions?: Coord[];
  tertiaryPositions?: Coord[];
  targetPieceId?: string;
  targetPos?: Coord;
  radiusTiles?: number;
  flaming?: boolean;
  killed?: boolean;
  impaled?: boolean;
  suffocated?: boolean;
  incinerated?: boolean;
  faithWard?: boolean;
  blocked?: boolean;
  dominoNodes?: BfsDominoNode[];
  dominoTriggeredCount?: number;
  droppedColor?: string;
  implosionAccumMs?: number;
  trailAccumMs?: number;
  label?: string;
  color?: string;
  sfx?: SfxKind;
  shakeIntensity?: number;
  ghostPiece?: Piece;
  isKingDeath?: boolean;
  boardWidth?: number;
  boardHeight?: number;
}

export type SfxCallback = (kind: SfxKind) => void;

function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function isCoordVisible(
  coord: Coord,
  prevView?: VisibleState,
  nextView?: VisibleState,
): boolean {
  if (prevView === undefined && nextView === undefined) return true;
  if (prevView !== undefined && prevView.fog[coord.y]?.[coord.x] === 'VISIBLE') return true;
  if (nextView !== undefined && nextView.fog[coord.y]?.[coord.x] === 'VISIBLE') return true;
  return false;
}

function isPieceOwnedByViewer(pieceId: string, pieces: readonly Piece[], viewer?: string): boolean {
  if (viewer === undefined || viewer === 'OMNISCIENT') return true;
  const found = pieces.find((p) => p.id === pieceId);
  return found !== undefined && found.side === viewer;
}

function hasFaithWardProtection(piece: Piece | undefined): boolean {
  if (piece === undefined) return false;
  if (piece.type === 'SAINT_FAITH') return true;
  if (
    piece.type === 'CHIMERA' &&
    (piece.absorbedForms ?? []).some((f) => f.saintEcho === 'FAITH_WARD')
  ) {
    return true;
  }
  return false;
}

function resolveCopperWaypoints(from: Coord, to: Coord): Coord[] {
  const mid: Coord = { x: to.x, y: from.y };
  if ((mid.x === from.x && mid.y === from.y) || (mid.x === to.x && mid.y === to.y)) {
    return [{ x: from.x, y: from.y }, { x: to.x, y: to.y }];
  }
  return [{ x: from.x, y: from.y }, mid, { x: to.x, y: to.y }];
}

function findEmitterCoordsForPlate(
  plateCoord: Coord,
  view: VisibleState | undefined,
): Coord[] {
  if (view === undefined) return [];
  const plateTile = view.tiles[plateCoord.y]?.[plateCoord.x];
  if (plateTile?.trap?.kind !== 'PRESSURE_PLATE') return [];
  const targetIds = plateTile.trap.targetIds;
  const out: Coord[] = [];
  for (let y = 0; y < view.height; y++) {
    for (let x = 0; x < view.width; x++) {
      const trap = view.tiles[y]?.[x]?.trap;
      if (trap?.kind === 'ARROW_EMITTER' && targetIds.includes(trap.id)) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

/**
 * Deterministic sequential animation and visual FX queue driven by GameEvent[] + JuiceEngine.
 * Consumes dtMs via update(), supports Combo 25% acceleration, 100ms Input Buffer, 2x Hit-Stop floor,
 * and Calm Screen accessibility mode. Zero DOM, zero Math.random().
 */
export class FxQueue {
  private steps: AnimationStep[] = [];
  private floatingTexts: FloatingText[] = [];
  private speedMultiplier: 1 | 2 = 1;
  private sfxCallback: SfxCallback | null;
  private readonly juice: JuiceEngine;

  private pieceAnchors: Record<string, Coord> = {};
  private activeGhosts: Record<string, GhostPieceVisual> = {};
  private bufferedInput: (() => void) | null = null;

  private hitStopLeftMs = 0;
  private hitStopPieceId: string | null = null;

  public constructor(sfxCallback: SfxCallback | null = null, seed = 'tfc-fx-seed') {
    this.sfxCallback = sfxCallback;
    this.juice = new JuiceEngine(seed);
  }

  public getJuiceEngine(): JuiceEngine {
    return this.juice;
  }

  public setSpeed(speed: 1 | 2): void {
    this.speedMultiplier = speed;
  }

  public getSpeed(): 1 | 2 {
    return this.speedMultiplier;
  }

  public setCalmScreen(enabled: boolean): void {
    this.juice.setCalmScreen(enabled);
  }

  public isCalmScreen(): boolean {
    return this.juice.isCalmScreen();
  }

  public isAnimating(): boolean {
    return (
      this.steps.length > 0 ||
      this.hitStopLeftMs > 0 ||
      this.floatingTexts.length > 0 ||
      this.juice.hasActiveEffects()
    );
  }

  public hasActiveSteps(): boolean {
    return this.steps.length > 0 || this.hitStopLeftMs > 0;
  }

  /**
   * 2.6 Kural 2 — Kuyruğun kalan tahmini süresini gerçek milisaniye cinsinden döndürür.
   */
  public getRemainingDurationMs(): number {
    const speedFactor = this.speedMultiplier === 2 ? 1.86 : 1;
    let total = this.hitStopLeftMs;
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i]!;
      const rem = Math.max(0, s.durationMs - s.elapsedMs);
      total += rem / speedFactor;
      if (!s.started && (s.hitStopMs ?? 0) > 0) {
        total +=
          this.speedMultiplier === 2
            ? Math.max(28, Math.round((s.hitStopMs ?? 0) * 0.54))
            : (s.hitStopMs ?? 0);
      }
    }
    return total;
  }

  /**
   * Animasyonun son 100 ms penceresindeyse true döner (Input Buffering).
   */
  public isInInputBufferWindow(): boolean {
    return this.hasActiveSteps() && this.getRemainingDurationMs() <= 100;
  }

  /**
   * Son 100 ms içindeysek tıklamayı tamponlar ve kuyruk bitince otomatik işletir.
   */
  public bufferInput(action: () => void): boolean {
    if (!this.isInInputBufferWindow()) return false;
    this.bufferedInput = action;
    return true;
  }

  public hasBufferedInput(): boolean {
    return this.bufferedInput !== null;
  }

  public skipAll(): void {
    this.steps = [];
    this.floatingTexts = [];
    this.pieceAnchors = {};
    this.activeGhosts = {};
    this.hitStopLeftMs = 0;
    this.hitStopPieceId = null;
    this.bufferedInput = null;
    this.juice.reset();
  }

  /**
   * 2.6 Oda Geçişi — Karelerin dıştan merkeze çökmesi veya taşların gökten tozla inmesi.
   */
  public triggerRoomTransition(
    mode: 'COLLAPSE' | 'DROP',
    boardWidth: number,
    boardHeight: number,
    pieces: readonly Piece[] = [],
  ): void {
    const durationMs = mode === 'COLLAPSE' ? 260 : 450;
    this.steps.push({
      kind: mode === 'COLLAPSE' ? 'ROOM_COLLAPSE' : 'ROOM_DROP',
      durationMs,
      elapsedMs: 0,
      started: false,
      boardWidth,
      boardHeight,
      positions: pieces.map((p) => ({ x: p.pos.x, y: p.pos.y })),
      sfx: mode === 'COLLAPSE' ? 'roomCollapse' : 'roomDrop',
    });
  }

  /**
   * 2P Uzaktan gelen hamle sinyali (100 ms kızıl çıkış halkası).
   */
  public triggerRemoteSignal(coord: Coord): void {
    this.juice.spawnRemoteSignal(coord, '#f43f5e', 140);
    this.sfxCallback?.('remoteSignal');
  }

  /**
   * GameEvent[] listesini deterministik sıralı animasyon adımlarına çevirir.
   */
  public enqueue(
    events: readonly GameEvent[],
    prevPieces: readonly Piece[],
    prevView?: VisibleState,
    nextView?: VisibleState,
  ): void {
    const prevById: Record<string, Piece> = {};
    for (let i = 0; i < prevPieces.length; i++) {
      const p = prevPieces[i]!;
      prevById[p.id] = p;
    }

    const viewer = nextView?.viewer ?? prevView?.viewer;
    const allPieces = [
      ...prevPieces,
      ...(nextView !== undefined ? nextView.pieces : []),
    ];

    const pendingSteps: AnimationStep[] = [];
    let lastAttackerId: string | undefined;
    let lastAttackerPos: Coord | undefined;
    let idx = 0;

    while (idx < events.length) {
      const ev = events[idx]!;

      // Group consecutive TILE_IGNITED events
      if (ev.type === 'TILE_IGNITED') {
        const positions: Coord[] = [];
        while (idx < events.length && events[idx]!.type === 'TILE_IGNITED') {
          const item = events[idx] as Extract<GameEvent, { type: 'TILE_IGNITED' }>;
          if (isCoordVisible(item.pos, prevView, nextView)) {
            positions.push({ x: item.pos.x, y: item.pos.y });
          }
          idx++;
        }
        if (positions.length > 0) {
          pendingSteps.push({
            kind: 'IGNITE_GROUP',
            durationMs: 140,
            elapsedMs: 0,
            started: false,
            positions,
            sfx: 'ignite',
            shakeIntensity: positions.length >= 3 ? 4 : 2,
          });
        }
        continue;
      }

      // Group consecutive TILE_EXTINGUISHED events
      if (ev.type === 'TILE_EXTINGUISHED') {
        const positions: Coord[] = [];
        while (idx < events.length && events[idx]!.type === 'TILE_EXTINGUISHED') {
          const item = events[idx] as Extract<GameEvent, { type: 'TILE_EXTINGUISHED' }>;
          if (isCoordVisible(item.pos, prevView, nextView)) {
            positions.push({ x: item.pos.x, y: item.pos.y });
          }
          idx++;
        }
        if (positions.length > 0) {
          pendingSteps.push({
            kind: 'EXTINGUISH_GROUP',
            durationMs: 90,
            elapsedMs: 0,
            started: false,
            positions,
            sfx: 'extinguish',
          });
        }
        continue;
      }

      idx++;

      switch (ev.type) {
        case 'PIECE_DRIFTED': {
          const nextEv = events[idx];
          if (nextEv?.type === 'PIECE_MOVED' && nextEv.pieceId === ev.pieceId) {
            idx++;
            const mover = prevById[nextEv.pieceId] ?? allPieces.find((p) => p.id === nextEv.pieceId);
            const visible =
              isPieceOwnedByViewer(nextEv.pieceId, allPieces, viewer) ||
              ev.path.some((c) => isCoordVisible(c, prevView, nextView));
            if (visible) {
              if (this.pieceAnchors[nextEv.pieceId] === undefined) {
                this.pieceAnchors[nextEv.pieceId] = { x: nextEv.from.x, y: nextEv.from.y };
              }
              lastAttackerId = nextEv.pieceId;
              lastAttackerPos = { x: nextEv.from.x, y: nextEv.from.y };
              pendingSteps.push({
                kind: 'MOVE',
                durationMs: 210,
                elapsedMs: 0,
                started: false,
                pieceId: nextEv.pieceId,
                piece: mover,
                path: ev.path.map((c) => ({ x: c.x, y: c.y })),
                isDrifted: true,
                driftSign: ev.driftSign,
                pos: ev.path[ev.path.length - 1] ?? nextEv.to,
                label: '45° YALPA!',
                color: '#c084fc',
                sfx: 'move',
              });
            }
          } else {
            const endPos = ev.path[ev.path.length - 1];
            if (endPos !== undefined && isCoordVisible(endPos, prevView, nextView)) {
              pendingSteps.push({
                kind: 'PSYCH_FX',
                durationMs: 140,
                elapsedMs: 0,
                started: false,
                pieceId: ev.pieceId,
                pos: { x: endPos.x, y: endPos.y },
                label: '45° YALPA!',
                color: '#c084fc',
              });
            }
          }
          break;
        }

        case 'PIECE_MOVED': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.from, prevView, nextView) ||
            isCoordVisible(ev.to, prevView, nextView);
          if (!visible) break;
          if (this.pieceAnchors[ev.pieceId] === undefined) {
            this.pieceAnchors[ev.pieceId] = { x: ev.from.x, y: ev.from.y };
          }
          const mover = prevById[ev.pieceId] ?? allPieces.find((p) => p.id === ev.pieceId);
          lastAttackerId = ev.pieceId;
          lastAttackerPos = { x: ev.from.x, y: ev.from.y };
          const durByType: Record<PieceType, number> = {
            PAWN: 170,
            KNIGHT: 240,
            ROOK: 165,
            BISHOP: 185,
            QUEEN: 190,
            KING: 195,
            SAINT_FAITH: 190,
            SAINT_MADNESS: 175,
            CHIMERA: 210,
          };
          pendingSteps.push({
            kind: 'MOVE',
            durationMs: mover ? durByType[mover.type] : 165,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            piece: mover,
            path: [
              { x: ev.from.x, y: ev.from.y },
              { x: ev.to.x, y: ev.to.y },
            ],
            sfx: 'move',
          });
          break;
        }

        case 'PIECE_SLID': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            ev.path.some((c) => isCoordVisible(c, prevView, nextView));
          if (!visible) break;
          const startCoord = ev.path[0] ?? ev.to;
          if (this.pieceAnchors[ev.pieceId] === undefined) {
            this.pieceAnchors[ev.pieceId] = { x: startCoord.x, y: startCoord.y };
          }
          const slider = prevById[ev.pieceId] ?? allPieces.find((p) => p.id === ev.pieceId);
          const durationMs = Math.min(340, Math.max(180, ev.path.length * 65));
          pendingSteps.push({
            kind: 'SLIDE',
            durationMs,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            piece: slider,
            path: ev.path.map((c) => ({ x: c.x, y: c.y })),
            sfx: 'slide',
          });
          break;
        }

        case 'PIECE_PUSHED': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.from, prevView, nextView) ||
            isCoordVisible(ev.to, prevView, nextView);
          if (!visible) break;
          const blocked = ev.from.x === ev.to.x && ev.from.y === ev.to.y;
          if (this.pieceAnchors[ev.pieceId] === undefined) {
            this.pieceAnchors[ev.pieceId] = { x: ev.from.x, y: ev.from.y };
          }
          pendingSteps.push({
            kind: 'PUSH',
            durationMs: blocked ? 120 : 150,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            attackDir: {
              x: ev.to.x - ev.from.x || 1,
              y: ev.to.y - ev.from.y,
            },
            path: [
              { x: ev.from.x, y: ev.from.y },
              { x: ev.to.x, y: ev.to.y },
            ],
            pos: { x: ev.to.x, y: ev.to.y },
            blocked,
            label: blocked ? 'ENGELLENDİ!' : 'İTİLDİ!',
            color: '#c084fc',
            sfx: 'push',
            shakeIntensity: blocked ? 3 : 2,
          });
          break;
        }

        case 'SHIELD_BROKEN': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.pos, prevView, nextView);
          if (!visible) break;
          const victim = prevById[ev.pieceId] ?? allPieces.find((p) => p.id === ev.pieceId);
          const isNazar = hasFaithWardProtection(victim);
          const dirX = lastAttackerPos !== undefined ? ev.pos.x - lastAttackerPos.x : 1;
          const dirY = lastAttackerPos !== undefined ? ev.pos.y - lastAttackerPos.y : 0;
          pendingSteps.push({
            kind: 'SHIELD_BREAK',
            durationMs: 210,
            elapsedMs: 0,
            started: false,
            hitStopMs: 50,
            pieceId: ev.pieceId,
            piece: victim,
            attackerId: ev.source === 'ATTACK' ? lastAttackerId : undefined,
            attackDir: { x: dirX || 1, y: dirY },
            pos: { x: ev.pos.x, y: ev.pos.y },
            faithWard: isNazar,
            label: isNazar ? 'BONCUK ÇATLADI!' : 'KALKAN KIRILDI!',
            color: '#38bdf8',
            sfx: 'shieldBreak',
            shakeIntensity: 5,
          });
          break;
        }

        case 'PIECE_CAPTURED': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.pos, prevView, nextView);
          if (!visible) break;
          const victim = prevById[ev.pieceId];
          if (victim !== undefined && this.activeGhosts[victim.id] === undefined) {
            this.activeGhosts[victim.id] = {
              piece: victim,
              x: victim.pos.x,
              y: victim.pos.y,
              scale: 1,
              alpha: 1,
              rotation: 0,
            };
          }
          const attacker = prevById[ev.byPieceId] ?? allPieces.find((p) => p.id === ev.byPieceId);
          const dirX = attacker ? ev.pos.x - attacker.pos.x : 1;
          const dirY = attacker ? ev.pos.y - attacker.pos.y : 0;
          const isKing = ev.pieceType === 'KING';
          pendingSteps.push({
            kind: 'CAPTURE',
            durationMs: isKing ? 380 : 210,
            elapsedMs: 0,
            started: false,
            hitStopMs: isKing ? 150 : 65,
            pieceId: ev.pieceId,
            piece: victim,
            attackerId: ev.byPieceId,
            attackDir: { x: dirX || 1, y: dirY },
            pos: { x: ev.pos.x, y: ev.pos.y },
            ghostPiece: victim,
            isKingDeath: isKing,
            label: isKing ? 'ŞAH DÜŞTÜ!' : 'ELE GEÇİRİLDİ!',
            color: '#f87171',
            sfx: 'capture',
            shakeIntensity: isKing ? 9 : 4.5,
          });
          break;
        }

        case 'PIECE_FELL_IN_PIT': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.pos, prevView, nextView);
          if (!visible) break;
          const fallen = prevById[ev.pieceId];
          if (fallen !== undefined && this.activeGhosts[fallen.id] === undefined) {
            this.activeGhosts[fallen.id] = {
              piece: fallen,
              x: fallen.pos.x,
              y: fallen.pos.y,
              scale: 1,
              alpha: 1,
              rotation: 0,
            };
          }
          const isKing = ev.pieceType === 'KING';
          pendingSteps.push({
            kind: 'PIT_FALL',
            durationMs: 260,
            elapsedMs: 0,
            started: false,
            hitStopMs: isKing ? 150 : 0,
            pieceId: ev.pieceId,
            piece: fallen,
            pos: { x: ev.pos.x, y: ev.pos.y },
            ghostPiece: fallen,
            isKingDeath: isKing,
            label: 'ÇUKURA DÜŞTÜ!',
            color: '#a855f7',
            sfx: 'pitFall',
            shakeIntensity: isKing ? 9 : 6,
          });
          break;
        }

        case 'PIECE_BURNED': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.pos, prevView, nextView);
          if (!visible) break;
          const burned = ev.killed ? prevById[ev.pieceId] : undefined;
          if (burned !== undefined && this.activeGhosts[burned.id] === undefined) {
            this.activeGhosts[burned.id] = {
              piece: burned,
              x: ev.pos.x,
              y: ev.pos.y,
              scale: 1,
              alpha: 1,
              rotation: 0,
            };
          }
          pendingSteps.push({
            kind: 'BURN',
            durationMs: 210,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            piece: burned,
            pos: { x: ev.pos.x, y: ev.pos.y },
            killed: ev.killed,
            incinerated: true,
            ghostPiece: burned,
            label: ev.killed ? 'ALEVDE KÜL OLDU!' : 'YANMA HASARI',
            color: '#fb923c',
            sfx: 'burn',
            shakeIntensity: ev.killed ? 5 : 2,
          });
          break;
        }

        case 'PIECE_FROZEN': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.pos, prevView, nextView);
          if (!visible) break;
          pendingSteps.push({
            kind: 'FREEZE',
            durationMs: 170,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            pos: { x: ev.pos.x, y: ev.pos.y },
            label: 'DONDU!',
            color: '#7dd3fc',
            sfx: 'freeze',
            shakeIntensity: 2,
          });
          break;
        }

        case 'WALL_DESTROYED': {
          if (!isCoordVisible(ev.pos, prevView, nextView)) break;
          pendingSteps.push({
            kind: 'WALL_DESTROY',
            durationMs: 220,
            elapsedMs: 0,
            started: false,
            pos: { x: ev.pos.x, y: ev.pos.y },
            label: 'DUVAR YIKILDI!',
            color: '#fbbf24',
            sfx: 'wallDestroy',
            shakeIntensity: 8,
          });
          break;
        }

        case 'ENEMY_ALERTED': {
          if (!isCoordVisible(ev.pos, prevView, nextView)) break;
          pendingSteps.push({
            kind: 'ALERT',
            durationMs: 160,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            pos: { x: ev.pos.x, y: ev.pos.y },
            label: '! UYANDI',
            color: '#f59e0b',
            sfx: 'alert',
          });
          break;
        }

        case 'UNIT_SPAWNED': {
          if (!isCoordVisible(ev.pos, prevView, nextView)) break;
          pendingSteps.push({
            kind: 'SPAWN',
            durationMs: 200,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            pos: { x: ev.pos.x, y: ev.pos.y },
            label: 'İSKELET DOĞDU!',
            color: '#34d399',
            sfx: 'spawn',
          });
          break;
        }

        case 'PIECE_PROMOTED': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.pos, prevView, nextView);
          if (!visible) break;
          pendingSteps.push({
            kind: 'PROMOTE',
            durationMs: 220,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            pos: { x: ev.pos.x, y: ev.pos.y },
            label: 'VEZİR TERFİ!',
            color: '#facc15',
            sfx: 'promote',
          });
          break;
        }

        case 'TURN_CHANGED': {
          pendingSteps.push({
            kind: 'TURN_CHANGE',
            durationMs: 55,
            elapsedMs: 0,
            started: false,
            sfx: 'turnChange',
          });
          break;
        }

        case 'MATCH_ENDED': {
          const cx = (nextView?.width ?? prevView?.width ?? 8) / 2;
          const cy = (nextView?.height ?? prevView?.height ?? 8) / 2;
          const loserSide = ev.winner === 'PLAYER' ? 'ENEMY' : ev.winner === 'ENEMY' ? 'PLAYER' : null;
          const lostKing = prevPieces.find((p) => p.type === 'KING' && (loserSide === null || p.side === loserSide));
          const focusPos = lostKing ? { x: lostKing.pos.x, y: lostKing.pos.y } : { x: cx - 0.5, y: cy - 0.5 };
          const alreadyTriggeredKingKillcam = pendingSteps.some((s) => s.isKingDeath);
          pendingSteps.push({
            kind: 'MATCH_END',
            durationMs: 420,
            elapsedMs: 0,
            started: false,
            hitStopMs: alreadyTriggeredKingKillcam ? 0 : 150,
            pos: focusPos,
            isKingDeath: !alreadyTriggeredKingKillcam,
            label:
              ev.winner === 'PLAYER'
                ? 'ZAFER!'
                : ev.winner === 'ENEMY'
                  ? 'YENİLGİ!'
                  : 'BERABERE!',
            color: ev.winner === 'PLAYER' ? '#34d399' : '#f87171',
            sfx: ev.winner === 'PLAYER' ? 'victory' : 'defeat',
            shakeIntensity: 9,
          });
          break;
        }

        case 'GAS_CHAIN_DETONATED': {
          const visible =
            isCoordVisible(ev.origin, prevView, nextView) ||
            ev.tiles.some((c) => isCoordVisible(c, prevView, nextView));
          if (!visible) break;
          const dominoNodes = computeBfsDominoWaves(ev.origin, ev.tiles);
          const maxWave = dominoNodes.length > 0 ? dominoNodes[dominoNodes.length - 1]!.wave : 0;
          const durationMs = 45 + maxWave * 25 + 240;
          pendingSteps.push({
            kind: 'GAS_BLAST',
            durationMs,
            elapsedMs: 0,
            started: false,
            pos: { x: ev.origin.x, y: ev.origin.y },
            positions: ev.tiles.map((c) => ({ x: c.x, y: c.y })),
            dominoNodes,
            dominoTriggeredCount: 0,
            implosionAccumMs: 0,
            label: 'GAZ PATLAMASI!',
            color: '#4ade80',
            sfx: 'gasBlast',
            shakeIntensity: 8.5,
          });
          break;
        }

        case 'PLATE_TRIGGERED': {
          if (!isCoordVisible(ev.at, prevView, nextView)) break;
          const emitters = findEmitterCoordsForPlate(ev.at, prevView ?? nextView);
          pendingSteps.push({
            kind: 'PLATE_TRIGGER',
            durationMs: emitters.length > 0 ? 120 : 80,
            elapsedMs: 0,
            started: false,
            pos: { x: ev.at.x, y: ev.at.y },
            positions: emitters,
            label: 'KLİK!',
            color: '#f59e0b',
            sfx: 'plateClick',
          });
          break;
        }

        case 'ARROW_FIRED': {
          const visible =
            isCoordVisible(ev.from, prevView, nextView) ||
            ev.path.some((c) => isCoordVisible(c, prevView, nextView));
          if (!visible) break;
          const endPos = ev.path[ev.path.length - 1] ?? ev.from;
          pendingSteps.push({
            kind: 'ARROW_SHOT',
            durationMs: Math.min(220, Math.max(95, 50 + ev.path.length * 22)),
            elapsedMs: 0,
            started: false,
            pos: { x: ev.from.x, y: ev.from.y },
            path: [{ x: ev.from.x, y: ev.from.y }, { x: endPos.x, y: endPos.y }],
            flaming: ev.flaming,
            sfx: 'arrowShot',
          });
          break;
        }

        case 'TILE_COLLAPSED': {
          if (!isCoordVisible(ev.at, prevView, nextView)) break;
          pendingSteps.push({
            kind: 'TILE_COLLAPSE',
            durationMs: 230,
            elapsedMs: 0,
            started: false,
            pos: { x: ev.at.x, y: ev.at.y },
            label: 'ÇÖKTÜ!',
            color: '#94a3b8',
            sfx: 'tileCollapse',
            shakeIntensity: 4,
          });
          break;
        }

        case 'SPIKES_PHASE_CHANGED': {
          const visChanges = ev.changes.filter((c) => isCoordVisible(c.at, prevView, nextView));
          if (visChanges.length === 0) break;
          const anyExtended = visChanges.some((c) => c.phase === 2);
          pendingSteps.push({
            kind: 'SPIKES_TICK',
            durationMs: anyExtended ? 90 : 110,
            elapsedMs: 0,
            started: false,
            positions: visChanges.map((c) => ({ x: c.at.x, y: c.at.y })),
            sfx: anyExtended ? 'spikeStrike' : 'spikeTelegraph',
            shakeIntensity: anyExtended ? 3 : 0,
          });
          break;
        }

        case 'PIECE_CHOKED_BY_MIASMA': {
          if (!isCoordVisible(ev.at, prevView, nextView)) break;
          pendingSteps.push({
            kind: 'PSYCH_FX',
            durationMs: 180,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            pos: { x: ev.at.x, y: ev.at.y },
            label: 'Z. SİS FELCİ!',
            color: '#4ade80',
            sfx: 'miasmaChoke',
          });
          break;
        }

        case 'PIECE_SUFFOCATED':
        case 'PIECE_INCINERATED':
        case 'PIECE_SKEWERED': {
          const visible =
            isPieceOwnedByViewer(ev.pieceId, allPieces, viewer) ||
            isCoordVisible(ev.at, prevView, nextView);
          if (!visible) break;
          const dead = prevById[ev.pieceId] ?? prevView?.pieces.find((p) => p.id === ev.pieceId);
          if (dead !== undefined && this.activeGhosts[ev.pieceId] === undefined) {
            this.activeGhosts[ev.pieceId] = {
              piece: dead,
              x: ev.at.x,
              y: ev.at.y,
              scale: 1,
              alpha: 1,
              rotation: 0,
            };
          }
          const isImpale = ev.type === 'PIECE_SKEWERED';
          const isSuffocate = ev.type === 'PIECE_SUFFOCATED';
          const isIncinerate = ev.type === 'PIECE_INCINERATED';
          pendingSteps.push({
            kind: 'CAPTURE',
            durationMs: isSuffocate || isImpale ? 210 : 220,
            elapsedMs: 0,
            started: false,
            hitStopMs: isImpale ? 55 : 0,
            pieceId: ev.pieceId,
            piece: dead,
            pos: { x: ev.at.x, y: ev.at.y },
            killed: true,
            impaled: isImpale,
            suffocated: isSuffocate,
            incinerated: isIncinerate,
            ghostPiece: dead,
            isKingDeath: dead?.type === 'KING',
            label: isSuffocate
              ? 'BOĞULDU!'
              : isIncinerate
                ? 'KÜL OLDU!'
                : 'ŞİŞLENDİ!',
            color: isSuffocate ? '#4ade80' : isIncinerate ? '#f97316' : '#ef4444',
            sfx: isSuffocate ? 'miasmaChoke' : isIncinerate ? 'burn' : 'spikeStrike',
            shakeIntensity: 5.5,
          });
          break;
        }

        case 'COMPOSURE_CHANGED': {
          if (ev.to < ev.from) {
            const p = allPieces.find((x) => x.id === ev.pieceId);
            if (p && isCoordVisible(p.pos, prevView, nextView)) {
              pendingSteps.push({
                kind: 'COMPOSURE_CRACK',
                durationMs: 70,
                elapsedMs: 0,
                started: false,
                pieceId: ev.pieceId,
                pos: { x: p.pos.x, y: p.pos.y },
                color: '#c084fc',
              });
            }
          }
          break;
        }

        case 'PIECE_BREAKDOWN': {
          if (!isCoordVisible(ev.at, prevView, nextView)) break;
          pendingSteps.push({
            kind: 'PSYCH_FX',
            durationMs: 220,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            pos: { x: ev.at.x, y: ev.at.y },
            label: 'SİNİR KRİZİ!',
            color: '#f43f5e',
            sfx: 'breakdown',
            shakeIntensity: 5,
          });
          break;
        }

        case 'PIECE_DISOBEYED': {
          const actor = allPieces.find((p) => p.id === ev.pieceId);
          const pos = actor?.pos ?? ev.attemptedTo;
          pendingSteps.push({
            kind: 'DISOBEY',
            durationMs: 250,
            elapsedMs: 0,
            started: false,
            pieceId: ev.pieceId,
            pos: { x: pos.x, y: pos.y },
            targetPos: { x: ev.attemptedTo.x, y: ev.attemptedTo.y },
            label: 'İTAATSİZ!',
            color: '#fbbf24',
            sfx: 'disobey',
            shakeIntensity: 3,
          });
          break;
        }

        case 'FAITH_ULTIMATE_TRIGGERED': {
          if (!isCoordVisible(ev.pulseOrigin, prevView, nextView)) break;
          const allyCoords = ev.cleansedAllyIds
            .map((id) => allPieces.find((p) => p.id === id)?.pos)
            .filter((c): c is Coord => c !== undefined);
          const enemyCoords = ev.silencedEnemyIds
            .map((id) => allPieces.find((p) => p.id === id)?.pos)
            .filter((c): c is Coord => c !== undefined);
          const immuneChimeras = allPieces
            .filter(
              (p) =>
                p.type === 'CHIMERA' &&
                Math.max(Math.abs(p.pos.x - ev.pulseOrigin.x), Math.abs(p.pos.y - ev.pulseOrigin.y)) <=
                  ev.pulseRadius,
            )
            .map((p) => ({ x: p.pos.x, y: p.pos.y }));
          const shieldedTarget = allPieces.find((p) => p.id === ev.shieldedTargetId);
          pendingSteps.push({
            kind: 'FAITH_ULTIMATE',
            durationMs: 680,
            elapsedMs: 0,
            started: false,
            pieceId: ev.saintId,
            targetPieceId: ev.shieldedTargetId,
            targetPos: shieldedTarget ? { x: shieldedTarget.pos.x, y: shieldedTarget.pos.y } : undefined,
            pos: { x: ev.pulseOrigin.x, y: ev.pulseOrigin.y },
            radiusTiles: ev.pulseRadius,
            positions: allyCoords,
            secondaryPositions: enemyCoords,
            tertiaryPositions: immuneChimeras,
            label: '7×7 ARINMA & SUSTURMA!',
            color: '#fbbf24',
            sfx: 'faithUltimate',
            shakeIntensity: 5.5,
          });
          break;
        }

        case 'MADNESS_ULTIMATE_TRIGGERED': {
          if (!isCoordVisible(ev.at, prevView, nextView)) break;
          const saintPiece = allPieces.find((p) => p.id === ev.saintId);
          pendingSteps.push({
            kind: 'MADNESS_ULTIMATE',
            durationMs: 600,
            elapsedMs: 0,
            started: false,
            pieceId: ev.saintId,
            targetPieceId: ev.targetId,
            pos: saintPiece ? { x: saintPiece.pos.x, y: saintPiece.pos.y } : { x: ev.at.x, y: ev.at.y },
            targetPos: { x: ev.at.x, y: ev.at.y },
            label: 'KANLI CİNNET!',
            color: '#f43f5e',
            sfx: 'madnessUltimate',
            shakeIntensity: 5,
          });
          break;
        }

        case 'BERSERK_CHAIN_TRIGGERED': {
          if (!isCoordVisible(ev.at, prevView, nextView)) break;
          const kickedPiece = ev.kickedPieceId
            ? allPieces.find((p) => p.id === ev.kickedPieceId)
            : undefined;
          pendingSteps.push({
            kind: 'BERSERK_CHAIN',
            durationMs: 320,
            elapsedMs: 0,
            started: false,
            hitStopMs: 85,
            pieceId: ev.pieceId,
            pos: { x: ev.at.x, y: ev.at.y },
            targetPieceId: ev.kickedPieceId,
            targetPos: kickedPiece ? { x: kickedPiece.pos.x, y: kickedPiece.pos.y } : undefined,
            label: 'BİR HAMLE DAHA!',
            color: '#fb7185',
            sfx: 'madnessUltimate',
            shakeIntensity: 5,
          });
          break;
        }

        case 'CHIMERA_EVOLVED': {
          const ch = allPieces.find((p) => p.id === ev.chimeraId);
          if (ch === undefined || !isCoordVisible(ch.pos, prevView, nextView)) break;
          const paletteForDropped =
            ev.droppedType !== undefined
              ? getPieceExplosionPalette({ ...ch, type: ev.droppedType }, 'default')[0] ?? '#fef3c7'
              : undefined;
          pendingSteps.push({
            kind: 'CHIMERA_EVOLVE',
            durationMs: 620,
            elapsedMs: 0,
            started: false,
            pieceId: ev.chimeraId,
            pos: { x: ch.pos.x, y: ch.pos.y },
            droppedColor: paletteForDropped,
            label: 'KILIK ÇALINDI!',
            color: '#10b981',
            sfx: 'chimeraEvolve',
            shakeIntensity: 5,
          });
          break;
        }

        case 'HALLUCINATION_DISPELLED': {
          pendingSteps.push({
            kind: 'HALLUCINATION_DISPEL',
            durationMs: 200,
            elapsedMs: 0,
            started: false,
            pos: { x: ev.at.x, y: ev.at.y },
            label: 'HALÜSİNASYON!',
            color: '#f87171',
            sfx: 'hallucinationDispel',
          });
          break;
        }

        case 'PIECE_MIASMA_TICK':
        case 'SAINT_AURA_TICK':
        case 'PIECE_SILENCE_EXPIRED':
          break;
      }
    }

    // 2.6 Kural 1 — Kombo Hızlanması: 3+ olaylı aksiyonda 3. olaydan itibaren süreler %25 kısalır.
    if (pendingSteps.length >= 3) {
      for (let i = 2; i < pendingSteps.length; i++) {
        const st = pendingSteps[i]!;
        st.durationMs = Math.max(40, Math.round(st.durationMs * 0.75));
        st.comboAccelerated = true;
      }
    }

    for (let i = 0; i < pendingSteps.length; i++) {
      this.steps.push(pendingSteps[i]!);
    }
  }

  /**
   * Animasyonları, sabit havuz parçacıklarını, sarsıntıyı ve Input Buffer'ı dtMs kadar ilerletir.
   */
  public update(rawDtMs: number): void {
    const rawDt = Math.max(0, rawDtMs);
    if (rawDt <= 0) return;

    // 1. Hit-Stop freezes combat step progression while keeping star flash & white silhouette blazing
    if (this.hitStopLeftMs > 0) {
      const consumed = Math.min(this.hitStopLeftMs, rawDt);
      this.hitStopLeftMs = Math.max(0, this.hitStopLeftMs - consumed);
      const spillDt = rawDt - consumed;
      this.juice.update(rawDt);
      if (this.hitStopLeftMs === 0) {
        this.hitStopPieceId = null;
      }
      if (spillDt <= 0) {
        this.updateFloatingTexts(rawDt);
        return;
      }
      this.advanceStepsAndEffects(spillDt);
      return;
    }

    this.advanceStepsAndEffects(rawDt);
  }

  private advanceStepsAndEffects(rawDtMs: number): void {
    // Rule 3: 2x Speed reduces regular durations ~45% (dt * 1.86 -> 53.7%) while Hit-Stop preserves >=28ms floor
    const speedFactor = this.speedMultiplier === 2 ? 1.86 : 1;
    let remainingDt = rawDtMs * speedFactor;

    while (this.steps.length > 0 && remainingDt > 0) {
      const current = this.steps[0]!;
      if (!current.started) {
        this.onStepStart(current);
        current.started = true;
        if (this.hitStopLeftMs > 0) {
          // Consume leftover frame slice into Hit-Stop without aging future steps
          const stopRaw = Math.min(this.hitStopLeftMs, remainingDt / speedFactor);
          this.hitStopLeftMs = Math.max(0, this.hitStopLeftMs - stopRaw);
          this.juice.update(stopRaw);
          this.updateFloatingTexts(stopRaw);
          if (this.hitStopLeftMs === 0) {
            this.hitStopPieceId = null;
          }
          remainingDt = Math.max(0, remainingDt - stopRaw * speedFactor);
          if (this.hitStopLeftMs > 0 || remainingDt <= 0) {
            remainingDt = 0;
            break;
          }
        }
      }

      const needed = current.durationMs - current.elapsedMs;
      const slice = Math.min(remainingDt, needed);
      current.elapsedMs += slice;
      this.onStepUpdate(current, slice);
      this.juice.update(slice);
      this.updateFloatingTexts(slice);

      if (slice >= needed) {
        this.onStepFinish(current);
        this.steps.shift();
      }
      remainingDt -= slice;
    }

    if (remainingDt > 0) {
      this.juice.update(remainingDt);
      this.updateFloatingTexts(remainingDt);
    }

    if (this.steps.length === 0) {
      this.pieceAnchors = {};
      this.activeGhosts = {};
    }

    // Flush buffered tap/input immediately on completion
    if (!this.hasActiveSteps() && this.bufferedInput !== null) {
      const cb = this.bufferedInput;
      this.bufferedInput = null;
      cb();
    }
  }

  private updateFloatingTexts(dt: number): void {
    for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
      const ft = this.floatingTexts[i]!;
      ft.ageMs += dt;
      if (ft.ageMs >= ft.lifeMs) {
        this.floatingTexts.splice(i, 1);
        continue;
      }
      ft.y -= (dt / 1000) * 0.72;
    }
  }

  public getSnapshot(): FxRenderSnapshot {
    const pieceOverrides: Record<string, PieceVisualOverride> = {};

    const anchorIds = Object.keys(this.pieceAnchors);
    for (let i = 0; i < anchorIds.length; i++) {
      const id = anchorIds[i]!;
      const anchor = this.pieceAnchors[id]!;
      pieceOverrides[id] = {
        x: anchor.x,
        y: anchor.y,
        scale: 1,
        alpha: 1,
        rotation: 0,
        flashAlpha: 0,
      };
    }

    const shockwaves: FxShockwave[] = [];
    const arrowBeams: FxArrowBeam[] = [];
    const roomTileOffsets: Record<string, RoomTileAnimOffset> = {};

    const current = this.steps[0];
    if (current !== undefined && current.started) {
      const rawT = current.durationMs > 0 ? Math.min(1, current.elapsedMs / current.durationMs) : 1;

      if (current.kind === 'MOVE' && current.pieceId !== undefined && current.path !== undefined) {
        if (current.piece !== undefined) {
          const hasKnightGuise =
            current.piece.type === 'CHIMERA' &&
            (current.piece.absorbedForms ?? []).some((f) => f.sourceType === 'KNIGHT');
          const sample = evaluatePieceChoreography({
            pieceType: current.piece.type,
            hasKnightGuise,
            elapsedMs: current.elapsedMs,
            durationMs: current.durationMs,
            path: current.path,
            isDrifted: current.isDrifted,
            driftSign: current.driftSign,
          });
          pieceOverrides[current.pieceId] = {
            x: sample.x,
            y: sample.y,
            shadowX: sample.shadowX,
            shadowY: sample.shadowY,
            dxTexels: sample.dxTexels,
            dyTexels: sample.dyTexels,
            scale: 1,
            scaleX: sample.scaleX,
            scaleY: sample.scaleY,
            alpha: 1,
            rotation: sample.rotation,
            flashAlpha: 0,
            auraBoostAlpha: sample.auraBoostAlpha,
            slotGlowAlpha: sample.slotGlowAlpha,
          };
        } else {
          const pt = samplePolylinePath(current.path, easeOutCubic(rawT));
          pieceOverrides[current.pieceId] = {
            x: pt.x,
            y: pt.y,
            scale: 1,
            alpha: 1,
            rotation: 0,
            flashAlpha: 0,
          };
        }
      } else if (
        current.kind === 'SLIDE' &&
        current.pieceId !== undefined &&
        current.path !== undefined
      ) {
        const squashStart = 0.78;
        const pt = samplePolylinePath(current.path, easeInOutQuad(Math.min(1, rawT / squashStart)));
        let scaleX = 1;
        let scaleY = 1;
        if (rawT >= squashStart) {
          const end = current.path[current.path.length - 1] ?? pt;
          const prev = current.path[Math.max(0, current.path.length - 2)] ?? end;
          const horiz = Math.abs(end.x - prev.x) >= Math.abs(end.y - prev.y);
          const sq = 1 - (rawT - squashStart) / (1 - squashStart);
          if (horiz) {
            scaleX = 1 - 0.3 * sq;
            scaleY = 1 + 0.16 * sq;
          } else {
            scaleY = 1 - 0.3 * sq;
            scaleX = 1 + 0.16 * sq;
          }
        }
        pieceOverrides[current.pieceId] = {
          x: pt.x,
          y: pt.y,
          scale: 1,
          scaleX,
          scaleY,
          alpha: 1,
          rotation: 0,
          flashAlpha: 0,
        };
      } else if (
        current.kind === 'PUSH' &&
        current.pieceId !== undefined &&
        current.path !== undefined
      ) {
        let pt: Coord;
        if (current.blocked && current.pos !== undefined) {
          const bump = Math.sin(rawT * Math.PI) * 0.14;
          pt = { x: current.pos.x + bump, y: current.pos.y };
        } else {
          pt = samplePolylinePath(current.path, easeOutCubic(rawT));
        }
        pieceOverrides[current.pieceId] = {
          x: pt.x,
          y: pt.y,
          scale: 1,
          alpha: 1,
          rotation: 0,
          flashAlpha: 0,
        };
      } else if (
        current.kind === 'PIT_FALL' &&
        current.pieceId !== undefined &&
        current.pos !== undefined
      ) {
        const ghost = this.activeGhosts[current.pieceId];
        if (ghost !== undefined) {
          // 70ms edge balance tremble (~first 26%), then 1.0 -> 0.15 spin shrink
          if (rawT < 0.25) {
            const trem = Math.sin(rawT * Math.PI * 10) * 0.05;
            ghost.x = current.pos.x + trem;
            ghost.y = current.pos.y;
            ghost.scale = 0.96;
            ghost.rotation = trem * 1.4;
          } else {
            const k = (rawT - 0.25) / 0.75;
            ghost.x = current.pos.x;
            ghost.y = current.pos.y;
            ghost.scale = Math.max(0.15, 1 - easeOutCubic(k) * 0.85);
            ghost.alpha = Math.max(0, 1 - k * 0.95);
            ghost.rotation = 0.35 + k * 2.4;
          }
        }
      } else if (
        (current.kind === 'CAPTURE' || (current.kind === 'BURN' && current.killed)) &&
        current.pieceId !== undefined &&
        current.pos !== undefined
      ) {
        const ghost = this.activeGhosts[current.pieceId];
        if (ghost !== undefined) {
          if (current.impaled) {
            // Ok/Kazık: 3px geri savrulma + 90° devrilme
            const dir = current.attackDir ?? { x: 1, y: 0 };
            const len = Math.hypot(dir.x, dir.y) || 1;
            const knock = Math.min(1, rawT * 3) * 0.12;
            ghost.x = current.pos.x + (dir.x / len) * knock;
            ghost.y = current.pos.y + (dir.y / len) * knock;
            ghost.rotation = rawT * (Math.PI * 0.5);
            ghost.alpha = Math.max(0, 1 - easeOutCubic(rawT));
          } else if (current.suffocated) {
            // Miasma: 200ms yeşil tona bürünüp titreme
            ghost.x = current.pos.x + Math.sin(rawT * Math.PI * 10) * 0.04;
            ghost.y = current.pos.y;
            ghost.alpha = Math.max(0, 1 - easeOutCubic(rawT));
            pieceOverrides[current.pieceId] = {
              x: ghost.x,
              y: ghost.y,
              scale: 1,
              alpha: ghost.alpha,
              rotation: 0,
              flashAlpha: 0,
              greenTintAlpha: 0.78,
            };
          } else {
            ghost.x = current.pos.x;
            ghost.y = current.pos.y;
            ghost.scale = 1 + rawT * 0.16;
            ghost.alpha = Math.max(0, 1 - easeOutCubic(rawT));
          }
        }
      } else if (
        current.kind === 'SHIELD_BREAK' &&
        current.pieceId !== undefined &&
        current.pos !== undefined
      ) {
        pieceOverrides[current.pieceId] = {
          x: current.pos.x,
          y: current.pos.y,
          scale: 1,
          alpha: 1,
          rotation: 0,
          flashAlpha: rawT < 0.3 ? 0.9 : Math.sin(rawT * Math.PI) * 0.5,
        };
        if (current.attackerId !== undefined) {
          const prevA = this.pieceAnchors[current.attackerId];
          if (prevA !== undefined) {
            const dir = current.attackDir ?? { x: 1, y: 0 };
            const len = Math.hypot(dir.x, dir.y) || 1;
            const spring = Math.sin(rawT * Math.PI) * 0.16;
            pieceOverrides[current.attackerId] = {
              x: prevA.x - (dir.x / len) * spring,
              y: prevA.y - (dir.y / len) * spring,
              scale: 1,
              alpha: 1,
              rotation: 0,
              flashAlpha: 0,
            };
          }
        }
      } else if (
        (current.kind === 'FREEZE' || current.kind === 'PROMOTE' || current.kind === 'COMPOSURE_CRACK') &&
        current.pieceId !== undefined &&
        current.pos !== undefined
      ) {
        pieceOverrides[current.pieceId] = {
          x: current.pos.x,
          y: current.pos.y,
          scale: current.kind === 'PROMOTE' ? 1 + Math.sin(rawT * Math.PI) * 0.25 : 1,
          alpha: 1,
          rotation: 0,
          flashAlpha: current.kind === 'COMPOSURE_CRACK' ? (rawT < 0.45 ? 0.75 : 0) : Math.sin(rawT * Math.PI) * 0.7,
        };
      } else if (current.kind === 'DISOBEY' && current.pieceId !== undefined && current.pos !== undefined) {
        // 40ms ürkekçe 2px uzan -> 3 kez sağ-sol hayır sarsıntısı (3 -> -3 -> 2 -> 0)
        const tgt = current.targetPos ?? current.pos;
        const dx = tgt.x - current.pos.x;
        const dy = tgt.y - current.pos.y;
        const len = Math.hypot(dx, dy) || 1;
        let dxTex = 0;
        let dyTex = 0;
        if (rawT < 0.22) {
          const p = Math.sin((rawT / 0.22) * Math.PI);
          dxTex = (dx / len) * 2 * p;
          dyTex = (dy / len) * 2 * p;
        } else {
          const k = (rawT - 0.22) / 0.78;
          if (k < 0.28) dxTex = 3;
          else if (k < 0.56) dxTex = -3;
          else if (k < 0.82) dxTex = 2;
          else dxTex = 0;
        }
        pieceOverrides[current.pieceId] = {
          x: current.pos.x,
          y: current.pos.y,
          dxTexels: dxTex,
          dyTexels: dyTex,
          scale: 1,
          alpha: 1,
          rotation: 0,
          flashAlpha: 0,
        };
      } else if (current.kind === 'SPAWN' && current.pieceId !== undefined && current.pos !== undefined) {
        pieceOverrides[current.pieceId] = {
          x: current.pos.x,
          y: current.pos.y,
          scale: 0.35 + easeOutCubic(rawT) * 0.65,
          alpha: Math.min(1, rawT * 1.4),
          rotation: 0,
          flashAlpha: (1 - rawT) * 0.5,
        };
      } else if (current.kind === 'FAITH_ULTIMATE' && current.pos !== undefined) {
        if (current.pieceId !== undefined) {
          const anchor = this.pieceAnchors[current.pieceId] ?? current.pos;
          const lift = rawT < 0.75 ? -3 * Math.min(1, rawT * 4) : -3 * (1 - (rawT - 0.75) / 0.25);
          pieceOverrides[current.pieceId] = {
            x: anchor.x,
            y: anchor.y,
            dyTexels: lift,
            scale: 1,
            alpha: 1,
            rotation: 0,
            flashAlpha: rawT < 0.25 ? 0.5 : 0,
            auraBoostAlpha: Math.sin(rawT * Math.PI),
          };
        }
        if (current.targetPos !== undefined && current.targetPieceId !== undefined) {
          const lockT = Math.max(0, Math.min(1, (rawT - 0.18) / 0.3));
          if (rawT >= 0.18 && rawT <= 0.65) {
            this.juice.setNazarLock({
              targetId: current.targetPieceId,
              x: current.targetPos.x + 0.5,
              y: current.targetPos.y + (0.15 + lockT * 0.35),
              progress: lockT,
            });
          } else {
            this.juice.setNazarLock(null);
          }
        }
        if (rawT >= 0.22) {
          const waveP = Math.min(1, (rawT - 0.22) / 0.62);
          shockwaves.push({
            x: current.pos.x,
            y: current.pos.y,
            maxRadiusTiles: current.radiusTiles ?? 3,
            progress: easeOutCubic(waveP),
            color: '#2dd4bf',
          });
        }
      } else if (current.kind === 'MADNESS_ULTIMATE' && current.pos !== undefined) {
        shockwaves.push({
          x: current.pos.x,
          y: current.pos.y,
          maxRadiusTiles: 2,
          progress: easeOutCubic(Math.min(1, rawT * 1.4)),
          color: '#f43f5e',
        });
        if (rawT > 0.24) {
          shockwaves.push({
            x: current.pos.x,
            y: current.pos.y,
            maxRadiusTiles: 2.3,
            progress: easeOutCubic(Math.min(1, (rawT - 0.24) / 0.65)),
            color: '#9333ea',
          });
        }
      } else if (current.kind === 'CHIMERA_EVOLVE' && current.pieceId !== undefined && current.pos !== undefined) {
        // 60ms suspend -> 200ms spiral absorb (+15% swell + emerald-white flash) -> 160ms slot glow
        const swell = rawT >= 0.12 && rawT <= 0.6 ? 1 + Math.sin(((rawT - 0.12) / 0.48) * Math.PI) * 0.15 : 1;
        const flash = rawT >= 0.2 && rawT <= 0.48 ? Math.sin(((rawT - 0.2) / 0.28) * Math.PI) * 0.85 : 0;
        const slotGlow = rawT >= 0.58 ? Math.sin(((rawT - 0.58) / 0.42) * Math.PI) : 0;
        pieceOverrides[current.pieceId] = {
          x: current.pos.x,
          y: current.pos.y,
          scale: swell,
          alpha: 1,
          rotation: 0,
          flashAlpha: flash,
          slotGlowAlpha: slotGlow,
        };
      } else if (current.kind === 'PLATE_TRIGGER' && current.pos !== undefined && current.positions !== undefined) {
        const sparks: SignalSpark[] = [];
        for (let i = 0; i < current.positions.length; i++) {
          const em = current.positions[i]!;
          const waypoints = resolveCopperWaypoints(current.pos, em);
          const pt = samplePolylinePath(waypoints, rawT);
          sparks.push({
            from: pt,
            to: pt,
            progress: rawT,
            color: '#fbbf24',
          });
        }
        this.juice.setSignalSparks(sparks);
      } else if (current.kind === 'ARROW_SHOT' && current.path !== undefined && current.path.length >= 2) {
        arrowBeams.push({
          from: current.path[0]!,
          to: current.path[current.path.length - 1]!,
          progress: easeOutCubic(rawT),
          flaming: current.flaming === true,
        });
      } else if ((current.kind === 'ROOM_COLLAPSE' || current.kind === 'ROOM_DROP')) {
        const w = current.boardWidth ?? 8;
        const h = current.boardHeight ?? 8;
        const cx = (w - 1) * 0.5;
        const cy = (h - 1) * 0.5;
        for (let ty = 0; ty < h; ty++) {
          for (let tx = 0; tx < w; tx++) {
            const dist = Math.hypot(tx - cx, ty - cy);
            const maxDist = Math.hypot(cx, cy) || 1;
            const norm = current.kind === 'ROOM_COLLAPSE' ? 1 - dist / maxDist : dist / maxDist;
            const local = Math.max(0, Math.min(1, (rawT - norm * 0.35) / 0.65));
            if (current.kind === 'ROOM_COLLAPSE') {
              roomTileOffsets[`${tx},${ty}`] = {
                scale: Math.max(0.05, 1 - local),
                dyTexels: Math.round(local * 14),
                alpha: Math.max(0, 1 - local),
              };
            } else {
              roomTileOffsets[`${tx},${ty}`] = {
                scale: 0.75 + local * 0.25,
                dyTexels: Math.round((1 - local) * -12),
                alpha: Math.min(1, 0.2 + local * 0.8),
              };
            }
          }
        }
      }
    }

    // Keep white silhouette flash locked across Hit-Stop even before step animation begins
    if (this.hitStopLeftMs > 0 && this.hitStopPieceId !== null) {
      const targetPos = current?.pos;
      const hitId = this.hitStopPieceId;
      const existing = pieceOverrides[hitId];
      if (existing !== undefined) {
        existing.flashAlpha = 1;
      } else if (targetPos !== undefined) {
        pieceOverrides[hitId] = {
          x: targetPos.x,
          y: targetPos.y,
          scale: 1,
          alpha: 1,
          rotation: 0,
          flashAlpha: 1,
        };
      }
    }

    const cameraFx = this.juice.getCameraFxState();

    return {
      pieceOverrides,
      ghostPieces: Object.values(this.activeGhosts),
      particles: this.juice.getActiveParticles(),
      floatingTexts: this.floatingTexts,
      shockwaves,
      arrowBeams,
      starFlashes: this.juice.getStarFlashes(),
      ghostTrails: this.juice.getGhostTrails(),
      tileStains: this.juice.getTileStains(),
      speedlines: this.juice.getSpeedlines(),
      signalSparks: this.juice.getSignalSparks(),
      nazarLock: this.juice.getNazarLock(),
      flameStreaks: this.juice.getFlameStreaks(),
      splitCrown: this.juice.getSplitCrown(),
      remoteSignalRings: this.juice.getRemoteSignalRings(),
      roomTileOffsets,
      cameraFx,
      hitStopActive: this.hitStopLeftMs > 0,
      shakeOffset: cameraFx.shakeOffset,
      isAnimating: this.isAnimating(),
    };
  }

  private onStepStart(step: AnimationStep): void {
    if (step.sfx !== undefined && this.sfxCallback !== null) {
      this.sfxCallback(step.sfx);
    }

    // Activate Hit-Stop (preserving >=28ms floor even in 2x speed!)
    if ((step.hitStopMs ?? 0) > 0) {
      const baseStop = step.hitStopMs!;
      const actualStop =
        this.speedMultiplier === 2 ? Math.max(28, Math.round(baseStop * 0.54)) : baseStop;
      this.hitStopLeftMs = actualStop;
      this.hitStopPieceId = step.pieceId ?? null;

      if (step.pos !== undefined) {
        this.juice.spawnStarFlash(
          step.pos.x + 0.5,
          step.pos.y + 0.5,
          step.kind === 'SHIELD_BREAK' ? '#bae6fd' : '#ffffff',
          step.isKingDeath ? 1.15 : 0.72,
          Math.max(110, actualStop + 60),
        );
      }
      if (baseStop >= 80) {
        this.sfxCallback?.('hitStopPunch');
      }
    }

    if (step.shakeIntensity !== undefined && step.shakeIntensity > 0) {
      this.juice.triggerShake(
        step.shakeIntensity,
        Math.max(150, step.durationMs),
        step.attackDir?.x ?? 1,
        step.attackDir?.y ?? 0.25,
      );
    }

    if (step.label !== undefined && step.pos !== undefined) {
      this.spawnFloatingText(step.pos.x + 0.5, step.pos.y + 0.2, step.label, step.color ?? '#ffffff');
    }

    switch (step.kind) {
      case 'SHIELD_BREAK':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 10, '#38bdf8', 'shard', 3.4, 420, {
            pxSize: 2,
            bounce: true,
          });
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 6, '#e0f2fe', 'shard', 2.4, 340, {
            pxSize: 1,
          });
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#38bdf8', 320);
        }
        break;

      case 'CAPTURE':
        if (step.isKingDeath && step.pos !== undefined) {
          this.juice.triggerKillcam(step.pos, 1.08, 480);
          this.juice.triggerScreenFlash('#dc2626', 0.45, 220);
          this.sfxCallback?.('killcamDrop');
        }
        if (step.pos !== undefined) {
          if (step.suffocated) {
            this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 14, '#4ade80', 'smoke', 2.0, 440, {
              dirX: 0,
              dirY: -1,
              directionalBias: 0.9,
              pxSize: 2,
            });
          } else if (step.incinerated) {
            this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 16, '#ffffff', 'pixel', 2.5, 420, {
              dirX: 0,
              dirY: -1,
              directionalBias: 0.75,
              pxSize: 2,
              colorMid: '#f97316',
              colorEnd: '#1e293b',
            });
          } else if (step.impaled) {
            this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 12, '#be123c', 'shard', 3.1, 340, {
              dirX: step.attackDir?.x ?? 1,
              dirY: step.attackDir?.y ?? 0,
              directionalBias: 0.85,
              pxSize: 2,
              bounce: true,
            });
          } else {
            // Standart Yeme: Kurbanın kendi palet renklerinden 12-18 adet 2x2px seken parçacık
            const pal = step.piece ? getPieceExplosionPalette(step.piece) : ['#f87171', '#fde68a'];
            const totalCount = 15;
            const dirX = step.attackDir?.x ?? 1;
            const dirY = step.attackDir?.y ?? 0;
            for (let c = 0; c < totalCount; c++) {
              const col = pal[c % pal.length]!;
              this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 1, col, 'pixel', 3.2, 400, {
                dirX,
                dirY,
                directionalBias: 0.65,
                pxSize: 2,
                bounce: true,
              });
            }
          }
        }
        break;

      case 'PIT_FALL':
        if (step.isKingDeath && step.pos !== undefined) {
          this.juice.triggerKillcam(step.pos, 1.08, 480);
          this.sfxCallback?.('killcamDrop');
        }
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#a855f7', 380);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 12, '#6366f1', 'circle', 2.1, 360);
        }
        break;

      case 'BURN':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 14, '#ffffff', 'pixel', 2.6, 400, {
            dirX: 0,
            dirY: -1,
            directionalBias: 0.7,
            pxSize: 2,
            colorMid: '#f97316',
            colorEnd: '#1e293b',
          });
        }
        break;

      case 'FREEZE':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 12, '#7dd3fc', 'shard', 2.3, 420);
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#bae6fd', 320);
        }
        break;

      case 'IGNITE_GROUP':
        if (step.positions !== undefined) {
          for (let i = 0; i < step.positions.length; i++) {
            const p = step.positions[i]!;
            this.juice.spawnBurst(p.x + 0.5, p.y + 0.5, 8, '#f97316', 'circle', 2.3, 360, {
              colorMid: '#facc15',
              colorEnd: '#334155',
            });
          }
        }
        break;

      case 'EXTINGUISH_GROUP':
        if (step.positions !== undefined) {
          for (let i = 0; i < step.positions.length; i++) {
            const p = step.positions[i]!;
            this.juice.spawnBurst(p.x + 0.5, p.y + 0.5, 5, '#94a3b8', 'circle', 1.1, 320);
          }
        }
        break;

      case 'WALL_DESTROY':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 18, '#94a3b8', 'shard', 3.6, 460, {
            bounce: true,
          });
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 8, '#fbbf24', 'shard', 2.4, 340);
        }
        break;

      case 'ALERT':
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#f59e0b', 340);
        }
        break;

      case 'SPAWN':
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#34d399', 360);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 12, '#6ee7b7', 'circle', 2.2, 380);
        }
        break;

      case 'PROMOTE':
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#facc15', 380);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 16, '#fde047', 'shard', 2.9, 440);
        }
        break;

      case 'MATCH_END': {
        const mx = (step.pos?.x ?? 3.5) + 0.5;
        const my = (step.pos?.y ?? 3.5) + 0.5;
        if (step.isKingDeath && step.pos !== undefined) {
          this.juice.triggerKillcam(step.pos, 1.08, 480);
          this.juice.setCrtShutdown(true);
          this.sfxCallback?.('killcamDrop');
        } else if (step.color === '#f87171') {
          this.juice.setCrtShutdown(true);
        }
        this.juice.spawnBurst(mx, my, 24, step.color ?? '#facc15', 'shard', 4.2, 650, {
          bounce: true,
        });
        break;
      }

      case 'GAS_BLAST':
        // İlk 45 ms içe çekme (implosion): yeşil gaz pikselleri merkeze emilir
        if (step.pos !== undefined && step.positions !== undefined) {
          const origin = { x: step.pos.x + 0.5, y: step.pos.y + 0.5 };
          for (let i = 0; i < Math.min(step.positions.length, 6); i++) {
            const tile = step.positions[i]!;
            for (let k = 0; k < 3; k++) {
              this.juice.spawnParticle({
                x: tile.x + 0.25 + this.juice.nextFloat() * 0.5,
                y: tile.y + 0.25 + this.juice.nextFloat() * 0.5,
                vx: 0,
                vy: 0,
                pxSize: 2,
                color: '#4ade80',
                lifeMs: 140,
                shape: 'pixel',
                spiralTarget: origin,
                spiralSpeed: 5.5,
              });
            }
          }
        }
        break;

      case 'PLATE_TRIGGER':
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#f59e0b', 240);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 8, '#fbbf24', 'shard', 2.0, 260);
        }
        break;

      case 'ARROW_SHOT':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(
            step.pos.x + 0.5,
            step.pos.y + 0.5,
            6,
            step.flaming ? '#f97316' : '#fde047',
            'shard',
            2.2,
            240,
          );
        }
        break;

      case 'TILE_COLLAPSE':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 4, '#64748b', 'shard', 2.4, 340, {
            bounce: true,
            pxSize: 3,
          });
          this.juice.spawnTileStain(step.pos.x, step.pos.y, '#090d16', 'CRACK_CRUMB', 320);
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#334155', 320);
        }
        break;

      case 'SPIKES_TICK':
        if (step.positions !== undefined) {
          for (let i = 0; i < step.positions.length; i++) {
            const p = step.positions[i]!;
            this.juice.spawnBurst(p.x + 0.5, p.y + 0.5, 4, '#e2e8f0', 'shard', 1.6, 220);
          }
        }
        break;

      case 'FAITH_ULTIMATE':
        this.juice.setBoardOutsideDim(0.35);
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#fef08a', 420);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 16, '#2dd4bf', 'smoke', 2.6, 460);
        }
        if (step.positions !== undefined) {
          for (let i = 0; i < step.positions.length; i++) {
            const p = step.positions[i]!;
            this.juice.spawnBurst(p.x + 0.5, p.y + 0.5, 8, '#ffffff', 'pixel', 2.0, 380);
          }
        }
        if (step.secondaryPositions !== undefined) {
          for (let i = 0; i < step.secondaryPositions.length; i++) {
            const p = step.secondaryPositions[i]!;
            this.juice.spawnBurst(p.x + 0.5, p.y + 0.5, 8, '#f43f5e', 'shard', 2.0, 400);
          }
        }
        if (step.tertiaryPositions !== undefined) {
          for (let i = 0; i < step.tertiaryPositions.length; i++) {
            const p = step.tertiaryPositions[i]!;
            this.spawnFloatingText(p.x + 0.5, p.y + 0.05, 'EFSUN TUTMAZ!', '#10b981', 900);
            this.juice.spawnBurst(p.x + 0.5, p.y + 0.5, 6, '#34d399', 'shard', 2.2, 320);
          }
        }
        break;

      case 'MADNESS_ULTIMATE':
        this.juice.triggerScreenFlash('#881337', 0.42, 160);
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#f43f5e', 380);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 16, '#9333ea', 'shard', 3.2, 420);
        }
        if (step.targetPos !== undefined && step.targetPieceId !== undefined) {
          this.juice.addFlameStreak({
            pieceId: step.targetPieceId,
            x: step.targetPos.x,
            y: step.targetPos.y,
            progress: 0,
          });
        }
        break;

      case 'BERSERK_CHAIN':
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#fb7185', 360);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 14, '#f43f5e', 'shard', 3.4, 380);
          if (step.targetPos !== undefined) {
            this.juice.spawnSpeedline(
              { x: step.pos.x + 0.5, y: step.pos.y + 0.5 },
              { x: step.targetPos.x + 0.5, y: step.targetPos.y + 0.5 },
              '#ffffff',
              220,
            );
          }
        }
        break;

      case 'CHIMERA_EVOLVE':
        if (step.pos !== undefined) {
          // Stage 1: suspended victim pixels around Chimera before spiraling into chest
          const chest = { x: step.pos.x + 0.5, y: step.pos.y + 0.5 };
          for (let i = 0; i < 16; i++) {
            const ang = (i / 16) * Math.PI * 2;
            this.juice.spawnParticle({
              x: chest.x + Math.cos(ang) * 0.72,
              y: chest.y + Math.sin(ang) * 0.72,
              vx: 0,
              vy: 0,
              pxSize: 2,
              color: i % 2 === 0 ? '#10b981' : '#f59e0b',
              lifeMs: 420,
              shape: 'pixel',
              spiralTarget: chest,
              spiralSpeed: 3.4,
            });
          }
          if (step.droppedColor !== undefined) {
            // 3. formda eski yuvanın renginde 6 piksel kemik arkaya kusulur
            this.juice.spawnBurst(chest.x, chest.y, 6, step.droppedColor, 'shard', 2.4, 380, {
              dirX: 0,
              dirY: 1,
              directionalBias: 0.75,
              bounce: true,
            });
          }
        }
        break;

      case 'PSYCH_FX':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 10, step.color ?? '#f43f5e', 'shard', 2.2, 340);
        }
        break;

      case 'COMPOSURE_CRACK':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.85, 5, '#c084fc', 'pixel', 1.7, 260, {
            dirX: 0,
            dirY: 1,
            directionalBias: 0.8,
          });
        }
        break;

      case 'DISOBEY':
        if (step.pos !== undefined) {
          this.juice.spawnRing(step.pos.x + 0.5, step.pos.y + 0.5, '#f43f5e', 300);
        }
        break;

      case 'HALLUCINATION_DISPEL':
        if (step.pos !== undefined) {
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 12, '#f87171', 'circle', 1.8, 360);
          this.juice.spawnBurst(step.pos.x + 0.5, step.pos.y + 0.5, 6, '#9333ea', 'shard', 1.5, 300);
        }
        break;

      case 'MOVE':
        if (step.piece?.type === 'SAINT_FAITH' && step.path !== undefined && step.path[0] !== undefined) {
          this.juice.spawnBurst(step.path[0].x + 0.5, step.path[0].y + 0.4, 3, '#2dd4bf', 'smoke', 1.4, 340);
        } else if (step.piece?.type === 'QUEEN' && step.path !== undefined && step.path[0] !== undefined) {
          this.juice.spawnBurst(step.path[0].x + 0.5, step.path[0].y + 0.25, 4, '#fde047', 'pixel', 1.3, 260);
        }
        break;

      case 'SLIDE':
      case 'PUSH':
      case 'TURN_CHANGE':
      case 'ROOM_COLLAPSE':
      case 'ROOM_DROP':
        break;
    }
  }

  private onStepUpdate(step: AnimationStep, dt: number): void {
    if (step.kind === 'SLIDE' && step.path !== undefined) {
      step.trailAccumMs = (step.trailAccumMs ?? 0) + dt;
      if (step.trailAccumMs >= 28) {
        step.trailAccumMs = 0;
        const t = step.durationMs > 0 ? Math.min(1, step.elapsedMs / step.durationMs) : 1;
        const pt = samplePolylinePath(step.path, easeInOutQuad(t));
        if (step.piece !== undefined) {
          this.juice.spawnGhostTrail(step.piece, pt.x, pt.y, '#7dd3fc', 170);
        }
        this.juice.spawnBurst(pt.x + 0.5, pt.y + 0.5, 2, '#e0f2fe', 'shard', 1.3, 240, { pxSize: 1 });
      }
    } else if (step.kind === 'MOVE' && step.piece !== undefined && step.path !== undefined) {
      const hasKnightGuise =
        step.piece.type === 'CHIMERA' &&
        (step.piece.absorbedForms ?? []).some((f) => f.sourceType === 'KNIGHT');
      const pt = samplePolylinePath(step.path, step.durationMs > 0 ? step.elapsedMs / step.durationMs : 1);
      step.trailAccumMs = (step.trailAccumMs ?? 0) + dt;
      const trailCadence =
        step.piece.type === 'ROOK' || step.piece.type === 'QUEEN' || step.piece.type === 'SAINT_MADNESS'
          ? 38
          : 55;
      if (step.trailAccumMs >= trailCadence) {
        step.trailAccumMs = 0;
        if (step.piece.type === 'ROOK') {
          this.juice.spawnGhostTrail(step.piece, pt.x, pt.y, '#94a3b8', 130);
          this.juice.spawnBurst(pt.x + 0.5, pt.y + 0.75, 1, '#fde047', 'pixel', 1.4, 200, { pxSize: 1 });
        } else if (step.piece.type === 'QUEEN') {
          this.juice.spawnGhostTrail(step.piece, pt.x, pt.y, '#fde047', 140);
        } else if (step.piece.type === 'SAINT_MADNESS') {
          this.juice.spawnGhostTrail(step.piece, pt.x, pt.y, '#f43f5e', 140);
        } else if (step.piece.type === 'SAINT_FAITH') {
          this.juice.spawnBurst(pt.x + 0.5, pt.y + 0.45, 2, '#2dd4bf', 'smoke', 1.0, 280, { pxSize: 1 });
        } else if (step.piece.type === 'CHIMERA' && !hasKnightGuise) {
          this.juice.spawnTileStain(Math.round(pt.x), Math.round(pt.y), '#064e3b', 'MOSS', 300);
        }
        if (step.isDrifted) {
          this.juice.spawnBurst(pt.x + 0.5, pt.y + 0.75, 2, '#c084fc', 'pixel', 1.8, 260);
        }
      }
    } else if (step.kind === 'GAS_BLAST' && step.dominoNodes !== undefined) {
      // Wait 45ms implosion, then trigger each BFS wave staggered every 25ms
      const elapsedAfterImplosion = step.elapsedMs - 45;
      if (elapsedAfterImplosion >= 0) {
        let triggered = step.dominoTriggeredCount ?? 0;
        while (triggered < step.dominoNodes.length) {
          const node = step.dominoNodes[triggered]!;
          if (elapsedAfterImplosion >= node.delayMs) {
            this.juice.spawnTileStain(node.pos.x, node.pos.y, '#090d16', 'SCORCH', 420);
            this.juice.spawnBurst(
              node.pos.x + 0.5,
              node.pos.y + 0.5,
              12,
              '#ffffff',
              'pixel',
              3.4,
              400,
              {
                pxSize: 2,
                colorMid: '#f97316',
                colorEnd: '#1e293b',
              },
            );
            this.juice.spawnBurst(node.pos.x + 0.5, node.pos.y + 0.5, 4, '#4ade80', 'circle', 2.2, 320);
            triggered++;
          } else {
            break;
          }
        }
        step.dominoTriggeredCount = triggered;
      }
    }
  }

  private onStepFinish(step: AnimationStep): void {
    if (step.kind === 'MOVE' && step.piece !== undefined && step.path !== undefined && step.path.length > 0) {
      const end = step.path[step.path.length - 1]!;
      const hasKnightGuise =
        step.piece.type === 'CHIMERA' &&
        (step.piece.absorbedForms ?? []).some((f) => f.sourceType === 'KNIGHT');
      if (step.piece.type === 'PAWN') {
        this.juice.spawnBurst(end.x + 0.5, end.y + 0.8, 3, '#94a3b8', 'pixel', 1.2, 240, { pxSize: 1 });
      } else if (step.piece.type === 'KNIGHT' || (step.piece.type === 'CHIMERA' && hasKnightGuise)) {
        this.juice.spawnRing(end.x + 0.5, end.y + 0.78, '#cbd5e1', 260);
        this.juice.spawnBurst(
          end.x + 0.5,
          end.y + 0.78,
          7,
          step.piece.type === 'CHIMERA' ? '#10b981' : '#94a3b8',
          'pixel',
          2.1,
          280,
        );
      } else if (step.piece.type === 'ROOK') {
        this.juice.triggerShake(1.5, 110, 0, 1);
      } else if (step.piece.type === 'BISHOP' && step.path.length >= 2) {
        const start = step.path[0]!;
        this.juice.spawnSpeedline(
          { x: start.x + 0.5, y: start.y + 0.5 },
          { x: end.x + 0.5, y: end.y + 0.5 },
          'rgba(224, 242, 254, 0.7)',
          170,
        );
      } else if (step.piece.type === 'QUEEN') {
        this.juice.spawnRing(end.x + 0.5, end.y + 0.78, '#fde047', 280);
      } else if (step.piece.type === 'SAINT_MADNESS') {
        this.juice.spawnRing(end.x + 0.5, end.y + 0.78, '#9333ea', 260);
      } else if (step.piece.type === 'CHIMERA') {
        this.juice.triggerShake(2, 120, 0, 1);
      }
    }

    if (step.kind === 'FAITH_ULTIMATE') {
      this.juice.setBoardOutsideDim(0);
      this.juice.setNazarLock(null);
    } else if (step.kind === 'MADNESS_ULTIMATE') {
      this.juice.clearFlameStreaks();
    } else if (step.kind === 'PLATE_TRIGGER') {
      this.juice.setSignalSparks([]);
    }

    if (
      (step.kind === 'MOVE' || step.kind === 'SLIDE' || step.kind === 'PUSH') &&
      step.pieceId !== undefined &&
      step.path !== undefined &&
      step.path.length > 0
    ) {
      const end = step.path[step.path.length - 1]!;
      this.pieceAnchors[step.pieceId] = { x: end.x, y: end.y };
      const ghost = this.activeGhosts[step.pieceId];
      if (ghost !== undefined) {
        ghost.x = end.x;
        ghost.y = end.y;
      }
    }

    if (
      (step.kind === 'CAPTURE' || step.kind === 'PIT_FALL' || (step.kind === 'BURN' && step.killed)) &&
      step.pieceId !== undefined
    ) {
      delete this.activeGhosts[step.pieceId];
      delete this.pieceAnchors[step.pieceId];
    }
  }

  private spawnFloatingText(
    x: number,
    y: number,
    text: string,
    color: string,
    lifeMs = 1250,
  ): void {
    this.floatingTexts.push({
      x,
      y,
      text,
      color,
      ageMs: 0,
      lifeMs,
    });
  }
}

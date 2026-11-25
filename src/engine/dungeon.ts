/**
 * Pure deterministic dungeon chemistry & trap physics (Package A — Design V3).
 * Architectural invariant: zero DOM/Canvas/window/performance references, zero Math.random(),
 * canonical tile scan order (y asc, then x asc), canonical ID order (UTF-16 lexicographical).
 */

import { cloneCardinalDir, cloneTrap, coordEquals, createTile, inBounds } from './board';
import {
  CardinalDir,
  Coord,
  DEFAULT_BURN_TURNS,
  GameEvent,
  GasOverlay,
  MAX_GAS_CHAIN_TILES,
  Piece,
  SpikePhase,
  TileState,
  TileTrap,
} from './types';

/** 4 orthogonal neighbors ordered canonically (y asc, then x asc). */
const CANONICAL_ORTHOGONAL_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
];

export type DungeonKillCause = 'PIT' | 'INCINERATED' | 'SKEWERED' | 'SUFFOCATED';

export interface DungeonKillRecord {
  piece: Piece;
  cause: DungeonKillCause;
  pos: Coord;
}

export interface GasDetonationResult {
  detonatedTiles: Coord[];
  killedPieces: DungeonKillRecord[];
  shieldBrokenPieceIds: string[];
}

export interface PressurePlateTriggerResult {
  triggered: boolean;
  plateId: string | null;
  emitterIds: string[];
}

export interface ArrowFireResult {
  fired: boolean;
  path: Coord[];
  firstMiasmaHit: Coord | null;
  killedPieces: DungeonKillRecord[];
  shieldBrokenPieceIds: string[];
}

export interface SpikeAdvanceResult {
  changes: Array<{ at: Coord; phase: SpikePhase }>;
  killedPieces: DungeonKillRecord[];
  shieldBrokenPieceIds: string[];
}

export interface SpikeStepResult {
  triggered: boolean;
  killedPiece: DungeonKillRecord | null;
  shieldBroken: boolean;
}

export function compareCoordsCanonical(a: Coord, b: Coord): number {
  return a.y !== b.y ? a.y - b.y : a.x - b.x;
}

export function compareIdsCanonical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function hasMiasma(tile: TileState | null | undefined): boolean {
  return tile !== undefined && tile !== null && tile.gas?.kind === 'MIASMA';
}

export function canPlaceMiasma(tile: TileState | null | undefined): boolean {
  return tile !== undefined && tile !== null && tile.type !== 'WALL';
}

export function isExtendedSpikes(tile: TileState | null | undefined): boolean {
  return tile !== undefined && tile !== null && tile.trap?.kind === 'SPIKES' && tile.trap.phase === 2;
}

export function isTelegraphSpikes(tile: TileState | null | undefined): boolean {
  return tile !== undefined && tile !== null && tile.trap?.kind === 'SPIKES' && tile.trap.phase === 1;
}

export function isPressurePlate(tile: TileState | null | undefined): boolean {
  return tile !== undefined && tile !== null && tile.trap?.kind === 'PRESSURE_PLATE';
}

export function isArrowEmitter(tile: TileState | null | undefined): boolean {
  return tile !== undefined && tile !== null && tile.trap?.kind === 'ARROW_EMITTER';
}

export function createMiasmaOverlay(turnsRemaining: number | null = null): GasOverlay {
  return { kind: 'MIASMA', turnsRemaining };
}

export function createPressurePlateTrap(
  id: string,
  targetIds: readonly string[],
  maxCooldown = 1,
  cooldown = 0,
): Extract<TileTrap, { kind: 'PRESSURE_PLATE' }> {
  return {
    kind: 'PRESSURE_PLATE',
    id,
    targetIds: targetIds.slice().sort(compareIdsCanonical),
    cooldown,
    maxCooldown,
  };
}

export function createArrowEmitterTrap(
  id: string,
  dir: CardinalDir,
  options: { ammo?: number | null; flaming?: boolean; piercing?: boolean } = {},
): Extract<TileTrap, { kind: 'ARROW_EMITTER' }> {
  return {
    kind: 'ARROW_EMITTER',
    id,
    dir: cloneCardinalDir(dir),
    ammo: options.ammo === undefined ? null : options.ammo,
    flaming: options.flaming ?? false,
    piercing: options.piercing ?? false,
  };
}

export function createSpikesTrap(
  id: string,
  phase: SpikePhase = 0,
): Extract<TileTrap, { kind: 'SPIKES' }> {
  return {
    kind: 'SPIKES',
    id,
    phase,
  };
}

/**
 * Returns true if the piece is currently silenced by SAINT_FAITH's ultimate.
 * CHIMERA is permanently immune to silence.
 */
export function isPieceSilenced(piece: Piece): boolean {
  return piece.type !== 'CHIMERA' && (piece.silencedTurns ?? 0) > 0;
}

/**
 * Returns true if the piece's shield can currently absorb damage (active and not silenced).
 */
export function hasActiveShield(piece: Piece): boolean {
  return piece.shieldActive && !isPieceSilenced(piece);
}

/**
 * Returns true if the piece ignores MIASMA movement slowdown and entry choke.
 * CHIMERA is permanently immune; FRENZY_HASTE grants temporary movement/choke immunity.
 */
export function isPieceImmuneToMiasmaMovement(piece: Piece, hasFrenzyHaste = false): boolean {
  return piece.type === 'CHIMERA' || hasFrenzyHaste;
}

/**
 * Returns true if the piece is immune to end-of-turn MIASMA suffocation stacking.
 */
export function isPieceImmuneToMiasmaSuffocation(piece: Piece): boolean {
  return piece.type === 'CHIMERA';
}

/**
 * Returns true if landing on `tile` chokes and freezes the piece (PAWN / KING unless immune).
 */
export function shouldChokeOnMiasmaLanding(
  piece: Piece,
  tile: TileState | null | undefined,
  hasFrenzyHaste = false,
): boolean {
  if (!hasMiasma(tile)) return false;
  if (piece.type !== 'PAWN' && piece.type !== 'KING') return false;
  return !isPieceImmuneToMiasmaMovement(piece, hasFrenzyHaste);
}

/**
 * Returns canonical MIASMA coordinates in direct or 4-orthogonal contact with `coord`.
 * Used to detect fire + gas contact whenever a tile ignites or gas is placed.
 */
export function findMiasmaIgnitionOrigins(
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  coord: Coord,
): Coord[] {
  const dims = { width, height };
  if (!inBounds(dims, coord)) return [];

  const origins: Coord[] = [];
  const center = tiles[coord.y]?.[coord.x];
  if (hasMiasma(center)) {
    origins.push({ x: coord.x, y: coord.y });
  }

  for (let i = 0; i < CANONICAL_ORTHOGONAL_DIRS.length; i++) {
    const dir = CANONICAL_ORTHOGONAL_DIRS[i]!;
    const neighbor: Coord = { x: coord.x + dir.x, y: coord.y + dir.y };
    if (!inBounds(dims, neighbor)) continue;
    if (hasMiasma(tiles[neighbor.y]?.[neighbor.x])) {
      origins.push(neighbor);
    }
  }

  origins.sort(compareCoordsCanonical);
  return origins;
}

/**
 * Returns true if a BURNING tile and a MIASMA tile occupy the same cell or orthogonal neighbors.
 */
export function hasBurningMiasmaContact(
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  coord: Coord,
): boolean {
  const dims = { width, height };
  if (!inBounds(dims, coord)) return false;
  const tile = tiles[coord.y]?.[coord.x];
  if (tile === undefined) return false;

  if (tile.type === 'BURNING') {
    return findMiasmaIgnitionOrigins(tiles, width, height, coord).length > 0;
  }
  if (hasMiasma(tile)) {
    for (let i = 0; i < CANONICAL_ORTHOGONAL_DIRS.length; i++) {
      const dir = CANONICAL_ORTHOGONAL_DIRS[i]!;
      const n: Coord = { x: coord.x + dir.x, y: coord.y + dir.y };
      if (!inBounds(dims, n)) continue;
      if (tiles[n.y]?.[n.x]?.type === 'BURNING') return true;
    }
  }
  return false;
}

/**
 * Deterministic 4-connected BFS collecting all MIASMA tiles connected to `origin`,
 * capped at `maxTiles` (default MAX_GAS_CHAIN_TILES = 64) and returned in canonical (y, x) order.
 * Gas over PIT tiles acts as a fire bridge across chasms.
 */
export function collectGasChainTiles(
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  origin: Coord,
  maxTiles = MAX_GAS_CHAIN_TILES,
): Coord[] {
  const dims = { width, height };
  if (width <= 0 || height <= 0 || maxTiles <= 0 || !inBounds(dims, origin)) {
    return [];
  }

  const seeds: Coord[] = [];
  const originTile = tiles[origin.y]?.[origin.x];
  if (originTile !== undefined && originTile.type !== 'WALL' && hasMiasma(originTile)) {
    seeds.push({ x: origin.x, y: origin.y });
  } else {
    for (let i = 0; i < CANONICAL_ORTHOGONAL_DIRS.length; i++) {
      const dir = CANONICAL_ORTHOGONAL_DIRS[i]!;
      const n: Coord = { x: origin.x + dir.x, y: origin.y + dir.y };
      if (!inBounds(dims, n)) continue;
      const nTile = tiles[n.y]?.[n.x];
      if (nTile !== undefined && nTile.type !== 'WALL' && hasMiasma(nTile)) {
        seeds.push(n);
      }
    }
  }

  if (seeds.length === 0) return [];

  const visited = new Uint8Array(width * height);
  const queue: Coord[] = [];
  const collected: Coord[] = [];

  for (let i = 0; i < seeds.length && collected.length < maxTiles; i++) {
    const seed = seeds[i]!;
    const idx = seed.y * width + seed.x;
    if (visited[idx] === 1) continue;
    visited[idx] = 1;
    queue.push(seed);
    collected.push(seed);
  }

  let head = 0;
  while (head < queue.length && collected.length < maxTiles) {
    const curr = queue[head++]!;
    for (let i = 0; i < CANONICAL_ORTHOGONAL_DIRS.length && collected.length < maxTiles; i++) {
      const dir = CANONICAL_ORTHOGONAL_DIRS[i]!;
      const next: Coord = { x: curr.x + dir.x, y: curr.y + dir.y };
      if (!inBounds(dims, next)) continue;
      const idx = next.y * width + next.x;
      if (visited[idx] === 1) continue;
      const tile = tiles[next.y]?.[next.x];
      if (tile === undefined || tile.type === 'WALL' || !hasMiasma(tile)) continue;

      visited[idx] = 1;
      queue.push(next);
      collected.push(next);
    }
  }

  collected.sort(compareCoordsCanonical);
  return collected;
}

/**
 * Converts a non-WALL, non-PIT, non-CRACKED tile into BURNING while preserving
 * WATCHTOWER reversion, underlyingType, and traps (e.g. SPIKES / PRESSURE_PLATE).
 */
export function buildIgnitedTile(
  current: TileState,
  burnTurns = DEFAULT_BURN_TURNS,
): TileState {
  const revertType: 'PLAIN' | 'WATCHTOWER' | undefined =
    current.type === 'WATCHTOWER'
      ? 'WATCHTOWER'
      : current.type === 'BURNING' && current.revertType === 'WATCHTOWER'
        ? 'WATCHTOWER'
        : undefined;

  const underlyingType =
    current.type === 'BURNING'
      ? current.underlyingType
      : current.type === 'WATCHTOWER'
        ? 'WATCHTOWER'
        : undefined;

  const next = createTile('BURNING', burnTurns, revertType, {
    underlyingType,
    trap: current.trap !== undefined ? cloneTrap(current.trap) : undefined,
  });
  return next;
}

/**
 * Restores a BURNING tile whose burnTurns reached 0 back to its underlying terrain
 * while preserving any attached trap or gas overlay.
 */
export function getExtinguishTargetTile(tile: TileState): TileState {
  const revertedType = tile.underlyingType ?? tile.revertType ?? 'PLAIN';
  return createTile(revertedType, 0, undefined, {
    gas: tile.gas !== undefined ? { ...tile.gas } : undefined,
    trap: tile.trap !== undefined ? cloneTrap(tile.trap) : undefined,
  });
}

/**
 * Collapses a CRACKED tile into a PIT, destroying any trap on it.
 * For non-BLAST collapses (DEPARTURE / PASS_THROUGH), any MIASMA overlay remains above the PIT.
 */
export function collapseCrackedTile(
  tiles: TileState[][],
  width: number,
  height: number,
  at: Coord,
  reason: 'DEPARTURE' | 'PASS_THROUGH' | 'BLAST',
  events: GameEvent[],
): boolean {
  if (!inBounds({ width, height }, at)) return false;
  const row = tiles[at.y];
  const tile = row?.[at.x];
  if (row === undefined || tile === undefined || tile.type !== 'CRACKED') return false;

  row[at.x] =
    reason !== 'BLAST' && tile.gas !== undefined
      ? createTile('PIT', 0, undefined, { gas: { ...tile.gas } })
      : createTile('PIT');

  events.push({
    type: 'TILE_COLLAPSED',
    at: { x: at.x, y: at.y },
    reason,
  });
  return true;
}

/**
 * Identifies CRACKED tiles along a movement path that collapse on DEPARTURE or PASS_THROUGH.
 * - Departure square `path[0]` collapses only if the piece actually left it.
 * - Intermediate squares `path[1..n-2]` collapse only for non-jump movement (never KNIGHT leaps).
 * - Landing square `path[n-1]` never collapses upon arrival.
 */
export function collectPathCrackedCollapses(
  tiles: readonly (readonly TileState[])[],
  path: readonly Coord[],
  isJump: boolean,
): Array<{ at: Coord; reason: 'DEPARTURE' | 'PASS_THROUGH' }> {
  if (path.length < 2) return [];

  const collapses: Array<{ at: Coord; reason: 'DEPARTURE' | 'PASS_THROUGH' }> = [];
  const start = path[0]!;
  const end = path[path.length - 1]!;

  if (!coordEquals(start, end) && tiles[start.y]?.[start.x]?.type === 'CRACKED') {
    collapses.push({ at: { x: start.x, y: start.y }, reason: 'DEPARTURE' });
  }

  if (!isJump) {
    for (let i = 1; i < path.length - 1; i++) {
      const mid = path[i]!;
      if (tiles[mid.y]?.[mid.x]?.type !== 'CRACKED') continue;
      if (collapses.some((c) => coordEquals(c.at, mid))) continue;
      collapses.push({ at: { x: mid.x, y: mid.y }, reason: 'PASS_THROUGH' });
    }
  }

  return collapses;
}

/**
 * Resolves a DETONATE_GAS chain explosion starting from `origin`:
 * 1) Clears tile.gas across all 4-connected MIASMA tiles (canonical BFS, max 64).
 * 2) Collapses CRACKED tiles to PIT (reason: 'BLAST'); pieces on them fall in even if shielded.
 * 3) Ignites remaining walkable tiles to BURNING (2 turns).
 * 4) Deals 1 Blast Damage to pieces on detonated non-PIT tiles (breaks active unsilenced shield or incinerates).
 */
export function resolveGasDetonation(
  tiles: TileState[][],
  pieces: Piece[],
  width: number,
  height: number,
  origin: Coord,
  events: GameEvent[],
  maxTiles = MAX_GAS_CHAIN_TILES,
): GasDetonationResult {
  const blastTiles = collectGasChainTiles(tiles, width, height, origin, maxTiles);
  if (blastTiles.length === 0) {
    return { detonatedTiles: [], killedPieces: [], shieldBrokenPieceIds: [] };
  }

  const killedPieces: DungeonKillRecord[] = [];
  const shieldBrokenPieceIds: string[] = [];

  events.push({
    type: 'GAS_CHAIN_DETONATED',
    origin: { x: origin.x, y: origin.y },
    tiles: blastTiles.map((c) => ({ x: c.x, y: c.y })),
  });

  for (let i = 0; i < blastTiles.length; i++) {
    const pos = blastTiles[i]!;
    const row = tiles[pos.y];
    const tile = row?.[pos.x];
    if (row === undefined || tile === undefined) continue;

    // 1) Clear MIASMA
    delete tile.gas;

    // 2) CRACKED -> PIT collapse (lethal even through shield)
    if (tile.type === 'CRACKED') {
      collapseCrackedTile(tiles, width, height, pos, 'BLAST', events);
      const victimIdx = pieces.findIndex((p) => p.pos.x === pos.x && p.pos.y === pos.y);
      if (victimIdx !== -1) {
        const victim = pieces[victimIdx]!;
        pieces.splice(victimIdx, 1);
        events.push({
          type: 'PIECE_FELL_IN_PIT',
          pieceId: victim.id,
          pos: { x: pos.x, y: pos.y },
          pieceType: victim.type,
          side: victim.side,
        });
        killedPieces.push({ piece: victim, cause: 'PIT', pos: { x: pos.x, y: pos.y } });
      }
      continue;
    }

    // 3) WALL / PIT do not burn
    if (tile.type === 'WALL' || tile.type === 'PIT') {
      continue;
    }

    // Ignite tile to BURNING (2 turns)
    row[pos.x] = buildIgnitedTile(tile, DEFAULT_BURN_TURNS);
    events.push({
      type: 'TILE_IGNITED',
      pos: { x: pos.x, y: pos.y },
      burnTurns: DEFAULT_BURN_TURNS,
    });

    // 4) 1 Blast Damage to any occupant
    const occupantIdx = pieces.findIndex((p) => p.pos.x === pos.x && p.pos.y === pos.y);
    if (occupantIdx !== -1) {
      const occupant = pieces[occupantIdx]!;
      if (hasActiveShield(occupant)) {
        occupant.shieldActive = false;
        shieldBrokenPieceIds.push(occupant.id);
        events.push({
          type: 'SHIELD_BROKEN',
          pieceId: occupant.id,
          pos: { x: pos.x, y: pos.y },
          source: 'GAS_BLAST',
        });
      } else {
        pieces.splice(occupantIdx, 1);
        events.push({
          type: 'PIECE_INCINERATED',
          pieceId: occupant.id,
          at: { x: pos.x, y: pos.y },
        });
        killedPieces.push({ piece: occupant, cause: 'INCINERATED', pos: { x: pos.x, y: pos.y } });
      }
    }
  }

  return { detonatedTiles: blastTiles, killedPieces, shieldBrokenPieceIds };
}

/**
 * Finds an embedded ARROW_EMITTER trap by ID using canonical (y asc, x asc) board scan.
 */
export function findArrowEmitterById(
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  emitterId: string,
): { pos: Coord; trap: Extract<TileTrap, { kind: 'ARROW_EMITTER' }> } | null {
  for (let y = 0; y < height; y++) {
    const row = tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x++) {
      const tile = row[x];
      if (tile?.trap?.kind === 'ARROW_EMITTER' && tile.trap.id === emitterId) {
        return { pos: { x, y }, trap: tile.trap };
      }
    }
  }
  return null;
}

/**
 * Triggers a PRESSURE_PLATE if off cooldown and not yet fired in this stepGame() invocation.
 * Returns target emitter IDs sorted canonically.
 */
export function triggerPressurePlate(
  tiles: TileState[][],
  width: number,
  height: number,
  platePos: Coord,
  triggeredByPieceId: string,
  firedPlateIds: Set<string>,
  events: GameEvent[],
): PressurePlateTriggerResult {
  if (!inBounds({ width, height }, platePos)) {
    return { triggered: false, plateId: null, emitterIds: [] };
  }
  const tile = tiles[platePos.y]?.[platePos.x];
  if (tile === undefined || tile.trap?.kind !== 'PRESSURE_PLATE') {
    return { triggered: false, plateId: null, emitterIds: [] };
  }

  const plate = tile.trap;
  if (plate.cooldown > 0 || firedPlateIds.has(plate.id)) {
    return { triggered: false, plateId: plate.id, emitterIds: [] };
  }

  firedPlateIds.add(plate.id);
  plate.cooldown = plate.maxCooldown;

  events.push({
    type: 'PLATE_TRIGGERED',
    plateId: plate.id,
    at: { x: platePos.x, y: platePos.y },
    triggeredByPieceId,
  });

  return {
    triggered: true,
    plateId: plate.id,
    emitterIds: plate.targetIds.slice().sort(compareIdsCanonical),
  };
}

/**
 * Fires an ARROW_EMITTER from its embedded WALL coordinate along `dir`:
 * - Does not fire if `ammo === 0`; decrements finite `ammo` by 1.
 * - Flies starting 1 square ahead of the WALL until board edge or another WALL.
 * - If `flaming === true`, records the first MIASMA square touched (`firstMiasmaHit`) for gas detonation.
 * - Deals 1 Trap Damage to pieces struck (breaks active unsilenced shield or skewers).
 * - Stops at the first piece struck unless `piercing === true`.
 */
export function fireArrowEmitter(
  tiles: TileState[][],
  pieces: Piece[],
  width: number,
  height: number,
  emitterPos: Coord,
  events: GameEvent[],
): ArrowFireResult {
  const dims = { width, height };
  if (!inBounds(dims, emitterPos)) {
    return { fired: false, path: [], firstMiasmaHit: null, killedPieces: [], shieldBrokenPieceIds: [] };
  }
  const emitterTile = tiles[emitterPos.y]?.[emitterPos.x];
  if (emitterTile === undefined || emitterTile.trap?.kind !== 'ARROW_EMITTER') {
    return { fired: false, path: [], firstMiasmaHit: null, killedPieces: [], shieldBrokenPieceIds: [] };
  }

  const emitter = emitterTile.trap;
  if (emitter.ammo === 0) {
    return { fired: false, path: [], firstMiasmaHit: null, killedPieces: [], shieldBrokenPieceIds: [] };
  }
  if (emitter.ammo !== null) {
    emitter.ammo -= 1;
  }

  const path: Coord[] = [];
  const impactEvents: GameEvent[] = [];
  const killedPieces: DungeonKillRecord[] = [];
  const shieldBrokenPieceIds: string[] = [];
  let firstMiasmaHit: Coord | null = null;

  let cx = emitterPos.x + emitter.dir.dx;
  let cy = emitterPos.y + emitter.dir.dy;

  while (inBounds(dims, { x: cx, y: cy })) {
    const pos: Coord = { x: cx, y: cy };
    const tile = tiles[cy]?.[cx];
    if (tile === undefined || tile.type === 'WALL') {
      break;
    }

    path.push(pos);

    if (emitter.flaming && firstMiasmaHit === null && hasMiasma(tile)) {
      firstMiasmaHit = { x: pos.x, y: pos.y };
    }

    const hitIdx = pieces.findIndex((p) => p.pos.x === pos.x && p.pos.y === pos.y);
    if (hitIdx !== -1) {
      const hitPiece = pieces[hitIdx]!;
      if (hasActiveShield(hitPiece)) {
        hitPiece.shieldActive = false;
        shieldBrokenPieceIds.push(hitPiece.id);
        impactEvents.push({
          type: 'SHIELD_BROKEN',
          pieceId: hitPiece.id,
          pos: { x: pos.x, y: pos.y },
          source: 'ARROW',
        });
      } else {
        pieces.splice(hitIdx, 1);
        impactEvents.push({
          type: 'PIECE_SKEWERED',
          pieceId: hitPiece.id,
          at: { x: pos.x, y: pos.y },
          source: 'ARROW',
        });
        killedPieces.push({ piece: hitPiece, cause: 'SKEWERED', pos: { x: pos.x, y: pos.y } });
      }

      if (!emitter.piercing) {
        break;
      }
    }

    cx += emitter.dir.dx;
    cy += emitter.dir.dy;
  }

  events.push({
    type: 'ARROW_FIRED',
    emitterId: emitter.id,
    from: { x: emitterPos.x, y: emitterPos.y },
    path: path.map((c) => ({ x: c.x, y: c.y })),
    flaming: emitter.flaming,
  });

  for (let i = 0; i < impactEvents.length; i++) {
    events.push(impactEvents[i]!);
  }

  return {
    fired: true,
    path,
    firstMiasmaHit,
    killedPieces,
    shieldBrokenPieceIds,
  };
}

/**
 * Advances all SPIKES traps across the board in canonical (y asc, x asc) order:
 * 0 (RETRACTED) -> 1 (TELEGRAPH) -> 2 (EXTENDED) -> 0.
 * Pieces standing on tiles transitioning to EXTENDED (2) immediately suffer 1 Trap Damage.
 */
export function advanceAllSpikes(
  tiles: TileState[][],
  pieces: Piece[],
  width: number,
  height: number,
  events: GameEvent[],
): SpikeAdvanceResult {
  const changes: Array<{ at: Coord; phase: SpikePhase }> = [];
  const killedPieces: DungeonKillRecord[] = [];
  const shieldBrokenPieceIds: string[] = [];

  for (let y = 0; y < height; y++) {
    const row = tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x++) {
      const tile = row[x];
      if (tile?.trap?.kind !== 'SPIKES') continue;
      const nextPhase = ((tile.trap.phase + 1) % 3) as SpikePhase;
      tile.trap.phase = nextPhase;
      changes.push({ at: { x, y }, phase: nextPhase });
    }
  }

  if (changes.length === 0) {
    return { changes, killedPieces, shieldBrokenPieceIds };
  }

  events.push({
    type: 'SPIKES_PHASE_CHANGED',
    changes: changes.map((c) => ({ at: { x: c.at.x, y: c.at.y }, phase: c.phase })),
  });

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    if (change.phase !== 2) continue;
    const victimIdx = pieces.findIndex(
      (p) => p.pos.x === change.at.x && p.pos.y === change.at.y,
    );
    if (victimIdx === -1) continue;

    const victim = pieces[victimIdx]!;
    if (hasActiveShield(victim)) {
      victim.shieldActive = false;
      shieldBrokenPieceIds.push(victim.id);
      events.push({
        type: 'SHIELD_BROKEN',
        pieceId: victim.id,
        pos: { x: change.at.x, y: change.at.y },
        source: 'SPIKES',
      });
    } else {
      pieces.splice(victimIdx, 1);
      events.push({
        type: 'PIECE_SKEWERED',
        pieceId: victim.id,
        at: { x: change.at.x, y: change.at.y },
        source: 'SPIKES',
      });
      killedPieces.push({
        piece: victim,
        cause: 'SKEWERED',
        pos: { x: change.at.x, y: change.at.y },
      });
    }
  }

  return { changes, killedPieces, shieldBrokenPieceIds };
}

/**
 * Applies immediate 1 Trap Damage when a piece moves, slides, or is pushed onto an EXTENDED SPIKES tile.
 */
export function applySpikeTrapDamageAt(
  tiles: readonly (readonly TileState[])[],
  pieces: Piece[],
  pieceId: string,
  at: Coord,
  events: GameEvent[],
): SpikeStepResult {
  const tile = tiles[at.y]?.[at.x];
  if (!isExtendedSpikes(tile)) {
    return { triggered: false, killedPiece: null, shieldBroken: false };
  }

  const idx = pieces.findIndex((p) => p.id === pieceId);
  if (idx === -1) {
    return { triggered: false, killedPiece: null, shieldBroken: false };
  }

  const piece = pieces[idx]!;
  if (hasActiveShield(piece)) {
    piece.shieldActive = false;
    events.push({
      type: 'SHIELD_BROKEN',
      pieceId: piece.id,
      pos: { x: at.x, y: at.y },
      source: 'SPIKES',
    });
    return { triggered: true, killedPiece: null, shieldBroken: true };
  }

  pieces.splice(idx, 1);
  events.push({
    type: 'PIECE_SKEWERED',
    pieceId: piece.id,
    at: { x: at.x, y: at.y },
    source: 'SPIKES',
  });
  return {
    triggered: true,
    killedPiece: { piece, cause: 'SKEWERED', pos: { x: at.x, y: at.y } },
    shieldBroken: false,
  };
}

/**
 * Decrements temporary MIASMA gas overlays (turnsRemaining !== null) in canonical order,
 * dissipating any that reach 0. Permanent gas (turnsRemaining === null) is unchanged.
 */
export function tickTemporaryMiasma(
  tiles: TileState[][],
  width: number,
  height: number,
): Coord[] {
  const dissipated: Coord[] = [];
  for (let y = 0; y < height; y++) {
    const row = tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x++) {
      const tile = row[x];
      if (tile?.gas?.kind !== 'MIASMA' || tile.gas.turnsRemaining === null) continue;
      tile.gas.turnsRemaining -= 1;
      if (tile.gas.turnsRemaining <= 0) {
        delete tile.gas;
        dissipated.push({ x, y });
      }
    }
  }
  return dissipated;
}

/**
 * Decrements active PRESSURE_PLATE cooldowns by 1 (minimum 0) in canonical order.
 */
export function tickPressurePlateCooldowns(
  tiles: TileState[][],
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y++) {
    const row = tiles[y];
    if (row === undefined) continue;
    for (let x = 0; x < width; x++) {
      const tile = row[x];
      if (tile?.trap?.kind === 'PRESSURE_PLATE' && tile.trap.cooldown > 0) {
        tile.trap.cooldown = Math.max(0, tile.trap.cooldown - 1);
      }
    }
  }
}

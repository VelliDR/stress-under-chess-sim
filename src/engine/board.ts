import { getInitialDriftSign } from './prng';
import {
  BoardView,
  CardinalDir,
  ChimeraForm,
  ConnectivityResult,
  Coord,
  DEFAULT_COMPOSURE,
  LegalMove,
  MAX_SLIDE_STEPS,
  Piece,
  PieceType,
  Side,
  SlideResolution,
  TileState,
  TileTrap,
  TileType,
  TileV3Fields,
  VisibilityLevel,
} from './types';

/** 8-direction clockwise compass from North (0..7), used for 45° Curved Stress Drift. */
export const COMPASS_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },  // 0: N
  { x: 1, y: -1 },  // 1: NE
  { x: 1, y: 0 },   // 2: E
  { x: 1, y: 1 },   // 3: SE
  { x: 0, y: 1 },   // 4: S
  { x: -1, y: 1 },  // 5: SW
  { x: -1, y: 0 },  // 6: W
  { x: -1, y: -1 }, // 7: NW
];

const ROOK_COMPASS_INDICES: readonly number[] = [0, 2, 4, 6];
const BISHOP_COMPASS_INDICES: readonly number[] = [1, 3, 5, 7];
const QUEEN_COMPASS_INDICES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7];

const ORTHOGONAL_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const DIAGONAL_DIRS: readonly Coord[] = [
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
];

const ALL_EIGHT_DIRS: readonly Coord[] = [...ORTHOGONAL_DIRS, ...DIAGONAL_DIRS];

const KNIGHT_OFFSETS: readonly Coord[] = [
  { x: -2, y: -1 },
  { x: -2, y: 1 },
  { x: -1, y: -2 },
  { x: -1, y: 2 },
  { x: 1, y: -2 },
  { x: 1, y: 2 },
  { x: 2, y: -1 },
  { x: 2, y: 1 },
];

export function opponentOf(side: Side): Side {
  return side === 'PLAYER' ? 'ENEMY' : 'PLAYER';
}

export function pawnForwardDelta(side: Side): -1 | 1 {
  return side === 'PLAYER' ? -1 : 1;
}

export function isPromotionRank(side: Side, y: number, height: number): boolean {
  return side === 'PLAYER' ? y === 0 : y === height - 1;
}

export function shouldPromotePawn(piece: Piece, pos: Coord, boardHeight: number): boolean {
  return piece.type === 'PAWN' && isPromotionRank(piece.side, pos.y, boardHeight);
}

export function promotePiece(piece: Piece, toType: PieceType = 'QUEEN'): Piece {
  return {
    ...piece,
    type: toType,
    traits: piece.traits.slice(),
    pos: { x: piece.pos.x, y: piece.pos.y },
  };
}

export function coordEquals(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

export function chebyshevDistance(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function manhattanDistance(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function inBounds(board: { width: number; height: number }, coord: Coord): boolean {
  return coord.x >= 0 && coord.x < board.width && coord.y >= 0 && coord.y < board.height;
}

export function isKnightMove(from: Coord, to: Coord): boolean {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
}

export function cloneCardinalDir(dir: CardinalDir): CardinalDir {
  if (dir.dx === 1) return { dx: 1, dy: 0 };
  if (dir.dx === -1) return { dx: -1, dy: 0 };
  if (dir.dy === 1) return { dx: 0, dy: 1 };
  return { dx: 0, dy: -1 };
}

export function cloneTrap(trap: TileTrap): TileTrap {
  if (trap.kind === 'PRESSURE_PLATE') {
    return {
      kind: 'PRESSURE_PLATE',
      id: trap.id,
      targetIds: trap.targetIds.slice(),
      cooldown: trap.cooldown,
      maxCooldown: trap.maxCooldown,
    };
  }
  if (trap.kind === 'ARROW_EMITTER') {
    return {
      kind: 'ARROW_EMITTER',
      id: trap.id,
      dir: cloneCardinalDir(trap.dir),
      ammo: trap.ammo,
      flaming: trap.flaming,
      piercing: trap.piercing,
    };
  }
  return {
    kind: 'SPIKES',
    id: trap.id,
    phase: trap.phase,
  };
}

export function cloneTile(tile: TileState): TileState {
  const copy: TileState = {
    type: tile.type,
    burnTurns: tile.burnTurns,
  };
  if (tile.revertType !== undefined) {
    copy.revertType = tile.revertType;
  }
  if (tile.underlyingType !== undefined) {
    copy.underlyingType = tile.underlyingType;
  }
  if (tile.gas !== undefined) {
    copy.gas = {
      kind: tile.gas.kind,
      turnsRemaining: tile.gas.turnsRemaining,
    };
  }
  if (tile.trap !== undefined) {
    copy.trap = cloneTrap(tile.trap);
  }
  return copy;
}

export function cloneChimeraForm(form: ChimeraForm): ChimeraForm {
  const copy: ChimeraForm = {
    sourceType: form.sourceType,
    copiedTraits: form.copiedTraits.slice(),
  };
  if (form.saintEcho !== undefined) {
    copy.saintEcho = form.saintEcho;
  }
  return copy;
}

export function clonePiece(piece: Piece): Piece {
  const copy: Piece = {
    id: piece.id,
    side: piece.side,
    type: piece.type,
    pos: { x: piece.pos.x, y: piece.pos.y },
    traits: piece.traits.slice(),
    shieldActive: piece.shieldActive,
    frozenTurns: piece.frozenTurns,
    hasMoved: piece.hasMoved,
    aggro: piece.aggro,
    usedDashThisTurn: piece.usedDashThisTurn,
    wasVisibleAtTurnStart: piece.wasVisibleAtTurnStart,
  };
  if (piece.isBoss !== undefined) copy.isBoss = piece.isBoss;
  if (piece.miasmaExposure !== undefined) copy.miasmaExposure = piece.miasmaExposure;
  if (piece.composure !== undefined) copy.composure = piece.composure;
  if (piece.driftSign !== undefined) copy.driftSign = piece.driftSign;
  if (piece.faithCharge !== undefined) copy.faithCharge = piece.faithCharge;
  if (piece.madnessCharge !== undefined) copy.madnessCharge = piece.madnessCharge;
  if (piece.berserkReady !== undefined) copy.berserkReady = piece.berserkReady;
  if (piece.silencedTurns !== undefined) copy.silencedTurns = piece.silencedTurns;
  if (piece.absorbedForms !== undefined) {
    copy.absorbedForms = piece.absorbedForms.map(cloneChimeraForm);
  }
  return copy;
}

export function createTile(
  type: TileType = 'PLAIN',
  burnTurns = 0,
  revertType?: 'PLAIN' | 'WATCHTOWER',
  v3?: TileV3Fields,
): TileState {
  const tile: TileState = {
    type,
    burnTurns: type === 'BURNING' ? burnTurns : 0,
  };
  if (revertType !== undefined) {
    tile.revertType = revertType;
  }
  if (v3?.underlyingType !== undefined) {
    tile.underlyingType = v3.underlyingType;
  }
  if (v3?.gas !== undefined) {
    tile.gas = {
      kind: v3.gas.kind,
      turnsRemaining: v3.gas.turnsRemaining,
    };
  }
  if (v3?.trap !== undefined) {
    tile.trap = cloneTrap(v3.trap);
  }
  return tile;
}

export function createEmptyTiles(
  width: number,
  height: number,
  fill: TileType = 'PLAIN',
): TileState[][] {
  const rows: TileState[][] = [];
  for (let y = 0; y < height; y++) {
    const row: TileState[] = [];
    for (let x = 0; x < width; x++) {
      row.push(createTile(fill));
    }
    rows.push(row);
  }
  return rows;
}

export function cloneTiles(tiles: readonly (readonly TileState[])[]): TileState[][] {
  return tiles.map((row) => row.map(cloneTile));
}

export function createEmptyFog(
  width: number,
  height: number,
  fill: VisibilityLevel = 'UNEXPLORED',
): VisibilityLevel[][] {
  const rows: VisibilityLevel[][] = [];
  for (let y = 0; y < height; y++) {
    const row: VisibilityLevel[] = [];
    for (let x = 0; x < width; x++) {
      row.push(fill);
    }
    rows.push(row);
  }
  return rows;
}

export function getTile(board: BoardView, coord: Coord): TileState | null | undefined {
  if (!inBounds(board, coord)) return undefined;
  return board.tiles[coord.y]?.[coord.x];
}

export function isTileWalkable(tile: TileState | null | undefined): boolean {
  return tile !== undefined && tile !== null && tile.type !== 'WALL' && tile.type !== 'PIT';
}

export function getPieceAt(
  pieces: readonly Piece[],
  coord: Coord,
  ignorePieceId?: string,
): Piece | undefined {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (ignorePieceId !== undefined && p.id === ignorePieceId) continue;
    if (p.pos.x === coord.x && p.pos.y === coord.y) return p;
  }
  return undefined;
}

export function getPieceById(pieces: readonly Piece[], pieceId: string): Piece | undefined {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.id === pieceId) return p;
  }
  return undefined;
}

export interface RawMoveOptions {
  /** Bypass MIASMA movement slowdown (always true for CHIMERA; also granted by FRENZY_HASTE). */
  ignoreMiasma?: boolean;
  /** Extra movement range granted to range-limited units (e.g. FRENZY_HASTE +1). */
  extraRange?: number;
}

export interface DriftedTarget {
  to: Coord;
  path: Coord[];
  isDrifted: boolean;
  driftSign: 1 | -1;
}

function isPieceSilencedLocal(piece: Piece): boolean {
  return piece.type !== 'CHIMERA' && (piece.silencedTurns ?? 0) > 0;
}

function isPieceShieldEffective(piece: Piece): boolean {
  if (!piece.shieldActive) return false;
  if (isPieceSilencedLocal(piece)) return false;
  return true;
}

/**
 * Returns true if `piece` stands within Chebyshev <= 2 of an unsilenced friendly SAINT_MADNESS (excluding self).
 */
export function isInFriendlyMadnessAura(board: BoardView, piece: Piece): boolean {
  for (let i = 0; i < board.pieces.length; i++) {
    const other = board.pieces[i]!;
    if (other.id === piece.id) continue;
    if (other.side !== piece.side) continue;
    if (other.type !== 'SAINT_MADNESS') continue;
    if (isPieceSilencedLocal(other)) continue;
    if (chebyshevDistance(other.pos, piece.pos) <= 2) return true;
  }
  return false;
}

/**
 * FRENZY_HASTE: allies inside unsilenced friendly SAINT_MADNESS aura ignore MIASMA slowdown/choke,
 * and range-limited allies (KING, PAWN, SAINT_*, CHIMERA) gain +1 movement range.
 */
export function hasFrenzyHaste(board: BoardView, piece: Piece): boolean {
  return isInFriendlyMadnessAura(board, piece);
}

export function getFrenzyExtraRange(board: BoardView, piece: Piece): number {
  if (!hasFrenzyHaste(board, piece)) return 0;
  if (
    piece.type === 'KING' ||
    piece.type === 'PAWN' ||
    piece.type === 'SAINT_FAITH' ||
    piece.type === 'SAINT_MADNESS' ||
    piece.type === 'CHIMERA'
  ) {
    return 1;
  }
  return 0;
}

/**
 * FRENZY_POWER / MADNESS_PIERCE: attacks pierce active enemy SHIELDED shields in 1 lethal strike.
 */
export function hasArmorPierce(board: BoardView, attacker: Piece): boolean {
  if (isInFriendlyMadnessAura(board, attacker)) return true;
  if (attacker.type === 'CHIMERA' && attacker.absorbedForms !== undefined) {
    for (let i = 0; i < attacker.absorbedForms.length; i++) {
      if (attacker.absorbedForms[i]!.saintEcho === 'MADNESS_PIERCE') return true;
    }
  }
  return false;
}

export function isStressDriftActive(piece: Piece): boolean {
  if ((piece.composure ?? DEFAULT_COMPOSURE) !== 1) return false;
  return piece.type === 'ROOK' || piece.type === 'BISHOP' || piece.type === 'QUEEN';
}

export function getEffectiveDriftSign(piece: Piece): 1 | -1 {
  return piece.driftSign ?? getInitialDriftSign(piece.id);
}

/**
 * Computes predictable 45° curved drift targets for fragile (`composure === 1`) sliding pieces
 * (ROOK, BISHOP, QUEEN): steps 1..2 straight, steps 3..5 bent 45° by `driftSign`.
 */
export function computeDriftedMoveTargets(
  board: BoardView,
  piece: Piece,
  ignoreMiasma = false,
): DriftedTarget[] {
  if (piece.frozenTurns > 0) return [];
  if (!inBounds(board, piece.pos)) return [];
  if (!isStressDriftActive(piece)) return [];

  const dirIndices =
    piece.type === 'ROOK'
      ? ROOK_COMPASS_INDICES
      : piece.type === 'BISHOP'
        ? BISHOP_COMPASS_INDICES
        : QUEEN_COMPASS_INDICES;

  const sign = getEffectiveDriftSign(piece);
  const startTile = getTile(board, piece.pos);
  const startInMiasma = startTile?.gas?.kind === 'MIASMA';
  const maxSteps = !ignoreMiasma && startInMiasma ? 1 : 5;

  const targets: DriftedTarget[] = [];

  for (let d = 0; d < dirIndices.length; d++) {
    const dirIdx = dirIndices[d]!;
    const bentIdx = (dirIdx + sign + 8) % 8;
    const straightDir = COMPASS_DIRS[dirIdx]!;
    const bentDir = COMPASS_DIRS[bentIdx]!;

    const path: Coord[] = [{ x: piece.pos.x, y: piece.pos.y }];
    let cx = piece.pos.x;
    let cy = piece.pos.y;
    let enteredMiasma = false;

    for (let step = 1; step <= maxSteps; step++) {
      const vec = step <= 2 ? straightDir : bentDir;
      cx += vec.x;
      cy += vec.y;
      const coord: Coord = { x: cx, y: cy };
      if (!inBounds(board, coord)) break;

      const tile = getTile(board, coord);
      if (!isTileWalkable(tile)) break;

      const occupant = getPieceAt(board.pieces, coord);
      if (occupant !== undefined) {
        if (occupant.side !== piece.side) {
          const fullPath = [...path.map((c) => ({ x: c.x, y: c.y })), coord];
          if (!targets.some((t) => coordEquals(t.to, coord))) {
            targets.push({
              to: coord,
              path: fullPath,
              isDrifted: step >= 3,
              driftSign: sign,
            });
          }
        }
        break;
      }

      path.push(coord);
      if (!targets.some((t) => coordEquals(t.to, coord))) {
        targets.push({
          to: coord,
          path: path.map((c) => ({ x: c.x, y: c.y })),
          isDrifted: step >= 3,
          driftSign: sign,
        });
      }

      if (!ignoreMiasma) {
        if (enteredMiasma) break;
        if (tile?.gas?.kind === 'MIASMA') enteredMiasma = true;
      }
    }
  }

  return targets;
}

function pushUniqueCoord(targets: Coord[], coord: Coord): void {
  for (let i = 0; i < targets.length; i++) {
    if (coordEquals(targets[i]!, coord)) return;
  }
  targets.push(coord);
}

function traceSliderRay(
  board: BoardView,
  piece: Piece,
  dir: Coord,
  maxRange: number,
  ignoreMiasma: boolean,
  startInMiasma: boolean,
  targets: Coord[],
  dedupe = false,
): void {
  const effectiveMaxRange = !ignoreMiasma && startInMiasma ? 1 : maxRange;
  let enteredMiasma = false;

  for (let step = 1; step <= effectiveMaxRange; step++) {
    const coord: Coord = {
      x: piece.pos.x + dir.x * step,
      y: piece.pos.y + dir.y * step,
    };
    if (!inBounds(board, coord)) break;

    const tile = getTile(board, coord);
    if (!isTileWalkable(tile)) break;

    const occupant = getPieceAt(board.pieces, coord);
    if (occupant !== undefined) {
      if (occupant.side !== piece.side) {
        if (dedupe) pushUniqueCoord(targets, coord);
        else targets.push(coord);
      }
      break;
    }

    if (dedupe) pushUniqueCoord(targets, coord);
    else targets.push(coord);

    if (!ignoreMiasma) {
      if (enteredMiasma) {
        // Already spent the +1 allowed step past a MIASMA square
        break;
      }
      if (tile?.gas?.kind === 'MIASMA') {
        enteredMiasma = true;
      }
    }
  }
}

/**
 * Generates raw target squares reachable in one move by the piece (before ice slide resolution).
 * Enforces WALL/PIT blocking, MIASMA slider slowdown, Knight jumping over WALL/PIT/MIASMA,
 * Pawn direction & 2-step rule, Saint 2-range 8-dir slide, Chimera 3-range + absorbed forms,
 * and frozen status. No castling, no en passant, no check restrictions.
 */
export function getRawMoveTargets(
  board: BoardView,
  piece: Piece,
  options: RawMoveOptions = {},
): Coord[] {
  if (piece.frozenTurns > 0) return [];
  if (!inBounds(board, piece.pos)) return [];

  const targets: Coord[] = [];
  const { x, y } = piece.pos;
  const extraRange = options.extraRange ?? getFrenzyExtraRange(board, piece);
  const ignoreMiasma =
    options.ignoreMiasma === true || piece.type === 'CHIMERA' || hasFrenzyHaste(board, piece);
  const startTile = getTile(board, piece.pos);
  const startInMiasma = startTile?.gas?.kind === 'MIASMA';

  if (isStressDriftActive(piece)) {
    return computeDriftedMoveTargets(board, piece, ignoreMiasma).map((d) => d.to);
  }

  switch (piece.type) {
    case 'PAWN': {
      const dy = pawnForwardDelta(piece.side);
      const maxForwardSteps = extraRange > 0 ? Math.max(2, (piece.hasMoved ? 1 : 2) + extraRange) : piece.hasMoved ? 1 : 2;
      for (let step = 1; step <= maxForwardSteps; step++) {
        const next: Coord = { x, y: y + step * dy };
        const nextTile = getTile(board, next);
        if (!isTileWalkable(nextTile) || getPieceAt(board.pieces, next) !== undefined) {
          break;
        }
        targets.push(next);
      }

      const diagCoords: readonly Coord[] = [
        { x: x - 1, y: y + dy },
        { x: x + 1, y: y + dy },
      ];
      for (let i = 0; i < diagCoords.length; i++) {
        const diag = diagCoords[i]!;
        const diagTile = getTile(board, diag);
        if (!isTileWalkable(diagTile)) continue;
        const occupant = getPieceAt(board.pieces, diag);
        if (occupant !== undefined && occupant.side !== piece.side) {
          targets.push(diag);
        }
      }
      break;
    }

    case 'KNIGHT': {
      for (let i = 0; i < KNIGHT_OFFSETS.length; i++) {
        const offset = KNIGHT_OFFSETS[i]!;
        const target: Coord = { x: x + offset.x, y: y + offset.y };
        const tile = getTile(board, target);
        if (!isTileWalkable(tile)) continue;
        const occupant = getPieceAt(board.pieces, target);
        if (occupant === undefined || occupant.side !== piece.side) {
          targets.push(target);
        }
      }
      break;
    }

    case 'KING': {
      const kingRange = 1 + extraRange;
      for (let i = 0; i < ALL_EIGHT_DIRS.length; i++) {
        const dir = ALL_EIGHT_DIRS[i]!;
        for (let step = 1; step <= kingRange; step++) {
          const target: Coord = { x: x + dir.x * step, y: y + dir.y * step };
          const tile = getTile(board, target);
          if (!isTileWalkable(tile)) break;
          const occupant = getPieceAt(board.pieces, target);
          if (occupant !== undefined) {
            if (occupant.side !== piece.side) {
              targets.push(target);
            }
            break;
          }
          targets.push(target);
        }
      }
      break;
    }

    case 'ROOK':
    case 'BISHOP':
    case 'QUEEN': {
      const dirs =
        piece.type === 'ROOK'
          ? ORTHOGONAL_DIRS
          : piece.type === 'BISHOP'
            ? DIAGONAL_DIRS
            : ALL_EIGHT_DIRS;
      const maxRange = Math.max(board.width, board.height);

      for (let d = 0; d < dirs.length; d++) {
        traceSliderRay(board, piece, dirs[d]!, maxRange, ignoreMiasma, startInMiasma, targets);
      }
      break;
    }

    case 'SAINT_FAITH':
    case 'SAINT_MADNESS': {
      const saintRange = 2 + extraRange;
      for (let d = 0; d < ALL_EIGHT_DIRS.length; d++) {
        traceSliderRay(
          board,
          piece,
          ALL_EIGHT_DIRS[d]!,
          saintRange,
          ignoreMiasma,
          startInMiasma,
          targets,
        );
      }
      break;
    }

    case 'CHIMERA': {
      const forms = piece.absorbedForms ?? [];
      let unlimitedOrthogonal = false;
      let unlimitedDiagonal = false;
      let hasKnightJump = false;

      for (let i = 0; i < forms.length; i++) {
        const src = forms[i]!.sourceType;
        if (src === 'ROOK' || src === 'QUEEN') unlimitedOrthogonal = true;
        if (src === 'BISHOP' || src === 'QUEEN') unlimitedDiagonal = true;
        if (src === 'KNIGHT') hasKnightJump = true;
      }

      const boardMax = Math.max(board.width, board.height);
      const baseRange = 3 + extraRange;
      const orthRange = unlimitedOrthogonal ? boardMax : baseRange;
      const diagRange = unlimitedDiagonal ? boardMax : baseRange;

      for (let d = 0; d < ORTHOGONAL_DIRS.length; d++) {
        traceSliderRay(board, piece, ORTHOGONAL_DIRS[d]!, orthRange, true, false, targets, true);
      }
      for (let d = 0; d < DIAGONAL_DIRS.length; d++) {
        traceSliderRay(board, piece, DIAGONAL_DIRS[d]!, diagRange, true, false, targets, true);
      }
      if (hasKnightJump) {
        for (let i = 0; i < KNIGHT_OFFSETS.length; i++) {
          const offset = KNIGHT_OFFSETS[i]!;
          const target: Coord = { x: x + offset.x, y: y + offset.y };
          const tile = getTile(board, target);
          if (!isTileWalkable(tile)) continue;
          const occupant = getPieceAt(board.pieces, target);
          if (occupant === undefined || occupant.side !== piece.side) {
            pushUniqueCoord(targets, target);
          }
        }
      }
      break;
    }
  }

  return targets;
}

export interface IceSlideOptions {
  /** Whether sliding into an enemy piece triggers attack/capture (true for moves, false for pushed pieces). */
  allowCapture?: boolean;
  /** Preceding squares traversed before entering startIcePos (excluding startIcePos itself). */
  prefixPath?: readonly Coord[];
  /** True when the attacker pierces active enemy shields (FRENZY_POWER / MADNESS_PIERCE). */
  armorPierce?: boolean;
}

/**
 * Resolves chained ICE sliding starting from an empty ICE square `startIcePos`
 * along unit vector `dir`, capped at MAX_SLIDE_STEPS (16).
 */
export function resolveIceSlide(
  board: BoardView,
  piece: Piece,
  startIcePos: Coord,
  dir: Coord,
  options: IceSlideOptions = {},
): SlideResolution {
  const allowCapture = options.allowCapture ?? true;
  const armorPierce = options.armorPierce ?? hasArmorPierce(board, piece);
  const prefix = options.prefixPath ? options.prefixPath.map((c) => ({ x: c.x, y: c.y })) : [];
  const slidePath: Coord[] = [{ x: startIcePos.x, y: startIcePos.y }];

  let current: Coord = { x: startIcePos.x, y: startIcePos.y };

  for (let step = 0; step < MAX_SLIDE_STEPS; step++) {
    const next: Coord = { x: current.x + dir.x, y: current.y + dir.y };

    // Rule 1a: Out of bounds -> stop at previous square
    if (!inBounds(board, next)) {
      break;
    }

    const nextTile = getTile(board, next);

    // Rule 1b: WALL or unexplored/missing tile -> stop at previous square
    if (nextTile === undefined || nextTile === null || nextTile.type === 'WALL') {
      break;
    }

    const occupant = getPieceAt(board.pieces, next, piece.id);

    // Rule 1c & Rule 4: Piece collision
    if (occupant !== undefined) {
      if (occupant.side === piece.side || !allowCapture) {
        // Friendly piece (or pushed piece hitting any piece) -> stop at previous square
        break;
      }

      // Enemy collision during voluntary slide
      if (isPieceShieldEffective(occupant) && !armorPierce) {
        const currentTile = getTile(board, current);
        return {
          path: [...prefix, ...slidePath],
          finalPos: current,
          slid: true,
          fellInPit: false,
          endsOnBurning: currentTile?.type === 'BURNING',
          hitPieceId: occupant.id,
          hitPos: next,
          brokeShield: true,
          captured: false,
          promotes: shouldPromotePawn(piece, current, board.height),
        };
      }

      // Unshielded (or silenced) enemy -> capture and stop on enemy's square
      slidePath.push(next);
      return {
        path: [...prefix, ...slidePath],
        finalPos: next,
        slid: true,
        fellInPit: false,
        endsOnBurning: nextTile.type === 'BURNING',
        hitPieceId: occupant.id,
        hitPos: next,
        brokeShield: false,
        captured: true,
        promotes: shouldPromotePawn(piece, next, board.height),
      };
    }

    // Rule 3: PIT -> fall in and die
    if (nextTile.type === 'PIT') {
      slidePath.push(next);
      return {
        path: [...prefix, ...slidePath],
        finalPos: null,
        slid: true,
        fellInPit: true,
        endsOnBurning: false,
        hitPieceId: null,
        hitPos: null,
        brokeShield: false,
        captured: false,
        promotes: false,
      };
    }

    // Rule 2: PLAIN, WATCHTOWER, BURNING, or CRACKED -> move onto square and stop
    if (
      nextTile.type === 'PLAIN' ||
      nextTile.type === 'WATCHTOWER' ||
      nextTile.type === 'BURNING' ||
      nextTile.type === 'CRACKED'
    ) {
      slidePath.push(next);
      return {
        path: [...prefix, ...slidePath],
        finalPos: next,
        slid: true,
        fellInPit: false,
        endsOnBurning: nextTile.type === 'BURNING',
        hitPieceId: null,
        hitPos: null,
        brokeShield: false,
        captured: false,
        promotes: shouldPromotePawn(piece, next, board.height),
      };
    }

    // Rule 5: Another ICE tile -> continue sliding
    slidePath.push(next);
    current = next;
  }

  const finalTile = getTile(board, current);
  return {
    path: [...prefix, ...slidePath],
    finalPos: current,
    slid: slidePath.length > 1,
    fellInPit: false,
    endsOnBurning: finalTile?.type === 'BURNING',
    hitPieceId: null,
    hitPos: null,
    brokeShield: false,
    captured: false,
    promotes: shouldPromotePawn(piece, current, board.height),
  };
}

function buildApproachPath(from: Coord, to: Coord, isKnight: boolean): Coord[] {
  if (isKnight) {
    return [
      { x: from.x, y: from.y },
      { x: to.x, y: to.y },
    ];
  }

  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const path: Coord[] = [{ x: from.x, y: from.y }];

  let cx = from.x;
  let cy = from.y;
  let guard = 0;
  while ((cx !== to.x || cy !== to.y) && guard < 64) {
    cx += dx;
    cy += dy;
    path.push({ x: cx, y: cy });
    guard++;
  }

  return path;
}

/**
 * Resolves the full physical outcome of moving `piece` to a valid target square `to`,
 * including shield bounce-back, armor piercing, drifted approach paths, ice slide chains,
 * pit falls, burning finish, and pawn promotion.
 */
export function resolveMoveOutcome(
  board: BoardView,
  piece: Piece,
  to: Coord,
  explicitApproachPath?: readonly Coord[],
): SlideResolution {
  const from: Coord = { x: piece.pos.x, y: piece.pos.y };
  const isKnightJump =
    piece.type === 'KNIGHT' || (piece.type === 'CHIMERA' && isKnightMove(from, to));
  const immuneToIce = board.factions[piece.side] === 'FROST_WARDENS';
  const armorPierce = hasArmorPierce(board, piece);
  const approachPath =
    explicitApproachPath !== undefined
      ? explicitApproachPath.map((c) => ({ x: c.x, y: c.y }))
      : buildApproachPath(from, to, isKnightJump);
  const targetTile = getTile(board, to);
  const targetOccupant = getPieceAt(board.pieces, to, piece.id);

  // Direct attack onto an enemy-occupied square
  if (targetOccupant !== undefined && targetOccupant.side !== piece.side) {
    if (isPieceShieldEffective(targetOccupant) && !armorPierce) {
      // Knight or adjacent attack stays at `from`; ranged sliding pieces stop at previous square.
      const prevSquare = isKnightJump
        ? from
        : (approachPath[approachPath.length - 2] ?? from);
      const bouncePath = isKnightJump ? [from] : approachPath.slice(0, -1);
      const restTile = getTile(board, prevSquare);

      return {
        path: bouncePath,
        finalPos: prevSquare,
        slid: false,
        fellInPit: false,
        endsOnBurning: restTile?.type === 'BURNING',
        hitPieceId: targetOccupant.id,
        hitPos: { x: to.x, y: to.y },
        brokeShield: true,
        captured: false,
        promotes: shouldPromotePawn(piece, prevSquare, board.height),
      };
    }

    // Unshielded, silenced, or armor-pierced enemy -> capture and stop on `to`
    return {
      path: approachPath,
      finalPos: { x: to.x, y: to.y },
      slid: false,
      fellInPit: false,
      endsOnBurning: targetTile?.type === 'BURNING',
      hitPieceId: targetOccupant.id,
      hitPos: { x: to.x, y: to.y },
      brokeShield: false,
      captured: true,
      promotes: shouldPromotePawn(piece, to, board.height),
    };
  }

  // Empty target square: trigger ICE slide if tile is ICE, move is not a Knight jump, and not FROST_WARDENS
  if (targetTile?.type === 'ICE' && !isKnightJump && !immuneToIce) {
    const prevStep = approachPath[approachPath.length - 2] ?? from;
    const dir: Coord = {
      x: Math.sign(to.x - prevStep.x),
      y: Math.sign(to.y - prevStep.y),
    };
    return resolveIceSlide(board, piece, to, dir, {
      allowCapture: true,
      prefixPath: approachPath.slice(0, -1),
      armorPierce,
    });
  }

  // Standard stop on target square
  return {
    path: approachPath,
    finalPos: { x: to.x, y: to.y },
    slid: false,
    fellInPit: false,
    endsOnBurning: targetTile?.type === 'BURNING',
    hitPieceId: null,
    hitPos: null,
    brokeShield: false,
    captured: false,
    promotes: shouldPromotePawn(piece, to, board.height),
  };
}

/**
 * Generates all legal moves for a single piece with pre-computed ice slide, 45° drift, and hazard previews.
 */
export function getLegalMoves(
  board: BoardView,
  piece: Piece,
  bonusMovePieceId: string | null = null,
): LegalMove[] {
  if (bonusMovePieceId !== null && bonusMovePieceId !== piece.id) {
    return [];
  }

  if (isStressDriftActive(piece)) {
    const ignoreMiasma = hasFrenzyHaste(board, piece);
    const driftedTargets = computeDriftedMoveTargets(board, piece, ignoreMiasma);
    const moves: LegalMove[] = [];
    for (let i = 0; i < driftedTargets.length; i++) {
      const dt = driftedTargets[i]!;
      const resolution = resolveMoveOutcome(board, piece, dt.to, dt.path);
      const finalTile = resolution.finalPos !== null ? getTile(board, resolution.finalPos) : null;
      const endsOnExtendedSpikes =
        finalTile?.trap?.kind === 'SPIKES' && finalTile.trap.phase === 2;
      const move: LegalMove = {
        pieceId: piece.id,
        from: { x: piece.pos.x, y: piece.pos.y },
        to: dt.to,
        resolution,
        isHazardous: resolution.fellInPit || resolution.endsOnBurning || endsOnExtendedSpikes,
      };
      if (dt.isDrifted) {
        move.isDrifted = true;
        move.driftSign = dt.driftSign;
      }
      moves.push(move);
    }
    return moves;
  }

  const rawTargets = getRawMoveTargets(board, piece);
  const moves: LegalMove[] = [];

  for (let i = 0; i < rawTargets.length; i++) {
    const to = rawTargets[i]!;
    const resolution = resolveMoveOutcome(board, piece, to);
    const finalTile = resolution.finalPos !== null ? getTile(board, resolution.finalPos) : null;
    const endsOnExtendedSpikes =
      finalTile?.trap?.kind === 'SPIKES' && finalTile.trap.phase === 2;
    moves.push({
      pieceId: piece.id,
      from: { x: piece.pos.x, y: piece.pos.y },
      to,
      resolution,
      isHazardous: resolution.fellInPit || resolution.endsOnBurning || endsOnExtendedSpikes,
    });
  }

  return moves;
}

export function findLegalMove(
  board: BoardView,
  piece: Piece,
  to: Coord,
  bonusMovePieceId: string | null = null,
): LegalMove | undefined {
  const moves = getLegalMoves(board, piece, bonusMovePieceId);
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i]!;
    if (coordEquals(move.to, to)) return move;
  }
  return undefined;
}

export function getAllLegalMovesForSide(
  board: BoardView,
  side: Side,
  bonusMovePieceId: string | null = null,
  activeOnly = false,
): LegalMove[] {
  const result: LegalMove[] = [];
  for (let i = 0; i < board.pieces.length; i++) {
    const piece = board.pieces[i]!;
    if (piece.side !== side) continue;
    if (activeOnly && piece.aggro !== 'ACTIVE') continue;
    const moves = getLegalMoves(board, piece, bonusMovePieceId);
    for (let m = 0; m < moves.length; m++) {
      result.push(moves[m]!);
    }
  }
  return result;
}

/**
 * BFS softlock validator: verifies at least one 4-directional walkable path
 * (avoiding WALL and PIT) from any coordinate in `startCoords` to `goalCoord`.
 */
export function validateMapConnectivity(
  tiles: readonly (readonly TileState[])[],
  startCoords: readonly Coord[],
  goalCoord: Coord,
): ConnectivityResult {
  const height = tiles.length;
  const width = height > 0 ? (tiles[0]?.length ?? 0) : 0;
  if (width === 0 || height === 0) {
    return { connected: false, path: [] };
  }

  const dims = { width, height };
  if (!inBounds(dims, goalCoord)) {
    return { connected: false, path: [] };
  }

  const goalTile = tiles[goalCoord.y]?.[goalCoord.x];
  if (!isTileWalkable(goalTile)) {
    return { connected: false, path: [] };
  }

  const total = width * height;
  const visited = new Uint8Array(total);
  const parent = new Int32Array(total).fill(-1);
  const queue: number[] = [];

  const toIndex = (c: Coord): number => c.y * width + c.x;
  const fromIndex = (idx: number): Coord => ({
    x: idx % width,
    y: Math.floor(idx / width),
  });

  const goalIdx = toIndex(goalCoord);

  for (let i = 0; i < startCoords.length; i++) {
    const s = startCoords[i]!;
    if (!inBounds(dims, s)) continue;
    const tile = tiles[s.y]?.[s.x];
    if (!isTileWalkable(tile)) continue;
    const idx = toIndex(s);
    if (visited[idx] === 1) continue;
    visited[idx] = 1;
    if (idx === goalIdx) {
      return { connected: true, path: [{ x: s.x, y: s.y }] };
    }
    queue.push(idx);
  }

  let head = 0;
  while (head < queue.length) {
    const currIdx = queue[head++]!;
    const curr = fromIndex(currIdx);

    for (let d = 0; d < ORTHOGONAL_DIRS.length; d++) {
      const dir = ORTHOGONAL_DIRS[d]!;
      const next: Coord = { x: curr.x + dir.x, y: curr.y + dir.y };
      if (!inBounds(dims, next)) continue;

      const nextIdx = toIndex(next);
      if (visited[nextIdx] === 1) continue;

      const tile = tiles[next.y]?.[next.x];
      if (!isTileWalkable(tile)) continue;

      visited[nextIdx] = 1;
      parent[nextIdx] = currIdx;

      if (nextIdx === goalIdx) {
        const path: Coord[] = [];
        let trace = goalIdx;
        while (trace !== -1) {
          path.push(fromIndex(trace));
          trace = parent[trace]!;
        }
        path.reverse();
        return { connected: true, path };
      }

      queue.push(nextIdx);
    }
  }

  return { connected: false, path: [] };
}

/**
 * Carves a guaranteed walkable corridor via the center column between `start` and `goal`,
 * converting blocking WALL and PIT tiles along the corridor to PLAIN.
 */
export function carveConnectivityCorridor(
  tiles: readonly (readonly TileState[])[],
  start: Coord,
  goal: Coord,
): TileState[][] {
  const nextTiles = cloneTiles(tiles);
  const height = nextTiles.length;
  const width = height > 0 ? (nextTiles[0]?.length ?? 0) : 0;
  if (width === 0 || height === 0) return nextTiles;

  const dims = { width, height };
  const midX = Math.floor(width / 2);

  const clearIfBlocked = (x: number, y: number): void => {
    if (!inBounds(dims, { x, y })) return;
    const tile = nextTiles[y]?.[x];
    if (tile !== undefined && !isTileWalkable(tile)) {
      nextTiles[y]![x] = createTile('PLAIN');
    }
  };

  // Horizontal leg from start.x to midX on start.y
  const stepX1 = Math.sign(midX - start.x);
  let cx = start.x;
  clearIfBlocked(cx, start.y);
  while (cx !== midX) {
    cx += stepX1;
    clearIfBlocked(cx, start.y);
  }

  // Vertical center leg from start.y to goal.y on midX
  const stepY = Math.sign(goal.y - start.y);
  let cy = start.y;
  while (cy !== goal.y) {
    cy += stepY;
    clearIfBlocked(midX, cy);
  }

  // Horizontal leg from midX to goal.x on goal.y
  const stepX2 = Math.sign(goal.x - midX);
  cx = midX;
  while (cx !== goal.x) {
    cx += stepX2;
    clearIfBlocked(cx, goal.y);
  }

  return nextTiles;
}

/**
 * Validates connectivity and, if blocked, automatically carves a center passage so maps never softlock.
 */
export function ensureMapConnectivity(
  tiles: readonly (readonly TileState[])[],
  startCoords: readonly Coord[],
  goalCoord: Coord,
): { tiles: TileState[][]; carved: boolean; path: Coord[] } {
  const check = validateMapConnectivity(tiles, startCoords, goalCoord);
  if (check.connected) {
    return {
      tiles: cloneTiles(tiles),
      carved: false,
      path: check.path,
    };
  }

  const height = tiles.length;
  const width = height > 0 ? (tiles[0]?.length ?? 0) : 0;
  const dims = { width, height };
  const fallbackStart =
    startCoords.find((c) => inBounds(dims, c)) ?? {
      x: Math.floor(width / 2),
      y: Math.max(0, height - 1),
    };

  const carvedTiles = carveConnectivityCorridor(tiles, fallbackStart, goalCoord);
  const recheck = validateMapConnectivity(carvedTiles, [fallbackStart, ...startCoords], goalCoord);

  return {
    tiles: carvedTiles,
    carved: true,
    path: recheck.path,
  };
}

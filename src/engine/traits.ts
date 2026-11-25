import {
  coordEquals,
  createTile,
  getPieceAt,
  getTile,
  inBounds,
  isTileWalkable,
  manhattanDistance,
  resolveIceSlide,
  shouldPromotePawn,
} from './board';
import { getEffectiveTraits } from './psychology';
import {
  AbilityId,
  BoardView,
  Coord,
  DEFAULT_BURN_TURNS,
  FactionPassive,
  GameEvent,
  MAX_TRAITS_PER_PIECE,
  NECROMANCER_SPAWN_TURNS,
  PendingSpawn,
  Piece,
  Side,
  TileState,
  TraitId,
} from './types';

const ORTHOGONAL_DIRS: readonly Coord[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/**
 * Checks whether a piece effectively possesses a trait, including faction-granted traits
 * (RAIDERS Knight -> DASH_ON_REVEAL), CHIMERA absorbed traits, and silence suppression.
 */
export function hasTrait(
  piece: Piece,
  trait: TraitId,
  factions?: Readonly<Record<Side, FactionPassive>>,
): boolean {
  return getEffectiveTraits(piece, factions).includes(trait);
}

export function canAddTrait(piece: Piece, trait: TraitId): boolean {
  return !piece.traits.includes(trait) && piece.traits.length < MAX_TRAITS_PER_PIECE;
}

/**
 * Purely returns a new Piece with `trait` appended (respecting MAX_TRAITS_PER_PIECE = 3).
 * Adding SHIELDED automatically activates `shieldActive`.
 */
export function addTraitToPiece(piece: Piece, trait: TraitId): Piece {
  if (!canAddTrait(piece, trait)) {
    return {
      ...piece,
      pos: { x: piece.pos.x, y: piece.pos.y },
      traits: piece.traits.slice(),
    };
  }
  return {
    ...piece,
    pos: { x: piece.pos.x, y: piece.pos.y },
    traits: [...piece.traits, trait],
    shieldActive: trait === 'SHIELDED' ? true : piece.shieldActive,
  };
}

/**
 * Ignites the death tile and its 4 orthogonal neighbors (excluding WALL and PIT) for 2 turns.
 * Preserves WATCHTOWER via `revertType`; melts ICE to PLAIN upon extinguishment.
 */
export function igniteExplosiveCross(
  tiles: TileState[][],
  width: number,
  height: number,
  center: Coord,
  events: GameEvent[],
): void {
  const dims = { width, height };
  const affected: Coord[] = [center];
  for (let i = 0; i < ORTHOGONAL_DIRS.length; i++) {
    const dir = ORTHOGONAL_DIRS[i]!;
    affected.push({ x: center.x + dir.x, y: center.y + dir.y });
  }

  for (let i = 0; i < affected.length; i++) {
    const pos = affected[i]!;
    if (!inBounds(dims, pos)) continue;
    const row = tiles[pos.y];
    const current = row?.[pos.x];
    if (row === undefined || current === undefined) continue;
    if (current.type === 'WALL' || current.type === 'PIT') continue;

    const revertType: 'PLAIN' | 'WATCHTOWER' | undefined =
      current.type === 'WATCHTOWER'
        ? 'WATCHTOWER'
        : current.type === 'BURNING' && current.revertType === 'WATCHTOWER'
          ? 'WATCHTOWER'
          : undefined;

    row[pos.x] = createTile('BURNING', DEFAULT_BURN_TURNS, revertType);
    events.push({
      type: 'TILE_IGNITED',
      pos: { x: pos.x, y: pos.y },
      burnTurns: DEFAULT_BURN_TURNS,
    });
  }
}

/**
 * Applies FROST_TOUCH after a surviving mover's move:
 * 1) Freezes a shielded enemy whose shield was just broken (even at range/Knight jump).
 * 2) If that target was not already orthogonally adjacent, freezes the first orthogonally
 *    adjacent enemy (clockwise: up, right, down, left) for 1 turn.
 */
export function applyFrostTouch(
  pieces: Piece[],
  mover: Piece,
  shieldBrokenTargetId: string | null,
  events: GameEvent[],
): void {
  if (!hasTrait(mover, 'FROST_TOUCH')) return;

  let alreadyFrozeAdjacent = false;

  if (shieldBrokenTargetId !== null) {
    const target = pieces.find((p) => p.id === shieldBrokenTargetId);
    if (target !== undefined && target.side !== mover.side && target.type !== 'CHIMERA') {
      target.frozenTurns = Math.max(target.frozenTurns, 1);
      events.push({
        type: 'PIECE_FROZEN',
        pieceId: target.id,
        pos: { x: target.pos.x, y: target.pos.y },
        turns: 1,
      });
      if (manhattanDistance(mover.pos, target.pos) === 1) {
        alreadyFrozeAdjacent = true;
      }
    }
  }

  if (alreadyFrozeAdjacent) return;

  for (let i = 0; i < ORTHOGONAL_DIRS.length; i++) {
    const dir = ORTHOGONAL_DIRS[i]!;
    const adjPos: Coord = { x: mover.pos.x + dir.x, y: mover.pos.y + dir.y };
    const adjPiece = getPieceAt(pieces, adjPos, mover.id);
    if (adjPiece !== undefined && adjPiece.side !== mover.side && adjPiece.type !== 'CHIMERA') {
      if (adjPiece.id === shieldBrokenTargetId) break;
      adjPiece.frozenTurns = Math.max(adjPiece.frozenTurns, 1);
      events.push({
        type: 'PIECE_FROZEN',
        pieceId: adjPiece.id,
        pos: { x: adjPiece.pos.x, y: adjPiece.pos.y },
        turns: 1,
      });
      break;
    }
  }
}

/**
 * Registers a 2-turn NECROMANCERS skeleton spawn marker at a non-King unit's death square,
 * provided the death square is walkable (never spawns inside PIT or WALL).
 */
export function enqueueNecromancerSpawn(
  pendingSpawns: PendingSpawn[],
  deadPiece: Piece,
  factions: Readonly<Record<Side, FactionPassive>>,
  tiles: readonly (readonly TileState[])[],
): void {
  if (factions[deadPiece.side] !== 'NECROMANCERS') return;
  if (deadPiece.type === 'KING') return;

  const tile = tiles[deadPiece.pos.y]?.[deadPiece.pos.x];
  if (!isTileWalkable(tile)) return;

  const existing = pendingSpawns.find((sp) => coordEquals(sp.pos, deadPiece.pos));
  if (existing !== undefined) {
    existing.turnsRemaining = NECROMANCER_SPAWN_TURNS;
    existing.side = deadPiece.side;
    existing.pieceType = 'PAWN';
    return;
  }

  pendingSpawns.push({
    pos: { x: deadPiece.pos.x, y: deadPiece.pos.y },
    turnsRemaining: NECROMANCER_SPAWN_TURNS,
    side: deadPiece.side,
    pieceType: 'PAWN',
  });
}

export interface PushOutcome {
  dir: Coord;
  dest: Coord;
  blocked: boolean;
  slid: boolean;
  fellInPit: boolean;
  finalPos: Coord | null;
  slidePath: Coord[];
  promotes: boolean;
}

/**
 * Resolves pushing `targetPiece` 1 tile away from orthogonal neighbor `pusher`,
 * chaining into PIT death or ICE sliding (`allowCapture: false`).
 */
export function resolvePushOutcome(
  board: BoardView,
  pusher: Piece,
  targetPiece: Piece,
): PushOutcome {
  const dir: Coord = {
    x: targetPiece.pos.x - pusher.pos.x,
    y: targetPiece.pos.y - pusher.pos.y,
  };
  const dest: Coord = {
    x: targetPiece.pos.x + dir.x,
    y: targetPiece.pos.y + dir.y,
  };

  if (!inBounds(board, dest)) {
    return {
      dir,
      dest,
      blocked: true,
      slid: false,
      fellInPit: false,
      finalPos: { x: targetPiece.pos.x, y: targetPiece.pos.y },
      slidePath: [],
      promotes: false,
    };
  }

  const destTile = getTile(board, dest);
  const occupant = getPieceAt(board.pieces, dest, targetPiece.id);

  if (
    destTile === undefined ||
    destTile === null ||
    destTile.type === 'WALL' ||
    occupant !== undefined
  ) {
    return {
      dir,
      dest,
      blocked: true,
      slid: false,
      fellInPit: false,
      finalPos: { x: targetPiece.pos.x, y: targetPiece.pos.y },
      slidePath: [],
      promotes: false,
    };
  }

  if (destTile.type === 'PIT') {
    return {
      dir,
      dest,
      blocked: false,
      slid: false,
      fellInPit: true,
      finalPos: null,
      slidePath: [],
      promotes: false,
    };
  }

  if (destTile.type === 'ICE' && board.factions[targetPiece.side] !== 'FROST_WARDENS') {
    const slideRes = resolveIceSlide(board, targetPiece, dest, dir, {
      allowCapture: false,
    });
    return {
      dir,
      dest,
      blocked: false,
      slid: slideRes.slid,
      fellInPit: slideRes.fellInPit,
      finalPos: slideRes.finalPos,
      slidePath: slideRes.path,
      promotes: slideRes.promotes,
    };
  }

  return {
    dir,
    dest,
    blocked: false,
    slid: false,
    fellInPit: false,
    finalPos: dest,
    slidePath: [],
    promotes: shouldPromotePawn(targetPiece, dest, board.height),
  };
}

export interface LegalAbility {
  pieceId: string;
  ability: AbilityId;
  target: Coord;
  pushPreview?: PushOutcome;
}

/**
 * Generates all legal active ability targets (PUSHER -> PUSH, SIEGE_ENGINEERS Rook -> BREAK_WALL)
 * for a piece.
 */
export function getLegalAbilities(
  board: BoardView,
  piece: Piece,
  bonusMovePieceId: string | null = null,
): LegalAbility[] {
  if (piece.frozenTurns > 0) return [];
  if (bonusMovePieceId !== null && bonusMovePieceId !== piece.id) return [];
  if (!inBounds(board, piece.pos)) return [];

  const abilities: LegalAbility[] = [];

  if (hasTrait(piece, 'PUSHER', board.factions)) {
    for (let i = 0; i < ORTHOGONAL_DIRS.length; i++) {
      const dir = ORTHOGONAL_DIRS[i]!;
      const target: Coord = { x: piece.pos.x + dir.x, y: piece.pos.y + dir.y };
      if (!inBounds(board, target)) continue;
      const enemy = getPieceAt(board.pieces, target, piece.id);
      if (enemy !== undefined && enemy.side !== piece.side) {
        abilities.push({
          pieceId: piece.id,
          ability: 'PUSH',
          target,
          pushPreview: resolvePushOutcome(board, piece, enemy),
        });
      }
    }
  }

  if (board.factions[piece.side] === 'SIEGE_ENGINEERS' && piece.type === 'ROOK') {
    for (let i = 0; i < ORTHOGONAL_DIRS.length; i++) {
      const dir = ORTHOGONAL_DIRS[i]!;
      const target: Coord = { x: piece.pos.x + dir.x, y: piece.pos.y + dir.y };
      if (!inBounds(board, target)) continue;
      const tile = getTile(board, target);
      if (tile !== undefined && tile !== null && tile.type === 'WALL') {
        abilities.push({
          pieceId: piece.id,
          ability: 'BREAK_WALL',
          target,
        });
      }
    }
  }

  return abilities;
}

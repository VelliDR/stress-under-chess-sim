import { getEffectiveDriftSign } from '../engine/board';
import { fnv1a32 } from '../engine/prng';
import type {
  ChimeraForm,
  GameState,
  Piece,
  PieceType,
  TileType,
  TraitId,
} from '../engine/types';

/**
 * Pure deterministic 64-bit (hi32, lo32) Zobrist hashing covering ALL S.U.C.S. V3 state:
 * - Turn side, bonusMovePieceId, bossCooldown
 * - Pieces: side, type, position, traits bitmask, shield, frozen, hasMoved (pawn),
 *   aggro, dash visibility flags, miasmaExposure, composure, driftSign, faithCharge,
 *   madnessCharge, berserkReady, silencedTurns, and CHIMERA absorbedForms (FIFO order)
 * - Tiles: type, burnTurns, MIASMA gas (permanent vs turnsRemaining),
 *   SPIKES phase, PRESSURE_PLATE cooldown, ARROW_EMITTER ammo
 * - Pending Necromancer spawns
 *
 * Zero heap allocations per hash call (uses precomputed Uint32Array tables + splitmix32).
 */

const PIECE_TYPE_IDX: Readonly<Record<PieceType, number>> = {
  KING: 0,
  QUEEN: 1,
  ROOK: 2,
  BISHOP: 3,
  KNIGHT: 4,
  PAWN: 5,
  SAINT_FAITH: 6,
  SAINT_MADNESS: 7,
  CHIMERA: 8,
};

const TILE_TYPE_IDX: Readonly<Record<TileType, number>> = {
  PLAIN: 0,
  WALL: 1,
  PIT: 2,
  ICE: 3,
  WATCHTOWER: 4,
  BURNING: 5,
  CRACKED: 6,
};

const TRAIT_BIT: Readonly<Record<TraitId, number>> = {
  SHIELDED: 1 << 0,
  FROST_TOUCH: 1 << 1,
  EXPLOSIVE: 1 << 2,
  SCOUT: 1 << 3,
  SHADOW_WALKER: 1 << 4,
  PUSHER: 1 << 5,
  DASH_ON_REVEAL: 1 << 6,
};

// Board index space: supports up to 16x16 boards (256 squares)
const MAX_SQ = 256;
const NUM_PIECE_SLOTS = 18; // 2 sides * 9 piece types
const PIECE_TABLE_LEN = MAX_SQ * NUM_PIECE_SLOTS;
const TILE_TABLE_LEN = MAX_SQ * 32; // tile type/burn/gas/trap variants
const AUX_TABLE_LEN = 2048;

const pieceHi = new Uint32Array(PIECE_TABLE_LEN);
const pieceLo = new Uint32Array(PIECE_TABLE_LEN);
const tileHi = new Uint32Array(TILE_TABLE_LEN);
const tileLo = new Uint32Array(TILE_TABLE_LEN);
const auxHi = new Uint32Array(AUX_TABLE_LEN);
const auxLo = new Uint32Array(AUX_TABLE_LEN);

// Deterministic SplitMix32 table generator (no Math.random)
let seedCursor = 0x9e3779b9;
function nextU32(): number {
  seedCursor = (seedCursor + 0x9e3779b9) >>> 0;
  let z = seedCursor;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

for (let i = 0; i < PIECE_TABLE_LEN; i++) {
  pieceHi[i] = nextU32();
  pieceLo[i] = nextU32();
}
for (let i = 0; i < TILE_TABLE_LEN; i++) {
  tileHi[i] = nextU32();
  tileLo[i] = nextU32();
}
for (let i = 0; i < AUX_TABLE_LEN; i++) {
  auxHi[i] = nextU32();
  auxLo[i] = nextU32();
}

const TURN_ENEMY_HI = nextU32();
const TURN_ENEMY_LO = nextU32();

function mix32(x: number): number {
  let z = (x + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

function traitsMask(traits: readonly TraitId[]): number {
  let m = 0;
  for (let i = 0; i < traits.length; i++) {
    m |= TRAIT_BIT[traits[i]!] ?? 0;
  }
  return m;
}

function encodeChimeraForm(form: ChimeraForm): number {
  const src = PIECE_TYPE_IDX[form.sourceType];
  const tm = traitsMask(form.copiedTraits);
  const echo =
    form.saintEcho === 'FAITH_WARD' ? 1 : form.saintEcho === 'MADNESS_PIERCE' ? 2 : 0;
  return (src << 10) | (echo << 8) | tm;
}

function packPieceFlags(p: Piece, factions: GameState['factions']): number {
  const tm = traitsMask(p.traits);
  const shield = p.shieldActive ? 1 : 0;
  const frozen = Math.min(3, p.frozenTurns) & 3;
  const moved = p.type === 'PAWN' && p.hasMoved ? 1 : 0;
  const aggro = p.aggro === 'ACTIVE' ? 0 : p.aggro === 'ALERTED' ? 1 : 2;
  const hasDash =
    (tm & TRAIT_BIT.DASH_ON_REVEAL) !== 0 ||
    (p.type === 'KNIGHT' && factions[p.side] === 'RAIDERS') ||
    (p.type === 'CHIMERA' &&
      p.absorbedForms !== undefined &&
      p.absorbedForms.some((f) => f.copiedTraits.includes('DASH_ON_REVEAL')));
  const dashFlags = hasDash
    ? (p.usedDashThisTurn ? 1 : 0) | (p.wasVisibleAtTurnStart ? 2 : 0)
    : 0;
  const miasma = Math.min(3, p.miasmaExposure ?? 0) & 3;
  const comp = (p.composure ?? 3) & 3;
  const drift =
    comp === 1 && (p.type === 'ROOK' || p.type === 'BISHOP' || p.type === 'QUEEN')
      ? getEffectiveDriftSign(p) === 1
        ? 1
        : 2
      : 0;
  const faith = Math.min(3, p.faithCharge ?? 0) & 3;
  const madness = Math.min(3, p.madnessCharge ?? 0) & 3;
  const berserk = p.berserkReady === true ? 1 : 0;
  const silenced = Math.min(3, p.silencedTurns ?? 0) & 3;

  // Split into two 32-bit signatures and mix cleanly
  const f1 =
    tm |
    (shield << 7) |
    (frozen << 8) |
    (moved << 10) |
    (aggro << 11) |
    (dashFlags << 13) |
    (miasma << 15) |
    (comp << 17) |
    (drift << 19) |
    (faith << 21) |
    (madness << 23) |
    (berserk << 25) |
    (silenced << 26);
  return f1 >>> 0;
}

export interface ZobristHashOut {
  hi: number;
  lo: number;
}

/**
 * Computes a complete, deterministic 64-bit Zobrist hash into `out` (zero allocation).
 */
export function computeZobristHashInto(state: GameState, out: ZobristHashOut): void {
  let hi = state.turn === 'ENEMY' ? TURN_ENEMY_HI : 0;
  let lo = state.turn === 'ENEMY' ? TURN_ENEMY_LO : 0;

  if (state.bonusMovePieceId !== null) {
    const h = fnv1a32(state.bonusMovePieceId);
    hi ^= mix32(h ^ 0x51a7b3c1);
    lo ^= mix32(h ^ 0x2f89e4d7);
  }

  if (state.bossCooldown > 0) {
    const idx = (state.bossCooldown & 15) + 1024;
    hi ^= auxHi[idx]!;
    lo ^= auxLo[idx]!;
  }

  const width = state.width;
  const height = state.height;

  // 1) Pieces (commutative XOR across pieces so array order never causes spurious misses)
  const pieces = state.pieces;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    const sq = (p.pos.y * width + p.pos.x) & 255;
    const slot = (p.side === 'ENEMY' ? 9 : 0) + PIECE_TYPE_IDX[p.type];
    const pIdx = sq * NUM_PIECE_SLOTS + slot;
    let pHi = pieceHi[pIdx]!;
    let pLo = pieceLo[pIdx]!;

    const flags = packPieceFlags(p, state.factions);
    // Mix piece-specific V3 flags with square & slot so distinct piece states never cancel
    if (flags !== (3 << 17)) {
      const salt = (sq << 5) | slot;
      pHi ^= mix32(flags ^ Math.imul(salt, 0x45d9f3b));
      pLo ^= mix32(flags ^ Math.imul(salt, 0x119de1f3));
    }

    if (p.type === 'CHIMERA' && p.absorbedForms !== undefined && p.absorbedForms.length > 0) {
      for (let f = 0; f < p.absorbedForms.length; f++) {
        const enc = encodeChimeraForm(p.absorbedForms[f]!);
        const fSalt = (sq << 8) | (f << 4) | 0x7;
        pHi ^= mix32(enc ^ Math.imul(fSalt, 0x27d4eb2d));
        pLo ^= mix32(enc ^ Math.imul(fSalt, 0x165667b1));
      }
    }

    hi ^= pHi;
    lo ^= pLo;
  }

  // 2) Tiles (dynamic terrain, gas overlays, traps, phases, cooldowns, ammo)
  const tiles = state.tiles;
  for (let y = 0; y < height; y++) {
    const row = tiles[y]!;
    const rowBase = y * width;
    for (let x = 0; x < width; x++) {
      const t = row[x]!;
      const tType = t.type;
      const gas = t.gas;
      const trap = t.trap;
      if (tType === 'PLAIN' && gas === undefined && trap === undefined) continue;

      const sq = (rowBase + x) & 255;
      const base = sq * 32;

      if (tType !== 'PLAIN') {
        const typeCode = TILE_TYPE_IDX[tType];
        hi ^= tileHi[base + typeCode]!;
        lo ^= tileLo[base + typeCode]!;
        if (tType === 'BURNING') {
          const bt = Math.min(7, Math.max(0, t.burnTurns));
          hi ^= tileHi[base + 8 + bt]!;
          lo ^= tileLo[base + 8 + bt]!;
        }
      }

      if (gas !== undefined && gas.kind === 'MIASMA') {
        const gCode =
          gas.turnsRemaining === null ? 16 : 17 + Math.min(6, Math.max(0, gas.turnsRemaining));
        hi ^= tileHi[base + gCode]!;
        lo ^= tileLo[base + gCode]!;
      }

      if (trap !== undefined) {
        if (trap.kind === 'SPIKES') {
          const spCode = 24 + (trap.phase & 3);
          hi ^= tileHi[base + spCode]!;
          lo ^= tileLo[base + spCode]!;
        } else if (trap.kind === 'PRESSURE_PLATE') {
          const cd = Math.min(4, Math.max(0, trap.cooldown));
          hi ^= tileHi[base + 27 + cd]!;
          lo ^= tileLo[base + 27 + cd]!;
        } else if (trap.kind === 'ARROW_EMITTER' && trap.ammo !== null) {
          const aHash = (sq << 6) | (Math.min(31, Math.max(0, trap.ammo)) & 31);
          hi ^= auxHi[aHash & 2047]!;
          lo ^= auxLo[aHash & 2047]!;
        }
      }
    }
  }

  // 3) Pending Necromancer spawns
  const spawns = state.pendingSpawns;
  for (let i = 0; i < spawns.length; i++) {
    const sp = spawns[i]!;
    const sq = (sp.pos.y * width + sp.pos.x) & 255;
    const sig =
      sq |
      ((sp.side === 'ENEMY' ? 1 : 0) << 8) |
      ((sp.turnsRemaining & 7) << 9) |
      (PIECE_TYPE_IDX[sp.pieceType] << 12);
    hi ^= mix32(sig ^ 0x6c8e9cf5);
    lo ^= mix32(sig ^ 0x3b7a12d9);
  }

  out.hi = hi >>> 0;
  out.lo = lo >>> 0;
}

/**
 * Convenience wrapper returning a pair `{ hi, lo }`.
 */
export function computeZobristHash(state: GameState): ZobristHashOut {
  const out: ZobristHashOut = { hi: 0, lo: 0 };
  computeZobristHashInto(state, out);
  return out;
}

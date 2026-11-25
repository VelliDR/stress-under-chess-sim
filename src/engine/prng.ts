/**
 * Deterministic PRNG (mulberry32) and canonical FNV-1a 32-bit state hashing.
 * Strictly pure and headless — Math.random() is never used anywhere in the engine.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Computes an unsigned 32-bit FNV-1a hash over the UTF-8 encoding of a string.
 */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);

    // Handle UTF-16 surrogate pairs
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i++;
      }
    }

    if (code < 0x80) {
      hash ^= code;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    } else if (code < 0x800) {
      hash ^= 0xc0 | (code >> 6);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    } else if (code < 0x10000) {
      hash ^= 0xe0 | (code >> 12);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= 0x80 | ((code >> 6) & 0x3f);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    } else {
      hash ^= 0xf0 | (code >> 18);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= 0x80 | ((code >> 12) & 0x3f);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= 0x80 | ((code >> 6) & 0x3f);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= 0x80 | (code & 0x3f);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  }

  return hash >>> 0;
}

/**
 * Converts a string or numeric seed into an initial unsigned 32-bit mulberry32 state.
 */
export function seedToRngState(seed: string | number): number {
  if (typeof seed === 'number') {
    return (seed | 0) >>> 0;
  }
  return fnv1a32(seed);
}

/**
 * Pure single step of mulberry32.
 * Returns a float in [0, 1) and the next unsigned 32-bit rngState.
 */
export function nextRng(rngState: number): { value: number; nextState: number } {
  const nextState = (rngState + 0x6d2b79f5) >>> 0;
  let t = Math.imul(nextState ^ (nextState >>> 15), 1 | nextState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState };
}

/**
 * Returns a deterministic integer in [minInclusive, maxExclusive).
 */
export function nextInt(
  rngState: number,
  minInclusive: number,
  maxExclusive: number,
): { value: number; nextState: number } {
  if (maxExclusive <= minInclusive) {
    throw new RangeError(
      `nextInt requires maxExclusive (${maxExclusive}) > minInclusive (${minInclusive})`,
    );
  }
  const { value, nextState } = nextRng(rngState);
  const span = maxExclusive - minInclusive;
  return {
    value: minInclusive + Math.floor(value * span),
    nextState,
  };
}

/**
 * Deterministically picks one element from a non-empty array.
 */
export function pickOne<T>(
  rngState: number,
  items: readonly T[],
): { value: T; nextState: number } {
  if (items.length === 0) {
    throw new RangeError('pickOne requires a non-empty array');
  }
  const { value: index, nextState } = nextInt(rngState, 0, items.length);
  const picked = items[index];
  if (picked === undefined) {
    throw new Error('Unexpected out-of-bounds pickOne index');
  }
  return { value: picked, nextState };
}

/**
 * Returns a deterministically Fisher-Yates shuffled shallow copy of the array.
 */
export function shuffle<T>(
  rngState: number,
  items: readonly T[],
): { value: T[]; nextState: number } {
  const copy = items.slice();
  let state = rngState;

  for (let i = copy.length - 1; i > 0; i--) {
    const res = nextInt(state, 0, i + 1);
    state = res.nextState;
    const j = res.value;
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }

  return { value: copy, nextState: state };
}

/**
 * Deterministically derives a piece's initial 45° Stress Drift sign (+1 CW, -1 CCW)
 * from its `piece.id` via FNV-1a 32-bit hashing.
 */
export function getInitialDriftSign(pieceId: string): 1 | -1 {
  return (fnv1a32(pieceId) & 1) === 0 ? 1 : -1;
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTileForHash(tile: unknown): unknown {
  if (!isRecord(tile)) return tile;

  const out: Record<string, unknown> = {};
  const keys = Object.keys(tile);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = tile[k];
    if (v === undefined) continue;

    if (k === 'gas' && isRecord(v)) {
      out.gas = {
        kind: v.kind,
        turnsRemaining: v.turnsRemaining ?? null,
      };
    } else if (k === 'trap' && isRecord(v)) {
      if (v.kind === 'PRESSURE_PLATE') {
        const rawTargets = Array.isArray(v.targetIds)
          ? (v.targetIds.filter((id): id is string => typeof id === 'string').slice().sort(compareLex))
          : [];
        out.trap = {
          kind: 'PRESSURE_PLATE',
          id: v.id,
          targetIds: rawTargets,
          cooldown: v.cooldown,
          maxCooldown: v.maxCooldown,
        };
      } else if (v.kind === 'ARROW_EMITTER') {
        const dir = isRecord(v.dir) ? { dx: v.dir.dx, dy: v.dir.dy } : v.dir;
        out.trap = {
          kind: 'ARROW_EMITTER',
          id: v.id,
          dir,
          ammo: v.ammo ?? null,
          flaming: Boolean(v.flaming),
          piercing: Boolean(v.piercing),
        };
      } else if (v.kind === 'SPIKES') {
        out.trap = {
          kind: 'SPIKES',
          id: v.id,
          phase: v.phase,
        };
      } else {
        out.trap = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizePieceForHash(piece: unknown): unknown {
  if (!isRecord(piece)) return piece;

  const out: Record<string, unknown> = {};
  const keys = Object.keys(piece);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const v = piece[k];
    if (v === undefined) continue;

    // Normalize optional V3 fields against deterministic defaults so omitted legacy fields
    // and explicitly set defaults produce identical lockstep hashes.
    if (k === 'composure' && v === 3) continue;
    if (k === 'miasmaExposure' && v === 0) continue;
    if (k === 'faithCharge' && v === 0) continue;
    if (k === 'madnessCharge' && v === 0) continue;
    if (k === 'berserkReady' && v === false) continue;
    if (k === 'silencedTurns' && v === 0) continue;

    if (k === 'absorbedForms' && Array.isArray(v)) {
      if (v.length === 0) continue;
      out.absorbedForms = v.map((form) => {
        if (!isRecord(form)) return form;
        const normalizedForm: Record<string, unknown> = {
          sourceType: form.sourceType,
          copiedTraits: Array.isArray(form.copiedTraits)
            ? form.copiedTraits
                .filter((t): t is string => typeof t === 'string')
                .slice()
                .sort(compareLex)
            : [],
        };
        if (form.saintEcho !== undefined) {
          normalizedForm.saintEcho = form.saintEcho;
        }
        return normalizedForm;
      });
      continue;
    }

    out[k] = v;
  }
  return out;
}

function normalizeStateForHash(state: unknown): unknown {
  if (!isRecord(state)) return state;
  if (!Array.isArray(state.tiles) || !Array.isArray(state.pieces)) {
    return state;
  }

  const normalizedTiles = state.tiles.map((row) =>
    Array.isArray(row) ? row.map((tile) => normalizeTileForHash(tile)) : row,
  );

  const normalizedPieces = state.pieces
    .map((p) => normalizePieceForHash(p))
    .sort((a, b) => {
      const idA = isRecord(a) && typeof a.id === 'string' ? a.id : '';
      const idB = isRecord(b) && typeof b.id === 'string' ? b.id : '';
      return compareLex(idA, idB);
    });

  return {
    ...state,
    tiles: normalizedTiles,
    pieces: normalizedPieces,
  };
}

/**
 * Produces canonical key-sorted JSON string for deterministic hashing regardless of
 * object key insertion order.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value as number)) return 'null';
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const elem = value[i];
      parts.push(elem === undefined ? 'null' : canonicalStringify(elem));
    }
    return `[${parts.join(',')}]`;
  }
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      const v = record[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalStringify(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/**
 * Computes a deterministic 8-char lowercase hex FNV-1a 32-bit digest for any
 * JSON-serializable state object (e.g. GameState), canonically summarizing all V3
 * dungeon overlays (tile.gas, tile.trap, tile.underlyingType) and psychology/unit
 * fields (miasmaExposure, composure, driftSign, faithCharge, madnessCharge,
 * berserkReady, silencedTurns, absorbedForms).
 */
export function computeStateHash(state: unknown): string {
  return fnv1a32(canonicalStringify(normalizeStateForHash(state)))
    .toString(16)
    .padStart(8, '0');
}

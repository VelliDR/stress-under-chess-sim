/**
 * Pure deterministic Piece Psychology, Saint Auras, Silence, and Chimera Evolution engine
 * (Package B — Design V3).
 * Architectural invariant: zero DOM/Canvas/window/performance references, zero Math.random().
 */

import {
  chebyshevDistance,
  COMPASS_DIRS,
  computeDriftedMoveTargets,
  coordEquals,
  DriftedTarget,
  getEffectiveDriftSign,
  getFrenzyExtraRange,
  getLegalMoves,
  getPieceAt,
  getTile,
  hasArmorPierce,
  hasFrenzyHaste,
  inBounds,
  isInFriendlyMadnessAura,
  isStressDriftActive,
  isTileWalkable,
  pawnForwardDelta,
} from './board';
import {
  compareIdsCanonical,
  hasMiasma,
  isExtendedSpikes,
  isPieceSilenced,
} from './dungeon';
import { fnv1a32 } from './prng';
import {
  BoardView,
  ChimeraForm,
  ComposureChangeReason,
  ComposureLevel,
  Coord,
  DEFAULT_COMPOSURE,
  FactionPassive,
  GameEvent,
  GameState,
  LegalMove,
  LegalMoveMeta,
  Piece,
  PieceType,
  Side,
  TraitId,
  VisibilityLevel,
} from './types';

export {
  COMPASS_DIRS,
  computeDriftedMoveTargets,
  getEffectiveDriftSign,
  getFrenzyExtraRange,
  hasArmorPierce,
  hasFrenzyHaste,
  isInFriendlyMadnessAura,
  isStressDriftActive,
};
export type { DriftedTarget };

const DISOBEY_FALLBACK_QUOTES: readonly string[] = [
  'O kareye basmam, tehlike açık!',
  'Şah ya da Ocaklı yakında değil; ileri yürümüyorum.',
  'Göz göre göre ateşe atlamam.',
  'Sinirlerim kaldırmıyor, başka hamle seç.',
];

export interface DisobedienceResult {
  disobeyed: boolean;
  reason?: string;
  quote?: string;
}

/**
 * Returns true if the piece is silenced (buffs, traits, shield protection, berserk, and auras suppressed).
 * CHIMERA is permanently immune.
 */
export function isSilenced(piece: Piece): boolean {
  return isPieceSilenced(piece);
}

/**
 * Computes a piece's currently effective trait list:
 * - Silenced pieces return `[]`.
 * - Includes faction-granted traits (RAIDERS Knight -> DASH_ON_REVEAL).
 * - For CHIMERA, merges structural `copiedTraits` from all absorbed forms (plus SHIELDED from FAITH_WARD).
 */
export function getEffectiveTraits(
  piece: Piece,
  factions?: Readonly<Record<Side, FactionPassive>>,
): TraitId[] {
  if (isSilenced(piece)) return [];

  const result: TraitId[] = [];
  const addUnique = (t: TraitId): void => {
    if (!result.includes(t)) result.push(t);
  };

  for (let i = 0; i < piece.traits.length; i++) {
    addUnique(piece.traits[i]!);
  }

  if (
    piece.type === 'KNIGHT' &&
    factions !== undefined &&
    factions[piece.side] === 'RAIDERS'
  ) {
    addUnique('DASH_ON_REVEAL');
  }

  if (piece.type === 'CHIMERA' && piece.absorbedForms !== undefined) {
    for (let i = 0; i < piece.absorbedForms.length; i++) {
      const form = piece.absorbedForms[i]!;
      for (let t = 0; t < form.copiedTraits.length; t++) {
        addUnique(form.copiedTraits[t]!);
      }
      if (form.saintEcho === 'FAITH_WARD') {
        addUnique('SHIELDED');
      }
    }
  }

  return result;
}

export function getComposure(piece: Piece): ComposureLevel {
  return piece.composure ?? DEFAULT_COMPOSURE;
}

/**
 * CHIMERA, SAINT_FAITH, and SAINT_MADNESS permanently remain at Composure 3.
 */
export function isComposureImmune(piece: Piece): boolean {
  return (
    piece.type === 'CHIMERA' ||
    piece.type === 'SAINT_FAITH' ||
    piece.type === 'SAINT_MADNESS'
  );
}

/**
 * Adjusts a piece's composure within [floor, 3], emitting COMPOSURE_CHANGED
 * and triggering PIECE_BREAKDOWN (frozenTurns = 1 + newlyFrozenIds) upon hitting 0.
 * KING can never drop below 1.
 */
export function adjustComposure(
  piece: Piece,
  delta: number,
  reason: ComposureChangeReason,
  events: GameEvent[],
  newlyFrozenIds: Set<string>,
  minFloor: ComposureLevel = 0,
): ComposureLevel {
  if (isComposureImmune(piece)) return DEFAULT_COMPOSURE;

  const effectiveFloor: ComposureLevel =
    piece.type === 'KING' ? (Math.max(1, minFloor) as ComposureLevel) : minFloor;
  const from = getComposure(piece);
  const clamped = Math.max(effectiveFloor, Math.min(3, from + delta)) as ComposureLevel;

  if (clamped === from) return from;

  if (clamped === 3) {
    piece.composure = undefined;
  } else {
    piece.composure = clamped;
  }

  events.push({
    type: 'COMPOSURE_CHANGED',
    pieceId: piece.id,
    from,
    to: clamped,
    reason,
  });

  if (clamped === 0) {
    piece.frozenTurns = Math.max(piece.frozenTurns, 1);
    newlyFrozenIds.add(piece.id);
    events.push({
      type: 'PIECE_BREAKDOWN',
      pieceId: piece.id,
      at: { x: piece.pos.x, y: piece.pos.y },
    });
  }

  return clamped;
}

/**
 * Returns true if `piece` is protected by an unsilenced friendly SAINT_FAITH within Chebyshev <= 2.
 */
export function hasFriendlyFaithAura(board: BoardView, piece: Piece): boolean {
  for (let i = 0; i < board.pieces.length; i++) {
    const other = board.pieces[i]!;
    if (other.side !== piece.side) continue;
    if (other.type !== 'SAINT_FAITH') continue;
    if (isSilenced(other)) continue;
    if (chebyshevDistance(other.pos, piece.pos) <= 2) return true;
  }
  return false;
}

/**
 * Checks whether an enemy piece threatens `targetSquare` given current board geometry
 * (treating `targetSquare` as the target occupancy regardless of whether currently empty).
 */
export function canPieceAttackSquare(
  board: BoardView,
  attacker: Piece,
  targetSquare: Coord,
  ignorePieceId?: string,
): boolean {
  if (!inBounds(board, attacker.pos) || !inBounds(board, targetSquare)) return false;
  if (coordEquals(attacker.pos, targetSquare)) return false;

  const extraRange = getFrenzyExtraRange(board, attacker);
  const ignoreMiasma = hasFrenzyHaste(board, attacker) || attacker.type === 'CHIMERA';
  const startInMiasma = hasMiasma(getTile(board, attacker.pos));

  const traceRay = (dirs: readonly Coord[], maxRange: number, applyMiasma: boolean): boolean => {
    const effMax = applyMiasma && !ignoreMiasma && startInMiasma ? 1 : maxRange;
    for (let d = 0; d < dirs.length; d++) {
      const dir = dirs[d]!;
      let enteredMiasma = false;
      for (let step = 1; step <= effMax; step++) {
        const c: Coord = {
          x: attacker.pos.x + dir.x * step,
          y: attacker.pos.y + dir.y * step,
        };
        if (!inBounds(board, c)) break;
        const tile = getTile(board, c);
        if (!isTileWalkable(tile)) break;
        if (coordEquals(c, targetSquare)) return true;
        const occ = getPieceAt(board.pieces, c, ignorePieceId);
        if (occ !== undefined) break;
        if (applyMiasma && !ignoreMiasma) {
          if (enteredMiasma) break;
          if (hasMiasma(tile)) enteredMiasma = true;
        }
      }
    }
    return false;
  };

  const dx = Math.abs(targetSquare.x - attacker.pos.x);
  const dy = Math.abs(targetSquare.y - attacker.pos.y);

  switch (attacker.type) {
    case 'PAWN': {
      const fdy = pawnForwardDelta(attacker.side);
      return dx === 1 && targetSquare.y - attacker.pos.y === fdy;
    }
    case 'KNIGHT':
      return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
    case 'KING':
      return traceRay(COMPASS_DIRS, 1 + extraRange, false);
    case 'ROOK': {
      if (isStressDriftActive(attacker)) {
        return computeDriftedMoveTargets(board, attacker, ignoreMiasma).some((t) =>
          coordEquals(t.to, targetSquare),
        );
      }
      return traceRay(
        [COMPASS_DIRS[0]!, COMPASS_DIRS[2]!, COMPASS_DIRS[4]!, COMPASS_DIRS[6]!],
        Math.max(board.width, board.height),
        true,
      );
    }
    case 'BISHOP': {
      if (isStressDriftActive(attacker)) {
        return computeDriftedMoveTargets(board, attacker, ignoreMiasma).some((t) =>
          coordEquals(t.to, targetSquare),
        );
      }
      return traceRay(
        [COMPASS_DIRS[1]!, COMPASS_DIRS[3]!, COMPASS_DIRS[5]!, COMPASS_DIRS[7]!],
        Math.max(board.width, board.height),
        true,
      );
    }
    case 'QUEEN': {
      if (isStressDriftActive(attacker)) {
        return computeDriftedMoveTargets(board, attacker, ignoreMiasma).some((t) =>
          coordEquals(t.to, targetSquare),
        );
      }
      return traceRay(COMPASS_DIRS, Math.max(board.width, board.height), true);
    }
    case 'SAINT_FAITH':
    case 'SAINT_MADNESS':
      return traceRay(COMPASS_DIRS, 2 + extraRange, true);
    case 'CHIMERA': {
      const forms = attacker.absorbedForms ?? [];
      let orthMax = 3 + extraRange;
      let diagMax = 3 + extraRange;
      let hasKnight = false;
      const boardMax = Math.max(board.width, board.height);
      for (let i = 0; i < forms.length; i++) {
        const src = forms[i]!.sourceType;
        if (src === 'ROOK' || src === 'QUEEN') orthMax = boardMax;
        if (src === 'BISHOP' || src === 'QUEEN') diagMax = boardMax;
        if (src === 'KNIGHT') hasKnight = true;
      }
      if (hasKnight && ((dx === 1 && dy === 2) || (dx === 2 && dy === 1))) return true;
      if (
        traceRay(
          [COMPASS_DIRS[0]!, COMPASS_DIRS[2]!, COMPASS_DIRS[4]!, COMPASS_DIRS[6]!],
          orthMax,
          false,
        )
      ) {
        return true;
      }
      return traceRay(
        [COMPASS_DIRS[1]!, COMPASS_DIRS[3]!, COMPASS_DIRS[5]!, COMPASS_DIRS[7]!],
        diagMax,
        false,
      );
    }
  }
}

/**
 * Checks whether `piece` has moral protection against Disobedience:
 * friendly KING or unsilenced friendly SAINT_FAITH within Chebyshev <= 2.
 */
export function hasMoralProtection(board: BoardView, piece: Piece): boolean {
  for (let i = 0; i < board.pieces.length; i++) {
    const other = board.pieces[i]!;
    if (other.side !== piece.side) continue;
    if (other.type === 'KING' && chebyshevDistance(other.pos, piece.pos) <= 2) {
      return true;
    }
    if (
      other.type === 'SAINT_FAITH' &&
      !isSilenced(other) &&
      chebyshevDistance(other.pos, piece.pos) <= 2
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates Disobedience for a fragile (`composure === 1`) piece attempting `move`:
 * - Immune: KING, CHIMERA, SAINT_FAITH, SAINT_MADNESS, active unsilenced berserkReady,
 *   or pieces with moral protection (friendly KING or unsilenced SAINT_FAITH within Chebyshev <= 2).
 * - Triggers when `move.to` is threatened by a VISIBLE enemy piece:
 *   always for PAWN; for non-capture moves on other fragile pieces.
 */
export function evaluateDisobedience(
  board: BoardView,
  piece: Piece,
  move: LegalMove,
  viewerFog?: readonly (readonly VisibilityLevel[])[],
  turnNumber = 1,
  isSquareVisible?: (coord: Coord) => boolean,
): DisobedienceResult {
  if (getComposure(piece) !== 1) return { disobeyed: false };
  if (
    piece.type === 'KING' ||
    piece.type === 'CHIMERA' ||
    piece.type === 'SAINT_FAITH' ||
    piece.type === 'SAINT_MADNESS'
  ) {
    return { disobeyed: false };
  }
  if (piece.berserkReady === true && !isSilenced(piece)) {
    return { disobeyed: false };
  }
  if (hasMoralProtection(board, piece)) {
    return { disobeyed: false };
  }

  const isCapture = move.resolution.captured || move.resolution.brokeShield;
  if (piece.type !== 'PAWN' && isCapture) {
    return { disobeyed: false };
  }

  let threatenedByVisibleEnemy = false;
  for (let i = 0; i < board.pieces.length; i++) {
    const enemy = board.pieces[i]!;
    if (enemy.side === piece.side) continue;
    if (viewerFog !== undefined) {
      if (viewerFog[enemy.pos.y]?.[enemy.pos.x] !== 'VISIBLE') {
        continue;
      }
    } else if (isSquareVisible !== undefined) {
      if (!isSquareVisible(enemy.pos)) {
        continue;
      }
    }
    if (canPieceAttackSquare(board, enemy, move.to, piece.id)) {
      threatenedByVisibleEnemy = true;
      break;
    }
  }

  if (!threatenedByVisibleEnemy) {
    return { disobeyed: false };
  }

  const idx =
    fnv1a32(`${piece.id}:${turnNumber}:${move.to.x},${move.to.y}`) %
    DISOBEY_FALLBACK_QUOTES.length;
  const quote = DISOBEY_FALLBACK_QUOTES[idx] ?? DISOBEY_FALLBACK_QUOTES[0]!;
  return {
    disobeyed: true,
    reason: 'Hedef kare görünür düşman tehdidi altında',
    quote,
  };
}

/**
 * Builds rich UI / preview metadata (`LegalMoveMeta[]`) for a piece's legal moves,
 * including 45° Stress Drift flags, Disobedience status, and lethal terrain warnings.
 */
export function buildLegalMovesMeta(
  board: BoardView,
  piece: Piece,
  legalMoves: readonly LegalMove[],
  viewerFog?: readonly (readonly VisibilityLevel[])[],
  turnNumber = 1,
): LegalMoveMeta[] {
  const metas: LegalMoveMeta[] = [];

  for (let i = 0; i < legalMoves.length; i++) {
    const move = legalMoves[i]!;
    const disob = evaluateDisobedience(board, piece, move, viewerFog, turnNumber);
    const finalPos = move.resolution.finalPos;
    const finalTile = finalPos !== null ? getTile(board, finalPos) : null;

    let lethalWarning: LegalMoveMeta['lethalWarning'];
    if (move.resolution.fellInPit) {
      lethalWarning = 'PIT';
    } else if (isExtendedSpikes(finalTile)) {
      lethalWarning = 'SPIKES';
    } else if (finalTile?.type === 'BURNING') {
      lethalWarning = 'BURNING';
    } else if (hasMiasma(finalTile) && piece.type !== 'CHIMERA') {
      lethalWarning = 'MIASMA';
    }

    const meta: LegalMoveMeta = {
      to: { x: move.to.x, y: move.to.y },
      path: move.resolution.path.map((c) => ({ x: c.x, y: c.y })),
      isDrifted: move.isDrifted === true,
      disobeyed: disob.disobeyed,
    };
    if (disob.reason !== undefined) meta.disobeyReason = disob.reason;
    if (lethalWarning !== undefined) meta.lethalWarning = lethalWarning;
    metas.push(meta);
  }

  return metas;
}

/**
 * Convenience helper returning `LegalMoveMeta[]` directly for a board/VisibleState and piece.
 */
export function getLegalMovesWithMeta(
  board: BoardView,
  piece: Piece,
  viewerFog?: readonly (readonly VisibilityLevel[])[],
  turnNumber = 1,
  bonusMovePieceId: string | null = null,
): LegalMoveMeta[] {
  const moves = getLegalMoves(board, piece, bonusMovePieceId);
  return buildLegalMovesMeta(board, piece, moves, viewerFog, turnNumber);
}

/**
 * Evolves a CHIMERA upon capturing `victim` using a 2-slot FIFO queue (`absorbedForms`):
 * - Traitless PAWN does NOT burn a slot.
 * - Copies victim's structural traits (even if victim was silenced).
 * - SAINT_FAITH grants `saintEcho: 'FAITH_WARD'` (immediate SHIELDED + shieldActive).
 * - SAINT_MADNESS grants `saintEcho: 'MADNESS_PIERCE'` (armor-piercing attacks).
 */
export function evolveChimeraOnCapture(
  chimera: Piece,
  victim: Piece,
  events: GameEvent[],
): boolean {
  if (chimera.type !== 'CHIMERA') return false;

  // Slot protection: traitless ordinary PAWN never burns a valuable slot
  if (victim.type === 'PAWN' && victim.traits.length === 0) {
    return false;
  }

  let newForm: ChimeraForm | null = null;
  if (victim.type === 'CHIMERA') {
    const victimForms = victim.absorbedForms ?? [];
    if (victimForms.length === 0) return false;
    const latest = victimForms[victimForms.length - 1]!;
    newForm = {
      sourceType: latest.sourceType,
      copiedTraits: latest.copiedTraits.slice(),
      ...(latest.saintEcho !== undefined ? { saintEcho: latest.saintEcho } : {}),
    };
  } else {
    const saintEcho: ChimeraForm['saintEcho'] =
      victim.type === 'SAINT_FAITH'
        ? 'FAITH_WARD'
        : victim.type === 'SAINT_MADNESS'
          ? 'MADNESS_PIERCE'
          : undefined;
    newForm = {
      sourceType: victim.type,
      copiedTraits: victim.traits.slice(),
      ...(saintEcho !== undefined ? { saintEcho } : {}),
    };
  }

  const forms = chimera.absorbedForms !== undefined ? chimera.absorbedForms.slice() : [];
  let droppedType: PieceType | undefined;
  if (forms.length >= 2) {
    const dropped = forms.shift();
    if (dropped !== undefined) {
      droppedType = dropped.sourceType;
    }
  }
  forms.push(newForm);
  chimera.absorbedForms = forms;

  // Activate shield immediately if newly absorbed form grants SHIELDED or FAITH_WARD
  if (
    newForm.saintEcho === 'FAITH_WARD' ||
    newForm.copiedTraits.includes('SHIELDED')
  ) {
    chimera.shieldActive = true;
  } else {
    // If previous shield source was evicted by FIFO, keep shield only if still backed by a form or trait
    const stillHasShieldSource =
      chimera.traits.includes('SHIELDED') ||
      forms.some((f) => f.saintEcho === 'FAITH_WARD' || f.copiedTraits.includes('SHIELDED'));
    if (!stillHasShieldSource) {
      chimera.shieldActive = false;
    }
  }

  events.push({
    type: 'CHIMERA_EVOLVED',
    chimeraId: chimera.id,
    absorbedType: newForm.sourceType,
    ...(droppedType !== undefined ? { droppedType } : {}),
  });

  return true;
}

/**
 * Runs end-of-turn Saint Auras, 3-turn Ultimates (7x7 Holy Cleanse & 2-turn Silence;
 * Madness Berserk Ready), and out-of-aura charge decay for `finishingSide` in canonical piece.id order.
 */
export function runSaintEndOfTurnAuras(
  state: GameState,
  finishingSide: Side,
  events: GameEvent[],
  newlyFrozenIds: Set<string>,
): void {
  const sortedActive = state.pieces
    .filter((p) => p.side === finishingSide)
    .sort((a, b) => compareIdsCanonical(a.id, b.id));

  const activeFaithSaints = sortedActive.filter(
    (p) => p.type === 'SAINT_FAITH' && !isSilenced(p),
  );
  const activeMadnessSaints = sortedActive.filter(
    (p) => p.type === 'SAINT_MADNESS' && !isSilenced(p),
  );

  const faithCoveredIds = new Set<string>();
  const madnessCoveredIds = new Set<string>();

  // 1) SAINT_FAITH auras (Chebyshev <= 2, excluding self) & 3-turn 7x7 Ultimate
  for (let s = 0; s < activeFaithSaints.length; s++) {
    const saint = activeFaithSaints[s]!;
    for (let a = 0; a < sortedActive.length; a++) {
      const ally = sortedActive[a]!;
      if (ally.id === saint.id) continue;
      if (chebyshevDistance(saint.pos, ally.pos) > 2) continue;

      faithCoveredIds.add(ally.id);
      adjustComposure(ally, 1, 'FAITH_AURA', events, newlyFrozenIds);

      const nextCharge = (ally.faithCharge ?? 0) + 1;
      ally.faithCharge = nextCharge;
      events.push({
        type: 'SAINT_AURA_TICK',
        saintId: saint.id,
        targetId: ally.id,
        aspect: 'FAITH',
        charge: nextCharge,
      });

      if (nextCharge >= 3) {
        ally.faithCharge = undefined;

        // 1. Grant / refresh SHIELDED on target ally
        if (!ally.traits.includes('SHIELDED')) {
          ally.traits.push('SHIELDED');
        }
        ally.shieldActive = true;

        // 2. 1.5x Holy Pulse (Chebyshev <= 3, 7x7 centered on Saint)
        const cleansedAllyIds: string[] = [];
        const silencedEnemyIds: string[] = [];

        const allSorted = state.pieces
          .slice()
          .sort((x, y) => compareIdsCanonical(x.id, y.id));

        for (let i = 0; i < allSorted.length; i++) {
          const target = allSorted[i]!;
          if (chebyshevDistance(saint.pos, target.pos) > 3) continue;

          if (target.side === finishingSide) {
            target.frozenTurns = 0;
            target.miasmaExposure = undefined;
            target.silencedTurns = undefined;
            target.madnessCharge = undefined;
            if (getComposure(target) < 3) {
              adjustComposure(target, 3, 'CLEANSE', events, newlyFrozenIds);
            }
            cleansedAllyIds.push(target.id);
          } else if (target.type !== 'CHIMERA') {
            target.silencedTurns = Math.max(target.silencedTurns ?? 0, 2);
            silencedEnemyIds.push(target.id);
          }
        }

        events.push({
          type: 'FAITH_ULTIMATE_TRIGGERED',
          saintId: saint.id,
          shieldedTargetId: ally.id,
          pulseOrigin: { x: saint.pos.x, y: saint.pos.y },
          pulseRadius: 3,
          cleansedAllyIds,
          silencedEnemyIds,
        });
      }
    }
  }

  // 2) SAINT_MADNESS auras (Chebyshev <= 2, excluding self) & 3-turn Berserk Ultimate
  for (let s = 0; s < activeMadnessSaints.length; s++) {
    const saint = activeMadnessSaints[s]!;
    for (let a = 0; a < sortedActive.length; a++) {
      const ally = sortedActive[a]!;
      if (ally.id === saint.id) continue;
      if (chebyshevDistance(saint.pos, ally.pos) > 2) continue;

      madnessCoveredIds.add(ally.id);
      adjustComposure(ally, -1, 'MADNESS_AURA', events, newlyFrozenIds, 1);

      const nextCharge = (ally.madnessCharge ?? 0) + 1;
      ally.madnessCharge = nextCharge;
      events.push({
        type: 'SAINT_AURA_TICK',
        saintId: saint.id,
        targetId: ally.id,
        aspect: 'MADNESS',
        charge: nextCharge,
      });

      if (nextCharge >= 3) {
        ally.madnessCharge = undefined;
        ally.berserkReady = true;
        events.push({
          type: 'MADNESS_ULTIMATE_TRIGGERED',
          saintId: saint.id,
          targetId: ally.id,
          at: { x: ally.pos.x, y: ally.pos.y },
        });
      }
    }
  }

  // 3) Out-of-aura charge decay (-1, min 0)
  for (let i = 0; i < sortedActive.length; i++) {
    const ally = sortedActive[i]!;
    if (!faithCoveredIds.has(ally.id) && (ally.faithCharge ?? 0) > 0) {
      const nextVal = (ally.faithCharge ?? 0) - 1;
      ally.faithCharge = nextVal <= 0 ? undefined : nextVal;
    }
    if (!madnessCoveredIds.has(ally.id) && (ally.madnessCharge ?? 0) > 0) {
      const nextVal = (ally.madnessCharge ?? 0) - 1;
      ally.madnessCharge = nextVal <= 0 ? undefined : nextVal;
    }
  }
}

/**
 * Finds the first orthogonally adjacent piece (ally OR enemy) around `center`
 * in canonical (y asc, x asc) order for Berserk Chain knockback.
 */
export function findCanonicalAdjacentPiece(
  pieces: readonly Piece[],
  center: Coord,
  ignorePieceId: string,
): Piece | undefined {
  const dirs: readonly Coord[] = [
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i]!;
    const found = getPieceAt(pieces, { x: center.x + d.x, y: center.y + d.y }, ignorePieceId);
    if (found !== undefined) return found;
  }
  return undefined;
}

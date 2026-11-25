import { describe, expect, it } from 'vitest';
import {
  coordEquals,
  createEmptyTiles,
  createTile,
  getLegalMoves,
  getRawMoveTargets,
} from '../src/engine/board';
import { createMiasmaOverlay } from '../src/engine/dungeon';
import { computeSilhouettes, getPieceVisionRadius } from '../src/engine/fog';
import { computeStateHash } from '../src/engine/prng';
import {
  getComposure,
  getEffectiveTraits,
  getLegalMovesWithMeta,
  isSilenced,
} from '../src/engine/psychology';
import { createGameState, replayActions, stepGame } from '../src/engine/reducer';
import { GameAction, Piece, PieceType, Side, TraitId } from '../src/engine/types';

function makePiece(
  overrides: Partial<Piece> & {
    id: string;
    side: Side;
    type: PieceType;
    pos: { x: number; y: number };
  },
): Piece {
  const traits: TraitId[] = overrides.traits ?? [];
  const base: Piece = {
    id: overrides.id,
    side: overrides.side,
    type: overrides.type,
    pos: { ...overrides.pos },
    traits,
    shieldActive: overrides.shieldActive ?? traits.includes('SHIELDED'),
    frozenTurns: overrides.frozenTurns ?? 0,
    hasMoved: overrides.hasMoved ?? false,
    aggro: overrides.aggro ?? 'ACTIVE',
    usedDashThisTurn: overrides.usedDashThisTurn ?? false,
    wasVisibleAtTurnStart: overrides.wasVisibleAtTurnStart ?? false,
  };
  if (overrides.composure !== undefined) base.composure = overrides.composure;
  if (overrides.driftSign !== undefined) base.driftSign = overrides.driftSign;
  if (overrides.miasmaExposure !== undefined) base.miasmaExposure = overrides.miasmaExposure;
  if (overrides.faithCharge !== undefined) base.faithCharge = overrides.faithCharge;
  if (overrides.madnessCharge !== undefined) base.madnessCharge = overrides.madnessCharge;
  if (overrides.berserkReady !== undefined) base.berserkReady = overrides.berserkReady;
  if (overrides.silencedTurns !== undefined) base.silencedTurns = overrides.silencedTurns;
  if (overrides.absorbedForms !== undefined) base.absorbedForms = overrides.absorbedForms;
  return base;
}

describe('FAZ V3-3: Composure (3->2->1->0), Breakdown & Recovery', () => {
  it('drops composure 3->2->1->0, freezes on breakdown with newlyFrozenIds protection, recovers to 1, and floors KING at 1', () => {
    const tiles = createEmptyTiles(7, 7, 'PLAIN');
    tiles[4]![2] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[4]![0] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });

    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 4 }, composure: 1 });
    const pKnight = makePiece({
      id: 'pn',
      side: 'PLAYER',
      type: 'KNIGHT',
      pos: { x: 2, y: 4 },
      composure: 2,
    });
    const pAlly = makePiece({ id: 'pa', side: 'PLAYER', type: 'PAWN', pos: { x: 3, y: 4 } });
    const eRook = makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 3, y: 2 } });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 6, y: 0 } });

    const s0 = createGameState({
      width: 7,
      height: 7,
      tiles,
      pieces: [pKing, pKnight, pAlly, eRook, eKing],
    });

    // Turn 1 (PLAYER passes): pn on MIASMA -> composure 2 -> 1 (HAZARD); pKing stays at 1 (never 0!)
    const r1 = stepGame(s0, { type: 'END_TURN' });
    expect(getComposure(r1.nextState.pieces.find((p) => p.id === 'pn')!)).toBe(1);
    expect(getComposure(r1.nextState.pieces.find((p) => p.id === 'pk')!)).toBe(1);
    expect(r1.nextState.pieces.find((p) => p.id === 'pk')!.frozenTurns).toBe(0);

    // Turn 2 (ENEMY captures pAlly at (3,4), dist 1 from pn): ALLY_DEATH drops pn 1 -> 0 -> PIECE_BREAKDOWN!
    const r2 = stepGame(r1.nextState, { type: 'MOVE', pieceId: 'er', to: { x: 3, y: 4 } });
    expect(r2.error).toBeUndefined();
    expect(r2.events.some((e) => e.type === 'PIECE_BREAKDOWN' && e.pieceId === 'pn')).toBe(true);
    const pnAfterBreakdown = r2.nextState.pieces.find((p) => p.id === 'pn')!;
    expect(getComposure(pnAfterBreakdown)).toBe(0);
    expect(pnAfterBreakdown.frozenTurns).toBe(1);

    // Turn 3 (PLAYER): pn is frozen; move pKing out of miasma so it doesn't suffocate -> Step 7 unfreezes pn & recovers 0 -> 1
    // Also pn has miasmaExposure=1 so move pn? It's frozen, wait: on Turn 3 Step 7 pn would hit exposure 2 and suffocate unless off miasma!
    // Let's verify breakdown recovery cleanly on a non-miasma tile in the next assertion!
    const cleanState = createGameState({
      width: 6,
      height: 6,
      pieces: [
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 5 } }),
        makePiece({ id: 'pn', side: 'PLAYER', type: 'KNIGHT', pos: { x: 2, y: 4 }, composure: 0, frozenTurns: 1 }),
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 5, y: 0 } }),
      ],
    });
    const recoverStep = stepGame(cleanState, { type: 'END_TURN' });
    const pnRecovered = recoverStep.nextState.pieces.find((p) => p.id === 'pn')!;
    expect(pnRecovered.frozenTurns).toBe(0);
    expect(getComposure(pnRecovered)).toBe(1);
    expect(
      recoverStep.events.some(
        (e) => e.type === 'COMPOSURE_CHANGED' && e.pieceId === 'pn' && e.from === 0 && e.to === 1 && e.reason === 'BREAKDOWN_RECOVERY',
      ),
    ).toBe(true);
  });
});

describe('FAZ V3-3: 45° Curved Stress Drift & Disobedience', () => {
  it('curves a composure-1 ROOK 45° around a WALL to capture behind cover and flips driftSign', () => {
    const tiles = createEmptyTiles(7, 7, 'PLAIN');
    tiles[2]![2] = createTile('WALL'); // directly blocks straight north at step 3!

    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 6 } });
    const pRook = makePiece({
      id: 'pr',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 2, y: 5 },
      composure: 1,
      driftSign: 1, // CW: North (0) bends to NE (1) at steps 3..5!
    });
    const eTarget = makePiece({ id: 'et', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 2 } });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 6, y: 0 } });

    const s0 = createGameState({
      width: 7,
      height: 7,
      tiles,
      pieces: [pKing, pRook, eTarget, eKing],
    });

    const moves = getLegalMoves(s0, pRook);
    // Path: (2,5) -> (2,4) -> (2,3) [straight 2] -> (3,2) [45° NE bend captures eTarget behind WALL(2,2)!]
    const curvedCapture = moves.find((m) => coordEquals(m.to, { x: 3, y: 2 }));
    expect(curvedCapture).toBeDefined();
    expect(curvedCapture?.isDrifted).toBe(true);
    expect(curvedCapture?.resolution.path).toEqual([
      { x: 2, y: 5 },
      { x: 2, y: 4 },
      { x: 2, y: 3 },
      { x: 3, y: 2 },
    ]);
    expect(curvedCapture?.resolution.captured).toBe(true);

    const step = stepGame(s0, { type: 'MOVE', pieceId: 'pr', to: { x: 3, y: 2 } });
    expect(step.error).toBeUndefined();
    expect(step.events.some((e) => e.type === 'PIECE_DRIFTED' && e.pieceId === 'pr' && e.driftSign === 1)).toBe(true);
    const rookAfter = step.nextState.pieces.find((p) => p.id === 'pr')!;
    expect(rookAfter.pos).toEqual({ x: 3, y: 2 });
    expect(rookAfter.driftSign).toBe(-1); // Flipped!
    expect(getComposure(rookAfter)).toBe(2); // Capture recovered +1 composure!
  });

  it('refuses threatened moves via Disobedience without advancing turn, unless protected by KING, unsilenced SAINT_FAITH, or berserkReady', () => {
    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 6 } });
    const pPawn = makePiece({ id: 'pp', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 4 }, composure: 1 });
    const eRook = makePiece({ id: 'er', side: 'ENEMY', type: 'ROOK', pos: { x: 4, y: 2 } }); // visible at dist 2, attacks (4,3)
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 6, y: 0 } });

    const s0 = createGameState({
      width: 7,
      height: 7,
      pieces: [pKing, pPawn, eRook, eKing],
    });

    const metas = getLegalMovesWithMeta(s0, pPawn, s0.fog.PLAYER, s0.turnNumber);
    const stepForwardMeta = metas.find((m) => coordEquals(m.to, { x: 4, y: 3 }));
    expect(stepForwardMeta?.disobeyed).toBe(true);

    // Attempting the move returns unchanged state (same turn!) + PIECE_DISOBEYED
    const refused = stepGame(s0, { type: 'MOVE', pieceId: 'pp', to: { x: 4, y: 3 } });
    expect(refused.error).toBeUndefined();
    expect(refused.nextState).toBe(s0);
    expect(refused.nextState.turn).toBe('PLAYER');
    expect(refused.events).toHaveLength(1);
    expect(refused.events[0]?.type).toBe('PIECE_DISOBEYED');

    // Place an unsilenced SAINT_FAITH within Chebyshev <= 2 -> Pawn OBEYS!
    const sWithSaint = createGameState({
      width: 7,
      height: 7,
      pieces: [
        pKing,
        pPawn,
        makePiece({ id: 'psf', side: 'PLAYER', type: 'SAINT_FAITH', pos: { x: 3, y: 5 } }),
        eRook,
        eKing,
      ],
    });
    const obeyed = stepGame(sWithSaint, { type: 'MOVE', pieceId: 'pp', to: { x: 4, y: 3 } });
    expect(obeyed.events.some((e) => e.type === 'PIECE_DISOBEYED')).toBe(false);
    expect(obeyed.nextState.turn).toBe('ENEMY');

    // If SAINT_FAITH is silenced, protection disappears -> Pawn disobeys again!
    const sWithSilencedSaint = createGameState({
      width: 7,
      height: 7,
      pieces: [
        pKing,
        pPawn,
        makePiece({ id: 'psf', side: 'PLAYER', type: 'SAINT_FAITH', pos: { x: 3, y: 5 }, silencedTurns: 2 }),
        eRook,
        eKing,
      ],
    });
    const refusedAgain = stepGame(sWithSilencedSaint, { type: 'MOVE', pieceId: 'pp', to: { x: 4, y: 3 } });
    expect(refusedAgain.events[0]?.type).toBe('PIECE_DISOBEYED');
    expect(refusedAgain.nextState.turn).toBe('PLAYER');

    // Active berserkReady overrides Disobedience!
    const sBerserk = createGameState({
      width: 7,
      height: 7,
      pieces: [pKing, { ...pPawn, berserkReady: true }, eRook, eKing],
    });
    const obeyedBerserk = stepGame(sBerserk, { type: 'MOVE', pieceId: 'pp', to: { x: 4, y: 3 } });
    expect(obeyedBerserk.events.some((e) => e.type === 'PIECE_DISOBEYED')).toBe(false);
    expect(obeyedBerserk.nextState.turn).toBe('ENEMY');
  });
});

describe('FAZ V3-3: SAINT_FAITH (Ocaklı) 1.5x (7x7) Cleanse & 2-Turn Silence Ultimate', () => {
  it('charges in 3 turns, grants SHIELDED, cleanses allies <= 3 (not 4), silences enemies <= 3 for 2 turns (not CHIMERA), and suppresses shields/traits/auras', () => {
    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 7 } });
    const saint = makePiece({ id: 'p_sf', side: 'PLAYER', type: 'SAINT_FAITH', pos: { x: 3, y: 4 } });
    // Target ally within dist 2 (starts at faithCharge = 2 so next end-of-turn hits 3!)
    const targetAlly = makePiece({
      id: 'p_ally',
      side: 'PLAYER',
      type: 'KNIGHT',
      pos: { x: 3, y: 5 },
      faithCharge: 2,
      composure: 1,
    });
    // Debuffed ally at Chebyshev 3 -> MUST be cleansed
    const nearAlly = makePiece({
      id: 'p_near',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 0, y: 4 },
      frozenTurns: 2,
      miasmaExposure: 1,
      silencedTurns: 2,
      madnessCharge: 2,
      composure: 1,
    });
    // Debuffed ally at Chebyshev 4 -> MUST NOT be cleansed
    const farAlly = makePiece({
      id: 'p_far',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 7, y: 4 },
      miasmaExposure: 1,
      composure: 1,
    });
    // Enemy with SHIELDED + EXPLOSIVE + SCOUT + SHADOW_WALKER at Chebyshev 3 -> MUST be silenced for 2 turns
    const enemyShielded = makePiece({
      id: 'e_sh',
      side: 'ENEMY',
      type: 'ROOK',
      pos: { x: 3, y: 1 },
      traits: ['SHIELDED', 'EXPLOSIVE', 'SCOUT'],
      shieldActive: true,
    });
    // Enemy SAINT_MADNESS at Chebyshev 3 -> MUST be silenced (aura disabled!)
    const enemyMadness = makePiece({
      id: 'e_sm',
      side: 'ENEMY',
      type: 'SAINT_MADNESS',
      pos: { x: 5, y: 2 },
    });
    // Enemy CHIMERA at Chebyshev 2 -> MUST BE IMMUNE to silence!
    const enemyChimera = makePiece({
      id: 'e_ch',
      side: 'ENEMY',
      type: 'CHIMERA',
      pos: { x: 4, y: 2 },
    });
    // Enemy at Chebyshev 4 -> MUST NOT be silenced
    const farEnemy = makePiece({
      id: 'e_far',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 7, y: 0 },
      traits: ['SHIELDED'],
      shieldActive: true,
    });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } });

    const s0 = createGameState({
      width: 8,
      height: 8,
      pieces: [pKing, saint, targetAlly, nearAlly, farAlly, enemyShielded, enemyMadness, enemyChimera, farEnemy, eKing],
    });

    // Turn 1 (PLAYER ends turn): p_ally faithCharge 2 -> 3 -> FAITH_ULTIMATE_TRIGGERED!
    const t1 = stepGame(s0, { type: 'END_TURN' });
    expect(t1.error).toBeUndefined();

    const ultEv = t1.events.find((e) => e.type === 'FAITH_ULTIMATE_TRIGGERED');
    expect(ultEv).toBeDefined();
    if (ultEv?.type === 'FAITH_ULTIMATE_TRIGGERED') {
      expect(ultEv.pulseRadius).toBe(3);
      expect(ultEv.shieldedTargetId).toBe('p_ally');
      expect(ultEv.cleansedAllyIds).toContain('p_near');
      expect(ultEv.cleansedAllyIds).not.toContain('p_far');
      expect(ultEv.silencedEnemyIds).toContain('e_sh');
      expect(ultEv.silencedEnemyIds).toContain('e_sm');
      expect(ultEv.silencedEnemyIds).not.toContain('e_ch');
      expect(ultEv.silencedEnemyIds).not.toContain('e_far');
    }

    // Verify target ally gained SHIELDED & shieldActive
    const allyAfter = t1.nextState.pieces.find((p) => p.id === 'p_ally')!;
    expect(allyAfter.traits).toContain('SHIELDED');
    expect(allyAfter.shieldActive).toBe(true);
    expect(allyAfter.faithCharge).toBeUndefined();

    // Verify nearAlly (dist 3) cleansed completely; farAlly (dist 4) untouched
    const nearAfter = t1.nextState.pieces.find((p) => p.id === 'p_near')!;
    expect(nearAfter.frozenTurns).toBe(0);
    expect(nearAfter.miasmaExposure).toBeUndefined();
    expect(nearAfter.silencedTurns).toBeUndefined();
    expect(nearAfter.madnessCharge).toBeUndefined();
    expect(getComposure(nearAfter)).toBe(3);

    const farAfter = t1.nextState.pieces.find((p) => p.id === 'p_far')!;
    expect(getComposure(farAfter)).toBe(1);

    // Verify enemy silence state & suppression
    const eShAfter = t1.nextState.pieces.find((p) => p.id === 'e_sh')!;
    expect(isSilenced(eShAfter)).toBe(true);
    expect(eShAfter.silencedTurns).toBe(2);
    expect(getEffectiveTraits(eShAfter)).toEqual([]);
    // Silenced SCOUT loses +2 vision bonus (Rook base = 3 instead of 5)
    expect(getPieceVisionRadius(t1.nextState, eShAfter)).toBe(3);
    // Enemy CHIMERA is completely immune
    expect(isSilenced(t1.nextState.pieces.find((p) => p.id === 'e_ch')!)).toBe(false);

    // Turn 2 (ENEMY ends turn 1 of silence): e_sh silencedTurns 2 -> 1; silenced enemyMadness gives NO madnessCharge to e_ch/e_sh!
    const t2 = stepGame(t1.nextState, { type: 'END_TURN' });
    expect(t2.nextState.pieces.find((p) => p.id === 'e_sh')!.silencedTurns).toBe(1);
    expect(t2.nextState.pieces.find((p) => p.id === 'e_sh')!.madnessCharge).toBeUndefined();

    // Verify silenced enemy with shieldActive=true dies in 1 hit AND does NOT trigger EXPLOSIVE!
    const killTestState = createGameState({
      width: 6,
      height: 6,
      pieces: [
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 5 } }),
        makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 2, y: 4 } }),
        makePiece({
          id: 'e_sil',
          side: 'ENEMY',
          type: 'PAWN',
          pos: { x: 2, y: 2 },
          traits: ['SHIELDED', 'EXPLOSIVE'],
          shieldActive: true,
          silencedTurns: 1,
        }),
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 5, y: 0 } }),
      ],
    });
    const killRes = stepGame(killTestState, { type: 'MOVE', pieceId: 'pr', to: { x: 2, y: 2 } });
    expect(killRes.nextState.pieces.find((p) => p.id === 'e_sil')).toBeUndefined();
    expect(killRes.events.some((e) => e.type === 'PIECE_CAPTURED' && e.pieceId === 'e_sil')).toBe(true);
    expect(killRes.events.some((e) => e.type === 'TILE_IGNITED')).toBe(false); // EXPLOSIVE suppressed!

    // Turn 3 (PLAYER passes), Turn 4 (ENEMY ends 2nd turn of silence): silencedTurns 1 -> 0 -> PIECE_SILENCE_EXPIRED!
    const t3 = stepGame(t2.nextState, { type: 'END_TURN' });
    const t4 = stepGame(t3.nextState, { type: 'END_TURN' });
    expect(t4.events.some((e) => e.type === 'PIECE_SILENCE_EXPIRED' && e.pieceId === 'e_sh')).toBe(true);
    const eShRestored = t4.nextState.pieces.find((p) => p.id === 'e_sh')!;
    expect(isSilenced(eShRestored)).toBe(false);
    expect(eShRestored.shieldActive).toBe(true); // Shield protection restored after surviving 2 turns!
    expect(getPieceVisionRadius(t4.nextState, eShRestored)).toBe(5); // SCOUT restored!
  });

  it('reveals a silenced SHADOW_WALKER enemy in silhouettes', () => {
    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 4 } }); // vision 3, silhouette ring 5
    const eShadow = makePiece({
      id: 'es',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 4, y: 4 }, // dist 4 (in +2 silhouette ring)
      traits: ['SHADOW_WALKER'],
      silencedTurns: 2,
    });
    const s = createGameState({ width: 6, height: 6, pieces: [pKing, eShadow] });
    expect(computeSilhouettes(s, 'PLAYER', s.fog.PLAYER)).toHaveLength(1);
  });
});

describe('FAZ V3-3: SAINT_MADNESS (Meczup) Frenzy, Berserk Chain & CHIMERA (Gulyabani) FIFO Evolution', () => {
  it('grants FRENZY_HASTE (+1 range & miasma choke immunity), FRENZY_POWER (armor pierce), and 3-turn Berserk Chain + knockback', () => {
    const tiles = createEmptyTiles(7, 7, 'PLAIN');
    tiles[3]![3] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[2]![4] = createTile('PIT');

    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 5 } });
    const madness = makePiece({ id: 'p_sm', side: 'PLAYER', type: 'SAINT_MADNESS', pos: { x: 1, y: 4 } });
    const pPawn = makePiece({
      id: 'p_pw',
      side: 'PLAYER',
      type: 'PAWN',
      pos: { x: 3, y: 5 },
      hasMoved: true,
      madnessCharge: 2,
    });
    const pRook = makePiece({
      id: 'p_rk',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 2, y: 5 },
      berserkReady: true,
    });
    const eShielded = makePiece({
      id: 'e_sh',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 2, y: 2 },
      traits: ['SHIELDED'],
      shieldActive: true,
    });
    const eBystander = makePiece({
      id: 'e_by',
      side: 'ENEMY',
      type: 'KNIGHT',
      pos: { x: 3, y: 2 }, // East of landing (2,2) -> kicked East into PIT(4,2)!
    });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 6, y: 0 } });

    const s0 = createGameState({
      width: 7,
      height: 7,
      tiles,
      pieces: [pKing, madness, pPawn, pRook, eShielded, eBystander, eKing],
    });

    // FRENZY_HASTE: hasMoved PAWN within dist 2 of SAINT_MADNESS can advance 2 squares to (3,3) MIASMA!
    const pawnTargets = getRawMoveTargets(s0, pPawn);
    expect(pawnTargets.some((c) => coordEquals(c, { x: 3, y: 3 }))).toBe(true);
    // KING within dist 2 of SAINT_MADNESS can move 2 squares!
    expect(getRawMoveTargets(s0, pKing).some((c) => coordEquals(c, { x: 0, y: 3 }))).toBe(true);

    // Move Pawn 2 squares onto MIASMA(3,3) -> NO choke thanks to FRENZY_HASTE!
    // And Step 7 hits madnessCharge 3 -> berserkReady = true (composure floored at 1, never 0)!
    const pawnStep = stepGame(s0, { type: 'MOVE', pieceId: 'p_pw', to: { x: 3, y: 3 } });
    expect(pawnStep.error).toBeUndefined();
    expect(pawnStep.events.some((e) => e.type === 'PIECE_CHOKED_BY_MIASMA')).toBe(false);
    expect(pawnStep.events.some((e) => e.type === 'MADNESS_ULTIMATE_TRIGGERED' && e.targetId === 'p_pw')).toBe(true);
    expect(pawnStep.nextState.pieces.find((p) => p.id === 'p_pw')?.berserkReady).toBe(true);

    // FRENZY_POWER + BERSERK_CHAIN: pRook starts inside SAINT_MADNESS aura, attacks shielded e_sh at (2,2):
    // 1) Pierces shield in 1 hit (FRENZY_POWER)!
    // 2) Consumes berserkReady -> grants bonusMovePieceId = 'p_rk' (turn stays PLAYER!)
    // 3) Kicks adjacent e_by at (3,2) East into PIT(4,2) -> PIECE_FELL_IN_PIT!
    const rookStep = stepGame(s0, { type: 'MOVE', pieceId: 'p_rk', to: { x: 2, y: 2 } });
    expect(rookStep.error).toBeUndefined();
    expect(rookStep.nextState.pieces.find((p) => p.id === 'e_sh')).toBeUndefined();
    expect(rookStep.nextState.pieces.find((p) => p.id === 'e_by')).toBeUndefined();
    expect(rookStep.events.some((e) => e.type === 'BERSERK_CHAIN_TRIGGERED' && e.kickedPieceId === 'e_by')).toBe(true);
    expect(rookStep.events.some((e) => e.type === 'PIECE_FELL_IN_PIT' && e.pieceId === 'e_by')).toBe(true);
    expect(rookStep.nextState.turn).toBe('PLAYER');
    expect(rookStep.nextState.bonusMovePieceId).toBe('p_rk');
  });

  it('evolves CHIMERA with 2-slot FIFO, preserves slots on traitless PAWN, copies silenced traits, and blocks FROST_TOUCH freeze', () => {
    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 6 } });
    const chimera = makePiece({ id: 'p_ch', side: 'PLAYER', type: 'CHIMERA', pos: { x: 2, y: 5 } });
    const ePlainPawn = makePiece({ id: 'e_p0', side: 'ENEMY', type: 'PAWN', pos: { x: 2, y: 4 } });
    const eKnight = makePiece({
      id: 'e_kn',
      side: 'ENEMY',
      type: 'KNIGHT',
      pos: { x: 2, y: 2 },
      traits: ['SCOUT'],
      silencedTurns: 2, // structural trait must STILL be copied by Chimera!
    });
    const eFaith = makePiece({ id: 'e_sf', side: 'ENEMY', type: 'SAINT_FAITH', pos: { x: 4, y: 1 } });
    const eMadness = makePiece({ id: 'e_sm', side: 'ENEMY', type: 'SAINT_MADNESS', pos: { x: 4, y: 3 } });
    const eFrost = makePiece({
      id: 'e_fr',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 5, y: 4 },
      traits: ['FROST_TOUCH'],
    });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 6, y: 0 } });

    let state = createGameState({
      width: 7,
      height: 7,
      pieces: [pKing, chimera, ePlainPawn, eKnight, eFaith, eMadness, eFrost, eKing],
    });

    // 1) Capture traitless PAWN -> MUST NOT burn a slot!
    const r1 = stepGame(state, { type: 'MOVE', pieceId: 'p_ch', to: { x: 2, y: 4 } });
    expect(r1.events.some((e) => e.type === 'CHIMERA_EVOLVED')).toBe(false);
    expect(r1.nextState.pieces.find((p) => p.id === 'p_ch')?.absorbedForms).toBeUndefined();
    state = stepGame(r1.nextState, { type: 'END_TURN' }).nextState;

    // 2) Capture silenced KNIGHT (SCOUT) -> Slot 1 = KNIGHT + SCOUT (+2 vision -> 5!)
    const r2 = stepGame(state, { type: 'MOVE', pieceId: 'p_ch', to: { x: 2, y: 2 } });
    expect(r2.events.some((e) => e.type === 'CHIMERA_EVOLVED' && e.absorbedType === 'KNIGHT')).toBe(true);
    const ch2 = r2.nextState.pieces.find((p) => p.id === 'p_ch')!;
    expect(ch2.absorbedForms).toHaveLength(1);
    expect(getEffectiveTraits(ch2)).toContain('SCOUT');
    expect(getPieceVisionRadius(r2.nextState, ch2)).toBe(5);
    state = stepGame(r2.nextState, { type: 'END_TURN' }).nextState;

    // 3) Use newly acquired KNIGHT L-jump from (2,2) to capture SAINT_FAITH at (4,1)!
    // Slot 2 = SAINT_FAITH -> FAITH_WARD -> immediate active shield!
    const r3 = stepGame(state, { type: 'MOVE', pieceId: 'p_ch', to: { x: 4, y: 1 } });
    expect(r3.error).toBeUndefined();
    const ch3 = r3.nextState.pieces.find((p) => p.id === 'p_ch')!;
    expect(ch3.absorbedForms).toHaveLength(2);
    expect(ch3.shieldActive).toBe(true);
    state = stepGame(r3.nextState, { type: 'END_TURN' }).nextState;

    // 4) Capture SAINT_MADNESS at (4,3) -> FIFO drops Slot 1 (KNIGHT), keeps [SAINT_FAITH, SAINT_MADNESS]!
    const r4 = stepGame(state, { type: 'MOVE', pieceId: 'p_ch', to: { x: 4, y: 3 } });
    const ev4 = r4.events.find((e) => e.type === 'CHIMERA_EVOLVED');
    expect(ev4?.type === 'CHIMERA_EVOLVED' && ev4.absorbedType === 'SAINT_MADNESS' && ev4.droppedType === 'KNIGHT').toBe(
      true,
    );
    const ch4 = r4.nextState.pieces.find((p) => p.id === 'p_ch')!;
    expect(ch4.absorbedForms?.map((f) => f.sourceType)).toEqual(['SAINT_FAITH', 'SAINT_MADNESS']);
    expect(ch4.shieldActive).toBe(true); // Still backed by FAITH_WARD!

    // 5) Enemy FROST_TOUCH pawn moves adjacent to CHIMERA -> CHIMERA is IMMUNE to freeze!
    const r5 = stepGame(r4.nextState, { type: 'MOVE', pieceId: 'e_fr', to: { x: 5, y: 5 } });
    expect(r5.nextState.pieces.find((p) => p.id === 'p_ch')?.frozenTurns).toBe(0);
    // Move e_fr directly adjacent to (4,3) on a fresh board to test direct adjacency immunity
    const frostState = createGameState({
      width: 5,
      height: 5,
      turn: 'ENEMY',
      pieces: [
        makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 4 } }),
        makePiece({ id: 'p_ch', side: 'PLAYER', type: 'CHIMERA', pos: { x: 2, y: 2 } }),
        makePiece({ id: 'e_fr', side: 'ENEMY', type: 'ROOK', pos: { x: 3, y: 0 }, traits: ['FROST_TOUCH'] }),
        makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 4, y: 0 } }),
      ],
    });
    const frostRes = stepGame(frostState, { type: 'MOVE', pieceId: 'e_fr', to: { x: 3, y: 2 } });
    expect(frostRes.nextState.pieces.find((p) => p.id === 'p_ch')?.frozenTurns).toBe(0);
    expect(frostRes.events.some((e) => e.type === 'PIECE_FROZEN' && e.pieceId === 'p_ch')).toBe(false);
  });

  it('guarantees identical computeStateHash across 2 isolated engines through full V3 psychology & unit chains', () => {
    const buildState = () =>
      createGameState({
        width: 7,
        height: 7,
        pieces: [
          makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 6 } }),
          makePiece({ id: 'p_sf', side: 'PLAYER', type: 'SAINT_FAITH', pos: { x: 2, y: 4 } }),
          makePiece({ id: 'p_rk', side: 'PLAYER', type: 'ROOK', pos: { x: 2, y: 5 }, composure: 1, driftSign: 1, faithCharge: 2 }),
          makePiece({ id: 'p_ch', side: 'PLAYER', type: 'CHIMERA', pos: { x: 4, y: 4 } }),
          makePiece({ id: 'e_kn', side: 'ENEMY', type: 'KNIGHT', pos: { x: 4, y: 2 }, traits: ['SHIELDED'], shieldActive: true }),
          makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 6, y: 0 } }),
        ],
        seed: 'v3-psych-lockstep',
      });

    const actions: GameAction[] = [
      { type: 'END_TURN' }, // triggers SAINT_FAITH 7x7 ultimate + silences e_kn!
      { type: 'END_TURN' }, // e_kn silencedTurns 2 -> 1
      { type: 'MOVE', pieceId: 'p_ch', to: { x: 4, y: 2 } }, // Chimera kills silenced shielded Knight in 1 hit & absorbs it!
      { type: 'END_TURN' },
    ];

    const a = replayActions(buildState(), actions);
    const b = replayActions(buildState(), actions);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(computeStateHash(a.state)).toBe(computeStateHash(b.state));
    expect(a.allEvents).toEqual(b.allEvents);
  });
});

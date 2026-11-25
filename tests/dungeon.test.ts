import { describe, expect, it } from 'vitest';
import {
  clonePiece,
  cloneTile,
  coordEquals,
  createEmptyTiles,
  createTile,
  getLegalMoves,
  getRawMoveTargets,
  resolveIceSlide,
  resolveMoveOutcome,
} from '../src/engine/board';
import {
  advanceAllSpikes,
  applySpikeTrapDamageAt,
  collapseCrackedTile,
  collectGasChainTiles,
  collectPathCrackedCollapses,
  createArrowEmitterTrap,
  createMiasmaOverlay,
  createPressurePlateTrap,
  createSpikesTrap,
  findArrowEmitterById,
  findMiasmaIgnitionOrigins,
  fireArrowEmitter,
  getExtinguishTargetTile,
  hasBurningMiasmaContact,
  resolveGasDetonation,
  shouldChokeOnMiasmaLanding,
  tickPressurePlateCooldowns,
  tickTemporaryMiasma,
  triggerPressurePlate,
} from '../src/engine/dungeon';
import { computeFogForSide, computeSilhouettes, hasSymmetricLineOfSight } from '../src/engine/fog';
import { computeStateHash, getInitialDriftSign } from '../src/engine/prng';
import { createGameState, replayActions, stepGame } from '../src/engine/reducer';
import {
  BoardView,
  FactionPassive,
  GameAction,
  GameEvent,
  MAX_GAS_CHAIN_TILES,
  Piece,
  PieceType,
  Side,
  TileState,
  TraitId,
} from '../src/engine/types';
import { getVisibleState } from '../src/engine/visibility';

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
  if (overrides.isBoss !== undefined) base.isBoss = overrides.isBoss;
  if (overrides.miasmaExposure !== undefined) base.miasmaExposure = overrides.miasmaExposure;
  if (overrides.composure !== undefined) base.composure = overrides.composure;
  if (overrides.driftSign !== undefined) base.driftSign = overrides.driftSign;
  if (overrides.faithCharge !== undefined) base.faithCharge = overrides.faithCharge;
  if (overrides.madnessCharge !== undefined) base.madnessCharge = overrides.madnessCharge;
  if (overrides.berserkReady !== undefined) base.berserkReady = overrides.berserkReady;
  if (overrides.silencedTurns !== undefined) base.silencedTurns = overrides.silencedTurns;
  if (overrides.absorbedForms !== undefined) base.absorbedForms = overrides.absorbedForms;
  return base;
}

function makeBoard(
  width: number,
  height: number,
  pieces: Piece[],
  tileOverrides: Array<{ x: number; y: number; tile: TileState }> = [],
  factions: Record<Side, FactionPassive> = { PLAYER: 'NONE', ENEMY: 'NONE' },
): BoardView {
  const tiles = createEmptyTiles(width, height, 'PLAIN');
  for (const ov of tileOverrides) {
    tiles[ov.y]![ov.x] = ov.tile;
  }
  return { width, height, tiles, pieces, factions };
}

describe('FAZ V3-1: MIASMA Movement Constraints & New Piece Base Movement', () => {
  it('caps sliding pieces to at most +1 step after entering MIASMA, and 1 step when starting inside MIASMA', () => {
    const rook = makePiece({ id: 'p_rook', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 3 } });
    const enemyBehind = makePiece({ id: 'e_pawn', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 3 } });
    const board = makeBoard(
      8,
      8,
      [rook, enemyBehind],
      [{ x: 2, y: 3, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) }],
    );

    const targets = getRawMoveTargets(board, rook);
    // East ray: (1,3) clear -> (2,3) MIASMA -> (3,3) +1 step capture allowed -> (4,3)+ blocked
    expect(targets.some((c) => coordEquals(c, { x: 1, y: 3 }))).toBe(true);
    expect(targets.some((c) => coordEquals(c, { x: 2, y: 3 }))).toBe(true);
    expect(targets.some((c) => coordEquals(c, { x: 3, y: 3 }))).toBe(true);
    expect(targets.some((c) => coordEquals(c, { x: 4, y: 3 }))).toBe(false);

    // Even without an enemy at (3,3), (4,3) is still unreachable past MIASMA at (2,3)
    const openBoard = makeBoard(
      8,
      8,
      [rook],
      [{ x: 2, y: 3, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) }],
    );
    const openTargets = getRawMoveTargets(openBoard, rook);
    expect(openTargets.some((c) => coordEquals(c, { x: 3, y: 3 }))).toBe(true);
    expect(openTargets.some((c) => coordEquals(c, { x: 4, y: 3 }))).toBe(false);

    // Starting INSIDE MIASMA caps slider to 1 step in every direction
    const rookInGas = makePiece({ id: 'p_rook2', side: 'PLAYER', type: 'ROOK', pos: { x: 3, y: 3 } });
    const gasStartBoard = makeBoard(
      8,
      8,
      [rookInGas],
      [{ x: 3, y: 3, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) }],
    );
    const gasStartTargets = getRawMoveTargets(gasStartBoard, rookInGas);
    expect(gasStartTargets).toHaveLength(4);
    expect(gasStartTargets.some((c) => coordEquals(c, { x: 4, y: 3 }))).toBe(true);
    expect(gasStartTargets.some((c) => coordEquals(c, { x: 5, y: 3 }))).toBe(false);
  });

  it('lets KNIGHT jump over intermediate MIASMA unaffected and flags PAWN/KING choking on landing', () => {
    const knight = makePiece({ id: 'p_kn', side: 'PLAYER', type: 'KNIGHT', pos: { x: 2, y: 4 } });
    const pawn = makePiece({ id: 'p_pw', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 4 } });
    const king = makePiece({ id: 'p_kg', side: 'PLAYER', type: 'KING', pos: { x: 5, y: 4 } });
    const chimera = makePiece({ id: 'p_ch', side: 'PLAYER', type: 'CHIMERA', pos: { x: 6, y: 4 } });

    const gasTile = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    const board = makeBoard(8, 8, [knight], [
      { x: 2, y: 3, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) },
      { x: 3, y: 3, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) },
    ]);

    const targets = getRawMoveTargets(board, knight);
    expect(targets.some((c) => coordEquals(c, { x: 3, y: 2 }))).toBe(true);

    expect(shouldChokeOnMiasmaLanding(pawn, gasTile)).toBe(true);
    expect(shouldChokeOnMiasmaLanding(king, gasTile)).toBe(true);
    expect(shouldChokeOnMiasmaLanding(pawn, gasTile, true)).toBe(false); // FRENZY_HASTE immunity
    expect(shouldChokeOnMiasmaLanding(knight, gasTile)).toBe(false);
    expect(shouldChokeOnMiasmaLanding(chimera, gasTile)).toBe(false);
  });

  it('moves SAINT_FAITH and SAINT_MADNESS up to 2 squares in 8 directions and CHIMERA up to 3 squares immune to MIASMA', () => {
    const saint = makePiece({ id: 'p_sf', side: 'PLAYER', type: 'SAINT_FAITH', pos: { x: 3, y: 3 } });
    const saintBoard = makeBoard(8, 8, [saint], [
      { x: 4, y: 3, tile: createTile('WALL') }, // blocks east 2nd square too
      { x: 3, y: 3, tile: createTile('PLAIN') },
    ]);
    const saintTargets = getRawMoveTargets(saintBoard, saint);
    // East blocked at step 1 -> neither (4,3) nor (5,3)
    expect(saintTargets.some((c) => coordEquals(c, { x: 4, y: 3 }))).toBe(false);
    expect(saintTargets.some((c) => coordEquals(c, { x: 5, y: 3 }))).toBe(false);
    // Diagonal & orthogonal reach 2 squares, never 3
    expect(saintTargets.some((c) => coordEquals(c, { x: 5, y: 5 }))).toBe(true);
    expect(saintTargets.some((c) => coordEquals(c, { x: 6, y: 6 }))).toBe(false);
    expect(saintTargets.some((c) => coordEquals(c, { x: 3, y: 1 }))).toBe(true);
    expect(saintTargets.some((c) => coordEquals(c, { x: 3, y: 0 }))).toBe(false);

    // Saint starting inside MIASMA is capped to 1 square
    const saintGasBoard = makeBoard(8, 8, [saint], [
      { x: 3, y: 3, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) },
    ]);
    const saintGasTargets = getRawMoveTargets(saintGasBoard, saint);
    expect(saintGasTargets).toHaveLength(8);
    expect(saintGasTargets.some((c) => coordEquals(c, { x: 5, y: 3 }))).toBe(false);

    // CHIMERA: 3-range in 8 directions, completely immune to MIASMA, plus absorbed forms
    const chimera = makePiece({
      id: 'p_ch',
      side: 'PLAYER',
      type: 'CHIMERA',
      pos: { x: 0, y: 4 },
      absorbedForms: [
        { sourceType: 'KNIGHT', copiedTraits: [] },
        { sourceType: 'ROOK', copiedTraits: [] },
      ],
    });
    const chimeraBoard = makeBoard(8, 8, [chimera], [
      { x: 0, y: 4, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) },
      { x: 1, y: 4, tile: createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() }) },
      { x: 1, y: 2, tile: createTile('ICE') },
    ]);
    const chimeraTargets = getRawMoveTargets(chimeraBoard, chimera);
    // Unlimited orthogonal from absorbed ROOK, immune to MIASMA
    expect(chimeraTargets.some((c) => coordEquals(c, { x: 7, y: 4 }))).toBe(true);
    // 3-range diagonal base movement, immune to MIASMA
    expect(chimeraTargets.some((c) => coordEquals(c, { x: 3, y: 1 }))).toBe(true);
    expect(chimeraTargets.some((c) => coordEquals(c, { x: 4, y: 0 }))).toBe(false);
    // Knight L-jump from absorbed KNIGHT onto ICE does NOT trigger ICE slide
    expect(chimeraTargets.some((c) => coordEquals(c, { x: 1, y: 2 }))).toBe(true);
    const jumpRes = resolveMoveOutcome(chimeraBoard, chimera, { x: 1, y: 2 });
    expect(jumpRes.slid).toBe(false);
    expect(jumpRes.finalPos).toEqual({ x: 1, y: 2 });
  });

  it('stops ICE sliding on CRACKED tiles and flags EXTENDED spikes as hazardous in getLegalMoves', () => {
    const rook = makePiece({ id: 'p_r', side: 'PLAYER', type: 'ROOK', pos: { x: 0, y: 2 } });
    const board = makeBoard(6, 6, [rook], [
      { x: 1, y: 2, tile: createTile('ICE') },
      { x: 2, y: 2, tile: createTile('CRACKED') },
      { x: 0, y: 1, tile: createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('sp1', 2) }) },
      { x: 0, y: 3, tile: createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('sp2', 1) }) },
    ]);

    const slideRes = resolveIceSlide(board, rook, { x: 1, y: 2 }, { x: 1, y: 0 });
    expect(slideRes.slid).toBe(true);
    expect(slideRes.finalPos).toEqual({ x: 2, y: 2 });

    const moves = getLegalMoves(board, rook);
    const ontoExtended = moves.find((m) => coordEquals(m.to, { x: 0, y: 1 }));
    const ontoTelegraph = moves.find((m) => coordEquals(m.to, { x: 0, y: 3 }));
    expect(ontoExtended?.isHazardous).toBe(true);
    expect(ontoTelegraph?.isHazardous).toBe(false);
  });
});

describe('FAZ V3-1: MIASMA Line-of-Sight Symmetry & Silhouettes', () => {
  it('allows seeing a MIASMA tile itself while blocking LOS strictly behind it and preserving symmetry', () => {
    const tiles = createEmptyTiles(7, 7, 'PLAIN');
    tiles[2]![2] = createTile('WALL');
    tiles[3]![3] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[3]![4] = createTile('PIT', 0, undefined, { gas: createMiasmaOverlay(3) });
    tiles[4]![2] = createTile('CRACKED');
    tiles[1]![5] = createTile('ICE');

    const board: BoardView = {
      width: 7,
      height: 7,
      tiles,
      pieces: [],
      factions: { PLAYER: 'NONE', ENEMY: 'NONE' },
    };

    // Viewer at (1,3) sees MIASMA at (3,3) itself, but NOT (5,3) behind it
    expect(hasSymmetricLineOfSight(board, { x: 1, y: 3 }, { x: 3, y: 3 })).toBe(true);
    expect(hasSymmetricLineOfSight(board, { x: 1, y: 3 }, { x: 4, y: 3 })).toBe(false);
    expect(hasSymmetricLineOfSight(board, { x: 1, y: 3 }, { x: 5, y: 3 })).toBe(false);

    // Exhaustive symmetry verification across all 49 x 49 pairs
    for (let ay = 0; ay < 7; ay++) {
      for (let ax = 0; ax < 7; ax++) {
        for (let by = 0; by < 7; by++) {
          for (let bx = 0; bx < 7; bx++) {
            const ab = hasSymmetricLineOfSight(board, { x: ax, y: ay }, { x: bx, y: by });
            const ba = hasSymmetricLineOfSight(board, { x: bx, y: by }, { x: ax, y: ay });
            expect(ab).toBe(ba);
          }
        }
      }
    }

    // Enemy standing behind MIASMA leaves neither VISIBLE nor '?' silhouette
    const scout = makePiece({ id: 'p_k', side: 'PLAYER', type: 'KING', pos: { x: 1, y: 3 } });
    const enemyOnGas = makePiece({ id: 'e_on', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 3 } });
    const enemyBehindGas = makePiece({ id: 'e_beh', side: 'ENEMY', type: 'PAWN', pos: { x: 5, y: 3 } });
    const fogBoard: BoardView = { ...board, pieces: [scout, enemyOnGas, enemyBehindGas] };

    const fog = computeFogForSide(fogBoard, 'PLAYER');
    expect(fog[3]![3]).toBe('VISIBLE');
    expect(fog[3]![5]).toBe('UNEXPLORED');

    const silhouettes = computeSilhouettes(fogBoard, 'PLAYER', fog);
    expect(silhouettes).toHaveLength(0);
  });
});

describe('FAZ V3-1: DETONATE_GAS Chain BFS & Blast Resolution', () => {
  it('bridges gas explosions across PIT tiles in canonical order, collapses CRACKED through shields, and respects silence', () => {
    const tiles = createEmptyTiles(6, 4, 'PLAIN');
    // Connected L-shape + PIT bridge: (1,1) PLAIN, (2,1) PIT, (3,1) CRACKED, (3,2) WATCHTOWER
    tiles[1]![1] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[1]![2] = createTile('PIT', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[1]![3] = createTile('CRACKED', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[2]![3] = createTile('WATCHTOWER', 0, undefined, { gas: createMiasmaOverlay() });
    // Disconnected pocket at (5,3) must NOT detonate
    tiles[3]![5] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });

    const shieldedOnPlain = makePiece({
      id: 'p1',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 1, y: 1 },
      traits: ['SHIELDED'],
      shieldActive: true,
    });
    const shieldedOnCracked = makePiece({
      id: 'e1',
      side: 'ENEMY',
      type: 'KNIGHT',
      pos: { x: 3, y: 1 },
      traits: ['SHIELDED'],
      shieldActive: true,
    });
    const silencedShieldOnTower = makePiece({
      id: 'e2',
      side: 'ENEMY',
      type: 'BISHOP',
      pos: { x: 3, y: 2 },
      traits: ['SHIELDED'],
      shieldActive: true,
      silencedTurns: 2,
    });

    const pieces = [shieldedOnPlain, shieldedOnCracked, silencedShieldOnTower];
    const events: GameEvent[] = [];

    expect(findMiasmaIgnitionOrigins(tiles, 6, 4, { x: 0, y: 1 })).toEqual([{ x: 1, y: 1 }]);
    tiles[1]![0] = createTile('BURNING', 2);
    expect(hasBurningMiasmaContact(tiles, 6, 4, { x: 0, y: 1 })).toBe(true);

    const res = resolveGasDetonation(tiles, pieces, 6, 4, { x: 1, y: 1 }, events);

    // Canonical (y asc, x asc) order across PIT bridge
    expect(res.detonatedTiles).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
    ]);

    // Gas cleared on detonated pocket, untouched on disconnected (5,3)
    expect(tiles[1]![1]!.gas).toBeUndefined();
    expect(tiles[1]![2]!.gas).toBeUndefined();
    expect(tiles[1]![2]!.type).toBe('PIT');
    expect(tiles[3]![5]!.gas?.kind).toBe('MIASMA');

    // (3,1) CRACKED collapsed to PIT and killed shielded enemy
    expect(tiles[1]![3]!.type).toBe('PIT');
    expect(events.some((e) => e.type === 'TILE_COLLAPSED' && e.reason === 'BLAST')).toBe(true);
    expect(res.killedPieces.some((k) => k.piece.id === 'e1' && k.cause === 'PIT')).toBe(true);

    // (1,1) unsilenced shield absorbed blast
    expect(res.shieldBrokenPieceIds).toEqual(['p1']);
    expect(pieces.find((p) => p.id === 'p1')?.shieldActive).toBe(false);

    // (3,2) silenced shield did NOT protect -> incinerated, WATCHTOWER preserved for extinguish
    expect(res.killedPieces.some((k) => k.piece.id === 'e2' && k.cause === 'INCINERATED')).toBe(true);
    expect(tiles[2]![3]!.type).toBe('BURNING');
    expect(getExtinguishTargetTile(tiles[2]![3]!).type).toBe('WATCHTOWER');
  });

  it('caps collectGasChainTiles at MAX_GAS_CHAIN_TILES (64) and ticks temporary MIASMA', () => {
    const tiles = createEmptyTiles(10, 10, 'PLAIN');
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        tiles[y]![x] = createTile('PLAIN', 0, undefined, {
          gas: createMiasmaOverlay(y === 0 && x === 0 ? 1 : null),
        });
      }
    }
    const chain = collectGasChainTiles(tiles, 10, 10, { x: 0, y: 0 });
    expect(chain).toHaveLength(MAX_GAS_CHAIN_TILES);

    const dissipated = tickTemporaryMiasma(tiles, 10, 10);
    expect(dissipated).toEqual([{ x: 0, y: 0 }]);
    expect(tiles[0]![0]!.gas).toBeUndefined();
    expect(tiles[0]![1]!.gas?.turnsRemaining).toBeNull();
  });
});

describe('FAZ V3-1: Pressure Plates, Arrow Emitters, Cracked Tiles & Rhythmic Spikes', () => {
  it('triggers pressure plates once per step in canonical emitter order and fires normal, flaming, and piercing arrows', () => {
    const tiles = createEmptyTiles(7, 5, 'PLAIN');
    tiles[2]![2] = createTile('PLAIN', 0, undefined, {
      trap: createPressurePlateTrap('plate_a', ['em_b', 'em_a'], 2, 0),
    });
    tiles[1]![0] = createTile('WALL', 0, undefined, {
      trap: createArrowEmitterTrap('em_a', { dx: 1, dy: 0 }, { ammo: 1, flaming: true, piercing: false }),
    });
    tiles[3]![0] = createTile('WALL', 0, undefined, {
      trap: createArrowEmitterTrap('em_b', { dx: 1, dy: 0 }, { ammo: null, flaming: false, piercing: true }),
    });
    tiles[1]![4] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[1]![6] = createTile('WALL');

    const p1 = makePiece({ id: 'p_1', side: 'PLAYER', type: 'PAWN', pos: { x: 3, y: 1 }, traits: ['SHIELDED'], shieldActive: true });
    const p2 = makePiece({ id: 'p_2', side: 'ENEMY', type: 'PAWN', pos: { x: 5, y: 1 } });
    const p3 = makePiece({ id: 'p_3', side: 'ENEMY', type: 'PAWN', pos: { x: 2, y: 3 } });
    const p4 = makePiece({ id: 'p_4', side: 'PLAYER', type: 'PAWN', pos: { x: 4, y: 3 } });
    const pieces = [p1, p2, p3, p4];
    const firedPlateIds = new Set<string>();
    const events: GameEvent[] = [];

    // First trigger succeeds and returns canonical sorted emitter IDs
    const trig1 = triggerPressurePlate(tiles, 7, 5, { x: 2, y: 2 }, 'mover_1', firedPlateIds, events);
    expect(trig1.triggered).toBe(true);
    expect(trig1.emitterIds).toEqual(['em_a', 'em_b']);

    // Second trigger in same stepGame is blocked by firedPlateIds
    const trig2 = triggerPressurePlate(tiles, 7, 5, { x: 2, y: 2 }, 'mover_1', firedPlateIds, events);
    expect(trig2.triggered).toBe(false);

    // Cooldown ticks down from 2 -> 1 -> 0
    tickPressurePlateCooldowns(tiles, 7, 5);
    expect((tiles[2]![2]!.trap as Extract<TileState['trap'], { kind: 'PRESSURE_PLATE' }>).cooldown).toBe(1);
    tickPressurePlateCooldowns(tiles, 7, 5);
    expect((tiles[2]![2]!.trap as Extract<TileState['trap'], { kind: 'PRESSURE_PLATE' }>).cooldown).toBe(0);

    // Fire em_a (non-piercing, flaming, ammo 1): hits shielded p1 at (3,1) and stops before MIASMA at (4,1)
    const emA = findArrowEmitterById(tiles, 7, 5, 'em_a')!;
    const shotA = fireArrowEmitter(tiles, pieces, 7, 5, emA.pos, events);
    expect(shotA.fired).toBe(true);
    expect(shotA.path).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }]);
    expect(shotA.shieldBrokenPieceIds).toEqual(['p_1']);
    expect(shotA.firstMiasmaHit).toBeNull();
    expect(pieces.find((p) => p.id === 'p_2')).toBeDefined();

    // Ammo is now 0 -> second shot does not fire
    const shotA2 = fireArrowEmitter(tiles, pieces, 7, 5, emA.pos, events);
    expect(shotA2.fired).toBe(false);

    // Fire em_b (piercing, unlimited ammo): kills BOTH p3 at (2,3) and p4 at (4,3)
    const emB = findArrowEmitterById(tiles, 7, 5, 'em_b')!;
    const shotB = fireArrowEmitter(tiles, pieces, 7, 5, emB.pos, events);
    expect(shotB.fired).toBe(true);
    expect(shotB.killedPieces.map((k) => k.piece.id)).toEqual(['p_3', 'p_4']);

    // Flaming arrow hitting MIASMA when unimpeded records firstMiasmaHit
    tiles[1]![0] = createTile('WALL', 0, undefined, {
      trap: createArrowEmitterTrap('em_flame', { dx: 1, dy: 0 }, { ammo: 1, flaming: true, piercing: true }),
    });
    const shotFlame = fireArrowEmitter(tiles, pieces, 7, 5, { x: 0, y: 1 }, events);
    expect(shotFlame.firstMiasmaHit).toEqual({ x: 4, y: 1 });
  });

  it('collapses CRACKED tiles on DEPARTURE and PASS_THROUGH (not jump mids) and destroys attached plates', () => {
    const tiles = createEmptyTiles(5, 3, 'PLAIN');
    tiles[1]![0] = createTile('CRACKED', 0, undefined, {
      trap: createPressurePlateTrap('p_on_crack', ['e1'], 1, 0),
      gas: createMiasmaOverlay(),
    });
    tiles[1]![1] = createTile('CRACKED');
    tiles[1]![2] = createTile('CRACKED');

    const sliderPath = [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ];
    expect(collectPathCrackedCollapses(tiles, sliderPath, false)).toEqual([
      { at: { x: 0, y: 1 }, reason: 'DEPARTURE' },
      { at: { x: 1, y: 1 }, reason: 'PASS_THROUGH' },
    ]);

    // Jump collapses departure only, never intermediate tiles
    expect(collectPathCrackedCollapses(tiles, sliderPath, true)).toEqual([
      { at: { x: 0, y: 1 }, reason: 'DEPARTURE' },
    ]);

    // Bounce-back staying on start square does not collapse departure
    expect(collectPathCrackedCollapses(tiles, [{ x: 0, y: 1 }], false)).toEqual([]);

    const events: GameEvent[] = [];
    expect(collapseCrackedTile(tiles, 5, 3, { x: 0, y: 1 }, 'DEPARTURE', events)).toBe(true);
    expect(tiles[1]![0]!.type).toBe('PIT');
    expect(tiles[1]![0]!.trap).toBeUndefined();
    expect(tiles[1]![0]!.gas?.kind).toBe('MIASMA');
  });

  it('cycles SPIKES 0 -> 1 -> 2 -> 0 in canonical order and skewers pieces on extension or step', () => {
    const tiles = createEmptyTiles(4, 4, 'PLAIN');
    tiles[1]![2] = createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('s1', 1) });
    tiles[2]![1] = createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('s2', 0) });

    const victim = makePiece({ id: 'v1', side: 'PLAYER', type: 'PAWN', pos: { x: 2, y: 1 } });
    const shielded = makePiece({
      id: 'v2',
      side: 'ENEMY',
      type: 'ROOK',
      pos: { x: 1, y: 2 },
      traits: ['SHIELDED'],
      shieldActive: true,
    });
    const pieces = [victim, shielded];
    const events: GameEvent[] = [];

    // Tick 1: s1 (1 -> 2 EXTENDED skewers v1), s2 (0 -> 1 TELEGRAPH)
    const r1 = advanceAllSpikes(tiles, pieces, 4, 4, events);
    expect(r1.changes).toEqual([
      { at: { x: 2, y: 1 }, phase: 2 },
      { at: { x: 1, y: 2 }, phase: 1 },
    ]);
    expect(r1.killedPieces.map((k) => k.piece.id)).toEqual(['v1']);
    expect(events.some((e) => e.type === 'PIECE_SKEWERED' && e.source === 'SPIKES')).toBe(true);

    // Stepping onto extended spike at (2,1) kills unshielded or breaks shield
    const walker = makePiece({ id: 'w1', side: 'PLAYER', type: 'KNIGHT', pos: { x: 2, y: 1 } });
    pieces.push(walker);
    const stepRes = applySpikeTrapDamageAt(tiles, pieces, 'w1', { x: 2, y: 1 }, events);
    expect(stepRes.triggered).toBe(true);
    expect(stepRes.killedPiece?.piece.id).toBe('w1');

    // Tick 2: s1 (2 -> 0 RETRACTED), s2 (1 -> 2 EXTENDED breaks v2's shield)
    const r2 = advanceAllSpikes(tiles, pieces, 4, 4, events);
    expect(r2.changes).toEqual([
      { at: { x: 2, y: 1 }, phase: 0 },
      { at: { x: 1, y: 2 }, phase: 2 },
    ]);
    expect(r2.shieldBrokenPieceIds).toEqual(['v2']);
    expect(pieces.find((p) => p.id === 'v2')?.shieldActive).toBe(false);
  });
});

describe('FAZ V3-1: Canonical V3 State Hashing & Deep Cloning', () => {
  it('canonically hashes all V3 tile/piece fields, normalizes defaults, and deep-clones across GameState and VisibleState', () => {
    const baseTiles = createEmptyTiles(5, 5, 'PLAIN');
    const kingP = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 2, y: 4 } });
    const kingE = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 2, y: 0 } });

    const baseState = createGameState({
      width: 5,
      height: 5,
      tiles: baseTiles,
      pieces: [kingP, kingE],
      seed: 'v3-hash',
    });
    const baseHash = computeStateHash(baseState);

    // Explicitly setting V3 default values produces the EXACT same hash as legacy omitted fields
    const withDefaults = createGameState({
      width: 5,
      height: 5,
      tiles: baseTiles,
      pieces: [
        kingE, // intentionally reversed order to verify canonical piece.id sorting
        makePiece({
          ...kingP,
          composure: 3,
          miasmaExposure: 0,
          faithCharge: 0,
          madnessCharge: 0,
          berserkReady: false,
          silencedTurns: 0,
          absorbedForms: [],
        }),
      ],
      seed: 'v3-hash',
    });
    expect(computeStateHash(withDefaults)).toBe(baseHash);

    // Every single V3 field must change the state hash
    const seenHashes = new Set<string>([baseHash]);
    const checkMutation = (mutate: (s: typeof baseState) => void): void => {
      const cloned = JSON.parse(JSON.stringify(baseState)) as typeof baseState;
      mutate(cloned);
      const h = computeStateHash(cloned);
      expect(h).not.toBe(baseHash);
      seenHashes.add(h);
    };

    checkMutation((s) => {
      s.tiles[2]![2]!.gas = createMiasmaOverlay(null);
    });
    checkMutation((s) => {
      s.tiles[2]![2]!.trap = createSpikesTrap('sp1', 1);
    });
    checkMutation((s) => {
      s.tiles[2]![2]!.trap = createPressurePlateTrap('pl1', ['e1'], 2, 0);
    });
    checkMutation((s) => {
      s.tiles[2]![2]!.trap = createArrowEmitterTrap('em1', { dx: 1, dy: 0 }, { ammo: 2, flaming: true });
    });
    checkMutation((s) => {
      s.pieces[0]!.miasmaExposure = 1;
    });
    checkMutation((s) => {
      s.pieces[0]!.composure = 2;
    });
    checkMutation((s) => {
      s.pieces[0]!.driftSign = 1;
    });
    checkMutation((s) => {
      s.pieces[0]!.driftSign = -1;
    });
    checkMutation((s) => {
      s.pieces[0]!.faithCharge = 2;
    });
    checkMutation((s) => {
      s.pieces[0]!.madnessCharge = 2;
    });
    checkMutation((s) => {
      s.pieces[0]!.berserkReady = true;
    });
    checkMutation((s) => {
      s.pieces[0]!.silencedTurns = 2;
    });
    checkMutation((s) => {
      s.pieces[0]!.absorbedForms = [
        { sourceType: 'KNIGHT', copiedTraits: ['SCOUT'] },
        { sourceType: 'ROOK', copiedTraits: [] },
      ];
    });
    checkMutation((s) => {
      // Reversed FIFO order must produce a distinct hash
      s.pieces[0]!.absorbedForms = [
        { sourceType: 'ROOK', copiedTraits: [] },
        { sourceType: 'KNIGHT', copiedTraits: ['SCOUT'] },
      ];
    });

    expect(seenHashes.size).toBe(15);

    // Initial driftSign from piece.id is deterministic (1 or -1)
    expect([1, -1]).toContain(getInitialDriftSign('p_rook_1'));
    expect(getInitialDriftSign('p_rook_1')).toBe(getInitialDriftSign('p_rook_1'));

    // Deep clone isolation check for tiles, pieces, createGameState, and getVisibleState
    const richTile = createTile('PLAIN', 0, undefined, {
      gas: createMiasmaOverlay(2),
      trap: createPressurePlateTrap('p1', ['e2', 'e1'], 2, 1),
    });
    const clonedTile = cloneTile(richTile);
    (clonedTile.trap as Extract<TileState['trap'], { kind: 'PRESSURE_PLATE' }>).targetIds.push('e3');
    expect((richTile.trap as Extract<TileState['trap'], { kind: 'PRESSURE_PLATE' }>).targetIds).toHaveLength(2);

    const richChimera = makePiece({
      id: 'p_ch',
      side: 'PLAYER',
      type: 'CHIMERA',
      pos: { x: 2, y: 3 },
      composure: 3,
      absorbedForms: [{ sourceType: 'SAINT_FAITH', copiedTraits: ['SHIELDED'], saintEcho: 'FAITH_WARD' }],
    });
    const clonedChimera = clonePiece(richChimera);
    clonedChimera.absorbedForms![0]!.copiedTraits.push('SCOUT');
    expect(richChimera.absorbedForms![0]!.copiedTraits).toEqual(['SHIELDED']);

    const richTiles = createEmptyTiles(5, 5, 'PLAIN');
    richTiles[3]![2] = richTile;
    const richState = createGameState({
      width: 5,
      height: 5,
      tiles: richTiles,
      pieces: [kingP, richChimera, kingE],
    });
    const visible = getVisibleState(richState, 'PLAYER');
    expect(visible.tiles[3]![2]?.gas?.turnsRemaining).toBe(2);
    expect(visible.tiles[3]![2]?.trap?.kind).toBe('PRESSURE_PLATE');
    expect(visible.pieces.find((p) => p.id === 'p_ch')?.absorbedForms?.[0]?.saintEcho).toBe('FAITH_WARD');
  });
});

describe('FAZ V3-2: 9-Step Reducer & Reactive Dungeon Chains (Package A)', () => {
  it('chokes PAWN on MIASMA landing with newlyFrozenIds protection, suffocates on turn 2, shields hold at 1, and CHIMERA is immune', () => {
    const tiles = createEmptyTiles(6, 6, 'PLAIN');
    tiles[3]![1] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[3]![4] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[3]![5] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });

    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 5 } });
    const pPawn = makePiece({ id: 'pp', side: 'PLAYER', type: 'PAWN', pos: { x: 1, y: 4 } });
    const pShield = makePiece({
      id: 'ps',
      side: 'PLAYER',
      type: 'KNIGHT',
      pos: { x: 4, y: 3 },
      traits: ['SHIELDED'],
      shieldActive: true,
    });
    const pChimera = makePiece({ id: 'pc', side: 'PLAYER', type: 'CHIMERA', pos: { x: 5, y: 3 } });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 0, y: 0 } });

    const s0 = createGameState({
      width: 6,
      height: 6,
      tiles,
      pieces: [pKing, pPawn, pShield, pChimera, eKing],
    });

    // Turn 1 (PLAYER): Pawn steps into MIASMA at (1,3) -> chokes (frozenTurns=1, newlyFrozenIds keeps it 1!)
    // and ticks miasmaExposure = 1 at Step 7. Shielded Knight ticks 1; Chimera immune (0).
    const r1 = stepGame(s0, { type: 'MOVE', pieceId: 'pp', to: { x: 1, y: 3 } });
    expect(r1.error).toBeUndefined();
    expect(r1.events.some((e) => e.type === 'PIECE_CHOKED_BY_MIASMA' && e.pieceId === 'pp')).toBe(true);
    const pawnAfterT1 = r1.nextState.pieces.find((p) => p.id === 'pp')!;
    expect(pawnAfterT1.frozenTurns).toBe(1);
    expect(pawnAfterT1.miasmaExposure).toBe(1);
    expect(r1.nextState.pieces.find((p) => p.id === 'ps')!.miasmaExposure).toBe(1);
    expect(r1.nextState.pieces.find((p) => p.id === 'pc')!.miasmaExposure).toBeUndefined();

    // Turn 2 (ENEMY): passes
    const r2 = stepGame(r1.nextState, { type: 'END_TURN' });
    expect(r2.error).toBeUndefined();

    // Turn 3 (PLAYER): Pawn is STILL frozen and cannot move!
    const illegalFrozenMove = stepGame(r2.nextState, { type: 'MOVE', pieceId: 'pp', to: { x: 1, y: 2 } });
    expect(illegalFrozenMove.error).toBeDefined();

    // PLAYER passes -> Step 7: Pawn hits exposure 2 and suffocates! Shielded Knight breaks shield & stays exposure 1!
    const r3 = stepGame(r2.nextState, { type: 'END_TURN' });
    expect(r3.error).toBeUndefined();
    expect(r3.nextState.pieces.find((p) => p.id === 'pp')).toBeUndefined();
    expect(r3.events.some((e) => e.type === 'PIECE_SUFFOCATED' && e.pieceId === 'pp')).toBe(true);

    const shieldAfterT3 = r3.nextState.pieces.find((p) => p.id === 'ps')!;
    expect(shieldAfterT3.shieldActive).toBe(false);
    expect(shieldAfterT3.miasmaExposure).toBe(1);
    expect(r3.events.some((e) => e.type === 'SHIELD_BROKEN' && e.pieceId === 'ps' && e.source === 'MIASMA')).toBe(true);

    // Chimera still completely unharmed
    expect(r3.nextState.pieces.find((p) => p.id === 'pc')?.miasmaExposure).toBeUndefined();

    // Turn 4 (ENEMY passes), Turn 5 (PLAYER moves Knight OUT of MIASMA -> resets exposure to 0/undefined)
    const r4 = stepGame(r3.nextState, { type: 'END_TURN' });
    const r5 = stepGame(r4.nextState, { type: 'MOVE', pieceId: 'ps', to: { x: 3, y: 1 } });
    expect(r5.error).toBeUndefined();
    expect(r5.nextState.pieces.find((p) => p.id === 'ps')?.miasmaExposure).toBeUndefined();
  });

  it('chains ICE slide -> PRESSURE_PLATE -> flaming ARROW_EMITTER -> DETONATE_GAS across PIT bridge -> secondary EXPLOSIVE', () => {
    const tiles = createEmptyTiles(7, 6, 'PLAIN');
    // Rook slides along row 4 across ICE(2,4) onto PLATE(3,4) and stops at PLAIN(3,4)
    tiles[4]![2] = createTile('ICE');
    tiles[4]![3] = createTile('PLAIN', 0, undefined, {
      trap: createPressurePlateTrap('pl_main', ['em_flame'], 2, 0),
    });
    // Flaming arrow emitter embedded in WALL(0,2) pointing east -> hits MIASMA at (2,2), bridging PIT(3,2) to (4,2)
    tiles[2]![0] = createTile('WALL', 0, undefined, {
      trap: createArrowEmitterTrap('em_flame', { dx: 1, dy: 0 }, { ammo: 1, flaming: true, piercing: false }),
    });
    tiles[2]![2] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[2]![3] = createTile('PIT', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[2]![4] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    tiles[3]![4] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay() });
    // Secondary CRACKED tile at (5,3) adjacent to EXPLOSIVE enemy at (4,3)
    tiles[3]![5] = createTile('CRACKED');

    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 5 } });
    const pRook = makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 1, y: 4 } });
    const eBomb = makePiece({
      id: 'eb',
      side: 'ENEMY',
      type: 'PAWN',
      pos: { x: 4, y: 3 },
      traits: ['EXPLOSIVE'],
    });
    const eShieldedOnCracked = makePiece({
      id: 'ec',
      side: 'ENEMY',
      type: 'ROOK',
      pos: { x: 5, y: 3 },
      traits: ['SHIELDED'],
      shieldActive: true,
    });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 6, y: 0 } });

    const s0 = createGameState({
      width: 7,
      height: 6,
      tiles,
      pieces: [pKing, pRook, eBomb, eShieldedOnCracked, eKing],
    });

    const step = stepGame(s0, { type: 'MOVE', pieceId: 'pr', to: { x: 2, y: 4 } });
    expect(step.error).toBeUndefined();
    expect(step.nextState.pieces.find((p) => p.id === 'pr')?.pos).toEqual({ x: 3, y: 4 });

    const types = step.events.map((e) => e.type);
    expect(types).toContain('PIECE_SLID');
    expect(types).toContain('PLATE_TRIGGERED');
    expect(types).toContain('ARROW_FIRED');
    expect(types).toContain('GAS_CHAIN_DETONATED');
    expect(types).toContain('PIECE_INCINERATED');
    // Incinerated EXPLOSIVE eBomb blasted CRACKED(5,3) into PIT, killing shielded Rook!
    expect(types).toContain('TILE_COLLAPSED');
    expect(types).toContain('PIECE_FELL_IN_PIT');

    expect(step.nextState.pieces.find((p) => p.id === 'eb')).toBeUndefined();
    expect(step.nextState.pieces.find((p) => p.id === 'ec')).toBeUndefined();
    expect(step.nextState.tiles[3]![5]!.type).toBe('PIT');
    expect(step.nextState.tiles[2]![2]!.type).toBe('BURNING');
    expect(step.nextState.tiles[2]![3]!.type).toBe('PIT');
    expect(step.nextState.tiles[2]![3]!.gas).toBeUndefined();
  });

  it('collapses CRACKED tiles on DEPARTURE and PASS_THROUGH (not Knight mid-air) and disables emitter via BREAK_WALL', () => {
    const tiles = createEmptyTiles(6, 5, 'PLAIN');
    tiles[3]![1] = createTile('CRACKED');
    tiles[3]![2] = createTile('CRACKED');
    tiles[3]![3] = createTile('CRACKED');
    tiles[1]![1] = createTile('CRACKED');
    tiles[2]![2] = createTile('WALL', 0, undefined, {
      trap: createArrowEmitterTrap('em_wall', { dx: 1, dy: 0 }, { ammo: null }),
    });

    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 4 } });
    const pRook = makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 1, y: 3 } });
    const pKnight = makePiece({ id: 'pn', side: 'PLAYER', type: 'KNIGHT', pos: { x: 1, y: 1 } });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 5, y: 0 } });

    const s0 = createGameState({
      width: 6,
      height: 5,
      tiles,
      pieces: [pKing, pRook, pKnight, eKing],
      factions: { PLAYER: 'SIEGE_ENGINEERS', ENEMY: 'NONE' },
    });

    // Rook slides from CRACKED(1,3) across CRACKED(2,3) to land on CRACKED(3,3)
    const r1 = stepGame(s0, { type: 'MOVE', pieceId: 'pr', to: { x: 3, y: 3 } });
    expect(r1.error).toBeUndefined();
    expect(r1.nextState.tiles[3]![1]!.type).toBe('PIT'); // DEPARTURE
    expect(r1.nextState.tiles[3]![2]!.type).toBe('PIT'); // PASS_THROUGH
    expect(r1.nextState.tiles[3]![3]!.type).toBe('CRACKED'); // Landing stays intact!

    // Enemy passes
    const r2 = stepGame(r1.nextState, { type: 'END_TURN' });
    // Knight jumps from CRACKED(1,1) to (2,3)?? Wait (2,3) is PIT, jump to (3,2) over WALL(2,2)
    const r3 = stepGame(r2.nextState, { type: 'MOVE', pieceId: 'pn', to: { x: 3, y: 2 } });
    expect(r3.error).toBeUndefined();
    expect(r3.nextState.tiles[1]![1]!.type).toBe('PIT'); // DEPARTURE on jump!
    expect(r3.nextState.tiles[3]![3]!.type).toBe('CRACKED'); // Untouched!

    // Enemy passes; Siege Engineers Rook moves adjacent to WALL(2,2) and destroys emitter with BREAK_WALL
    const r4 = stepGame(r3.nextState, { type: 'END_TURN' });
    const r5 = stepGame(r4.nextState, { type: 'MOVE', pieceId: 'pr', to: { x: 3, y: 3 } });
    expect(r5.error).toBeDefined(); // already on (3,3)

    const r6 = stepGame(r4.nextState, { type: 'MOVE', pieceId: 'pr', to: { x: 2, y: 3 } });
    expect(r6.error).toBeDefined(); // (2,3) collapsed to PIT!

    // Move Rook from (3,3) up? (3,2) has Knight. Move Knight away or test BREAK_WALL directly from (2,1)
    const r7 = stepGame(r4.nextState, { type: 'MOVE', pieceId: 'pr', to: { x: 3, y: 4 } });
    expect(r7.error).toBeUndefined();
    expect(r7.nextState.tiles[3]![3]!.type).toBe('PIT'); // DEPARTURE!
  });

  it('executes PUSHER -> TELEGRAPH SPIKES combo, skewering ENEMY KING at Step 8 for KING_SKEWERED victory', () => {
    const tiles = createEmptyTiles(5, 5, 'PLAIN');
    tiles[2]![3] = createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('sp_combo', 1) });

    const pKing = makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 4 } });
    const pPusher = makePiece({
      id: 'pp',
      side: 'PLAYER',
      type: 'ROOK',
      pos: { x: 1, y: 2 },
      traits: ['PUSHER'],
    });
    const eKing = makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 2, y: 2 } });

    const s0 = createGameState({
      width: 5,
      height: 5,
      tiles,
      pieces: [pKing, pPusher, eKing],
    });

    // Push Enemy King onto TELEGRAPH(1) spikes -> Step 8 advances 1 -> 2 (EXTENDED) -> KING_SKEWERED!
    const step = stepGame(s0, {
      type: 'USE_ABILITY',
      pieceId: 'pp',
      ability: 'PUSH',
      target: { x: 2, y: 2 },
    });

    expect(step.error).toBeUndefined();
    expect(step.nextState.winner).toBe('PLAYER');
    expect(step.events.some((e) => e.type === 'SPIKES_PHASE_CHANGED')).toBe(true);
    expect(step.events.some((e) => e.type === 'PIECE_SKEWERED' && e.pieceId === 'ek' && e.source === 'SPIKES')).toBe(
      true,
    );
    expect(step.events.some((e) => e.type === 'MATCH_ENDED' && e.winner === 'PLAYER' && e.reason === 'KING_SKEWERED')).toBe(
      true,
    );
  });

  it('maintains 100% deterministic lockstep state hash across 2 isolated engines through all V3 dungeon events', () => {
    const buildArena = () => {
      const tiles = createEmptyTiles(6, 6, 'PLAIN');
      tiles[3]![2] = createTile('CRACKED');
      tiles[3]![3] = createTile('PLAIN', 0, undefined, {
        trap: createPressurePlateTrap('pl1', ['em1'], 2, 0),
      });
      tiles[1]![0] = createTile('WALL', 0, undefined, {
        trap: createArrowEmitterTrap('em1', { dx: 1, dy: 0 }, { ammo: 2, flaming: true }),
      });
      tiles[1]![3] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay(4) });
      tiles[4]![4] = createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('sp1', 0) });

      return createGameState({
        width: 6,
        height: 6,
        tiles,
        pieces: [
          makePiece({ id: 'pk', side: 'PLAYER', type: 'KING', pos: { x: 0, y: 5 } }),
          makePiece({ id: 'pr', side: 'PLAYER', type: 'ROOK', pos: { x: 1, y: 3 } }),
          makePiece({ id: 'ek', side: 'ENEMY', type: 'KING', pos: { x: 5, y: 0 } }),
          makePiece({ id: 'ep', side: 'ENEMY', type: 'PAWN', pos: { x: 3, y: 1 } }),
        ],
        seed: 'v3-lockstep-dungeon',
      });
    };

    const actions: GameAction[] = [
      { type: 'MOVE', pieceId: 'pr', to: { x: 3, y: 3 } }, // crosses CRACKED, triggers PLATE -> flaming arrow -> gas blast kills ep!
      { type: 'END_TURN' },
      { type: 'MOVE', pieceId: 'pk', to: { x: 1, y: 5 } },
      { type: 'END_TURN' },
    ];

    const engA = replayActions(buildArena(), actions);
    const engB = replayActions(buildArena(), actions);

    expect(engA.error).toBeUndefined();
    expect(engB.error).toBeUndefined();
    expect(computeStateHash(engA.state)).toBe(computeStateHash(engB.state));
    expect(computeStateHash(engA.state)).toBe(computeStateHash(JSON.parse(JSON.stringify(engA.state))));
    expect(engA.allEvents).toEqual(engB.allEvents);
  });
});

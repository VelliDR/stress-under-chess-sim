import { createEmptyTiles, createTile, ensureMapConnectivity } from '../engine/board';
import {
  createArrowEmitterTrap,
  createMiasmaOverlay,
  createPressurePlateTrap,
  createSpikesTrap,
} from '../engine/dungeon';
import { createGameState } from '../engine/reducer';
import { FactionPassive, GameState, Piece, PieceType, Side, TraitId } from '../engine/types';

export interface SandboxPresetMeta {
  id: string;
  name: string;
  description: string;
  defaultFactions: Record<Side, FactionPassive>;
  build: (factionsOverride?: Partial<Record<Side, FactionPassive>>) => GameState;
}

function makePiece(
  id: string,
  side: Side,
  type: PieceType,
  x: number,
  y: number,
  traits: TraitId[] = [],
  extras?: Partial<Piece>,
): Piece {
  return {
    id,
    side,
    type,
    pos: { x, y },
    traits: traits.slice(),
    shieldActive: extras?.shieldActive ?? traits.includes('SHIELDED'),
    frozenTurns: extras?.frozenTurns ?? 0,
    hasMoved: extras?.hasMoved ?? false,
    aggro: extras?.aggro ?? 'ACTIVE',
    usedDashThisTurn: false,
    wasVisibleAtTurnStart: false,
    ...(extras?.isBoss !== undefined ? { isBoss: extras.isBoss } : {}),
    ...(extras?.composure !== undefined ? { composure: extras.composure } : {}),
    ...(extras?.driftSign !== undefined ? { driftSign: extras.driftSign } : {}),
    ...(extras?.miasmaExposure !== undefined ? { miasmaExposure: extras.miasmaExposure } : {}),
    ...(extras?.faithCharge !== undefined ? { faithCharge: extras.faithCharge } : {}),
    ...(extras?.madnessCharge !== undefined ? { madnessCharge: extras.madnessCharge } : {}),
    ...(extras?.berserkReady !== undefined ? { berserkReady: extras.berserkReady } : {}),
    ...(extras?.silencedTurns !== undefined ? { silencedTurns: extras.silencedTurns } : {}),
    ...(extras?.absorbedForms !== undefined ? { absorbedForms: extras.absorbedForms } : {}),
  };
}

export const SANDBOX_PRESETS: readonly SandboxPresetMeta[] = [
  {
    id: 'tactical-lab',
    name: 'Taktik Laboratuvar (Tümü)',
    description:
      'Tüm arazi tipleri, 7 mutasyon, buz→çukur itme kombosu, kule görüşü, silüet halkası ve duvar kırma.',
    defaultFactions: { PLAYER: 'SIEGE_ENGINEERS', ENEMY: 'NECROMANCERS' },
    build(factionsOverride) {
      const width = 9;
      const height = 8;
      const tiles = createEmptyTiles(width, height, 'PLAIN');

      // Walls creating LOS occlusion & breakable siege wall next to player's rook at (2, 6)
      tiles[3]![1] = createTile('WALL');
      tiles[4]![1] = createTile('WALL');
      tiles[5]![2] = createTile('WALL');
      tiles[2]![6] = createTile('WALL');
      tiles[3]![6] = createTile('WALL');

      // Watchtowers for +2 vision radius (step onto (4,5) on Turn 1 to expand fog!)
      tiles[5]![4] = createTile('WATCHTOWER');
      tiles[2]![4] = createTile('WATCHTOWER');

      // Ice corridors:
      // 1) Vertical slide on col 7 leading into VISIBLE PIT at (7,3) (shows lethal skull preview for Queen at (7,6))
      tiles[5]![7] = createTile('ICE');
      tiles[4]![7] = createTile('ICE');
      tiles[3]![7] = createTile('PIT');
      // 2) Horizontal push-to-ice-to-pit lane on row 4: PUSHER at (5,4) -> enemy at (6,4) -> ICE (7,4) -> PIT (8,4)
      tiles[4]![8] = createTile('PIT');

      // Burning tile in mid-center
      tiles[3]![4] = createTile('BURNING', 2);

      const ensured = ensureMapConnectivity(tiles, [{ x: 4, y: 7 }], { x: 4, y: 0 });

      const pieces: Piece[] = [
        // PLAYER side (bottom)
        makePiece('p_king', 'PLAYER', 'KING', 4, 7, ['SHIELDED']),
        makePiece('p_rook', 'PLAYER', 'ROOK', 2, 6, ['SHIELDED']),
        makePiece('p_knight', 'PLAYER', 'KNIGHT', 3, 6, ['DASH_ON_REVEAL']),
        makePiece('p_scout', 'PLAYER', 'PAWN', 4, 6, ['SCOUT']),
        makePiece('p_bishop', 'PLAYER', 'BISHOP', 5, 6, ['FROST_TOUCH']),
        makePiece('p_pusher', 'PLAYER', 'PAWN', 5, 4, ['PUSHER']),
        makePiece('p_queen', 'PLAYER', 'QUEEN', 7, 6, ['EXPLOSIVE']),

        // ENEMY side (top & mid)
        makePiece('e_king', 'ENEMY', 'KING', 4, 0, ['SHIELDED']),
        makePiece('e_rook', 'ENEMY', 'ROOK', 1, 1, ['SHIELDED']),
        makePiece('e_knight', 'ENEMY', 'KNIGHT', 6, 1, ['SHADOW_WALKER']),
        makePiece('e_bishop', 'ENEMY', 'BISHOP', 3, 1, ['FROST_TOUCH']),
        // Orthogonally east of p_pusher (5,4): PUSH pushes it onto ICE (7,4) -> PIT (8,4)!
        makePiece('e_bait', 'ENEMY', 'PAWN', 6, 4, ['EXPLOSIVE']),
        makePiece('e_guard', 'ENEMY', 'PAWN', 4, 2, ['SHIELDED']),
        makePiece('e_sil', 'ENEMY', 'PAWN', 0, 2, []),
      ];

      return createGameState({
        width,
        height,
        tiles: ensured.tiles,
        pieces,
        mode: 'SANDBOX',
        factions: {
          PLAYER: factionsOverride?.PLAYER ?? 'SIEGE_ENGINEERS',
          ENEMY: factionsOverride?.ENEMY ?? 'NECROMANCERS',
        },
        seed: 'sandbox-tactical-lab',
      });
    },
  },
  {
    id: 'ice-push-arena',
    name: 'Buzul & İtme Kombo Arenası',
    description:
      'Uzun buz koridorları, çukur tuzakları, zırhlı hedefler ve PUSHER / FROST_WARDENS etkileşimleri.',
    defaultFactions: { PLAYER: 'NONE', ENEMY: 'FROST_WARDENS' },
    build(factionsOverride) {
      const width = 8;
      const height = 8;
      const tiles = createEmptyTiles(width, height, 'PLAIN');

      // Twin vertical ice highways into pits
      for (let y = 2; y <= 5; y++) {
        tiles[y]![2] = createTile('ICE');
        tiles[y]![5] = createTile('ICE');
      }
      tiles[1]![2] = createTile('PIT');
      tiles[1]![5] = createTile('PIT');

      // Horizontal ice bridge in center
      tiles[4]![3] = createTile('ICE');
      tiles[4]![4] = createTile('ICE');
      tiles[4]![6] = createTile('ICE');
      tiles[4]![7] = createTile('PIT');

      // Cover walls & central watchtower
      tiles[3]![3] = createTile('WATCHTOWER');
      tiles[3]![1] = createTile('WALL');
      tiles[5]![6] = createTile('WALL');

      const ensured = ensureMapConnectivity(tiles, [{ x: 3, y: 7 }], { x: 4, y: 0 });

      const pieces: Piece[] = [
        makePiece('p_king', 'PLAYER', 'KING', 3, 7, []),
        makePiece('p_rook', 'PLAYER', 'ROOK', 2, 6, ['FROST_TOUCH']),
        makePiece('p_pusher', 'PLAYER', 'KNIGHT', 3, 4, ['PUSHER']),
        makePiece('p_queen', 'PLAYER', 'QUEEN', 5, 6, ['SHIELDED']),
        makePiece('p_pawn', 'PLAYER', 'PAWN', 4, 6, ['SCOUT']),

        makePiece('e_king', 'ENEMY', 'KING', 4, 0, ['SHIELDED']),
        makePiece('e_target', 'ENEMY', 'ROOK', 4, 4, ['SHIELDED']),
        makePiece('e_pawn1', 'ENEMY', 'PAWN', 2, 4, ['EXPLOSIVE']),
        makePiece('e_pawn2', 'ENEMY', 'PAWN', 5, 3, []),
        makePiece('e_bishop', 'ENEMY', 'BISHOP', 6, 1, ['FROST_TOUCH']),
      ];

      return createGameState({
        width,
        height,
        tiles: ensured.tiles,
        pieces,
        mode: 'SANDBOX',
        factions: {
          PLAYER: factionsOverride?.PLAYER ?? 'NONE',
          ENEMY: factionsOverride?.ENEMY ?? 'FROST_WARDENS',
        },
        seed: 'sandbox-ice-arena',
      });
    },
  },
  {
    id: 'fog-ambush',
    name: 'Savaş Sisi & Pusu Testi',
    description:
      'Simetrik duvar görüş hattı, ? silüet halkası, SHADOW_WALKER gizliliği ve DASH_ON_REVEAL (RAIDERS) pusu hamlesi.',
    defaultFactions: { PLAYER: 'RAIDERS', ENEMY: 'NECROMANCERS' },
    build(factionsOverride) {
      const width = 9;
      const height = 9;
      const tiles = createEmptyTiles(width, height, 'PLAIN');

      // Asymmetric wall pillars creating rich LOS corridors
      tiles[4]![2] = createTile('WALL');
      tiles[4]![3] = createTile('WALL');
      tiles[4]![5] = createTile('WALL');
      tiles[4]![6] = createTile('WALL');
      tiles[2]![4] = createTile('WALL');
      tiles[6]![4] = createTile('WALL');

      // Vantage watchtowers
      tiles[5]![4] = createTile('WATCHTOWER');
      tiles[3]![4] = createTile('WATCHTOWER');

      const ensured = ensureMapConnectivity(tiles, [{ x: 4, y: 8 }], { x: 4, y: 0 });

      const pieces: Piece[] = [
        makePiece('p_king', 'PLAYER', 'KING', 4, 8, []),
        makePiece('p_raider1', 'PLAYER', 'KNIGHT', 1, 6, ['DASH_ON_REVEAL']),
        makePiece('p_raider2', 'PLAYER', 'KNIGHT', 7, 6, ['SHADOW_WALKER']),
        makePiece('p_scout', 'PLAYER', 'PAWN', 4, 7, ['SCOUT']),
        makePiece('p_bishop', 'PLAYER', 'BISHOP', 2, 7, []),

        makePiece('e_king', 'ENEMY', 'KING', 4, 0, ['SHIELDED']),
        makePiece('e_shadow', 'ENEMY', 'KNIGHT', 7, 3, ['SHADOW_WALKER']),
        makePiece('e_visible_sil', 'ENEMY', 'ROOK', 1, 2, ['EXPLOSIVE']),
        makePiece('e_tower_guard', 'ENEMY', 'BISHOP', 4, 3, []),
        makePiece('e_pawn', 'ENEMY', 'PAWN', 5, 2, []),
      ];

      return createGameState({
        width,
        height,
        tiles: ensured.tiles,
        pieces,
        mode: 'SANDBOX',
        factions: {
          PLAYER: factionsOverride?.PLAYER ?? 'RAIDERS',
          ENEMY: factionsOverride?.ENEMY ?? 'NECROMANCERS',
        },
        seed: 'sandbox-fog-ambush',
      });
    },
  },
  {
    id: 'gas-arrow-lab',
    name: 'V3: Gaz + Ok Kimyası',
    description:
      'Baskı plakası → alevli duvar oku → çukur köprülü MIASMA zincirleme patlaması, çatlak zemin ve ritimli kazık itme kombosu.',
    defaultFactions: { PLAYER: 'SIEGE_ENGINEERS', ENEMY: 'NONE' },
    build(factionsOverride) {
      const width = 8;
      const height = 8;
      const tiles = createEmptyTiles(width, height, 'PLAIN');

      // Ice slide onto Pressure Plate (3,5) wired to flaming Arrow Emitter at WALL(0,3)
      tiles[5]![2] = createTile('ICE');
      tiles[5]![3] = createTile('PLAIN', 0, undefined, {
        trap: createPressurePlateTrap('pl_fire', ['em_flame'], 2, 0),
      });
      tiles[3]![0] = createTile('WALL', 0, undefined, {
        trap: createArrowEmitterTrap('em_flame', { dx: 1, dy: 0 }, { ammo: 3, flaming: true }),
      });

      // Connected MIASMA pocket bridging PIT(4,3) into enemy squad
      tiles[3]![3] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay(null) });
      tiles[3]![4] = createTile('PIT', 0, undefined, { gas: createMiasmaOverlay(null) });
      tiles[3]![5] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay(null) });
      tiles[2]![5] = createTile('CRACKED', 0, undefined, { gas: createMiasmaOverlay(null) });

      // Cracked bridge & telegraph spikes for PUSHER combo
      tiles[5]![5] = createTile('CRACKED');
      tiles[4]![6] = createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('sp_1', 1) });
      tiles[4]![5] = createTile('PLAIN', 0, undefined, { trap: createSpikesTrap('sp_2', 0) });

      const ensured = ensureMapConnectivity(tiles, [{ x: 3, y: 7 }], { x: 4, y: 0 });
      const pieces: Piece[] = [
        makePiece('p_king', 'PLAYER', 'KING', 3, 7, ['SHIELDED']),
        makePiece('p_rook', 'PLAYER', 'ROOK', 1, 5, []),
        makePiece('p_pusher', 'PLAYER', 'KNIGHT', 6, 6, ['PUSHER']),
        makePiece('p_pawn', 'PLAYER', 'PAWN', 5, 5, []),

        makePiece('e_king', 'ENEMY', 'KING', 4, 0, ['SHIELDED']),
        makePiece('e_gas_bomb', 'ENEMY', 'PAWN', 5, 3, ['EXPLOSIVE']),
        makePiece('e_cracked_rook', 'ENEMY', 'ROOK', 5, 2, ['SHIELDED']),
        makePiece('e_spike_bait', 'ENEMY', 'BISHOP', 6, 5, []),
      ];

      return createGameState({
        width,
        height,
        tiles: ensured.tiles,
        pieces,
        mode: 'SANDBOX',
        factions: {
          PLAYER: factionsOverride?.PLAYER ?? 'SIEGE_ENGINEERS',
          ENEMY: factionsOverride?.ENEMY ?? 'NONE',
        },
        seed: 'sandbox-gas-arrow-lab',
      });
    },
  },
  {
    id: 'saint-silence-lab',
    name: 'V3: Ocaklı 1.5× Susturma & Meczup Cinnet',
    description:
      'Ocaklı (SAINT_FAITH) 7×7 arınma + 2 tur susturma ultisi ve Meczup (SAINT_MADNESS) zırh delme + zincirleme cinnet sahnesi.',
    defaultFactions: { PLAYER: 'NONE', ENEMY: 'NONE' },
    build(factionsOverride) {
      const width = 8;
      const height = 8;
      const tiles = createEmptyTiles(width, height, 'PLAIN');
      tiles[2]![6] = createTile('PIT');
      tiles[4]![1] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay(null) });

      const pieces: Piece[] = [
        makePiece('p_king', 'PLAYER', 'KING', 3, 7, []),
        makePiece('p_ocakli', 'PLAYER', 'SAINT_FAITH', 2, 4, []),
        makePiece('p_devoted', 'PLAYER', 'KNIGHT', 2, 5, [], { faithCharge: 2, composure: 1 }),
        makePiece('p_debuffed', 'PLAYER', 'PAWN', 1, 4, [], { frozenTurns: 1, miasmaExposure: 1, composure: 1 }),
        makePiece('p_meczup', 'PLAYER', 'SAINT_MADNESS', 5, 5, []),
        makePiece('p_berserker', 'PLAYER', 'ROOK', 4, 5, [], { berserkReady: true }),

        makePiece('e_king', 'ENEMY', 'KING', 4, 0, []),
        makePiece('e_shield_bomb', 'ENEMY', 'ROOK', 2, 1, ['SHIELDED', 'EXPLOSIVE']),
        makePiece('e_enemy_meczup', 'ENEMY', 'SAINT_MADNESS', 3, 2, []),
        makePiece('e_shield_target', 'ENEMY', 'BISHOP', 4, 2, ['SHIELDED']),
        makePiece('e_kick_bait', 'ENEMY', 'PAWN', 5, 2, []),
        makePiece('e_gulyabani', 'ENEMY', 'CHIMERA', 1, 2, []),
      ];

      return createGameState({
        width,
        height,
        tiles,
        pieces,
        mode: 'SANDBOX',
        factions: {
          PLAYER: factionsOverride?.PLAYER ?? 'NONE',
          ENEMY: factionsOverride?.ENEMY ?? 'NONE',
        },
        seed: 'sandbox-saint-silence-lab',
      });
    },
  },
  {
    id: 'chimera-drift-lab',
    name: 'V3: Gulyabani & 45° Yalpalama',
    description:
      'Efsun tutmaz Gulyabani (CHIMERA) 2-slot kılık çalma evrimi, duvar arkasını vuran 45° kavisli yalpalama ve itaatsizlik testi.',
    defaultFactions: { PLAYER: 'NONE', ENEMY: 'NONE' },
    build(factionsOverride) {
      const width = 8;
      const height = 8;
      const tiles = createEmptyTiles(width, height, 'PLAIN');
      tiles[2]![1] = createTile('WALL'); // Rook at (1,5) curves 45° NE around WALL(1,2) to hit (2,2)!
      tiles[4]![4] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay(null) });
      tiles[4]![5] = createTile('PLAIN', 0, undefined, { gas: createMiasmaOverlay(null) });

      const pieces: Piece[] = [
        makePiece('p_king', 'PLAYER', 'KING', 0, 7, []),
        makePiece('p_drifter', 'PLAYER', 'ROOK', 1, 5, [], { composure: 1, driftSign: 1 }),
        makePiece('p_fragile_pawn', 'PLAYER', 'PAWN', 6, 5, [], { composure: 1 }),
        makePiece('p_gulyabani', 'PLAYER', 'CHIMERA', 4, 5, []),

        makePiece('e_king', 'ENEMY', 'KING', 7, 0, []),
        makePiece('e_behind_wall', 'ENEMY', 'BISHOP', 2, 2, []),
        makePiece('e_knight_meal', 'ENEMY', 'KNIGHT', 4, 3, ['SCOUT']),
        makePiece('e_ocakli_meal', 'ENEMY', 'SAINT_FAITH', 5, 2, []),
        makePiece('e_meczup_meal', 'ENEMY', 'SAINT_MADNESS', 3, 2, []),
        makePiece('e_threat_rook', 'ENEMY', 'ROOK', 6, 2, []),
      ];

      return createGameState({
        width,
        height,
        tiles,
        pieces,
        mode: 'SANDBOX',
        factions: {
          PLAYER: factionsOverride?.PLAYER ?? 'NONE',
          ENEMY: factionsOverride?.ENEMY ?? 'NONE',
        },
        seed: 'sandbox-chimera-drift-lab',
      });
    },
  },
];

export function getSandboxPreset(id: string): SandboxPresetMeta {
  return SANDBOX_PRESETS.find((p) => p.id === id) ?? SANDBOX_PRESETS[0]!;
}

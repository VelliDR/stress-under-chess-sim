import {
  createEmptyTiles,
  createTile,
  ensureMapConnectivity,
  isTileWalkable,
} from '../engine/board';
import {
  createArrowEmitterTrap,
  createMiasmaOverlay,
  createPressurePlateTrap,
  createSpikesTrap,
} from '../engine/dungeon';
import { nextInt, seedToRngState, shuffle } from '../engine/prng';
import { createGameState } from '../engine/reducer';
import {
  CampaignPactEffect,
  CardinalDir,
  Coord,
  FactionPassive,
  GameState,
  MAX_TRAITS_PER_PIECE,
  Piece,
  PieceType,
  RosterUnit,
  SpikePhase,
  TileState,
  TraitId,
} from '../engine/types';

export interface EncounterEnemySpec {
  type: PieceType;
  traits: readonly TraitId[];
  isBoss?: boolean;
  preferFront?: boolean;
}

export interface CampaignRoomTemplate {
  roomIndex: number;
  id: string;
  name: string;
  subtitle: string;
  width: number;
  height: number;
  enemyFaction: FactionPassive;
  isBoss: boolean;
  wallCount: number;
  iceCount: number;
  pitCount: number;
  watchtowerCount: number;
  enemies: readonly EncounterEnemySpec[];
  /** Optional V3 Campaign Act identifier (omitted = Act 1). */
  act?: 1 | 2 | 3 | 4;
  /** V3 Dungeon Chemistry: number of MIASMA gas pockets/tiles. */
  miasmaCount?: number;
  /** V3 Dungeon Chemistry: number of CRACKED fragile tiles. */
  crackedCount?: number;
  /** V3 Dungeon Chemistry: number of rhythmic SPIKES traps. */
  spikeCount?: number;
  /** V3 Dungeon Chemistry: number of wired PRESSURE_PLATE -> ARROW_EMITTER pairs. */
  plateEmitterPairs?: number;
}

export interface SkirmishMapTemplate {
  id: string;
  name: string;
  width: number;
  height: number;
  wallPairs: number;
  icePairs: number;
  pitPairs: number;
  watchtowerPairs: number;
}

export const CAMPAIGN_ROOMS: readonly CampaignRoomTemplate[] = [
  {
    roomIndex: 0,
    id: 'forest-border',
    name: 'Oda 1 · Orman Sınırı',
    subtitle: 'İlk keşif hattı. Hafif siperler ve gözetleme kuleleri.',
    width: 8,
    height: 8,
    enemyFaction: 'NONE',
    isBoss: false,
    wallCount: 5,
    iceCount: 0,
    pitCount: 0,
    watchtowerCount: 2,
    enemies: [
      { type: 'KING', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'BISHOP', traits: [] },
      { type: 'PAWN', traits: [], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
      { type: 'PAWN', traits: ['SCOUT'], preferFront: true },
    ],
  },
  {
    roomIndex: 1,
    id: 'glacial-pass',
    name: 'Oda 2 · Buzul Geçidi',
    subtitle: 'Buzul Muhafızları kaymaz; çukurlara kaymamaya dikkat et.',
    width: 8,
    height: 8,
    enemyFaction: 'FROST_WARDENS',
    isBoss: false,
    wallCount: 4,
    iceCount: 9,
    pitCount: 3,
    watchtowerCount: 2,
    enemies: [
      { type: 'KING', traits: [] },
      { type: 'ROOK', traits: ['FROST_TOUCH'] },
      { type: 'KNIGHT', traits: ['PUSHER'] },
      { type: 'BISHOP', traits: [] },
      { type: 'PAWN', traits: [], preferFront: true },
      { type: 'PAWN', traits: ['FROST_TOUCH'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 2,
    id: 'bone-plains',
    name: 'Oda 3 · Kemik Ovası',
    subtitle: 'Nekromanserler ölen birimlerinden 2 tur sonra iskelet diriltir.',
    width: 9,
    height: 8,
    enemyFaction: 'NECROMANCERS',
    isBoss: false,
    wallCount: 6,
    iceCount: 2,
    pitCount: 2,
    watchtowerCount: 2,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'KNIGHT', traits: ['SHADOW_WALKER'] },
      { type: 'BISHOP', traits: ['EXPLOSIVE'] },
      { type: 'ROOK', traits: [] },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: ['SHADOW_WALKER'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 3,
    id: 'siege-wall',
    name: 'Oda 4 · Kuşatma Duvarı',
    subtitle: 'Kuşatma Mühendisleri Kaleleriyle siper duvarlarını yıkıp geçit açar.',
    width: 9,
    height: 9,
    enemyFaction: 'SIEGE_ENGINEERS',
    isBoss: false,
    wallCount: 9,
    iceCount: 2,
    pitCount: 2,
    watchtowerCount: 2,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'ROOK', traits: ['SHIELDED'] },
      { type: 'ROOK', traits: ['PUSHER'] },
      { type: 'KNIGHT', traits: ['DASH_ON_REVEAL'] },
      { type: 'BISHOP', traits: ['FROST_TOUCH'] },
      { type: 'PAWN', traits: ['SHIELDED'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 4,
    id: 'boss-glacier-siege',
    name: 'Oda 5 · BOSS: Buzul Kuşatma Komutanı',
    subtitle: 'Zırhlı Boss Şah her 3 düşman turunda etrafına 1 kare buz/alev halkası saçar!',
    width: 9,
    height: 9,
    enemyFaction: 'FROST_WARDENS',
    isBoss: true,
    wallCount: 6,
    iceCount: 8,
    pitCount: 2,
    watchtowerCount: 2,
    enemies: [
      { type: 'KING', traits: ['SHIELDED', 'FROST_TOUCH'], isBoss: true },
      { type: 'ROOK', traits: ['SHIELDED', 'FROST_TOUCH'] },
      { type: 'QUEEN', traits: ['EXPLOSIVE', 'PUSHER'] },
      { type: 'KNIGHT', traits: ['DASH_ON_REVEAL'] },
      { type: 'PAWN', traits: ['SHIELDED'], preferFront: true },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
];

/**
 * Perde 2 — Karantina & Zindan Kimyası (Miasma, Baskı Plakaları, Ok Atıcılar, Çatlak Zemin, Kazıklar).
 */
export const ACT2_CAMPAIGN_ROOMS: readonly CampaignRoomTemplate[] = [
  {
    roomIndex: 0,
    act: 2,
    id: 'act2-1',
    name: 'Perde 2 · Oda 1 · Havalandırma Koridoru',
    subtitle: 'Zehirli Miasma cepleri görüşü keser ve 2 turda boğar; alevle patlatılabilir.',
    width: 8,
    height: 8,
    enemyFaction: 'NONE',
    isBoss: false,
    wallCount: 4,
    iceCount: 0,
    pitCount: 1,
    watchtowerCount: 2,
    miasmaCount: 6,
    crackedCount: 2,
    spikeCount: 0,
    plateEmitterPairs: 0,
    enemies: [
      { type: 'KING', traits: [] },
      { type: 'ROOK', traits: [] },
      { type: 'BISHOP', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: ['SCOUT'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 1,
    act: 2,
    id: 'act2-2',
    name: 'Perde 2 · Oda 2 · Kablo Düğümü',
    subtitle: 'Bakır kablolarla bağlı baskı plakaları duvar oklarını ateşler; dost-düşman ayırmaz.',
    width: 8,
    height: 8,
    enemyFaction: 'SIEGE_ENGINEERS',
    isBoss: false,
    wallCount: 4,
    iceCount: 2,
    pitCount: 1,
    watchtowerCount: 1,
    miasmaCount: 3,
    crackedCount: 2,
    spikeCount: 0,
    plateEmitterPairs: 2,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'ROOK', traits: ['PUSHER'] },
      { type: 'KNIGHT', traits: [] },
      { type: 'BISHOP', traits: [] },
      { type: 'PAWN', traits: ['SHIELDED'], preferFront: true },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 2,
    act: 2,
    id: 'act2-3',
    name: 'Perde 2 · Oda 3 · Çift Şalterli Sığınak',
    subtitle: 'Buz koridorları, çatlak köprüler ve çift ok tuzağı hattı.',
    width: 9,
    height: 8,
    enemyFaction: 'FROST_WARDENS',
    isBoss: false,
    wallCount: 5,
    iceCount: 5,
    pitCount: 2,
    watchtowerCount: 2,
    miasmaCount: 3,
    crackedCount: 4,
    spikeCount: 2,
    plateEmitterPairs: 2,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'ROOK', traits: ['FROST_TOUCH'] },
      { type: 'BISHOP', traits: ['PUSHER'] },
      { type: 'KNIGHT', traits: ['SHIELDED'] },
      { type: 'PAWN', traits: ['SHIELDED'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 3,
    act: 2,
    id: 'act2-4',
    name: 'Perde 2 · Oda 4 · Kazıklı Mezarlık',
    subtitle: 'Ölüler 2 turda dirilir, zemin kazıkları 3 turda açılır. İtme kombolarına dikkat.',
    width: 9,
    height: 9,
    enemyFaction: 'NECROMANCERS',
    isBoss: false,
    wallCount: 5,
    iceCount: 2,
    pitCount: 2,
    watchtowerCount: 2,
    miasmaCount: 4,
    crackedCount: 3,
    spikeCount: 6,
    plateEmitterPairs: 1,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'ROOK', traits: [] },
      { type: 'BISHOP', traits: ['EXPLOSIVE'] },
      { type: 'KNIGHT', traits: ['PUSHER'] },
      { type: 'PAWN', traits: ['SHADOW_WALKER'], preferFront: true },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 4,
    act: 2,
    id: 'act2-boss',
    name: 'Perde 2 · BOSS: KİMYAGER-OS',
    subtitle: 'Zehirli sis cepleri, alevli ok atıcılar ve patlayıcı komutan bir arada!',
    width: 9,
    height: 9,
    enemyFaction: 'NECROMANCERS',
    isBoss: true,
    wallCount: 5,
    iceCount: 3,
    pitCount: 2,
    watchtowerCount: 2,
    miasmaCount: 8,
    crackedCount: 4,
    spikeCount: 4,
    plateEmitterPairs: 2,
    enemies: [
      { type: 'KING', traits: ['SHIELDED', 'EXPLOSIVE'], isBoss: true },
      { type: 'QUEEN', traits: ['EXPLOSIVE'] },
      { type: 'ROOK', traits: ['PUSHER'] },
      { type: 'KNIGHT', traits: ['SHADOW_WALKER'] },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: ['SHIELDED'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
];

/**
 * Perde 3 — Psikoloji, Ocaklı/Meczup & Gulyabani.
 */
export const ACT3_CAMPAIGN_ROOMS: readonly CampaignRoomTemplate[] = [
  {
    roomIndex: 0,
    act: 3,
    id: 'act3-1',
    name: 'Perde 3 · Oda 1 · Yamuk Koridorlar',
    subtitle: 'Sıkışık duvarlar ve çatlak zemin: 45° stres yalpalamasını lehine çevir.',
    width: 8,
    height: 8,
    enemyFaction: 'NONE',
    isBoss: false,
    wallCount: 7,
    iceCount: 1,
    pitCount: 1,
    watchtowerCount: 2,
    miasmaCount: 4,
    crackedCount: 4,
    spikeCount: 2,
    plateEmitterPairs: 0,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'ROOK', traits: [] },
      { type: 'BISHOP', traits: [] },
      { type: 'BISHOP', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 1,
    act: 3,
    id: 'act3-2',
    name: 'Perde 3 · Oda 2 · Ocaklı’nın Tekkesi',
    subtitle: 'Düşman Ocaklı 3 tur şarj olursa 7×7 alanda tüm mutasyonlarını 2 tur susturur!',
    width: 9,
    height: 8,
    enemyFaction: 'FROST_WARDENS',
    isBoss: false,
    wallCount: 5,
    iceCount: 3,
    pitCount: 1,
    watchtowerCount: 2,
    miasmaCount: 4,
    crackedCount: 2,
    spikeCount: 3,
    plateEmitterPairs: 0,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'SAINT_FAITH', traits: ['SHIELDED'] },
      { type: 'ROOK', traits: ['FROST_TOUCH'] },
      { type: 'BISHOP', traits: [] },
      { type: 'PAWN', traits: ['SHIELDED'], preferFront: true },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 2,
    act: 3,
    id: 'act3-3',
    name: 'Perde 3 · Oda 3 · Çatlak Köprüler',
    subtitle: 'Meczup ve Ocaklı aynı tahtada! Çatlak köprüler tek geçişte çukura çöker.',
    width: 9,
    height: 9,
    enemyFaction: 'RAIDERS',
    isBoss: false,
    wallCount: 4,
    iceCount: 2,
    pitCount: 3,
    watchtowerCount: 2,
    miasmaCount: 3,
    crackedCount: 6,
    spikeCount: 2,
    plateEmitterPairs: 1,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'SAINT_FAITH', traits: [] },
      { type: 'SAINT_MADNESS', traits: [] },
      { type: 'KNIGHT', traits: ['DASH_ON_REVEAL'] },
      { type: 'PAWN', traits: ['PUSHER'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 3,
    act: 3,
    id: 'act3-4',
    name: 'Perde 3 · Oda 4 · Gulyabani Kafesi',
    subtitle: 'Efsun tutmaz Gulyabani yediği taşların hareket ve mutasyonlarını çalar!',
    width: 9,
    height: 9,
    enemyFaction: 'NONE',
    isBoss: false,
    wallCount: 5,
    iceCount: 2,
    pitCount: 2,
    watchtowerCount: 2,
    miasmaCount: 6,
    crackedCount: 4,
    spikeCount: 4,
    plateEmitterPairs: 1,
    enemies: [
      { type: 'KING', traits: ['SHIELDED'] },
      { type: 'CHIMERA', traits: [] },
      { type: 'KNIGHT', traits: ['SHADOW_WALKER'] },
      { type: 'BISHOP', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'], preferFront: true },
      { type: 'PAWN', traits: [], preferFront: true },
    ],
  },
  {
    roomIndex: 4,
    act: 3,
    id: 'act3-boss',
    name: 'Perde 3 · FİNAL BOSS: BÜYÜKUSTA-OS v0.94',
    subtitle: 'Ocaklı, Meczup, Gulyabani ve tüm zindan kimyası tek son savaşta!',
    width: 9,
    height: 9,
    enemyFaction: 'SIEGE_ENGINEERS',
    isBoss: true,
    wallCount: 5,
    iceCount: 2,
    pitCount: 2,
    watchtowerCount: 2,
    miasmaCount: 6,
    crackedCount: 5,
    spikeCount: 4,
    plateEmitterPairs: 2,
    enemies: [
      { type: 'KING', traits: ['SHIELDED', 'FROST_TOUCH'], isBoss: true },
      { type: 'SAINT_FAITH', traits: ['SHIELDED'] },
      { type: 'SAINT_MADNESS', traits: [] },
      { type: 'CHIMERA', traits: [] },
      { type: 'ROOK', traits: ['PUSHER'] },
      { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
      { type: 'PAWN', traits: ['SHIELDED'], preferFront: true },
    ],
  },
];

/**
 * Gizli Perde 4 · Çekirdek Meydan Okuması (`act4-core`).
 */
export const SECRET_ACT4_ROOM: CampaignRoomTemplate = {
  roomIndex: 0,
  act: 4,
  id: 'act4-core',
  name: 'Gizli Perde 4 · 0x00_ÇEKİRDEK',
  subtitle: 'Çekirdek kilidi kırıldı. Gulyabani, çift Azize ve gölge elitlere karşı son direniş.',
  width: 9,
  height: 9,
  enemyFaction: 'NECROMANCERS',
  isBoss: true,
  wallCount: 5,
  iceCount: 2,
  pitCount: 2,
  watchtowerCount: 2,
  miasmaCount: 8,
  crackedCount: 6,
  spikeCount: 6,
  plateEmitterPairs: 2,
  enemies: [
    { type: 'KING', traits: ['SHIELDED', 'EXPLOSIVE'], isBoss: true },
    { type: 'CHIMERA', traits: [] },
    { type: 'SAINT_FAITH', traits: ['SHIELDED'] },
    { type: 'SAINT_MADNESS', traits: ['SHIELDED'] },
    { type: 'QUEEN', traits: ['SHADOW_WALKER'] },
    { type: 'KNIGHT', traits: ['DASH_ON_REVEAL'] },
    { type: 'PAWN', traits: ['EXPLOSIVE'], preferFront: true },
  ],
};

export const ALL_CAMPAIGN_ROOMS: readonly CampaignRoomTemplate[] = [
  ...CAMPAIGN_ROOMS,
  ...ACT2_CAMPAIGN_ROOMS,
  ...ACT3_CAMPAIGN_ROOMS,
  SECRET_ACT4_ROOM,
];

export const SKIRMISH_MAP_TEMPLATES: readonly SkirmishMapTemplate[] = [
  {
    id: 'twin-towers',
    name: 'İkiz Gözetleme Kuleleri',
    width: 8,
    height: 8,
    wallPairs: 3,
    icePairs: 2,
    pitPairs: 1,
    watchtowerPairs: 1,
  },
  {
    id: 'frozen-rift',
    name: 'Buzul Yarığı',
    width: 9,
    height: 8,
    wallPairs: 3,
    icePairs: 5,
    pitPairs: 2,
    watchtowerPairs: 1,
  },
  {
    id: 'citadel-crossroads',
    name: 'Kale Kavşağı',
    width: 9,
    height: 9,
    wallPairs: 5,
    icePairs: 3,
    pitPairs: 1,
    watchtowerPairs: 2,
  },
];

export function getCampaignRoomsForAct(act: 1 | 2 | 3 = 1): readonly CampaignRoomTemplate[] {
  if (act === 2) return ACT2_CAMPAIGN_ROOMS;
  if (act === 3) return ACT3_CAMPAIGN_ROOMS;
  return CAMPAIGN_ROOMS;
}

export function getCampaignRoomTemplate(
  roomIndex: number,
  act: 1 | 2 | 3 = 1,
): CampaignRoomTemplate {
  const rooms = getCampaignRoomsForAct(act);
  const clamped = Math.max(0, Math.min(rooms.length - 1, roomIndex));
  return rooms[clamped]!;
}

export function getCampaignRoomById(roomId: string): CampaignRoomTemplate | undefined {
  return ALL_CAMPAIGN_ROOMS.find((r) => r.id === roomId);
}

function deployUnitsInZone(
  tiles: readonly (readonly TileState[])[],
  width: number,
  backRowY: number,
  frontRowY: number,
  units: readonly {
    id: string;
    type: PieceType;
    traits: readonly TraitId[];
    isBoss?: boolean;
    preferFront?: boolean;
    extraShield?: boolean;
    aggro: 'SLEEPING' | 'ACTIVE';
    side: 'PLAYER' | 'ENEMY';
  }[],
  rngState: number,
): { pieces: Piece[]; nextRngState: number } {
  const backSlots: Coord[] = [];
  const frontSlots: Coord[] = [];

  for (let x = 0; x < width; x++) {
    if (isTileWalkable(tiles[backRowY]?.[x])) {
      backSlots.push({ x, y: backRowY });
    }
    if (frontRowY !== backRowY && isTileWalkable(tiles[frontRowY]?.[x])) {
      frontSlots.push({ x, y: frontRowY });
    }
  }

  let rng = rngState;
  const sBack = shuffle(rng, backSlots);
  rng = sBack.nextState;
  const sFront = shuffle(rng, frontSlots);
  rng = sFront.nextState;

  const remBack = sBack.value.slice();
  const remFront = sFront.value.slice();
  const centerX = (width - 1) / 2;

  const takeSlot = (preferFront: boolean, centerBias: boolean): Coord | null => {
    const primary = preferFront ? remFront : remBack;
    const secondary = preferFront ? remBack : remFront;
    const pool = primary.length > 0 ? primary : secondary;
    if (pool.length === 0) return null;

    if (centerBias) {
      let bestIdx = 0;
      let bestDist = Math.abs(pool[0]!.x - centerX);
      for (let i = 1; i < pool.length; i++) {
        const d = Math.abs(pool[i]!.x - centerX);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return pool.splice(bestIdx, 1)[0]!;
    }
    return pool.shift()!;
  };

  const pieces: Piece[] = [];

  // King placed first near center on back row
  const king = units.find((u) => u.type === 'KING');
  if (king !== undefined) {
    const slot = takeSlot(false, true);
    if (slot !== null) {
      pieces.push({
        id: king.id,
        side: king.side,
        type: king.type,
        pos: slot,
        traits: king.traits.slice(),
        shieldActive: king.traits.includes('SHIELDED') || king.extraShield === true,
        frozenTurns: 0,
        hasMoved: false,
        aggro: king.aggro,
        usedDashThisTurn: false,
        wasVisibleAtTurnStart: false,
        ...(king.isBoss ? { isBoss: true } : {}),
      });
    }
  }

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (u.type === 'KING') continue;
    const preferFront = u.preferFront ?? u.type === 'PAWN';
    const slot = takeSlot(preferFront, false);
    if (slot === null) continue;
    pieces.push({
      id: u.id,
      side: u.side,
      type: u.type,
      pos: slot,
      traits: u.traits.slice(),
      shieldActive: u.traits.includes('SHIELDED') || u.extraShield === true,
      frozenTurns: 0,
      hasMoved: false,
      aggro: u.aggro,
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: false,
      ...(u.isBoss ? { isBoss: true } : {}),
    });
  }

  return { pieces, nextRngState: rng };
}

export interface BuildCampaignEncounterInput {
  roomIndex: number;
  seed: string;
  roster: readonly RosterUnit[];
  playerFaction: FactionPassive;
  shieldAllNextBattle: boolean;
  activePacts: readonly CampaignPactEffect[];
  /** Optional Campaign Act (defaults to Act 1 for full backwards compatibility). */
  act?: 1 | 2 | 3;
  /** Optional explicit template override (used by buildCampaignEncounterById, e.g. act4-core). */
  templateOverride?: CampaignRoomTemplate;
}

export interface BuiltCampaignEncounter {
  template: CampaignRoomTemplate;
  state: GameState;
}

function applyV3DungeonFeatures(
  tiles: TileState[][],
  width: number,
  height: number,
  template: CampaignRoomTemplate,
  rngState: number,
): number {
  let rng = rngState;
  const platePairs = template.plateEmitterPairs ?? 0;
  const crackedCount = template.crackedCount ?? 0;
  const spikeCount = template.spikeCount ?? 0;
  const miasmaCount = template.miasmaCount ?? 0;

  // Helper to gather fresh shuffled middle-zone coords (y = 2 .. height - 3)
  const midCoords: Coord[] = [];
  for (let y = 2; y <= height - 3; y++) {
    for (let x = 0; x < width; x++) {
      midCoords.push({ x, y });
    }
  }
  const shuffled = shuffle(rng, midCoords);
  rng = shuffled.nextState;
  const candidates = shuffled.value.slice();

  // 1. Wired PRESSURE_PLATE -> ARROW_EMITTER pairs
  const usedEmitterRows = new Set<number>();
  for (let i = 0; i < platePairs; i++) {
    let rowY = -1;
    for (let y = 2; y <= height - 3; y++) {
      if (!usedEmitterRows.has(y)) {
        rowY = y;
        break;
      }
    }
    if (rowY === -1) break;
    usedEmitterRows.add(rowY);

    const fromLeft = i % 2 === 0;
    const emitterX = fromLeft ? 0 : width - 1;
    const dir: CardinalDir = fromLeft ? { dx: 1, dy: 0 } : { dx: -1, dy: 0 };
    const emitterId = `em_${template.id}_${i}`;
    const plateId = `pl_${template.id}_${i}`;
    // Second emitter in a room fires flaming arrows for Miasma chain combos!
    const flaming = i >= 1 || (template.miasmaCount ?? 0) >= 6;
    const emitterTile = createTile('WALL');
    emitterTile.trap = createArrowEmitterTrap(emitterId, dir, { flaming });
    tiles[rowY]![emitterX] = emitterTile;

    // Place corresponding PRESSURE_PLATE on a walkable PLAIN tile inside the mid zone (not on emitter)
    let platePlaced = false;
    for (let k = 0; k < candidates.length; k++) {
      const c = candidates[k]!;
      const t = tiles[c.y]![c.x]!;
      if (
        c.x > 0 &&
        c.x < width - 1 &&
        t.type === 'PLAIN' &&
        t.trap === undefined
      ) {
        t.trap = createPressurePlateTrap(plateId, [emitterId], 2);
        candidates.splice(k, 1);
        platePlaced = true;
        break;
      }
    }
    if (!platePlaced) {
      const fallbackX = Math.max(1, Math.min(width - 2, Math.floor(width / 2)));
      const fallbackY = Math.min(height - 3, Math.max(2, rowY === 2 ? 3 : rowY - 1));
      const ft = createTile('PLAIN');
      ft.trap = createPressurePlateTrap(plateId, [emitterId], 2);
      tiles[fallbackY]![fallbackX] = ft;
    }
  }

  // 2. CRACKED fragile tiles (avoid blocking already-trapped tiles)
  let placedCracked = 0;
  for (let k = 0; k < candidates.length && placedCracked < crackedCount; k++) {
    const c = candidates[k]!;
    const t = tiles[c.y]![c.x]!;
    if (t.type === 'PLAIN' && t.trap === undefined) {
      tiles[c.y]![c.x] = createTile('CRACKED');
      placedCracked++;
    }
  }

  // 3. Rhythmic SPIKES traps (staggered 0/1/2 phases)
  let placedSpikes = 0;
  for (let k = 0; k < candidates.length && placedSpikes < spikeCount; k++) {
    const c = candidates[k]!;
    const t = tiles[c.y]![c.x]!;
    if (t.type === 'PLAIN' && t.trap === undefined) {
      t.trap = createSpikesTrap(`sp_${template.id}_${placedSpikes}`, (placedSpikes % 3) as SpikePhase);
      placedSpikes++;
    }
  }

  // 4. MIASMA pockets (clustered 2-3 tile clouds for gas chain chemistry, never on WALL)
  let placedMiasma = 0;
  const orthoOffsets: readonly Coord[] = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  for (let k = 0; k < candidates.length && placedMiasma < miasmaCount; k++) {
    const c = candidates[k]!;
    const t = tiles[c.y]![c.x]!;
    if (t.type === 'WALL' || t.gas !== undefined) continue;
    t.gas = createMiasmaOverlay();
    placedMiasma++;

    // Try expanding 1 orthogonal neighbor to form a connected gas pocket
    for (let d = 0; d < orthoOffsets.length && placedMiasma < miasmaCount; d++) {
      const nx = c.x + orthoOffsets[d]!.x;
      const ny = c.y + orthoOffsets[d]!.y;
      if (nx < 0 || nx >= width || ny < 2 || ny > height - 3) continue;
      const nt = tiles[ny]![nx]!;
      if (nt.type !== 'WALL' && nt.gas === undefined) {
        nt.gas = createMiasmaOverlay();
        placedMiasma++;
        break;
      }
    }
  }

  return rng;
}

/**
 * Generates a deterministic, BFS-connectivity-verified Campaign room (Act 1, 2, 3, or Secret Act 4).
 * - Spawns enemies as SLEEPING (Campaign fairness rule).
 * - Applies active Pact traits to enemy Pawns and shieldAllNextBattle to player units.
 * - Enables the 3-turn Boss Ice/Fire ring on Boss rooms.
 * - Preserves bit-for-bit Act 1 determinism when V3 dungeon counts are omitted.
 */
export function buildCampaignEncounter(input: BuildCampaignEncounterInput): BuiltCampaignEncounter {
  const template =
    input.templateOverride ?? getCampaignRoomTemplate(input.roomIndex, input.act ?? 1);
  const { width, height } = template;
  const tiles = createEmptyTiles(width, height, 'PLAIN');
  let rng = seedToRngState(`${input.seed}::room:${template.roomIndex}:${template.id}`);

  // Collect middle-zone candidate tiles (y = 2 .. height - 3) so spawn zones stay open
  const midCoords: Coord[] = [];
  for (let y = 2; y <= height - 3; y++) {
    for (let x = 0; x < width; x++) {
      midCoords.push({ x, y });
    }
  }

  const shuffledMid = shuffle(rng, midCoords);
  rng = shuffledMid.nextState;
  const pool = shuffledMid.value.slice();

  const takeMidCoord = (): Coord | undefined => pool.shift();

  // 1. Guaranteed Watchtowers in tactical mid zone
  for (let i = 0; i < template.watchtowerCount; i++) {
    const c = takeMidCoord();
    if (c !== undefined) {
      tiles[c.y]![c.x] = createTile('WATCHTOWER');
    }
  }

  // 2. Ice tiles (clustered slightly into corridors when iceCount >= 6)
  let placedIce = 0;
  if (template.iceCount >= 6) {
    const laneRoll = nextInt(rng, 1, width - 2);
    rng = laneRoll.nextState;
    const laneX = laneRoll.value;
    for (let y = 2; y <= height - 3 && placedIce < Math.min(4, template.iceCount); y++) {
      if (tiles[y]![laneX]!.type === 'PLAIN') {
        tiles[y]![laneX] = createTile('ICE');
        placedIce++;
      }
    }
  }
  while (placedIce < template.iceCount) {
    const c = takeMidCoord();
    if (c === undefined) break;
    if (tiles[c.y]![c.x]!.type === 'PLAIN') {
      tiles[c.y]![c.x] = createTile('ICE');
      placedIce++;
    }
  }

  // 3. Walls (for Siege Wall room, form a mid-row bastion with natural gaps)
  let placedWalls = 0;
  if (template.id === 'siege-wall' || template.isBoss) {
    const midY = Math.floor(height / 2);
    for (let x = 1; x < width - 1 && placedWalls < Math.min(5, template.wallCount); x++) {
      if (x === Math.floor(width / 2)) continue; // central gap
      if (tiles[midY]![x]!.type === 'PLAIN') {
        tiles[midY]![x] = createTile('WALL');
        placedWalls++;
      }
    }
  }
  while (placedWalls < template.wallCount) {
    const c = takeMidCoord();
    if (c === undefined) break;
    if (tiles[c.y]![c.x]!.type === 'PLAIN') {
      tiles[c.y]![c.x] = createTile('WALL');
      placedWalls++;
    }
  }

  // 4. Pits (avoid directly blocking center column)
  let placedPits = 0;
  while (placedPits < template.pitCount) {
    const c = takeMidCoord();
    if (c === undefined) break;
    if (tiles[c.y]![c.x]!.type === 'PLAIN' && c.x !== Math.floor(width / 2)) {
      tiles[c.y]![c.x] = createTile('PIT');
      placedPits++;
    }
  }

  // 5. V3 Dungeon Chemistry features (ONLY invoked for Act 2–4 rooms so Act 1 RNG is untouched!)
  const hasV3Features =
    (template.miasmaCount ?? 0) > 0 ||
    (template.crackedCount ?? 0) > 0 ||
    (template.spikeCount ?? 0) > 0 ||
    (template.plateEmitterPairs ?? 0) > 0;
  if (hasV3Features) {
    rng = applyV3DungeonFeatures(tiles, width, height, template, rng);
  }

  // Build player & enemy unit deployment specs
  const playerSpecs = input.roster.map((u) => ({
    id: u.id,
    type: u.type,
    traits: u.traits,
    extraShield: input.shieldAllNextBattle,
    aggro: 'ACTIVE' as const,
    side: 'PLAYER' as const,
  }));

  const pactTraits: TraitId[] = input.activePacts
    .filter((p) => p.roomsRemaining > 0)
    .map((p) => p.trait);

  const enemySpecs = template.enemies.map((e, idx) => {
    const traits = e.traits.slice();
    if (e.type === 'PAWN') {
      for (let p = 0; p < pactTraits.length; p++) {
        const pt = pactTraits[p]!;
        if (!traits.includes(pt) && traits.length < MAX_TRAITS_PER_PIECE) {
          traits.push(pt);
        }
      }
    }
    return {
      id: e.type === 'KING' ? 'e_king' : `e_u${idx}`,
      type: e.type,
      traits,
      isBoss: e.isBoss,
      preferFront: e.preferFront,
      aggro: 'SLEEPING' as const,
      side: 'ENEMY' as const,
    };
  });

  const deployedPlayer = deployUnitsInZone(tiles, width, height - 1, height - 2, playerSpecs, rng);
  rng = deployedPlayer.nextRngState;

  const deployedEnemy = deployUnitsInZone(tiles, width, 0, 1, enemySpecs, rng);
  rng = deployedEnemy.nextRngState;

  const enemyKing = deployedEnemy.pieces.find((p) => p.type === 'KING');
  const playerCoords = deployedPlayer.pieces.map((p) => p.pos);
  const goalCoord: Coord = enemyKing?.pos ?? { x: Math.floor(width / 2), y: 0 };

  // Mandatory BFS softlock verification & automatic corridor carving if needed
  const verified = ensureMapConnectivity(tiles, playerCoords, goalCoord);

  const battleSeed =
    template.act !== undefined && template.act > 1
      ? `${input.seed}::battle:${template.id}`
      : `${input.seed}::battle:${template.roomIndex}`;

  const state = createGameState({
    width,
    height,
    tiles: verified.tiles,
    pieces: [...deployedPlayer.pieces, ...deployedEnemy.pieces],
    mode: 'CAMPAIGN',
    turn: 'PLAYER',
    factions: {
      PLAYER: input.playerFaction,
      ENEMY: template.enemyFaction,
    },
    seed: battleSeed,
    bossCooldown: template.isBoss ? 3 : 0,
  });

  return { template, state };
}

/**
 * Builds any Campaign room directly by its template ID (including Act 2–3 rooms and `act4-core`).
 */
export function buildCampaignEncounterById(
  roomId: string,
  input: Omit<BuildCampaignEncounterInput, 'roomIndex' | 'act' | 'templateOverride'>,
): BuiltCampaignEncounter {
  const template = getCampaignRoomById(roomId) ?? CAMPAIGN_ROOMS[0]!;
  return buildCampaignEncounter({
    ...input,
    roomIndex: template.roomIndex,
    templateOverride: template,
  });
}

/**
 * Generates a point-symmetric, BFS-verified Skirmish map for Best-of-3 rounds (used in Faz 6).
 */
export function generateSkirmishMap(
  roundIndex: number,
  seed: string,
): { template: SkirmishMapTemplate; tiles: TileState[][]; width: number; height: number } {
  const template = SKIRMISH_MAP_TEMPLATES[roundIndex % SKIRMISH_MAP_TEMPLATES.length]!;
  const { width, height } = template;
  const tiles = createEmptyTiles(width, height, 'PLAIN');
  let rng = seedToRngState(`${seed}::skirmish-map:${roundIndex}`);

  // Pick from top-half middle rows (y = 2 .. floor((height-1)/2)) and mirror rotationally
  const halfCoords: Coord[] = [];
  const maxHalfY = Math.floor((height - 1) / 2);
  for (let y = 2; y <= maxHalfY; y++) {
    for (let x = 0; x < width; x++) {
      if (y === maxHalfY && height % 2 === 1 && x >= Math.ceil(width / 2)) continue;
      halfCoords.push({ x, y });
    }
  }

  const shuffled = shuffle(rng, halfCoords);
  rng = shuffled.nextState;
  const pool = shuffled.value.slice();

  const placeMirrorPair = (type: 'WATCHTOWER' | 'WALL' | 'ICE' | 'PIT'): void => {
    const c = pool.shift();
    if (c === undefined) return;
    const mx = width - 1 - c.x;
    const my = height - 1 - c.y;
    tiles[c.y]![c.x] = createTile(type);
    tiles[my]![mx] = createTile(type);
  };

  for (let i = 0; i < template.watchtowerPairs; i++) placeMirrorPair('WATCHTOWER');
  for (let i = 0; i < template.icePairs; i++) placeMirrorPair('ICE');
  for (let i = 0; i < template.wallPairs; i++) placeMirrorPair('WALL');
  for (let i = 0; i < template.pitPairs; i++) placeMirrorPair('PIT');

  const centerX = Math.floor(width / 2);
  const ensured = ensureMapConnectivity(
    tiles,
    [{ x: centerX, y: height - 1 }],
    { x: centerX, y: 0 },
  );

  return {
    template,
    tiles: ensured.tiles,
    width,
    height,
  };
}

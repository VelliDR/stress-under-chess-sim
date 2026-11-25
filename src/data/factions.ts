import { FactionPassive } from '../engine/types';

export interface FactionDefinition {
  id: FactionPassive;
  name: string;
  shortDesc: string;
  detailedDesc: string;
  accentColor: string;
}

export const FACTION_DEFINITIONS: Readonly<Record<FactionPassive, FactionDefinition>> = {
  NONE: {
    id: 'NONE',
    name: 'Pasif Yok',
    shortDesc: 'Standart kurallar',
    detailedDesc: 'Ek fraksiyon pasifi olmadan temel satranç ve arazi kurallarıyla savaşır.',
    accentColor: '#94a3b8',
  },
  FROST_WARDENS: {
    id: 'FROST_WARDENS',
    name: 'Buzul Muhafızları',
    shortDesc: 'Buzda kaymazlar',
    detailedDesc:
      'Tüm birimler ICE (Buz) karelerinde kontrolü kaybetmeden tam hedef karesinde durur; buz koridorlarını güvenle kullanabilirler.',
    accentColor: '#38bdf8',
  },
  NECROMANCERS: {
    id: 'NECROMANCERS',
    name: 'Nekromanserler',
    shortDesc: 'Ölen birim 2 turda İskelet doğurur',
    detailedDesc:
      'Şah dışındaki her ölen birim, yürünebilir ölüm karesinde 2 turluk bir işaret bırakır; süre dolduğunda kare boşsa orada 1 İskelet Piyon doğar.',
    accentColor: '#34d399',
  },
  SIEGE_ENGINEERS: {
    id: 'SIEGE_ENGINEERS',
    name: 'Kuşatma Mühendisleri',
    shortDesc: 'Kaleler bitişik duvarları kırar',
    detailedDesc:
      'Kaleler aktif yetenek (BREAK_WALL) ile ortogonal bitişiğindeki bir WALL karesini yıkıp PLAIN yapar (yeni görüş hattı ve geçit açar).',
    accentColor: '#f59e0b',
  },
  RAIDERS: {
    id: 'RAIDERS',
    name: 'Akıncılar',
    shortDesc: 'Atlar otomatik Pusu kazanır',
    detailedDesc:
      'Tüm Atlar otomatik olarak DASH_ON_REVEAL (Pusu) özelliğine sahiptir; karanlıktan rakibin görüşüne çıktıkları tur 1 ekstra hamle kazanırlar.',
    accentColor: '#c084fc',
  },
};

export const PLAYABLE_FACTIONS: readonly Exclude<FactionPassive, 'NONE'>[] = [
  'FROST_WARDENS',
  'NECROMANCERS',
  'SIEGE_ENGINEERS',
  'RAIDERS',
];

export const ALL_FACTIONS: readonly FactionPassive[] = [
  'NONE',
  ...PLAYABLE_FACTIONS,
];

export function getFactionDefinition(id: FactionPassive): FactionDefinition {
  return FACTION_DEFINITIONS[id];
}

import {
  PieceType,
  RosterUnit,
  SCOUT_PAWN_COST,
  TraitId,
  UNIT_COSTS,
} from '../engine/types';

export interface StarterSquadDefinition {
  id: string;
  name: string;
  tagline: string;
  description: string;
  units: readonly { type: PieceType; traits: readonly TraitId[] }[];
}

export interface SkirmishCatalogEntry {
  id: string;
  label: string;
  type: Exclude<PieceType, 'KING'>;
  traits: readonly TraitId[];
  cost: number;
  summary: string;
}

export const STARTER_SQUADS: readonly StarterSquadDefinition[] = [
  {
    id: 'recon-squad',
    name: 'Keşif Mangası',
    tagline: 'Yüksek Görüş & Hızlı Kuşatma',
    description:
      'Gözcü Piyonlarla savaş sisini erkenden açar, çift At ile duvarların ve çukurların üstünden pusu kurar.',
    units: [
      { type: 'KING', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'] },
      { type: 'PAWN', traits: ['SCOUT'] },
    ],
  },
  {
    id: 'siege-corps',
    name: 'Kuşatma Birliği',
    tagline: 'Zırhlı Hat & Dayanıklı Cephe',
    description:
      'Zırhlı Kale öncülüğünde güvenli cephe kurar; Fil ve 3 Piyon ile istikrarlı ilerleyiş sağlar.',
    units: [
      { type: 'KING', traits: [] },
      { type: 'ROOK', traits: ['SHIELDED'] },
      { type: 'BISHOP', traits: [] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: [] },
    ],
  },
  {
    id: 'assassins',
    name: 'Suikastçılar',
    tagline: 'Elit Vezir & Gölge Öncü',
    description:
      'Küçük ama ölümcül manga: Vezir tüm hatları tehdit ederken Gölge Piyon silüet bırakmadan yaklaşır.',
    units: [
      { type: 'KING', traits: [] },
      { type: 'QUEEN', traits: [] },
      { type: 'PAWN', traits: ['SHADOW_WALKER'] },
    ],
  },
];

export const V3_STARTER_SQUADS: readonly StarterSquadDefinition[] = [
  {
    id: 'cult-and-beast',
    name: 'Kült ve Canavar',
    tagline: 'Ocaklı Arınması & Meczup Cinneti',
    description:
      'Ocaklı (7×7 arınma + 2 tur susturma) ve Meczup (zırh delme + kanlı cinnet) eşliğinde psikolojik baskıyı silaha dönüştürür.',
    units: [
      { type: 'KING', traits: [] },
      { type: 'SAINT_FAITH', traits: [] },
      { type: 'SAINT_MADNESS', traits: [] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: ['SCOUT'] },
    ],
  },
];

export const ALL_STARTER_SQUADS: readonly StarterSquadDefinition[] = [
  ...STARTER_SQUADS,
  ...V3_STARTER_SQUADS,
];

export const SKIRMISH_UNIT_CATALOG: readonly SkirmishCatalogEntry[] = [
  {
    id: 'pawn',
    label: 'Piyon',
    type: 'PAWN',
    traits: [],
    cost: UNIT_COSTS.PAWN,
    summary: 'Ucuz ön hat birimi, son sırada Vezir olur.',
  },
  {
    id: 'scout-pawn',
    label: 'Gözcü Piyon',
    type: 'PAWN',
    traits: ['SCOUT'],
    cost: SCOUT_PAWN_COST,
    summary: 'SCOUT (+2 görüş) ile sisi erkenden yarar.',
  },
  {
    id: 'knight',
    label: 'At',
    type: 'KNIGHT',
    traits: [],
    cost: UNIT_COSTS.KNIGHT,
    summary: 'Duvar ve çukurlardan atlar, buzda kaymaz.',
  },
  {
    id: 'bishop',
    label: 'Fil',
    type: 'BISHOP',
    traits: [],
    cost: UNIT_COSTS.BISHOP,
    summary: 'Uzun çapraz kontrol ve yüksek görüş (3).',
  },
  {
    id: 'rook',
    label: 'Kale',
    type: 'ROOK',
    traits: [],
    cost: UNIT_COSTS.ROOK,
    summary: 'Güçlü dikey/yatay baskı ve kuşatma hattı.',
  },
  {
    id: 'queen',
    label: 'Vezir',
    type: 'QUEEN',
    traits: [],
    cost: UNIT_COSTS.QUEEN,
    summary: 'Her yöne kayabilen en güçlü saldırı taşı.',
  },
];

export const V3_SKIRMISH_UNIT_CATALOG: readonly SkirmishCatalogEntry[] = [
  {
    id: 'saint-faith',
    label: 'Ocaklı',
    type: 'SAINT_FAITH',
    traits: [],
    cost: UNIT_COSTS.SAINT_FAITH,
    summary: '2× Şah hareketi; 5×5 moral aurası, 3 turda Kalkan + 7×7 arınma ve 2 tur düşman susturma.',
  },
  {
    id: 'saint-madness',
    label: 'Meczup',
    type: 'SAINT_MADNESS',
    traits: [],
    cost: UNIT_COSTS.SAINT_MADNESS,
    summary: '2× Şah hareketi; 5×5 +1 menzil & zırh delme aurası, 3 turda Kanlı Cinnet (zincir + savurma).',
  },
  {
    id: 'chimera',
    label: 'Gulyabani',
    type: 'CHIMERA',
    traits: [],
    cost: UNIT_COSTS.CHIMERA,
    summary: '3× Şah hareketi; Efsun Tutmaz (tam debuff bağışıklığı) + 2 yuvalı FIFO kılık çalma evrimi.',
  },
];

export const ALL_SKIRMISH_UNIT_CATALOG: readonly SkirmishCatalogEntry[] = [
  ...SKIRMISH_UNIT_CATALOG,
  ...V3_SKIRMISH_UNIT_CATALOG,
];

export function getStarterSquad(id: string): StarterSquadDefinition {
  return ALL_STARTER_SQUADS.find((s) => s.id === id) ?? ALL_STARTER_SQUADS[0]!;
}

export function buildRosterFromSquad(squad: StarterSquadDefinition): RosterUnit[] {
  return squad.units.map((u, idx) => ({
    id: u.type === 'KING' ? 'p_king' : `p_u${idx}`,
    type: u.type,
    traits: u.traits.slice(),
  }));
}

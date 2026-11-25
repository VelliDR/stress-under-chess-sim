// src/render/pieceSprites24.ts
// S.U.C.S. — 24x24 Taş Seti (Klasik 6 + Boss + Ocaklı, Meczup, Gulyabani) ve 7x7 Durum Rozetleri
// Her matris sıkı biçimde 24x24 (veya rozetler 7x7) boyutundadır ve SpriteCache tarafından 1x pişirilir.

import type { PieceType, Side, TraitId } from '../engine/types';
import type {
  BadgeKind,
  PaletteMap,
  PieceSpriteSpec,
  RenderTheme,
} from './spriteCache';

export const TEAM_ACCENT_BY_THEME: Readonly<Record<RenderTheme, Readonly<Record<Side, string>>>> = {
  default: {
    PLAYER: '#38bdf8',
    ENEMY: '#ef4444',
  },
  crt: {
    PLAYER: '#4ade80',
    ENEMY: '#fb7185',
  },
};

export const TEAM_SHADES_BY_THEME: Readonly<
  Record<RenderTheme, Readonly<Record<Side, { light: string; dark: string; deep: string }>>>
> = {
  default: {
    PLAYER: { light: '#e0f2fe', dark: '#2563eb', deep: '#1e3a8a' },
    ENEMY: { light: '#fecaca', dark: '#991b1b', deep: '#450a0a' },
  },
  crt: {
    PLAYER: { light: '#dcfce7', dark: '#15803d', deep: '#052e16' },
    ENEMY: { light: '#ffe4e6', dark: '#be123c', deep: '#4c0519' },
  },
};

export const GUISE_SLOT_COLORS: Readonly<Record<Exclude<PieceType, 'CHIMERA'> | 'EMPTY', string>> = {
  EMPTY: '#1f2937',
  PAWN: '#94a3b8',
  KNIGHT: '#38bdf8',
  BISHOP: '#c084fc',
  ROOK: '#f97316',
  QUEEN: '#facc15',
  KING: '#fb7185',
  SAINT_FAITH: '#0ea5e9',
  SAINT_MADNESS: '#f43f5e',
};

/**
 * 24x24 Taş Silüet Matrisleri (Sıfır Mixel için 32x32 karenin (4, 2) ofsetine 1:1 oturur).
 */
export const PIECE_SPRITES_24: Readonly<Record<PieceType | 'BOSS_KING', readonly string[]>> = {
  KING: [
    '..........OOOO..........',
    '..........OGGO..........',
    '........OOGHHGOO........',
    '........OGHHHHGO........',
    '........OOGHHGOO........',
    '.........OOGGOO.........',
    '......OOOOHLLOOOO.......',
    '.....OGGGLLLLLLGGO......',
    '....OGHHLLLLLMMMGGO.....',
    '....OHHLLCCMMCCMMDO.....',
    '.....OOLLLLMMMMDOO......',
    '......OOGGGGGGGDO.......',
    '.......OHLLLLMMDO.......',
    '.......OLLLLMMMDO.......',
    '......OHLLLLLLMMDO......',
    '......OLLLLLMMMMDO......',
    '.....OHLLLLLLMMMDO......',
    '.....OLLLLLLMMMMDDO.....',
    '....OHLLLLLLMMMMDDDO....',
    '....OOGGGGGGGGGGGDDO....',
    '...OOTTTTTTTTTTTTTTDO...',
    '..OBBBBBBBBBBBBBBBBBBO..',
    '..OBBBBBBBBBBBBBBBBBBO..',
    '...OOOOOOOOOOOOOOOOOO...',
  ],

  BOSS_KING: [
    '.OOO......OOOO......OOO.',
    'OGGGO.....OGGO.....OGDDO',
    '.OGGGO..OOGHHGOO..OGDDO.',
    '..OGGGO.OGHHHHGO.OGDDO..',
    '...OOGGOOOGGGGOOOGGOO...',
    '....OOHLLGGGGGGLLMOO....',
    '...OHHLLLLLLLLLLMMMDO...',
    '..OHHLLCCLLLLLLCCMMMDO..',
    '..OHLLCCCCLLLLCCCCMMDO..',
    '...OOLLLLLLLLLLMMMDOO...',
    '....OOGGGCCCCCCGGDDO....',
    '.....OHLLLLLLLLMMDO.....',
    '.....OLLLLLLLLMMMDO.....',
    '....OHLLLLLLLLLMMMDO....',
    '....OLLLLLMMMMMDDDDO....',
    '...OHLLLLLMMMMMMDDDDO...',
    '...OLLLLMMMMMMMMDDDDO...',
    '..OHLLLLGGGGGGGGMMMDDDO.',
    '..OOGGGGGGGGGGGGGGGGDDO.',
    '..OTTTTTTTTTTTTTTTTTTDO.',
    '..OBBDDDDDDDDDDDDDDBBBO.',
    '.OBBBBBBBBBBBBBBBBBBBBO.',
    '.OBBBBBBBBBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOOOOOOOOOO..',
  ],

  QUEEN: [
    '..........OOOO..........',
    '..OO......OHGO......OO..',
    '.OGGO..OO.OHLO.OO..OGDO.',
    '.OGHO.OGHOOHLOOHDO.OMDO.',
    '..OGHOOHHOOHHOOHDOOMDO..',
    '..OOHLOHLOOHLOOLDOOMDO..',
    '...OHLLLHLLLLLLMMMDOO...',
    '...OHLLLLCCMMCCMMMDO....',
    '....OGGGGGGGGGGGDDO.....',
    '.....OHLLLLLLMMMDO......',
    '......OLLLLLMMMDO.......',
    '......OHLLLLMMDOO.......',
    '.....OHLLLLLLMMDO.......',
    '.....OLLLLLLMMMDO.......',
    '....OHLLLLLLLMMMDO......',
    '....OLLLLLLMMMMDDO......',
    '...OHLLLLLLMMMMDDDO.....',
    '...OLLLLLLMMMMMDDDDO....',
    '...OGGGGGGGGGGGGGDDO....',
    '...OLLLLLLMMMMMDDDDO....',
    '..OOTTTTTTTTTTTTTTDOO...',
    '..OBBBBBBBBBBBBBBBBBO...',
    '..OBBBBBBBBBBBBBBBBBO...',
    '...OOOOOOOOOOOOOOOOO....',
  ],

  ROOK: [
    '........................',
    '..OOOO...OOOOOO...OOOO..',
    '..OHLO...OHLLMO...OMDO..',
    '..OHLLO..OHLLMO..OMMDO..',
    '..OHLLLOOOHLLLOOOMMMDO..',
    '..OHLLLLLLLLLLLLMMMMDO..',
    '..OHLLLLLLLLLLLLMMMMDO..',
    '...OOOOOOOOOOOOOOOOOO...',
    '....OHLLLLLLLLLMMMDO....',
    '....OHLLLCCMMCCMMMDO....',
    '....OHLLLCCMMCCMMMDO....',
    '....OLLLLLLLLLMMMMDO....',
    '....OLLLLLLMMMMMDDDO....',
    '....OLLLLLLMMMMMDDDO....',
    '...OHLLLLLLLMMMMDDDO....',
    '...OHLLLLLLLMMMMDDDDO...',
    '...OLLLLLLLLMMMMDDDDO...',
    '...OGGGGGGGGGGGGGGDDO...',
    '...OHLLLLLLLLMMMMDDDO...',
    '...OOTTTTTTTTTTTTTDDO...',
    '..OOBBBBBBBBBBBBBBBBOO..',
    '..OBBBBBBBBBBBBBBBBBBO..',
    '..OBBBBBBBBBBBBBBBBBBO..',
    '...OOOOOOOOOOOOOOOOOO...',
  ],

  BISHOP: [
    '..........OOOO..........',
    '.........OGHHGO.........',
    '.........OGHHGO.........',
    '..........OOOO..........',
    '.......OOOHLLOOO........',
    '......OHHLLLLMMOO.......',
    '.....OHLLLLOOOMMDO......',
    '....OHLLLLO.OOMMMDO.....',
    '....OHLLLO...OMMMDO.....',
    '....OHLLLOHLOMMMMDO.....',
    '....OHLLLCCCCMMMMDO.....',
    '.....OLLLLLLMMMMDO......',
    '......OOLLLLMMDOO.......',
    '.....OOGGGGGGGGGOO......',
    '......OHLLLLMMDOO.......',
    '.....OHLLLLLLMMDO.......',
    '.....OLLLLLLMMMDO.......',
    '....OHLLLLLLLMMMDO......',
    '....OLLLLLLMMMMDDDO.....',
    '...OOTTTTTTTTTTTTDOO....',
    '...OBBBBBBBBBBBBBBBO....',
    '..OBBBBBBBBBBBBBBBBBO...',
    '..OBBBBBBBBBBBBBBBBBO...',
    '...OOOOOOOOOOOOOOOOO....',
  ],

  KNIGHT: [
    '........OOOOOO..........',
    '......OOHHLLLMO.........',
    '.....OHHHLLLLMMOO.......',
    '....OHHLLLLLLLLMMOO.....',
    '...OHHLLLOCCLLLLMMDO....',
    '..OHHLLLLOOLLLLLLMMDO...',
    '..OHLLLLLLLLLLLMMMDOO...',
    '..OLLLLMMMMOOOOMMMMDO...',
    '...OMMMMDDDO..OHMMMDO...',
    '....OOOOOOO...OHLLLMO...',
    '.............OOHLLMMO...',
    '...........OOHLLLLMMO...',
    '.........OOHHLLLLMMDO...',
    '........OHHHLLLLMMMDO...',
    '.......OHHHLLLLLMMMDO...',
    '......OHHHLLLLLMMMDOO...',
    '......OLLLLLLLMMMMDDO...',
    '.....OOGGGGGGGGGGGDDO...',
    '.....OHLLLLLLMMMMDDDO...',
    '....OOTTTTTTTTTTTTTDO...',
    '...OBBBBBBBBBBBBBBBBBO..',
    '..OBBBBBBBBBBBBBBBBBBBO.',
    '..OBBBBBBBBBBBBBBBBBBBO.',
    '...OOOOOOOOOOOOOOOOOOO..',
  ],

  PAWN: [
    '........................',
    '........................',
    '........OOOOOOOO........',
    '......OOHHHLLLLOOO......',
    '.....OHHHLLLLLLMMOO.....',
    '....OHHHLLLLLLLLMMDO....',
    '....OHLLLLLLLLLLMMDO....',
    '....OLLLLLLLLLMMMMDO....',
    '.....OOLLLLLLMMMDOO.....',
    '.......OOLLLLMMOO.......',
    '.....OOGGGGGGGGGGO......',
    '......OHLLLLLLMMO.......',
    '......OHLLLLLMMDO.......',
    '.....OHLLLLLLMMDO.......',
    '.....OLLLLLLMMMDO.......',
    '....OHLLLLLLMMMDDDO.....',
    '....OLLLLLLMMMMDDDO.....',
    '...OHLLLLLLMMMMDDDDO....',
    '...OLLLLLLMMMMMDDDDO....',
    '...OOTTTTTTTTTTTTDOO....',
    '..OOBBBBBBBBBBBBBBBOO...',
    '..OBBBBBBBBBBBBBBBBBO...',
    '..OBBBBBBBBBBBBBBBBBO...',
    '...OOOOOOOOOOOOOOOOO....',
  ],

  /**
   * Ocaklı: Beyaz keçe başlık/yazma, çan pelerin, altın çerçeveli belirgin Nazar Boncuğu,
   * sağ elde turkuaz dumanı tüten pirinç üzerlik tütsü kabı.
   */
  SAINT_FAITH: [
    '......OOOOOOOOOO........',
    '.....OHHHHHHHHHHO.......',
    '....OHLLLLLLLLLLMO......',
    '....OHLLLLLLLLLLMO..U...',
    '....OOGGGGGGGGGGOO...U..',
    '.....OOHLLLLLLMMO..UU...',
    '.....OHLLCCLLCCMO..U.U..',
    '......OLLLLLLLMO...U....',
    '......OOGGGGGGOO..OGGO..',
    '....OOHLLGGGGMMOO.OUGO..',
    '...OHHLLGNNNNGMMOOGGGGO.',
    '...OHLLGNHHHNNGMMOGGGGO.',
    '..OHLLLGNWPPNWGMMDOGGGO.',
    '..OHLLLGNWPPNWGMMDOOOOO.',
    '..OHLLLGNHHHNNGMMDO.....',
    '..OLLLLLGNNNNGMMMDO.....',
    '..OLLLLLLGGGGMMMMDO.....',
    '...OHLLLLLLLLMMMDO......',
    '...OLLLLLLLLMMMMDDO.....',
    '...OGGGGGGGGGGGGGDO.....',
    '...OTTTTTTTTTTTTTTDO....',
    '..OBBBBBBBBBBBBBBBBBO...',
    '..OBBBBBBBBBBBBBBBBBO...',
    '...OOOOOOOOOOOOOOOOO....',
  ],

  /**
   * Meczup: Yırtık koyu kepenek, gölge altında tek parlayan neon kızıl göz,
   * sol kolda kopuk demir zincir, sağ elde çatlak ahşap-deri Deli Davulu.
   */
  SAINT_MADNESS: [
    '.......OOOOOOOOO........',
    '......OOMMMMMMMOO.......',
    '.....OHMMMMMMMMDDO......',
    '....OHLMMKKKKKKMDDO.....',
    '....OMMMKKKKKKKKMDO.....',
    '....OMMKKKKECKKKMDO.....',
    '....OMMKKKKCCKKKMDO.....',
    '.....ODMMKKKKKKMDO......',
    '.....OOMMMMMMMMMOO......',
    '..OO.OHLLMMMMMMMOO.OOOO.',
    '.OSIOOHLLMMMMMMMDOWGGGGW',
    '.OIO.OHLMMMMMMMDDWSSSSKW',
    '.OSIOOLMMMMMMMMDDWSSKSSW',
    '.OIO.OMMMMMMMMDDDWKSSSSW',
    '..O..OHLMMMMMMDDOWGGGGW.',
    '.....OMMMMMMMMMDO.OOOO..',
    '....OHLMDDMMDDDDO.......',
    '....OLMDOOMMDOODO.......',
    '....OMDO..OMDO..........',
    '....OOOO..OOOO..........',
    '...OOTTTTTTTTTTTTDO.....',
    '..OBBBBBBBBBBBBBBBBBO...',
    '..OBBBBBBBBBBBBBBBBBO...',
    '...OOOOOOOOOOOOOOOOO....',
  ],

  /**
   * Gulyabani: Geniş omuzlu kambur yosun-obsidyen silüet, kemik boynuz ve pençeler,
   * iki kehribar göz ve tabanda 2 dinamik kılık yuvası ('1' / '2').
   */
  CHIMERA: [
    '.OOO....OOOOOO....OOO...',
    'OGGGO..OHLLMMDO..OGGGO..',
    '.OGGGOOHLCCCCMDOOGGGO...',
    '..OOGGOHLLMMMDDOOGGO....',
    '..OOHHLLLLLLLLMMMOOO....',
    '.OHLCCCCLLLLLLCCCCMDO...',
    'OHLLCCCCLLLLLLCCCCMMDO..',
    'OHLLLLLMMMMMMMMMMMMDDO..',
    '.OOHHLLLGGGGGGMMMMDDOO..',
    '..OHHLLLTGGGGGTMMMMDO...',
    '..OHLLLLTTTTTTTTMMMDO...',
    '.OHLLLLMMMMMMMMMMMMDDO..',
    '.OHLLMMMMMMMMMMMMMMMDO..',
    '.OKLLLMMMDDDDDDMMMMKDO..',
    '..OKKMMMDOOOOOOMMMKKDO..',
    '..OHLMDO........OMMDDO..',
    '..OGMDO..........OMDGO..',
    '..OOOO............OOOO..',
    '.OOOOO.OOTTTTTTTO.OOOOO.',
    '.O111O.OBBBBBBBBO.O222O.',
    '.O111O.OTTTTTTTTO.O222O.',
    '.O111OOBBBBBBBBBBOO222O.',
    '.OOOOOBBBBBBBBBBBBOOOOO.',
    '..OOOOOOOOOOOOOOOOOOOO..',
  ],
};

/**
 * 7x7 Durum ve Mutasyon Rozetleri (SpriteCache üzerinden 1:1 blittenir).
 */
export const BADGE_SPRITES_7: Readonly<Record<BadgeKind, PieceSpriteSpec>> = {
  NAZAR: {
    matrix: [
      '.OOOOO.',
      'OGGGGGO',
      'OGBBBGO',
      'OGWCWGO',
      'OGBBBGO',
      'OGGGGGO',
      '.OOOOO.',
    ],
    palette: {
      O: '#070a12',
      G: '#fbbf24',
      B: '#0284c7',
      W: '#f8fafc',
      C: '#1e3a8a',
    },
  },
  SHIELD: {
    matrix: [
      '.OOOOO.',
      'OHAAAOO',
      'OHAAADO',
      'OHAAADO',
      '.OAAAD.',
      '..OAD..',
      '...O...',
    ],
    palette: { O: '#070a12', A: '#38bdf8', H: '#e0f2fe', D: '#0369a1' },
  },
  /** Kırmızı düğüm mührü (Ocaklı susturması) */
  AGIZ_BAGLAMA: {
    matrix: [
      '.OOOOO.',
      'ODAAADO',
      'OAHHHAO',
      'OAHKHAO',
      'OAHHHAO',
      'ODAAADO',
      '.OOOOO.',
    ],
    palette: { O: '#070a12', D: '#450a0a', A: '#dc2626', H: '#fca5a5', K: '#fef2f2' },
  },
  CINNET: {
    matrix: [
      '...H...',
      '..HAH..',
      '.HAAAH.',
      'HAAHAAH',
      'OAADAAO',
      '.ODDDO.',
      '..OOO..',
    ],
    palette: { O: '#070a12', H: '#fef08a', A: '#f43f5e', D: '#991b1b' },
  },
  FROST_TOUCH: {
    matrix: [
      '...H...',
      '.H.A.H.',
      '..HAH..',
      'HAAAAAH',
      '..HAH..',
      '.H.A.H.',
      '...H...',
    ],
    palette: { O: '#070a12', H: '#ecfeff', A: '#67e8f9', D: '#0e7490' },
  },
  EXPLOSIVE: {
    matrix: [
      '....HH.',
      '...H...',
      '..OOOO.',
      '.OHAAO.',
      '.OAAADO',
      '.OADDDO',
      '..OOOO.',
    ],
    palette: { O: '#070a12', H: '#fef08a', A: '#fb923c', D: '#9a3412' },
  },
  SCOUT: {
    matrix: [
      '..OOO..',
      '.OHHHO.',
      'OHAOAHO',
      'OHAAAHO',
      '.OHHHO.',
      '..OOO..',
      '.......',
    ],
    palette: { O: '#070a12', H: '#fef9c3', A: '#facc15', D: '#a16207' },
  },
  SHADOW_WALKER: {
    matrix: [
      '..OOO..',
      '.OAAAO.',
      'OAHOHAO',
      'OAAAAAO',
      'OAADAAO',
      'OA.O.AO',
      '.......',
    ],
    palette: { O: '#070a12', H: '#f3e8ff', A: '#c084fc', D: '#6b21a8' },
  },
  PUSHER: {
    matrix: [
      '...OO..',
      '...OAO.',
      'OOOOHAO',
      'OHAAAAO',
      'OOOOHAO',
      '...OAO.',
      '...OO..',
    ],
    palette: { O: '#070a12', H: '#ffffff', A: '#d8b4fe', D: '#6d28d9' },
  },
  DASH_ON_REVEAL: {
    matrix: [
      '...OO..',
      '..OHO..',
      '.OHAO..',
      'OHAAOO.',
      '.OOAHO.',
      '..OHO..',
      '..OO...',
    ],
    palette: { O: '#070a12', H: '#ffffff', A: '#fde047', D: '#b45309' },
  },
  FROZEN: {
    matrix: [
      '...O...',
      '..OHO..',
      '.OHAAO.',
      'OHAAADO',
      '.OAAAD.',
      '..OAD..',
      '...O...',
    ],
    palette: { O: '#070a12', H: '#ffffff', A: '#bae6fd', D: '#0369a1' },
  },
};

export function traitToBadgeKind(trait: TraitId, pieceType?: PieceType): BadgeKind {
  switch (trait) {
    case 'SHIELDED':
      return pieceType === 'SAINT_FAITH' ? 'NAZAR' : 'SHIELD';
    case 'FROST_TOUCH':
      return 'FROST_TOUCH';
    case 'EXPLOSIVE':
      return 'EXPLOSIVE';
    case 'SCOUT':
      return 'SCOUT';
    case 'SHADOW_WALKER':
      return 'SHADOW_WALKER';
    case 'PUSHER':
      return 'PUSHER';
    case 'DASH_ON_REVEAL':
      return 'DASH_ON_REVEAL';
  }
}

/**
 * 24x24 taş spesifikasyonunu ve token paletini döndürür.
 */
export function getPieceSpec24(
  type: PieceType,
  theme: RenderTheme = 'default',
  isBoss = false,
): PieceSpriteSpec {
  const key = isBoss && type === 'KING' ? 'BOSS_KING' : type;
  const matrix = PIECE_SPRITES_24[key];

  if (key === 'BOSS_KING') {
    return {
      matrix,
      palette: {
        O: '#06040a',
        H: '#fef08a',
        L: theme === 'crt' ? '#fb7185' : '#e11d48',
        M: '#9f1239',
        D: '#581c87',
        B: '#1e0b36',
        T: 'TEAM',
        G: '#f59e0b',
        C: '#67e8f9',
      },
    };
  }

  if (type === 'SAINT_FAITH') {
    return {
      matrix,
      palette: {
        O: '#070a12',
        H: '#ffffff',
        L: '#f8fafc',
        M: '#cbd5e1',
        D: '#64748b',
        W: '#f8fafc',
        N: '#0284c7',
        P: '#1e3a8a',
        U: theme === 'crt' ? '#5eead4' : '#2dd4bf',
        B: 'TEAM_DEEP',
        T: 'TEAM',
        G: '#fbbf24',
        C: theme === 'crt' ? '#4ade80' : '#0284c7',
      },
    };
  }

  if (type === 'SAINT_MADNESS') {
    return {
      matrix,
      palette: {
        O: '#090d16',
        K: '#090d16',
        H: '#f5d0fe',
        L: '#c084fc',
        M: '#9333ea',
        D: '#581c87',
        B: 'TEAM_DEEP',
        T: 'TEAM',
        C: theme === 'crt' ? '#fde047' : '#f43f5e',
        E: '#fda4af',
        I: '#94a3b8',
        S: '#e7e5e4',
        W: '#78350f',
        G: '#b45309',
      },
    };
  }

  if (type === 'CHIMERA') {
    return {
      matrix,
      palette: {
        O: '#050b08',
        H: '#34d399',
        L: '#10b981',
        M: '#059669',
        D: '#064e3b',
        B: 'TEAM_DEEP',
        T: 'TEAM',
        G: '#fef3c7',
        K: '#fef3c7',
        C: '#f59e0b',
        '1': 'SLOT1',
        '2': 'SLOT2',
      },
    };
  }

  return {
    matrix,
    palette: {
      O: '#070a12',
      H: '#ffffff',
      L: 'TEAM_LIGHT',
      M: 'TEAM',
      D: 'TEAM_DARK',
      B: 'TEAM_DEEP',
      T: 'TEAM',
      G: '#facc15',
      C: '#fef08a',
    },
  };
}

/**
 * 7x7 durum veya mutasyon rozeti spesifikasyonunu döndürür.
 */
export function getBadgeSpec7(kind: BadgeKind, theme: RenderTheme = 'default'): PieceSpriteSpec {
  const base = BADGE_SPRITES_7[kind];
  if (theme === 'default') return base;
  if (kind === 'SHIELD') {
    return {
      matrix: base.matrix,
      palette: { O: '#070a12', A: '#4ade80', H: '#dcfce7', D: '#15803d' },
    };
  }
  return base;
}

/**
 * Dinamik takım ve kılık slot tokenlarını tek noktadan çözer (SpriteCache & fallback ortak kullanır).
 */
export function resolvePiecePalette24(
  palette: PaletteMap,
  side: Side,
  theme: RenderTheme,
  slot1Type?: Exclude<PieceType, 'CHIMERA'>,
  slot2Type?: Exclude<PieceType, 'CHIMERA'>,
): Record<string, string> {
  const teamMain = TEAM_ACCENT_BY_THEME[theme][side];
  const teamShades = TEAM_SHADES_BY_THEME[theme][side];
  const resolved: Record<string, string> = {};
  for (const [k, raw] of Object.entries(palette)) {
    if (raw === 'TEAM') resolved[k] = teamMain;
    else if (raw === 'TEAM_LIGHT') resolved[k] = teamShades.light;
    else if (raw === 'TEAM_DARK') resolved[k] = teamShades.dark;
    else if (raw === 'TEAM_DEEP') resolved[k] = teamShades.deep;
    else if (raw === 'SLOT1') resolved[k] = GUISE_SLOT_COLORS[slot1Type ?? 'EMPTY'];
    else if (raw === 'SLOT2') resolved[k] = GUISE_SLOT_COLORS[slot2Type ?? 'EMPTY'];
    else resolved[k] = raw;
  }
  return resolved;
}

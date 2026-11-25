import { PieceType, Side, TraitId } from '../engine/types';
import {
  BADGE_SPRITES_7,
  getBadgeSpec7,
  getPieceSpec24,
  PIECE_SPRITES_24,
} from './pieceSprites24';
import type { Surface2DContext } from './spriteCache';

export type PixelPalette = Readonly<{
  O: string; // Crisp dark pixel outline
  H: string; // Specular highlight
  L: string; // Primary light body
  M: string; // Midtone body
  D: string; // Shaded body
  B: string; // Deep base / pedestal shadow
  G: string; // Gold / brass trim
  C: string; // Energy core / eye / gem
}>;

export const PLAYER_PALETTE: PixelPalette = {
  O: '#070a12',
  H: '#ffffff',
  L: '#e0f2fe',
  M: '#93c5fd',
  D: '#2563eb',
  B: '#1e3a8a',
  G: '#facc15',
  C: '#0284c7',
};

export const ENEMY_PALETTE: PixelPalette = {
  O: '#09060b',
  H: '#fecaca',
  L: '#f87171',
  M: '#dc2626',
  D: '#991b1b',
  B: '#450a0a',
  G: '#fbbf24',
  C: '#fde047',
};

export const BOSS_PALETTE: PixelPalette = {
  O: '#06040a',
  H: '#fef08a',
  L: '#e11d48',
  M: '#9f1239',
  D: '#581c87',
  B: '#1e0b36',
  G: '#f59e0b',
  C: '#67e8f9',
};

export const SAINT_FAITH_PLAYER_PALETTE: PixelPalette = {
  O: '#070a12',
  H: '#ffffff',
  L: '#f8fafc',
  M: '#93c5fd',
  D: '#60a5fa',
  B: '#1e3a8a',
  G: '#fbbf24',
  C: '#38bdf8',
};

export const SAINT_FAITH_ENEMY_PALETTE: PixelPalette = {
  O: '#09060b',
  H: '#fffbeb',
  L: '#fef3c7',
  M: '#fca5a5',
  D: '#dc2626',
  B: '#450a0a',
  G: '#fbbf24',
  C: '#fde047',
};

export const SAINT_MADNESS_PLAYER_PALETTE: PixelPalette = {
  O: '#080510',
  H: '#f5d0fe',
  L: '#c084fc',
  M: '#9333ea',
  D: '#581c87',
  B: '#1e1b4b',
  G: '#f472b6',
  C: '#f43f5e',
};

export const SAINT_MADNESS_ENEMY_PALETTE: PixelPalette = {
  O: '#0a040d',
  H: '#fda4af',
  L: '#be123c',
  M: '#9333ea',
  D: '#4c1d95',
  B: '#2e0619',
  G: '#fb7185',
  C: '#f43f5e',
};

export const CHIMERA_PLAYER_PALETTE: PixelPalette = {
  O: '#040a08',
  H: '#6ee7b7',
  L: '#10b981',
  M: '#059669',
  D: '#064e3b',
  B: '#022c22',
  G: '#38bdf8',
  C: '#f59e0b',
};

export const CHIMERA_ENEMY_PALETTE: PixelPalette = {
  O: '#080406',
  H: '#34d399',
  L: '#065f46',
  M: '#064e3b',
  D: '#7f1d1d',
  B: '#270909',
  G: '#ef4444',
  C: '#f59e0b',
};

/**
 * Handcrafted 16x16 tactical pixel-art chess pieces (Shotgun King / Into the Breach inspired).
 * Every row is strictly 16 characters wide for crisp integer-grid rendering.
 */
export const PIECE_PIXEL_SPRITES: Readonly<Record<PieceType | 'BOSS_KING', readonly string[]>> = {
  KING: [
    '......OOOO......',
    '......OGGO......',
    '....OOGHGOOO....',
    '....OGHHHHGO....',
    '....OOGGGOOO....',
    '....OOHLLOOO....',
    '..OOHLLLLMMOO...',
    '.OHHHLLLLMMMDO..',
    '.OHLLLLCCMMMDO..',
    '..OOGGGGGGGDDO..',
    '...OHLLLLMMDO...',
    '....OLLLMMDO....',
    '...OHLLLLMMDO...',
    '..OHLLLLLLMMDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  BOSS_KING: [
    '.OO...OOOO...OO.',
    'OGGO..OGGO..OGDO',
    '.OGGOOGHHGOOGDO.',
    '..OOGGHHHHGGOO..',
    '..OOHLLGGLLMOO..',
    '.OHHLLLLLLMMMDO.',
    '.OHLLCCLLCCMMDO.',
    '..OLLLLLLMMMDO..',
    '..OOGGCCCCGDDO..',
    '...OHLLLLMMDO...',
    '...OLLLLMMMDO...',
    '..OHLLLLLLMMDO..',
    '..OGGGGGGGGGDO..',
    '.OBBDDDDDDDDBBO.',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  QUEEN: [
    '.......OO.......',
    '.OO...OHGO...OO.',
    'OHGO..OHLO..OGDO',
    '.OHLO.OHLO.OMDO.',
    '.OHLOOOHLOOOMDO.',
    '..OHLHLLLLMMDO..',
    '..OLLLLCCMMMDO..',
    '...OGGGGGGGDO...',
    '...OHLLLLMMDO...',
    '....OLLLLDDO....',
    '....OHLLMMDO....',
    '...OHLLLLMMDO...',
    '..OHLLLLLLMMDO..',
    '..OLLLMMMMDDDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  ROOK: [
    '................',
    '..OOO..OO..OOO..',
    '.OHLLOOHLOOMMDO.',
    '.OHLLOOHLOOMMDO.',
    '.OHLLLLLLLLMMDO.',
    '..OOOOOOOOOOOO..',
    '...OHLLLLMMDO...',
    '...OHLLCCMMDO...',
    '...OHLLCCMMDO...',
    '...OLLLLMMMDO...',
    '...OLLLLMMMDO...',
    '..OHLLLLLLMMDO..',
    '..OGGGGGGGGDDO..',
    '..OLLLLLLMMMDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  BISHOP: [
    '.......OO.......',
    '......OHGO......',
    '.....OHLLDO.....',
    '....OHLLOMDO....',
    '...OHLLOOOMDO...',
    '...OHLLOLLMMO...',
    '...OHLLCCMMDO...',
    '....OLLLLDDO....',
    '....OOGGGDDO....',
    '....OHLLMMDO....',
    '...OHLLLLMMDO...',
    '...OLLLLMMMDO...',
    '..OHLLLLLLMMDO..',
    '..OLLLLLLDDDDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  KNIGHT: [
    '......OOO.......',
    '.....OHLMO......',
    '....OHLLMMOO....',
    '...OHLLOCLLMO...',
    '..OHLLLLLLLMDO..',
    '..OHLLMMOLLMMO..',
    '..OMMDDOOOMMMO..',
    '...OOOO..OHMMO..',
    '........OHLLMO..',
    '......OOHLLMMO..',
    '.....OHLLLLMMO..',
    '....OHLLLLMMDO..',
    '...OHLLLLLMMDO..',
    '..OGGGGGGGGGDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  PAWN: [
    '................',
    '......OOOO......',
    '....OOHHLLOO....',
    '...OHHLLLLMMO...',
    '...OHLLLLLMMO...',
    '....OLLLLMMO....',
    '.....OLLMDO.....',
    '....OOGGGDDO....',
    '.....OHLMDO.....',
    '....OHLLMMDO....',
    '....OLLLLDDO....',
    '...OHLLLLMMDO...',
    '..OHLLLLLLMMDO..',
    '..OLLLLLMMMMDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  SAINT_FAITH: [
    '....OOOOOOOO....',
    '...OGGGGGGGGO...',
    '...OGO....OGO...',
    '....OOOHHOOO....',
    '....OHHLLMMO....',
    '....OHLCCMDO....',
    '.....OLLMDO.....',
    '...OOHLGGMMOO...',
    '..OHHLLGGMMMDO..',
    '..OHLLGGGGMMDO..',
    '..OHLLLGGMMMDO..',
    '..OHLLLGGMMMDO..',
    '..OHLLLLLMMMDO..',
    '..OLLLLMMMMDDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  SAINT_MADNESS: [
    '...OOOO..OOO....',
    '..OGGGO..OGGO...',
    '..OGO......OO...',
    '....OOOHHOOO..O.',
    '...OHLLLLMMO.OGO',
    '...OHLLCCMD.OGGO',
    '....OLLMDO..OGO.',
    '..OOHLMMDOOOOGO.',
    '.OHHLLMDDMMO.O..',
    '.OHLLMMCCMDDO...',
    '..OHLMMMDDOO....',
    '..OHLLMMMDDO....',
    '.OHLLMMOOMMDO...',
    '.OLLMDO..OMDDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],

  CHIMERA: [
    '.OO...OOOO...OO.',
    'OGGO.OHLLMO.OGGO',
    '.OGGOHLCCMDGGO..',
    '..OOHLLMMMDDO...',
    '.OOHHLLLLMMMOO..',
    'OHLCLLLLLLCLMDO.',
    'OHLLLLMMMMMMMDO.',
    '.OOHLLGGGGMMDO..',
    '..OHLLLLMMMMDO..',
    '..OHLLMMMMMDDO..',
    '.OHLLLMMMMMDDDO.',
    '.OHLLMMOOMMMDDO.',
    '.OLLMDO..OMMDDO.',
    '..OMDO....OMDO..',
    '.OBBBBBBBBBBBBO.',
    '..OOOOOOOOOOOO..',
  ],
};

/**
 * 8x8 pixel-art micro icons for traits, status effects, and hazards.
 * Palette keys: O = outline, A = primary accent, H = bright highlight, D = dark shade.
 */
export const MICRO_PIXEL_ICONS: Readonly<
  Record<TraitId | 'SKULL' | 'TOWER' | 'ALERT' | 'SLEEP_Z' | 'QUESTION' | 'SPAWN', readonly string[]>
> = {
  SHIELDED: [
    '.OOOOOO.',
    'OHAAAADO',
    'OHHAAADO',
    'OHAAADDO',
    '.OAAADO.',
    '.OAAADO.',
    '..OADO..',
    '...OO...',
  ],
  FROST_TOUCH: [
    '...HH...',
    '.H.AA.H.',
    '..HAAH..',
    'HAAAAAAH',
    '..HAAH..',
    '.H.AA.H.',
    '...HH...',
    '........',
  ],
  EXPLOSIVE: [
    '....HH..',
    '...H..H.',
    '..OOOO..',
    '.OHAADO.',
    '.OAAADO.',
    '.OADDDO.',
    '..OOOO..',
    '........',
  ],
  SCOUT: [
    '........',
    '..OOOO..',
    '.OHAAHO.',
    'OHAOOAHO',
    '.OHAAHO.',
    '..OOOO..',
    '........',
    '........',
  ],
  SHADOW_WALKER: [
    '..OOOO..',
    '.OAAAAO.',
    'OAHOOHAO',
    'OAAAAAAO',
    'OAAADAAO',
    'OAD..DAO',
    'O..OO..O',
    '........',
  ],
  PUSHER: [
    '....OO..',
    '....OAO.',
    'OOOOOHAO',
    'OHAAAAHO',
    'OOOOOHAO',
    '....OAO.',
    '....OO..',
    '........',
  ],
  DASH_ON_REVEAL: [
    '....OO..',
    '...OHO..',
    '..OHAO..',
    '.OHAAOO.',
    '..OOAHO.',
    '...OHO..',
    '..OHO...',
    '..OO....',
  ],
  SKULL: [
    '..OOOO..',
    '.OHHHHO.',
    'OHHOOHHO',
    'OHHAAHHO',
    '.OHHHHO.',
    '..OHOHO.',
    '..OOOOO.',
    '........',
  ],
  TOWER: [
    'O.OO.OO.',
    'OHAAHAHO',
    '.OHAAHO.',
    '..OAAO..',
    '..OAAO..',
    '.OHAADO.',
    'OAAAAAOO',
    'OOOOOOOO',
  ],
  ALERT: [
    '..OOOO..',
    '..OHHO..',
    '..OHAO..',
    '..OAAO..',
    '..OAAO..',
    '...OO...',
    '..OHHO..',
    '..OOOO..',
  ],
  SLEEP_Z: [
    'OOOOOOO.',
    'OHHHHHO.',
    '....OHO.',
    '...OHO..',
    '..OHO...',
    '.OHO....',
    'OHHHHHO.',
    'OOOOOOO.',
  ],
  QUESTION: [
    '.OOOOO..',
    'OHHHHHO.',
    'OHO..OHO',
    '...OHO..',
    '..OHO...',
    '..OOO...',
    '..OHO...',
    '..OOO...',
  ],
  SPAWN: [
    '..OOOO..',
    '.OAAAAO.',
    'OAOAAOAO',
    'OAAAAAAO',
    '.OAOAO..',
    '..OOOO..',
    '.H....H.',
    '........',
  ],
};

/**
 * 3-frame 16x16 animated pixel-art flame overlays for BURNING tiles.
 * Keys: O = ember glow, R = red-orange, Y = bright yellow, W = white-hot core.
 */
export const FLAME_PIXEL_FRAMES: readonly (readonly string[])[] = [
  [
    '................',
    '........W.......',
    '.......R........',
    '......RRY...R...',
    '.....RRYR..RY...',
    '....RYYYR..RR...',
    '...RYYWYR.RRY...',
    '...RYWWYRRYYR...',
    '..RRYWWYYYWYR...',
    '..RYYWWWWWWYR...',
    '..RYYWWWWWWYR...',
    '...RYYWWWWYR....',
    '...ORRRRRRRO....',
    '....OOOOOOO.....',
    '................',
    '................',
  ],
  [
    '................',
    '......Y.........',
    '.......R...Y....',
    '......RYR..R....',
    '....R.RYYR......',
    '....RRYYYR..R...',
    '...RYYWWYR.RY...',
    '..RRYWWWYRRYYR..',
    '..RYYWWWWYYWYR..',
    '..RYYWWWWWWYR...',
    '...RYYWWWWYYR...',
    '...RYYYWWYYR....',
    '...ORRRRRRRO....',
    '....OOOOOOO.....',
    '................',
    '................',
  ],
  [
    '................',
    '..........W.....',
    '.....Y....R.....',
    '......R..RY.....',
    '.....RYRRRYR....',
    '....RYYYRYYR....',
    '...RYYWWYRYR....',
    '...RYWWWYRYR....',
    '..RRYWWWWWWYR...',
    '..RYYWWWWWWYR...',
    '..RYYWWWWWYYR...',
    '...RYYWWWWYR....',
    '...ORRRRRRRO....',
    '....OOOOOOO.....',
    '................',
    '................',
  ],
];

/**
 * Deterministic fast hash for per-tile pixel-art stone micro-variation (no Math.random).
 */
export function tilePixelHash(x: number, y: number, salt = 0): number {
  let h = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519) ^ Math.imul(salt + 1, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Renders any ASCII pixel grid onto a 2D canvas using crisp snapped integer blocks (zero anti-alias blur).
 */
export function drawPixelGrid(
  ctx: CanvasRenderingContext2D,
  grid: readonly string[],
  palette: Readonly<Record<string, string>>,
  destX: number,
  destY: number,
  destW: number,
  destH: number,
): void {
  const rows = grid.length;
  if (rows === 0) return;
  const cols = grid[0]!.length;
  if (cols === 0) return;

  const cellW = destW / cols;
  const cellH = destH / rows;

  for (let r = 0; r < rows; r++) {
    const row = grid[r]!;
    const y0 = Math.floor(destY + r * cellH);
    const y1 = Math.floor(destY + (r + 1) * cellH);
    const h = Math.max(1, y1 - y0);

    let c = 0;
    while (c < cols) {
      const ch = row[c]!;
      const color = ch !== '.' && ch !== ' ' ? palette[ch] : undefined;
      if (color === undefined) {
        c++;
        continue;
      }
      // Run-length horizontal merge for faster canvas draws and zero vertical seams
      const startC = c;
      while (c < cols && row[c] === ch) c++;
      const x0 = Math.floor(destX + startC * cellW);
      const x1 = Math.floor(destX + c * cellW);
      const w = Math.max(1, x1 - x0);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, w, h);
    }
  }
}

/**
 * Returns the pixel palette for a piece based on side, boss flag, and specialized V3 unit type.
 */
export function getPiecePalette(
  side: Side,
  isBoss?: boolean,
  pieceType?: PieceType,
): PixelPalette {
  if (pieceType === 'SAINT_FAITH') {
    return side === 'PLAYER' ? SAINT_FAITH_PLAYER_PALETTE : SAINT_FAITH_ENEMY_PALETTE;
  }
  if (pieceType === 'SAINT_MADNESS') {
    return side === 'PLAYER' ? SAINT_MADNESS_PLAYER_PALETTE : SAINT_MADNESS_ENEMY_PALETTE;
  }
  if (pieceType === 'CHIMERA') {
    return side === 'PLAYER' ? CHIMERA_PLAYER_PALETTE : CHIMERA_ENEMY_PALETTE;
  }
  if (side === 'PLAYER') return PLAYER_PALETTE;
  return isBoss ? BOSS_PALETTE : ENEMY_PALETTE;
}

/**
 * Helper to draw a single logical pixel inside a 16x16 tile space cleanly without subpixel cracks.
 */
export function fillTilePixel(
  ctx: CanvasRenderingContext2D,
  tileX: number,
  tileY: number,
  tileSize: number,
  gx: number,
  gy: number,
  gw: number,
  gh: number,
  color: string,
): void {
  const step = tileSize / 16;
  const x0 = Math.floor(tileX + gx * step);
  const y0 = Math.floor(tileY + gy * step);
  const x1 = Math.floor(tileX + (gx + gw) * step);
  const y1 = Math.floor(tileY + (gy + gh) * step);
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
}

/**
 * Helper to draw a crisp pixel rectangle on a 32x32 logical tile grid (zero mixel seams).
 */
export function fillTilePixel32(
  ctx: Surface2DContext,
  tileX: number,
  tileY: number,
  tileSize: number,
  gx: number,
  gy: number,
  gw: number,
  gh: number,
  color: string,
): void {
  const step = tileSize / 32;
  const x0 = Math.floor(tileX + gx * step);
  const y0 = Math.floor(tileY + gy * step);
  const x1 = Math.floor(tileX + (gx + gw) * step);
  const y1 = Math.floor(tileY + (gy + gh) * step);
  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
}

/**
 * 3-frame 32x32 animated pixel-art flame overlays for BURNING tiles.
 * Keys: O = ember glow, R = red-orange, Y = bright yellow, W = white-hot core.
 */
export const FLAME_FRAMES_32: readonly (readonly string[])[] = [
  [
    '................................',
    '................W...............',
    '...............R................',
    '..............RRY...............',
    '.............RRYR.....R.........',
    '............RYYYR....RY.........',
    '........R...RYYWYR..RRY.........',
    '.......RY...RYWWYRRYYR..........',
    '......RYYR.RRYWWYYYWYR....R.....',
    '.....RYYYR.RYYWWWWWWYR...RY.....',
    '.....RYYWYRRYWWWWWWWYR..RRY.....',
    '....RRYWWWRYYWWWWWWWYR..RYYR....',
    '....RYYWWWWWWWWWWWWYYR..RYYR....',
    '...RRYWWWWWWWWWWWWWWYR.RYYYR....',
    '...RYYWWWWWWWWWWWWWWYRRYYWYR....',
    '..RRYWWWWWWWWWWWWWWWWYYWWWYR....',
    '..RYYWWWWWWWWWWWWWWWWWWWWWYR....',
    '..RYYWWWWWWWWWWWWWWWWWWWWWYYR...',
    '..RYYWWWWWWWWWWWWWWWWWWWWWYYR...',
    '...RYYWWWWWWWWWWWWWWWWWWWWYR....',
    '...ORRYWWWWWWWWWWWWWWWWWWYRRO...',
    '....ORRRYYWWWWWWWWWWWWYYRRRO....',
    '.....OORRRRYYYYYYYYYYRRRROO.....',
    '......OOOORRRRRRRRRRRROOOO......',
    '.......OOOOOOOOOOOOOOOOOO.......',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
  ],
  [
    '................................',
    '.............Y..................',
    '............R.........Y.........',
    '...........RYR.......R..........',
    '..........RYYR......RY..........',
    '.....R....RRYYYR...RYYR.........',
    '....RY....RYYWWYR..RYYR.........',
    '....RYR..RRYWWWYRRYYYR....Y.....',
    '...RYYR..RYYWWWWYYWYRR...R......',
    '...RYYWR.RYYWWWWWWWYR...RYR.....',
    '..RRYWWWRRYWWWWWWWWYR..RYYR.....',
    '..RYYWWWWYYWWWWWWWWYYR.RYYYR....',
    '..RYYWWWWWWWWWWWWWWYYRRYYWYR....',
    '...RYYWWWWWWWWWWWWWWWYYWWWYR....',
    '...RYYWWWWWWWWWWWWWWWWWWWWYR....',
    '..RRYWWWWWWWWWWWWWWWWWWWWWYYR...',
    '..RYYWWWWWWWWWWWWWWWWWWWWWYYR...',
    '..RYYWWWWWWWWWWWWWWWWWWWWWWYR...',
    '...RYYWWWWWWWWWWWWWWWWWWWWYYR...',
    '...ORRYWWWWWWWWWWWWWWWWWWYRRO...',
    '....ORRRYYWWWWWWWWWWWWYYRRRO....',
    '.....OORRRRYYYYYYYYYYRRRROO.....',
    '......OOOORRRRRRRRRRRROOOO......',
    '.......OOOOOOOOOOOOOOOOOO.......',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
  ],
  [
    '................................',
    '....................W...........',
    '...........Y........R...........',
    '..........R........RY...........',
    '.........RYR......RYYR..........',
    '........RYYYR....RYYYR..........',
    '........RYYWYR..RYYWYR....R.....',
    '....R...RYWWWYRRYYWWYR...RY.....',
    '...RYR..RRYWWWWWWWWYYR..RYYR....',
    '...RYYR.RYYWWWWWWWWYYR..RYYR....',
    '..RYYWYRRYWWWWWWWWWWYR.RYYYR....',
    '..RYYWWWWWWWWWWWWWWWYR.RYYWYR...',
    '..RRYWWWWWWWWWWWWWWWYYRYYWWYR...',
    '...RYYWWWWWWWWWWWWWWWWWWWWYYR...',
    '...RYYWWWWWWWWWWWWWWWWWWWWYYR...',
    '..RRYWWWWWWWWWWWWWWWWWWWWWYYR...',
    '..RYYWWWWWWWWWWWWWWWWWWWWWWYR...',
    '..RYYWWWWWWWWWWWWWWWWWWWWWYYR...',
    '...RYYWWWWWWWWWWWWWWWWWWWWYR....',
    '...ORRYWWWWWWWWWWWWWWWWWWYRRO...',
    '....ORRRYYWWWWWWWWWWWWYYRRRO....',
    '.....OORRRRYYYYYYYYYYRRRROO.....',
    '......OOOORRRRRRRRRRRROOOO......',
    '.......OOOOOOOOOOOOOOOOOO.......',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
    '................................',
  ],
];

export { BADGE_SPRITES_7, getBadgeSpec7, getPieceSpec24, PIECE_SPRITES_24 };

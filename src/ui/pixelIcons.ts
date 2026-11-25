// src/ui/pixelIcons.ts
// S.U.C.S. — 16x16 El Yapımı Piksel-Sanat SVG İkon Kütüphanesi (shape-rendering="crispEdges").
// Sıfır harici varlık, sıfır yumuşak eğri; tahtadaki piksel ağırlığıyla %100 tutarlı.

export type PixelIconName =
  | 'fullscreenEnter'
  | 'fullscreenExit'
  | 'soundOn'
  | 'soundOff'
  | 'pause'
  | 'codex'
  | 'settings'
  | 'log'
  | 'threat'
  | 'intent'
  | 'speed1x'
  | 'speed2x'
  | 'lab'
  | 'skull'
  | 'shield'
  | 'alert'
  | 'flag'
  | 'close'
  | 'menu'
  | 'army';

/**
 * Her satır 16 karakter; 'X' = currentColor, '.' = boş.
 * Saf tamsayı <rect> bloklarına derlenir (sıfır anti-aliasing / sıfır mixel).
 */
const ICON_MATRICES: Readonly<Record<PixelIconName, readonly string[]>> = {
  // YouTube tarzı 4 köşe tam ekrana gir
  fullscreenEnter: [
    '................',
    '..XXXXX..XXXXX..',
    '..XXXXX..XXXXX..',
    '..XX........XX..',
    '..XX........XX..',
    '..XX........XX..',
    '................',
    '................',
    '................',
    '................',
    '..XX........XX..',
    '..XX........XX..',
    '..XX........XX..',
    '..XXXXX..XXXXX..',
    '..XXXXX..XXXXX..',
    '................',
  ],
  // YouTube tarzı 4 köşe tam ekrandan çık
  fullscreenExit: [
    '................',
    '....XX....XX....',
    '....XX....XX....',
    '....XX....XX....',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '................',
    '................',
    '................',
    '................',
    '..XXXX....XXXX..',
    '..XXXX....XXXX..',
    '....XX....XX....',
    '....XX....XX....',
    '....XX....XX....',
    '................',
  ],
  soundOn: [
    '................',
    '......XX........',
    '.....XXX...X....',
    '....XXXX....X...',
    '..XXXXXX..X..X..',
    '..XXXXXX...X..X.',
    '..XXXXXX...X..X.',
    '..XXXXXX...X..X.',
    '..XXXXXX...X..X.',
    '..XXXXXX..X..X..',
    '....XXXX....X...',
    '.....XXX...X....',
    '......XX........',
    '................',
    '................',
    '................',
  ],
  soundOff: [
    '................',
    '......XX........',
    '.....XXX........',
    '....XXXX........',
    '..XXXXXX.XX..XX.',
    '..XXXXXX..XXXX..',
    '..XXXXXX...XX...',
    '..XXXXXX...XX...',
    '..XXXXXX..XXXX..',
    '..XXXXXX.XX..XX.',
    '....XXXX........',
    '.....XXX........',
    '......XX........',
    '................',
    '................',
    '................',
  ],
  pause: [
    '................',
    '................',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '...XXXX..XXXX...',
    '................',
    '................',
  ],
  codex: [
    '................',
    '..XXXXXXXXXXXX..',
    '..X..........X..',
    '..X.XXXX.XXX.X..',
    '..X..........X..',
    '..X.XXX.XXXX.X..',
    '..X..........X..',
    '..X.XXXX.XXX.X..',
    '..X..........X..',
    '..X.XX..XXXX.X..',
    '..X..........X..',
    '..X..........X..',
    '..XXXXXXXXXXXX..',
    '...XXXXXXXXXX...',
    '................',
    '................',
  ],
  settings: [
    '................',
    '......XXXX......',
    '......XXXX......',
    '..XX..XXXX..XX..',
    '.XXXXXXXXXXXXXX.',
    '.XXXX......XXXX.',
    'XXXX........XXXX',
    'XXXX...XX...XXXX',
    'XXXX...XX...XXXX',
    'XXXX........XXXX',
    '.XXXX......XXXX.',
    '.XXXXXXXXXXXXXX.',
    '..XX..XXXX..XX..',
    '......XXXX......',
    '......XXXX......',
    '................',
  ],
  log: [
    '................',
    '.XXXXXXXXXXXXXX.',
    '.X............X.',
    '.X.XX.........X.',
    '.X..XX..XXXXX.X.',
    '.X.XX.........X.',
    '.X............X.',
    '.X.XXXXXXX....X.',
    '.X............X.',
    '.X.XXXXXXXXX..X.',
    '.X............X.',
    '.X.XXXXX......X.',
    '.X............X.',
    '.XXXXXXXXXXXXXX.',
    '................',
    '................',
  ],
  threat: [
    '................',
    '.......XX.......',
    '......XXXX......',
    '......XXXX......',
    '.....XX..XX.....',
    '....XX.XX.XX....',
    '....XX.XX.XX....',
    '...XX..XX..XX...',
    '...XX..XX..XX...',
    '..XX...XX...XX..',
    '..XX........XX..',
    '.XX....XX....XX.',
    '.XX....XX....XX.',
    '.XXXXXXXXXXXXXX.',
    '.XXXXXXXXXXXXXX.',
    '................',
  ],
  intent: [
    '................',
    '........XX......',
    '........XXX.....',
    '........XXXX....',
    '........XXXXX...',
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXXX.',
    '..XXXXXXXXXXXXXX',
    '..XXXXXXXXXXXXX.',
    '..XXXXXXXXXXXX..',
    '........XXXXX...',
    '........XXXX....',
    '........XXX.....',
    '........XX......',
    '................',
    '................',
  ],
  speed1x: [
    '................',
    '................',
    '....XX..........',
    '....XXXX........',
    '....XXXXXX......',
    '....XXXXXXXX....',
    '....XXXXXXXXXX..',
    '....XXXXXXXXXXX.',
    '....XXXXXXXXXX..',
    '....XXXXXXXX....',
    '....XXXXXX......',
    '....XXXX........',
    '....XX..........',
    '................',
    '................',
    '................',
  ],
  speed2x: [
    '................',
    '................',
    '.XX......XX.....',
    '.XXXX....XXXX...',
    '.XXXXXX..XXXXXX.',
    '.XXXXXXXXXXXXXXX',
    '.XXXXXXXXXXXXXXX',
    '.XXXXXXXXXXXXXXX',
    '.XXXXXXXXXXXXXXX',
    '.XXXXXX..XXXXXX.',
    '.XXXX....XXXX...',
    '.XX......XX.....',
    '................',
    '................',
    '................',
    '................',
  ],
  lab: [
    '................',
    '.....XXXXXX.....',
    '......XXXX......',
    '......X..X......',
    '......X..X......',
    '.....XX..XX.....',
    '....XX....XX....',
    '...XX......XX...',
    '..XX..XXXX..XX..',
    '..XX.XXXXXX.XX..',
    '.XXXXXXXXXXXXXX.',
    '.XXXXXXXXXXXXXX.',
    '.XXXXXXXXXXXXXX.',
    '..XXXXXXXXXXXX..',
    '................',
    '................',
  ],
  skull: [
    '................',
    '....XXXXXXXX....',
    '...XXXXXXXXXX...',
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXX..',
    '..XX..XXXX..XX..',
    '..XX..XXXX..XX..',
    '..XXXXXXXXXXXX..',
    '...XXXX..XXXX...',
    '....XXXXXXXX....',
    '....XX.XX.XX....',
    '....XX.XX.XX....',
    '.....XXXXXX.....',
    '................',
    '................',
    '................',
  ],
  shield: [
    '................',
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXX..',
    '..XX........XX..',
    '..XX..XXXX..XX..',
    '..XX..XXXX..XX..',
    '..XX..XXXX..XX..',
    '...XX..XX..XX...',
    '...XX..XX..XX...',
    '....XX....XX....',
    '.....XX..XX.....',
    '......XXXX......',
    '.......XX.......',
    '................',
    '................',
    '................',
  ],
  alert: [
    '................',
    '......XXXX......',
    '......XXXX......',
    '......XXXX......',
    '......XXXX......',
    '......XXXX......',
    '......XXXX......',
    '......XXXX......',
    '......XXXX......',
    '.......XX.......',
    '................',
    '......XXXX......',
    '......XXXX......',
    '......XXXX......',
    '................',
    '................',
  ],
  flag: [
    '................',
    '...XX...........',
    '...XXXXXXXXXX...',
    '...XXXXXXXXXXX..',
    '...XXXXXXXXXX...',
    '...XXXXXXXX.....',
    '...XXXXXXXXXX...',
    '...XXXXXXXXXXX..',
    '...XX...........',
    '...XX...........',
    '...XX...........',
    '...XX...........',
    '...XX...........',
    '..XXXX..........',
    '................',
    '................',
  ],
  close: [
    '................',
    '................',
    '..XXX......XXX..',
    '..XXXX....XXXX..',
    '...XXXX..XXXX...',
    '....XXXXXXXX....',
    '.....XXXXXX.....',
    '......XXXX......',
    '.....XXXXXX.....',
    '....XXXXXXXX....',
    '...XXXX..XXXX...',
    '..XXXX....XXXX..',
    '..XXX......XXX..',
    '................',
    '................',
    '................',
  ],
  menu: [
    '................',
    '................',
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXX..',
    '................',
    '................',
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXX..',
    '................',
    '................',
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXX..',
    '................',
    '................',
    '................',
    '................',
  ],
  army: [
    '................',
    '......XXXX......',
    '......XXXX......',
    '....XXXXXXXX....',
    '.....XXXXXX.....',
    '......XXXX......',
    '.....XXXXXX.....',
    '....XXXXXXXX....',
    '....XXXXXXXX....',
    '...XXXXXXXXXX...',
    '..XXXXXXXXXXXX..',
    '..XXXXXXXXXXXX..',
    '.XXXXXXXXXXXXXX.',
    '.XXXXXXXXXXXXXX.',
    '................',
    '................',
  ],
};

const SVG_RECTS_CACHE: Partial<Record<PixelIconName, string>> = {};

function compileRects(name: PixelIconName): string {
  const cached = SVG_RECTS_CACHE[name];
  if (cached !== undefined) return cached;

  const rows = ICON_MATRICES[name];
  let rects = '';
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    let x = 0;
    while (x < row.length) {
      if (row[x] === 'X') {
        const start = x;
        while (x < row.length && row[x] === 'X') x++;
        rects += `<rect x="${start}" y="${y}" width="${x - start}" height="1"/>`;
      } else {
        x++;
      }
    }
  }
  SVG_RECTS_CACHE[name] = rects;
  return rects;
}

/**
 * 16x16 keskin piksel SVG dizesi üretir (inline veya buton içine koymak için).
 */
export function renderPixelIconSvg(name: PixelIconName, sizePx = 16): string {
  return (
    `<svg class="px-icon" viewBox="0 0 16 16" width="${sizePx}" height="${sizePx}" ` +
    `fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">${compileRects(name)}</svg>`
  );
}

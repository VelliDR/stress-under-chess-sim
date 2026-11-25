import { describe, expect, it } from 'vitest';
import { generateSkirmishMap } from '../src/data/encounters';
import {
  advanceToNextSkirmishRound,
  applySkirmishDraftPick,
  autoDeploySkirmishRoster,
  buildValidatedSkirmishSidePieces,
  createLocal2pSkirmishRun,
  generateSkirmishDraftChoices,
  resolveSkirmishRoundOutcome,
  startLocal2pRoundBattle,
} from '../src/data/rewards';
import { getLegalMoves } from '../src/engine/board';
import { stepGame } from '../src/engine/reducer';
import { SAVE_VERSION } from '../src/engine/types';
import { getVisibleState } from '../src/engine/visibility';
import {
  CanvasRenderer,
  computeBoardLayout,
  localPointToTile,
  mapBoardCoord,
} from '../src/render/canvasRenderer';
import { FxQueue } from '../src/render/fxQueue';
import { DEFAULT_APP_SETTINGS, getResumableRunSummary } from '../src/storage/persistence';
import { getSandboxPreset } from '../src/ui/sandboxPresets';

function makeMockCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  textCalls: Array<{ text: string; x: number; y: number }>;
} {
  const textCalls: Array<{ text: string; x: number; y: number }> = [];
  const gradientStub = { addColorStop: () => undefined };

  const mock: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    lineDashOffset: 0,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: () => undefined,
    restore: () => undefined,
    setTransform: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    scale: () => undefined,
    beginPath: () => undefined,
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    quadraticCurveTo: () => undefined,
    bezierCurveTo: () => undefined,
    arc: () => undefined,
    ellipse: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    fill: () => undefined,
    stroke: () => undefined,
    fillRect: () => undefined,
    strokeRect: () => undefined,
    setLineDash: () => undefined,
    fillText: (text: string, x: number, y: number) => {
      textCalls.push({ text, x, y });
    },
    strokeText: () => undefined,
    createLinearGradient: () => gradientStub,
    createRadialGradient: () => gradientStub,
  };

  return {
    ctx: mock as unknown as CanvasRenderingContext2D,
    textCalls,
  };
}

function makeInteractiveMockCanvas(): {
  canvas: HTMLCanvasElement;
  emit: (type: string, event: Partial<PointerEvent>) => void;
} {
  const listeners: Record<string, Set<(ev: PointerEvent) => void>> = {};
  const mock = {
    width: 0,
    height: 0,
    style: { touchAction: '' },
    addEventListener: (type: string, fn: (ev: PointerEvent) => void) => {
      if (listeners[type] === undefined) listeners[type] = new Set();
      listeners[type]!.add(fn);
    },
    removeEventListener: (type: string, fn: (ev: PointerEvent) => void) => {
      listeners[type]?.delete(fn);
    },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 600 }),
  };

  return {
    canvas: mock as unknown as HTMLCanvasElement,
    emit: (type, event) => {
      const set = listeners[type];
      if (!set) return;
      for (const fn of set) {
        fn(event as PointerEvent);
      }
    },
  };
}

describe('Local 2P Hotseat (Pass & Play) — Secret Deploy, Turn Rotation & Draft', () => {
  it('initializes a balanced 20-pt Local 2P run, validates both deployments, and supports full turn & draft progression', () => {
    const run = createLocal2pSkirmishRun('hotseat-seed-2026');
    expect(run.isLocal2P).toBe(true);
    expect(run.playerRoster.some((u) => u.type === 'KING')).toBe(true);
    expect(run.enemyRoster.some((u) => u.type === 'KING')).toBe(true);

    const map = generateSkirmishMap(0, run.seed);
    const p1Auto = autoDeploySkirmishRoster(
      map.tiles,
      map.width,
      map.height,
      run.playerRoster,
      run.rngState,
      'PLAYER',
    );
    const p2Auto = autoDeploySkirmishRoster(
      map.tiles,
      map.width,
      map.height,
      run.enemyRoster,
      p1Auto.nextRngState,
      'ENEMY',
    );

    // Rejects invalid cross-side placement for Player 2
    const invalidP2 = buildValidatedSkirmishSidePieces(
      run.enemyRoster,
      { ...p2Auto.placements, [run.enemyRoster[0]!.id]: { x: 0, y: map.height - 1 } },
      map.tiles,
      map.width,
      map.height,
      'ENEMY',
      true,
    );
    expect(invalidP2.error).toBeDefined();

    // Launches live battle cleanly
    const launched = startLocal2pRoundBattle(run, p1Auto.placements, p2Auto.placements);
    expect(launched.error).toBeUndefined();
    expect(launched.nextRun.currentBattle).not.toBeNull();
    const battle = launched.nextRun.currentBattle!;
    expect(battle.turn).toBe('PLAYER');
    expect(battle.pieces.filter((p) => p.side === 'PLAYER').length).toBe(run.playerRoster.length);
    expect(battle.pieces.filter((p) => p.side === 'ENEMY').length).toBe(run.enemyRoster.length);

    // Resumable summary clearly labels Local 2P matches
    const summary = getResumableRunSummary({
      saveVersion: SAVE_VERSION,
      screen: 'BATTLE',
      settings: { ...DEFAULT_APP_SETTINGS },
      campaign: null,
      skirmish: launched.nextRun,
    });
    expect(summary?.title).toContain('2P');

    // Explicit hotseat turn check: after Player 1 passes turn, game turn switches to ENEMY
    // while viewerSide can remain PLAYER until explicit "Sıradaki" confirmation
    const afterP1 = stepGame(battle, { type: 'END_TURN' });
    expect(afterP1.error).toBeUndefined();
    expect(afterP1.nextState.turn).toBe('ENEMY');

    // Fog isolation: Player 1 and Player 2 see separate views
    const p1View = getVisibleState(afterP1.nextState, 'PLAYER');
    const p2View = getVisibleState(afterP1.nextState, 'ENEMY');
    expect(p1View.viewer).toBe('PLAYER');
    expect(p2View.viewer).toBe('ENEMY');

    // Simulate Round 1 win by Player 1 -> Draft choices for both players
    const finishedRound = { ...afterP1.nextState, winner: 'PLAYER' as const };
    const outcome = resolveSkirmishRoundOutcome(launched.nextRun, finishedRound);
    expect(outcome.status).toBe('NEXT_DRAFT');
    expect(outcome.nextRun.playerWins).toBe(1);

    const p1Offer = generateSkirmishDraftChoices(outcome.nextRun, 'PLAYER');
    const p2Offer = generateSkirmishDraftChoices(outcome.nextRun, 'ENEMY');
    expect(p1Offer.pool).toBe('STANDARD');
    expect(p2Offer.pool).toBe('RARE'); // Loser comeback advantage

    const afterP1Draft = applySkirmishDraftPick(outcome.nextRun, 'PLAYER', p1Offer.cards[0]!);
    expect(afterP1Draft.error).toBeUndefined();
    const afterP2Draft = applySkirmishDraftPick(afterP1Draft.nextRun, 'ENEMY', p2Offer.cards[0]!);
    expect(afterP2Draft.error).toBeUndefined();

    const round2 = advanceToNextSkirmishRound(afterP2Draft.nextRun);
    expect(round2.roundIndex).toBe(1);
    expect(round2.isLocal2P).toBe(true);
  });
});

describe('CanvasRenderer flipBoard — 180-Degree Rotated View & Pointer Coordinate Inversion', () => {
  it('inverts coordinates symmetrically for 8x8 and 9x8 boards and un-flips pointer hits', () => {
    const dims: Array<[number, number]> = [
      [8, 8],
      [9, 8],
    ];

    for (const [w, h] of dims) {
      const layout = computeBoardLayout(600, 600, w, h, 2);

      // Verify mapBoardCoord is self-inverting
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const flipped = mapBoardCoord({ x, y }, w, h, true);
          expect(flipped).toEqual({ x: w - 1 - x, y: h - 1 - y });
          expect(mapBoardCoord(flipped, w, h, true)).toEqual({ x, y });
        }
      }

      // Clicking screen bottom-left cell (gx=0, gy=h-1) in flipBoard=true must map to canonical (w-1, 0)
      const bottomLeftPxX = layout.offsetX + layout.tileSize * 0.5;
      const bottomLeftPxY = layout.offsetY + (h - 1) * layout.tileSize + layout.tileSize * 0.5;
      expect(localPointToTile(layout, bottomLeftPxX, bottomLeftPxY, w, h, false)).toEqual({
        x: 0,
        y: h - 1,
      });
      expect(localPointToTile(layout, bottomLeftPxX, bottomLeftPxY, w, h, true)).toEqual({
        x: w - 1,
        y: 0,
      });

      // Clicking screen top-right cell (gx=w-1, gy=0) in flipBoard=true must map to canonical (0, h-1)
      const topRightPxX = layout.offsetX + (w - 1) * layout.tileSize + layout.tileSize * 0.5;
      const topRightPxY = layout.offsetY + layout.tileSize * 0.5;
      expect(localPointToTile(layout, topRightPxX, topRightPxY, w, h, true)).toEqual({
        x: 0,
        y: h - 1,
      });

      // Out-of-bounds click stays null even with flipBoard=true
      expect(localPointToTile(layout, 0, 0, w, h, true)).toBeNull();
    }
  });

  it('renders Player 2 flipped view with reversed axis labels and delivers canonical coords via Pointer Events', () => {
    const state = getSandboxPreset('tactical-lab').build();
    const p2View = getVisibleState(state, 'ENEMY');
    const enemyPiece = p2View.pieces.find((p) => p.side === 'ENEMY')!;
    const legalMoves = getLegalMoves(p2View, enemyPiece);

    const { ctx, textCalls } = makeMockCanvasContext();
    const { canvas, emit } = makeInteractiveMockCanvas();
    const renderer = new CanvasRenderer(canvas, ctx);
    renderer.resize(600, 600, 2);

    const tapped: Array<{ x: number; y: number }> = [];
    renderer.bindPointerEvents({
      onTileTap: (c) => tapped.push(c),
      onTileHover: () => undefined,
    });

    const fx = new FxQueue(() => undefined, 'flip-fx');
    fx.enqueue(
      [
        {
          type: 'SHIELD_BROKEN',
          pieceId: enemyPiece.id,
          pos: enemyPiece.pos,
          source: 'ATTACK',
        },
      ],
      p2View.pieces,
      p2View,
      p2View,
    );
    fx.update(60);

    renderer.render(p2View, {
      selectedCoord: enemyPiece.pos,
      inspectedCoord: enemyPiece.pos,
      hoveredCoord: legalMoves[0]?.to ?? null,
      legalMoves,
      legalAbilities: [],
      activeAbility: null,
      deployZoneRows: [0, 1],
      flipBoard: true,
      fx: fx.getSnapshot(),
      timeMs: 1200,
    });

    // Axis labels in flipped 9x8 tactical-lab view: leftmost file label is 'I', rightmost is 'A'; top rank is '1', bottom is '8'
    const layout = renderer.getLayout();
    const expectedFiles = Array.from({ length: p2View.width }, (_, idx) =>
      String.fromCharCode(65 + (p2View.width - 1 - idx)),
    );
    const fileLabels = textCalls.filter(
      (t) => /^[A-Z]$/.test(t.text) && t.y > layout.offsetY + p2View.height * layout.tileSize,
    );
    expect(fileLabels.map((t) => t.text)).toEqual(expectedFiles);

    const rankLabels = textCalls.filter(
      (t) => /^[1-9]$/.test(t.text) && t.x < layout.offsetX,
    );
    expect(rankLabels.map((t) => t.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);

    // Simulate a Pointer tap on screen cell (gx=0, gy=height-1) accounting for canvas bounding rect (left=10, top=20)
    const clientX = 10 + layout.offsetX + layout.tileSize * 0.5;
    const clientY = 20 + layout.offsetY + (p2View.height - 1) * layout.tileSize + layout.tileSize * 0.5;

    emit('pointerdown', { button: 0, pointerType: 'touch', pointerId: 1, clientX, clientY });
    emit('pointerup', { button: 0, pointerType: 'touch', pointerId: 1, clientX, clientY });

    // Screen bottom-left on a flipped board maps to canonical ENEMY corner (width - 1, 0)
    expect(tapped).toEqual([{ x: p2View.width - 1, y: 0 }]);

    renderer.destroy();
  });
});

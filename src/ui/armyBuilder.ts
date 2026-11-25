// src/ui/armyBuilder.ts
// S.U.C.S. — 20 Puanlık Asimetrik Ordu Kurucu, Retro Pil Bütçe Göstergesi, 9 Birim Rafı,
// Hızlı Şablonlar & Kalın Sis Örtülü Gizli 2 Sıralı Tahta Yardımcısı.

import { createEmptyFog } from '../engine/board';
import { ALL_SKIRMISH_UNIT_CATALOG, type SkirmishCatalogEntry } from '../data/squads';
import {
  SKIRMISH_BUDGET,
  UNIT_COSTS,
  type PieceType,
  type RosterUnit,
  type Side,
  type VisibilityLevel,
} from '../engine/types';
import { nextRng, seedToRngState } from '../engine/prng';
import type { RenderTheme } from '../render/spriteCache';
import { createPieceIconCanvas } from '../render/sprites';

export type QuickArmyTemplateId = 'HEAVY_CAVALRY' | 'HEARTH_BEAST' | 'RANDOM_SPREAD';

export interface BatterySegmentState {
  index: number;
  filled: boolean;
  tone: 'green' | 'amber' | 'ice';
}

/**
 * 4.3.B 20 bölmeli retro pil göstergesi durumunu hesaplar:
 * Harcama arttıkça (kalan azaldıkça): yeşil -> kehribar -> tam dolunca (20/20) buz mavisi.
 */
export function computeBudgetBatterySegments(
  spent: number,
  budget = SKIRMISH_BUDGET,
): BatterySegmentState[] {
  const clampedSpent = Math.max(0, Math.min(budget, spent));
  const tone: BatterySegmentState['tone'] =
    clampedSpent >= budget ? 'ice' : clampedSpent >= budget - 4 ? 'amber' : 'green';
  const out: BatterySegmentState[] = [];
  for (let i = 0; i < budget; i++) {
    out.push({
      index: i,
      filled: i < clampedSpent,
      tone,
    });
  }
  return out;
}

/**
 * Gizli 2 Sıralı Dizilim Sisi: Yalnızca oyuncunun son 2 sırası (`VISIBLE`) aydınlıktır;
 * haritanın geri kalanı kalın `UNEXPLORED` sisle örtülüdür (duvar/kule ipucu soluk `EXPLORED` görünür).
 */
export function createDeployVisibilityFog(
  width: number,
  height: number,
  side: Side,
  tiles: ReadonlyArray<ReadonlyArray<{ type: string } | null>>,
): VisibilityLevel[][] {
  const fog = createEmptyFog(width, height, 'UNEXPLORED');
  const activeRows = side === 'PLAYER' ? [height - 2, height - 1] : [0, 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (activeRows.includes(y)) {
        fog[y]![x] = 'VISIBLE';
      } else {
        const t = tiles[y]?.[x];
        if (t !== null && t !== undefined && (t.type === 'WALL' || t.type === 'WATCHTOWER')) {
          fog[y]![x] = 'EXPLORED';
        }
      }
    }
  }
  return fog;
}

/**
 * 4.3.B Hızlı Şablon Orduları (Ağır Süvari / Ocak & Gulyabani / Rastgele Dağıt / Temizle).
 */
export function buildQuickArmyTemplate(
  template: QuickArmyTemplateId | 'CLEAR',
  idPrefix: string,
  rngSeed: number,
): RosterUnit[] {
  const king: RosterUnit = { id: `${idPrefix}_king`, type: 'KING', traits: [] };
  if (template === 'CLEAR') {
    return [king];
  }
  if (template === 'HEAVY_CAVALRY') {
    // 2 Kale (10) + 2 At (6) + 4 Piyon (4) = 20p
    const types: Array<{ type: PieceType; traits: RosterUnit['traits'] }> = [
      { type: 'ROOK', traits: [] },
      { type: 'ROOK', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'KNIGHT', traits: [] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: [] },
      { type: 'PAWN', traits: [] },
    ];
    return [
      king,
      ...types.map((u, idx) => ({ id: `${idPrefix}_hc_${idx}`, type: u.type, traits: u.traits })),
    ];
  }
  if (template === 'HEARTH_BEAST') {
    // 1 Gulyabani (10) + 1 Ocaklı (6) + 2 Gözcü Piyon (4) = 20p
    return [
      king,
      { id: `${idPrefix}_hb_0`, type: 'CHIMERA', traits: [] },
      { id: `${idPrefix}_hb_1`, type: 'SAINT_FAITH', traits: [] },
      { id: `${idPrefix}_hb_2`, type: 'PAWN', traits: ['SCOUT'] },
      { id: `${idPrefix}_hb_3`, type: 'PAWN', traits: ['SCOUT'] },
    ];
  }

  // RANDOM_SPREAD (deterministik PRNG ile 20p bütçeyi doldurur)
  let state = seedToRngState(`army-${rngSeed}`);
  let remaining = SKIRMISH_BUDGET;
  const units: RosterUnit[] = [king];
  let seq = 0;
  let guard = 0;
  while (remaining > 0 && units.length < 10 && guard++ < 40) {
    const affordable = ALL_SKIRMISH_UNIT_CATALOG.filter((c) => c.cost <= remaining);
    if (affordable.length === 0) break;
    const step = nextRng(state);
    state = step.nextState;
    const pick = affordable[Math.floor(step.value * affordable.length) % affordable.length]!;
    remaining -= pick.cost;
    units.push({
      id: `${idPrefix}_rnd_${seq++}`,
      type: pick.type,
      traits: pick.traits.slice(),
    });
  }
  return units;
}

export interface ArmyBuilderPanelOptions {
  containerEl: HTMLElement;
  spent: number;
  rosterLength: number;
  maxSlots: number;
  locked: boolean;
  theme: RenderTheme;
  bindButton: (label: string, onClick: () => void, extraClass?: string) => HTMLButtonElement;
  onApplyTemplate: (template: QuickArmyTemplateId | 'CLEAR') => void;
  onAddUnit: (entry: SkirmishCatalogEntry) => void;
}

export function renderArmyBuilderCatalogCard(opts: ArmyBuilderPanelOptions): void {
  const { containerEl, spent, rosterLength, maxSlots, locked, theme } = opts;
  const remaining = SKIRMISH_BUDGET - spent;
  const segments = computeBudgetBatterySegments(spent, SKIRMISH_BUDGET);

  const card = document.createElement('div');
  card.className = 'tfc-card';

  const title = document.createElement('h2');
  title.className = 'tfc-card-title';
  title.innerHTML =
    `<span>20 Puanlık Ordu Kurucu</span>` +
    `<span class="tfc-badge">${spent} / ${SKIRMISH_BUDGET} (${remaining}p kalan)</span>`;

  // 20 Bölmeli Retro Pil Göstergesi
  const batteryRow = document.createElement('div');
  batteryRow.className = 'sucs-battery-bar';
  batteryRow.setAttribute('aria-label', `Ordu bütçesi: ${spent} / ${SKIRMISH_BUDGET}`);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const cell = document.createElement('span');
    cell.className =
      'sucs-battery-cell' + (seg.filled ? ` is-filled is-${seg.tone}` : '');
    batteryRow.appendChild(cell);
  }

  // Hızlı Şablonlar & Temizle
  const tplRow = document.createElement('div');
  tplRow.className = 'tfc-btn-group';
  const tplHeavy = opts.bindButton('Ağır Süvari', () => opts.onApplyTemplate('HEAVY_CAVALRY'));
  const tplHearth = opts.bindButton('Ocak & Gulyabani', () => opts.onApplyTemplate('HEARTH_BEAST'));
  const tplRand = opts.bindButton('Rastgele Dağıt', () => opts.onApplyTemplate('RANDOM_SPREAD'));
  const tplClear = opts.bindButton('Temizle', () => opts.onApplyTemplate('CLEAR'), 'is-danger');
  tplHeavy.disabled = locked;
  tplHearth.disabled = locked;
  tplRand.disabled = locked;
  tplClear.disabled = locked;
  tplRow.append(tplHeavy, tplHearth, tplRand, tplClear);

  // Altta 2 satır Rol + Ulti Özeti kutusu (üzerine gelince veya basınca güncellenir)
  const infoBox = document.createElement('div');
  infoBox.className = 'sucs-unit-role-box';
  const updateRoleBox = (entry: SkirmishCatalogEntry): void => {
    const valNote =
      entry.type === 'PAWN' && entry.traits.includes('SCOUT')
        ? '2p (Gözcü)'
        : `${UNIT_COSTS[entry.type]}p`;
    infoBox.innerHTML =
      `<strong>${entry.label} · ${valNote}</strong>` +
      `<div>${entry.summary}</div>`;
  };
  updateRoleBox(ALL_SKIRMISH_UNIT_CATALOG[6] ?? ALL_SKIRMISH_UNIT_CATALOG[0]!);

  // 9 Birim Kartı Rafı (Sprite preview + Maliyet)
  const shelf = document.createElement('div');
  shelf.className = 'sucs-unit-shelf';
  for (let i = 0; i < ALL_SKIRMISH_UNIT_CATALOG.length; i++) {
    const item = ALL_SKIRMISH_UNIT_CATALOG[i]!;
    const canAfford = !locked && item.cost <= remaining && rosterLength < maxSlots;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sucs-unit-card';
    btn.disabled = !canAfford;

    const icon = createPieceIconCanvas(item.type, 'PLAYER', 26, theme, false);
    if (icon !== null) {
      btn.appendChild(icon);
    }

    const labelWrap = document.createElement('div');
    labelWrap.className = 'sucs-unit-card-meta';
    labelWrap.innerHTML =
      `<span class="sucs-unit-card-name">${item.label}</span>` +
      `<span class="sucs-unit-card-cost">${item.cost}p</span>`;
    btn.appendChild(labelWrap);

    btn.addEventListener('pointerenter', () => updateRoleBox(item));
    btn.addEventListener('focus', () => updateRoleBox(item));
    btn.addEventListener('click', () => {
      updateRoleBox(item);
      opts.onAddUnit(item);
    });
    shelf.appendChild(btn);
  }

  card.append(title, batteryRow, tplRow, shelf, infoBox);
  containerEl.appendChild(card);
}

import {
  buildRosterFromTemplate,
  computeSkirmishRosterCost,
  deploySkirmishAiArmy,
  selectSkirmishAiTemplate,
} from '../ai/skirmishAi';
import { inBounds, isTileWalkable } from '../engine/board';
import { nextRng, pickOne, seedToRngState, shuffle } from '../engine/prng';
import { createGameState } from '../engine/reducer';
import {
  CampaignPactEffect,
  CampaignRunState,
  Coord,
  FactionPassive,
  GameState,
  MAX_TRAITS_PER_PIECE,
  Piece,
  PieceType,
  RosterUnit,
  Side,
  SKIRMISH_BUDGET,
  SkirmishRunState,
  TileState,
  TraitId,
} from '../engine/types';
import {
  buildCampaignEncounter,
  generateSkirmishMap,
  getCampaignRoomsForAct,
} from './encounters';
import { buildRosterFromSquad, getStarterSquad } from './squads';

export type CampaignRewardKind = 'REINFORCE' | 'MUTATE' | 'REPAIR_REVIVE' | 'PACT';

export interface CampaignRewardCard {
  id: string;
  kind: CampaignRewardKind;
  title: string;
  subtitle: string;
  description: string;
  rarity: 'STANDARD' | 'RARE' | 'PACT';
  /** New unit added for REINFORCE or Queen PACT. */
  addUnit?: { type: PieceType; traits: TraitId[] };
  /** Trait(s) applied to a chosen existing unit (MUTATE or 2-trait PACT). */
  addTraits?: TraitId[];
  /** True when card allows reviving a lost unit OR granting shield-all next battle. */
  allowReviveOrShieldAll?: boolean;
  /** Downside applied when taking a PACT card (next 2 rooms). */
  pactPenalty?: CampaignPactEffect;
}

export interface SkirmishDraftCard {
  id: string;
  pool: 'STANDARD' | 'RARE';
  title: string;
  description: string;
  addUnit?: { type: Exclude<PieceType, 'KING'>; traits: TraitId[] };
  addTraitToAllOrTarget?: { trait: TraitId; targetMode: 'PICK_UNIT' | 'ALL_PAWNS' };
  grantFaction?: Exclude<FactionPassive, 'NONE'>;
}

const REINFORCE_POOL: readonly {
  type: Exclude<PieceType, 'KING'>;
  traits: TraitId[];
  title: string;
  desc: string;
}[] = [
  {
    type: 'KNIGHT',
    traits: [],
    title: 'Takviye: Süvari (At)',
    desc: 'Orduna 1 At ekle. Duvar ve çukurlardan atlar, buzda kaymaz.',
  },
  {
    type: 'BISHOP',
    traits: [],
    title: 'Takviye: Çapraz Nişancı (Fil)',
    desc: 'Orduna 1 Fil ekle. Geniş çapraz hat kontrolü ve 3 kare görüş sağlar.',
  },
  {
    type: 'ROOK',
    traits: [],
    title: 'Takviye: Kuşatma Kalesi',
    desc: 'Orduna 1 Kale ekle. Dikey ve yatay hatları güçlü biçimde domine eder.',
  },
  {
    type: 'PAWN',
    traits: ['SCOUT'],
    title: 'Takviye: Gözcü Piyon',
    desc: 'Orduna SCOUT (+2 görüş) özellikli 1 Piyon ekle.',
  },
];

const V3_REINFORCE_POOL: readonly {
  type: Exclude<PieceType, 'KING'>;
  traits: TraitId[];
  title: string;
  desc: string;
}[] = [
  ...REINFORCE_POOL,
  {
    type: 'SAINT_FAITH',
    traits: [],
    title: 'Takviye: Ocaklı',
    desc: 'Orduna 1 Ocaklı ekle. 5×5 moral aurası ve 3 turda 7×7 arınma + 2 tur düşman susturma.',
  },
  {
    type: 'SAINT_MADNESS',
    traits: [],
    title: 'Takviye: Meczup',
    desc: 'Orduna 1 Meczup ekle. 5×5 hız & zırh delme aurası ve 3 turda Kanlı Cinnet zinciri.',
  },
];

const MUTATION_POOL: readonly { trait: TraitId; title: string; desc: string }[] = [
  {
    trait: 'SHIELDED',
    title: 'Mutasyon: Zırhlı',
    desc: 'Seçtiğin bir taşa SHIELDED ekle (savaş başına ilk hasarı emer).',
  },
  {
    trait: 'FROST_TOUCH',
    title: 'Mutasyon: Buz Dokunuşu',
    desc: 'Seçtiğin bir taşa FROST_TOUCH ekle (bitişik/kalkanlı düşmanı 1 tur dondurur).',
  },
  {
    trait: 'EXPLOSIVE',
    title: 'Mutasyon: Patlayıcı',
    desc: 'Seçtiğin bir taşa EXPLOSIVE ekle (ölünce 4 ortogonal komşuyu yakar).',
  },
  {
    trait: 'SCOUT',
    title: 'Mutasyon: Gözcü',
    desc: 'Seçtiğin bir taşa SCOUT ekle (+2 görüş yarıçapı).',
  },
  {
    trait: 'SHADOW_WALKER',
    title: 'Mutasyon: Gölge',
    desc: 'Seçtiğin bir taşa SHADOW_WALKER ekle (silüet halkasında ? bırakmaz).',
  },
  {
    trait: 'PUSHER',
    title: 'Mutasyon: İtici',
    desc: 'Seçtiğin bir taşa PUSHER ekle (bitişik düşmanı çukur/buza itme yeteneği).',
  },
  {
    trait: 'DASH_ON_REVEAL',
    title: 'Mutasyon: Pusu',
    desc: 'Seçtiğin bir taşa DASH_ON_REVEAL ekle (karanlıktan çıkınca 1 ekstra hamle).',
  },
];

const PACT_TRAIT_PAIRS: readonly { traits: [TraitId, TraitId]; title: string }[] = [
  { traits: ['SHIELDED', 'FROST_TOUCH'], title: 'Buzul Zırhı (SHIELDED + FROST_TOUCH)' },
  { traits: ['DASH_ON_REVEAL', 'SHADOW_WALKER'], title: 'Karanlık Suikast (PUSU + GÖLGE)' },
  { traits: ['PUSHER', 'SHIELDED'], title: 'Demir Koçbaşı (İTİCİ + ZIRHLI)' },
];

export const SKIRMISH_STANDARD_CARDS: readonly SkirmishDraftCard[] = [
  {
    id: 'std-knight',
    pool: 'STANDARD',
    title: 'Takviye: At',
    description: 'Orduna yeni 1 At ekle.',
    addUnit: { type: 'KNIGHT', traits: [] },
  },
  {
    id: 'std-bishop',
    pool: 'STANDARD',
    title: 'Takviye: Fil',
    description: 'Orduna yeni 1 Fil ekle.',
    addUnit: { type: 'BISHOP', traits: [] },
  },
  {
    id: 'std-scout-pawn',
    pool: 'STANDARD',
    title: 'Takviye: Gözcü Piyon',
    description: 'Orduna SCOUT (+2 görüş) özellikli 1 Piyon ekle.',
    addUnit: { type: 'PAWN', traits: ['SCOUT'] },
  },
  {
    id: 'std-trait-shield',
    pool: 'STANDARD',
    title: 'Zırh Takviyesi (SHIELDED)',
    description: 'Seçtiğin 1 taşına SHIELDED ekle.',
    addTraitToAllOrTarget: { trait: 'SHIELDED', targetMode: 'PICK_UNIT' },
  },
  {
    id: 'std-trait-frost',
    pool: 'STANDARD',
    title: 'Buz Dokunuşu (FROST_TOUCH)',
    description: 'Seçtiğin 1 taşına FROST_TOUCH ekle.',
    addTraitToAllOrTarget: { trait: 'FROST_TOUCH', targetMode: 'PICK_UNIT' },
  },
  {
    id: 'std-trait-pusher',
    pool: 'STANDARD',
    title: 'İtici Donanım (PUSHER)',
    description: 'Seçtiğin 1 taşına PUSHER yeteneği ekle.',
    addTraitToAllOrTarget: { trait: 'PUSHER', targetMode: 'PICK_UNIT' },
  },
];

export const SKIRMISH_RARE_CARDS: readonly SkirmishDraftCard[] = [
  {
    id: 'rare-rook-shield',
    pool: 'RARE',
    title: 'Zırhlı Kale',
    description: 'Orduna SHIELDED özellikli elit 1 Kale ekle.',
    addUnit: { type: 'ROOK', traits: ['SHIELDED'] },
  },
  {
    id: 'rare-knight-dash',
    pool: 'RARE',
    title: 'Akıncı Süvarisi',
    description: 'Orduna DASH_ON_REVEAL + SHADOW_WALKER özellikli elit 1 At ekle.',
    addUnit: { type: 'KNIGHT', traits: ['DASH_ON_REVEAL', 'SHADOW_WALKER'] },
  },
  {
    id: 'rare-queen',
    pool: 'RARE',
    title: 'Kraliyet Veziri',
    description: 'Orduna geri dönüş gücü sağlayan 1 Vezir ekle.',
    addUnit: { type: 'QUEEN', traits: [] },
  },
  {
    id: 'rare-faction-frost',
    pool: 'RARE',
    title: 'Fraksiyon: Buzul Muhafızları',
    description: 'Ordun buz karelerinde kaymadan tam kontrolle durur.',
    grantFaction: 'FROST_WARDENS',
  },
  {
    id: 'rare-faction-necro',
    pool: 'RARE',
    title: 'Fraksiyon: Nekromanserler',
    description: 'Ölen her birimin (Şah hariç) 2 tur sonra İskelet Piyon doğurur.',
    grantFaction: 'NECROMANCERS',
  },
  {
    id: 'rare-faction-siege',
    pool: 'RARE',
    title: 'Fraksiyon: Kuşatma Mühendisleri',
    description: 'Kalelerin ortogonal bitişikteki WALL karelerini kırabilir.',
    grantFaction: 'SIEGE_ENGINEERS',
  },
  {
    id: 'rare-faction-raiders',
    pool: 'RARE',
    title: 'Fraksiyon: Akıncılar',
    description: 'Tüm Atların otomatik DASH_ON_REVEAL (Pusu) kazanır.',
    grantFaction: 'RAIDERS',
  },
];

/**
 * Creates a fresh Campaign run (Act 1 by default; supports Act 2 and Act 3) from a starter squad and deterministic seed.
 */
export function createCampaignRun(
  squadId: string,
  seed: string,
  act?: 1 | 2 | 3,
): CampaignRunState {
  const squad = getStarterSquad(squadId);
  const roster = buildRosterFromSquad(squad);
  const rngState = seedToRngState(`campaign::${seed}::${squad.id}`);

  const run: CampaignRunState = {
    seed,
    rngState,
    squadId: squad.id,
    ...(act !== undefined && act > 1 ? { act } : {}),
    roomIndex: 0,
    roster,
    lostUnits: [],
    playerFaction: 'NONE',
    shieldAllNextBattle: false,
    activePacts: [],
    currentBattle: null,
  };

  return startCampaignRoom(run, 0);
}

/**
 * Carries a victorious Campaign roster directly into the next Act (Act 1 -> Act 2 -> Act 3).
 */
export function continueCampaignToNextAct(
  completedRun: CampaignRunState,
  nextAct: 2 | 3,
): CampaignRunState {
  const nextRun: CampaignRunState = {
    ...completedRun,
    act: nextAct,
    roomIndex: 0,
    shieldAllNextBattle: false,
    currentBattle: null,
  };
  return startCampaignRoom(nextRun, 0);
}

/**
 * Generates and attaches the battle GameState for `roomIndex` inside a CampaignRunState.
 */
export function startCampaignRoom(run: CampaignRunState, roomIndex: number): CampaignRunState {
  const built = buildCampaignEncounter({
    roomIndex,
    seed: run.seed,
    roster: run.roster,
    playerFaction: run.playerFaction,
    shieldAllNextBattle: run.shieldAllNextBattle,
    activePacts: run.activePacts,
    ...(run.act !== undefined ? { act: run.act } : {}),
  });

  return {
    ...run,
    roomIndex,
    roster: run.roster.map((u) => ({ id: u.id, type: u.type, traits: u.traits.slice() })),
    lostUnits: run.lostUnits.map((u) => ({ id: u.id, type: u.type, traits: u.traits.slice() })),
    activePacts: run.activePacts.map((p) => ({ trait: p.trait, roomsRemaining: p.roomsRemaining })),
    currentBattle: built.state,
  };
}

export interface CampaignBattleOutcome {
  nextRun: CampaignRunState;
  status: 'RUN_VICTORY' | 'ROOM_CLEARED' | 'RUN_DEFEAT';
  newlyLost: RosterUnit[];
}

/**
 * Resolves permadeath, promotions, pact decay, and progression after a Campaign battle ends.
 */
export function resolveCampaignBattleOutcome(
  run: CampaignRunState,
  finishedBattle: GameState,
): CampaignBattleOutcome {
  const survivorsById: Record<string, RosterUnit> = {};
  for (let i = 0; i < finishedBattle.pieces.length; i++) {
    const p = finishedBattle.pieces[i]!;
    if (p.side !== 'PLAYER') continue;
    survivorsById[p.id] = {
      id: p.id,
      type: p.type, // Preserves Pawn -> Queen promotions!
      traits: p.traits.slice(),
    };
  }

  const nextRoster: RosterUnit[] = [];
  const newlyLost: RosterUnit[] = [];

  for (let i = 0; i < run.roster.length; i++) {
    const prevUnit = run.roster[i]!;
    const survivor = survivorsById[prevUnit.id];
    if (survivor !== undefined) {
      nextRoster.push(survivor);
    } else {
      newlyLost.push({
        id: prevUnit.id,
        type: prevUnit.type,
        traits: prevUnit.traits.slice(),
      });
    }
  }

  // Also preserve any dynamically spawned friendly units (e.g. if player ever gets NECROMANCERS)
  const knownIds: Record<string, true> = {};
  for (let i = 0; i < run.roster.length; i++) {
    knownIds[run.roster[i]!.id] = true;
  }
  const survivorKeys = Object.keys(survivorsById);
  for (let i = 0; i < survivorKeys.length; i++) {
    const id = survivorKeys[i]!;
    if (!knownIds[id]) {
      nextRoster.push(survivorsById[id]!);
    }
  }

  const nextLost = [
    ...run.lostUnits.map((u) => ({ id: u.id, type: u.type, traits: u.traits.slice() })),
    ...newlyLost,
  ];

  const decayedPacts = run.activePacts
    .map((p) => ({ trait: p.trait, roomsRemaining: p.roomsRemaining - 1 }))
    .filter((p) => p.roomsRemaining > 0);

  const playerWon = finishedBattle.winner === 'PLAYER';
  const rooms = getCampaignRoomsForAct(run.act ?? 1);
  const isFinalBoss = run.roomIndex >= rooms.length - 1;

  const nextRun: CampaignRunState = {
    ...run,
    roster: nextRoster,
    lostUnits: nextLost,
    shieldAllNextBattle: false,
    activePacts: decayedPacts,
    currentBattle: null,
  };

  if (!playerWon) {
    return { nextRun, status: 'RUN_DEFEAT', newlyLost };
  }
  if (isFinalBoss) {
    return { nextRun, status: 'RUN_VICTORY', newlyLost };
  }
  return { nextRun, status: 'ROOM_CLEARED', newlyLost };
}

/**
 * Generates 3 deterministic, seeded post-battle Campaign reward cards:
 * 1) Reinforce (new unit)
 * 2) Mutation (add 1 trait to an existing unit)
 * 3) 30% chance Pact (high reward + 2-room enemy pawn buff), 70% Repair/Revive (revive lost unit OR shield-all)
 */
export function generateCampaignRewards(run: CampaignRunState): {
  cards: CampaignRewardCard[];
  nextRngState: number;
} {
  let rng = run.rngState;

  // Card 1: Reinforce (Act 2-3 expands pool with Ocaklı & Meczup; Act 1 keeps bit-for-bit pool)
  const reinforcePool = (run.act ?? 1) >= 2 ? V3_REINFORCE_POOL : REINFORCE_POOL;
  const rPick = pickOne(rng, reinforcePool);
  rng = rPick.nextState;
  const rChoice = rPick.value ?? reinforcePool[0]!;
  const reinforceCard: CampaignRewardCard = {
    id: `reward_reinforce_${run.roomIndex}`,
    kind: 'REINFORCE',
    title: rChoice.title,
    subtitle: 'Takviye Kartı',
    description: rChoice.desc,
    rarity: 'STANDARD',
    addUnit: { type: rChoice.type, traits: rChoice.traits.slice() },
  };

  // Card 2: Mutation
  const mPick = pickOne(rng, MUTATION_POOL);
  rng = mPick.nextState;
  const mChoice = mPick.value ?? MUTATION_POOL[0]!;
  const mutateCard: CampaignRewardCard = {
    id: `reward_mutate_${run.roomIndex}`,
    kind: 'MUTATE',
    title: mChoice.title,
    subtitle: 'Mutasyon Kartı',
    description: mChoice.desc,
    rarity: 'STANDARD',
    addTraits: [mChoice.trait],
  };

  // Card 3: 30% chance Pact, 70% Repair/Revive
  const pactRoll = nextRng(rng);
  rng = pactRoll.nextState;

  let thirdCard: CampaignRewardCard;
  if (pactRoll.value < 0.3) {
    const penaltyPick = pickOne(rng, ['SHIELDED', 'EXPLOSIVE'] as const);
    rng = penaltyPick.nextState;
    const penaltyTrait = penaltyPick.value ?? 'SHIELDED';
    const penaltyLabel = penaltyTrait === 'SHIELDED' ? 'SHIELDED (Zırhlı)' : 'EXPLOSIVE (Patlayıcı)';

    const rewardVariantRoll = nextRng(rng);
    rng = rewardVariantRoll.nextState;

    if (rewardVariantRoll.value < 0.5) {
      const offerChimera = (run.act ?? 1) >= 3 && rewardVariantRoll.value < 0.25;
      thirdCard = offerChimera
        ? {
            id: `reward_pact_chimera_${run.roomIndex}`,
            kind: 'PACT',
            title: 'Karanlık Pazarlık: Gulyabani',
            subtitle: 'Yüksek Risk · Efsun Tutmaz Evrim',
            description: `Orduna hemen 1 Gulyabani (Kimera) ekle. Karşılığında sonraki 2 odada tüm düşman piyonları ${penaltyLabel} kazanır.`,
            rarity: 'PACT',
            addUnit: { type: 'CHIMERA', traits: [] },
            pactPenalty: { trait: penaltyTrait, roomsRemaining: 2 },
          }
        : {
            id: `reward_pact_queen_${run.roomIndex}`,
            kind: 'PACT',
            title: 'Karanlık Pazarlık: Vezir',
            subtitle: 'Yüksek Risk · Yüksek Ödül',
            description: `Orduna hemen 1 Vezir ekle. Karşılığında sonraki 2 odada tüm düşman piyonları ${penaltyLabel} kazanır.`,
            rarity: 'PACT',
            addUnit: { type: 'QUEEN', traits: [] },
            pactPenalty: { trait: penaltyTrait, roomsRemaining: 2 },
          };
    } else {
      const pairPick = pickOne(rng, PACT_TRAIT_PAIRS);
      rng = pairPick.nextState;
      const pair = pairPick.value ?? PACT_TRAIT_PAIRS[0]!;
      thirdCard = {
        id: `reward_pact_traits_${run.roomIndex}`,
        kind: 'PACT',
        title: `Pazarlık: ${pair.title}`,
        subtitle: 'Yüksek Risk · Çift Mutasyon',
        description: `Seçtiğin 1 taşına 2 mutasyon (${pair.traits.join(' + ')}) ekle. Karşılığında sonraki 2 odada tüm düşman piyonları ${penaltyLabel} kazanır.`,
        rarity: 'PACT',
        addTraits: pair.traits.slice(),
        pactPenalty: { trait: penaltyTrait, roomsRemaining: 2 },
      };
    }
  } else {
    const hasLost = run.lostUnits.length > 0;
    thirdCard = {
      id: `reward_repair_${run.roomIndex}`,
      kind: 'REPAIR_REVIVE',
      title: hasLost ? 'Onarım / Diriltme' : 'Kalkan Dökümü',
      subtitle: 'Savunma & Onarım',
      description: hasLost
        ? 'Kaybedilen 1 taşını geri dirilt VEYA sonraki savaşta tüm orduna Zırh (SHIELDED) kazandır.'
        : 'Sonraki savaşta tüm ordun aktif Kalkan (SHIELDED) ile başlar.',
      rarity: 'RARE',
      allowReviveOrShieldAll: true,
    };
  }

  return {
    cards: [reinforceCard, mutateCard, thirdCard],
    nextRngState: rng,
  };
}

export interface ApplyCampaignRewardOptions {
  /** Required for MUTATE / 2-trait PACT (existing roster unit ID) or REVIVE (lost unit ID). */
  targetUnitId?: string;
  /** When applying REPAIR_REVIVE, choose 'REVIVE' or 'SHIELD_ALL'. */
  repairChoice?: 'REVIVE' | 'SHIELD_ALL';
}

/**
 * Purely applies the chosen reward card, advances `roomIndex + 1`, and builds the next room!
 */
export function applyCampaignReward(
  run: CampaignRunState,
  card: CampaignRewardCard,
  options: ApplyCampaignRewardOptions = {},
): { nextRun: CampaignRunState; error?: string } {
  const nextRoster = run.roster.map((u) => ({
    id: u.id,
    type: u.type,
    traits: u.traits.slice(),
  }));
  const nextLost = run.lostUnits.map((u) => ({
    id: u.id,
    type: u.type,
    traits: u.traits.slice(),
  }));
  const nextPacts = run.activePacts.map((p) => ({
    trait: p.trait,
    roomsRemaining: p.roomsRemaining,
  }));
  let shieldAllNextBattle = run.shieldAllNextBattle;

  if (card.addUnit !== undefined) {
    const newId = `p_r${run.roomIndex}_${nextRoster.length + nextLost.length + 1}`;
    nextRoster.push({
      id: newId,
      type: card.addUnit.type,
      traits: card.addUnit.traits.slice(),
    });
  } else if (card.addTraits !== undefined && card.addTraits.length > 0) {
    const target =
      options.targetUnitId !== undefined
        ? nextRoster.find((u) => u.id === options.targetUnitId)
        : nextRoster.find((u) => u.traits.length < MAX_TRAITS_PER_PIECE);

    if (target === undefined) {
      return { nextRun: run, error: 'Mutasyon uygulanacak geçerli bir taş seçilmedi.' };
    }
    if (target.traits.length >= MAX_TRAITS_PER_PIECE) {
      return { nextRun: run, error: 'Bu taş zaten en fazla 3 mutasyon taşıyor.' };
    }

    let addedCount = 0;
    for (let i = 0; i < card.addTraits.length; i++) {
      const trait = card.addTraits[i]!;
      if (!target.traits.includes(trait) && target.traits.length < MAX_TRAITS_PER_PIECE) {
        target.traits.push(trait);
        addedCount++;
      }
    }
    if (addedCount === 0) {
      return { nextRun: run, error: 'Seçilen taş bu mutasyona zaten sahip.' };
    }
  } else if (card.allowReviveOrShieldAll) {
    const choice = options.repairChoice ?? (nextLost.length > 0 && options.targetUnitId ? 'REVIVE' : 'SHIELD_ALL');
    if (choice === 'REVIVE') {
      const lostIdx =
        options.targetUnitId !== undefined
          ? nextLost.findIndex((u) => u.id === options.targetUnitId)
          : 0;
      if (lostIdx === -1 || nextLost[lostIdx] === undefined) {
        return { nextRun: run, error: 'Diriltilecek kayıp taş bulunamadı.' };
      }
      const revived = nextLost.splice(lostIdx, 1)[0]!;
      nextRoster.push(revived);
    } else {
      shieldAllNextBattle = true;
    }
  }

  if (card.pactPenalty !== undefined) {
    nextPacts.push({
      trait: card.pactPenalty.trait,
      roomsRemaining: card.pactPenalty.roomsRemaining,
    });
  }

  const updatedRun: CampaignRunState = {
    ...run,
    roster: nextRoster,
    lostUnits: nextLost,
    shieldAllNextBattle,
    activePacts: nextPacts,
  };

  const rooms = getCampaignRoomsForAct(run.act ?? 1);
  const nextRoomIdx = Math.min(rooms.length - 1, run.roomIndex + 1);
  return {
    nextRun: startCampaignRoom(updatedRun, nextRoomIdx),
  };
}

// ============================================================================
// MOD 2: ASİMETRİK ORDU VE GELİŞEN DÜELLO (BEST-OF-3 SKIRMISH)
// ============================================================================

/**
 * Balanced 20-point starting roster (free King + 20 pts) so players can either customize
 * or launch straight into secret deployment.
 */
export function createDefaultPlayerSkirmishRoster(prefix = 'sp'): RosterUnit[] {
  return [
    { id: `${prefix}_king`, type: 'KING', traits: [] },
    { id: `${prefix}_1`, type: 'ROOK', traits: [] }, // 5
    { id: `${prefix}_2`, type: 'KNIGHT', traits: [] }, // 3
    { id: `${prefix}_3`, type: 'KNIGHT', traits: [] }, // 3
    { id: `${prefix}_4`, type: 'BISHOP', traits: [] }, // 3
    { id: `${prefix}_5`, type: 'PAWN', traits: ['SCOUT'] }, // 2
    { id: `${prefix}_6`, type: 'PAWN', traits: ['SCOUT'] }, // 2
    { id: `${prefix}_7`, type: 'PAWN', traits: [] }, // 1
    { id: `${prefix}_8`, type: 'PAWN', traits: [] }, // 1
  ];
}

/**
 * Initializes a Best-of-3 Skirmish run with a deterministically chosen asymmetric AI template.
 */
export function createSkirmishRun(seed: string): SkirmishRunState {
  let rng = seedToRngState(`skirmish::${seed}`);
  const pickedTemplate = selectSkirmishAiTemplate(rng);
  rng = pickedTemplate.nextRngState;
  const aiTemplate = pickedTemplate.template;

  return {
    seed,
    rngState: rng,
    roundIndex: 0,
    playerWins: 0,
    enemyWins: 0,
    lastRoundWinner: null,
    playerRoster: createDefaultPlayerSkirmishRoster('sp'),
    enemyRoster: buildRosterFromTemplate(aiTemplate, 'se'),
    playerFaction: 'NONE',
    enemyFaction: 'NONE',
    aiTemplateName: aiTemplate.name,
    isLocal2P: false,
    currentBattle: null,
  };
}

/**
 * Initializes a Best-of-3 same-device 2-Player (Pass & Play) Skirmish run.
 * Both sides start with a customizable 20-point roster and zero network dependencies.
 */
export function createLocal2pSkirmishRun(seed: string): SkirmishRunState {
  const rng = seedToRngState(`local2p::${seed}`);
  return {
    seed,
    rngState: rng,
    roundIndex: 0,
    playerWins: 0,
    enemyWins: 0,
    lastRoundWinner: null,
    playerRoster: createDefaultPlayerSkirmishRoster('p1'),
    enemyRoster: createDefaultPlayerSkirmishRoster('p2'),
    playerFaction: 'NONE',
    enemyFaction: 'NONE',
    isLocal2P: true,
    currentBattle: null,
  };
}

/**
 * Checks whether `coord` is a legal secret deployment square for `side`
 * (back 2 rows of that side, neither WALL nor PIT).
 */
export function isValidSkirmishDeployCoord(
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  coord: Coord,
  side: Side,
): boolean {
  if (!inBounds({ width, height }, coord)) return false;
  const inZone =
    side === 'PLAYER'
      ? coord.y === height - 1 || coord.y === height - 2
      : coord.y === 0 || coord.y === 1;
  if (!inZone) return false;
  return isTileWalkable(tiles[coord.y]?.[coord.x]);
}

/**
 * Auto-places a roster onto valid walkable tiles in that side's 2-row deployment zone.
 */
export function autoDeploySkirmishRoster(
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  roster: readonly RosterUnit[],
  rngState: number,
  side: Side,
): { placements: Record<string, Coord>; nextRngState: number } {
  const deployed = deploySkirmishAiArmy(tiles, width, height, roster, rngState, side);
  const placements: Record<string, Coord> = {};
  for (let i = 0; i < deployed.pieces.length; i++) {
    const p = deployed.pieces[i]!;
    placements[p.id] = { x: p.pos.x, y: p.pos.y };
  }
  return { placements, nextRngState: deployed.nextRngState };
}

/**
 * Validates one side's secret deployment plan (King presence, Round 1 budget, valid 2-row slots)
 * and builds its live `Piece[]` array.
 */
export function buildValidatedSkirmishSidePieces(
  roster: readonly RosterUnit[],
  placements: Readonly<Record<string, Coord>>,
  tiles: readonly (readonly TileState[])[],
  width: number,
  height: number,
  side: Side,
  enforceBudget: boolean,
): { pieces: Piece[]; error?: string } {
  const hasKing = roster.some((u) => u.type === 'KING');
  if (!hasKing) {
    return { pieces: [], error: 'Orduda mutlaka 1 Şah bulunmalıdır.' };
  }

  if (enforceBudget) {
    const cost = computeSkirmishRosterCost(roster);
    if (cost > SKIRMISH_BUDGET) {
      return {
        pieces: [],
        error: `Ordu maliyeti (${cost}) 20 puanlık bütçeyi aşıyor!`,
      };
    }
  }

  const usedKeys: Record<string, true> = {};
  const pieces: Piece[] = [];

  for (let i = 0; i < roster.length; i++) {
    const unit = roster[i]!;
    const coord = placements[unit.id];
    if (coord === undefined) {
      return { pieces: [], error: 'Tüm taşlar kendi son 2 sırana yerleştirilmelidir.' };
    }
    if (!isValidSkirmishDeployCoord(tiles, width, height, coord, side)) {
      return {
        pieces: [],
        error: `Geçersiz dizilim karesi: (${coord.x}, ${coord.y}). Sadece kendi 2 sırandaki yürünebilir kareler kullanılabilir.`,
      };
    }
    const key = `${coord.x},${coord.y}`;
    if (usedKeys[key]) {
      return { pieces: [], error: 'İki taş aynı kareye yerleştirilemez.' };
    }
    usedKeys[key] = true;

    pieces.push({
      id: unit.id,
      side,
      type: unit.type,
      pos: { x: coord.x, y: coord.y },
      traits: unit.traits.slice(),
      shieldActive: unit.traits.includes('SHIELDED'),
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE',
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: false,
    });
  }

  return { pieces };
}

/**
 * Validates BOTH human players' secret deployments and constructs the live Local 2P battle GameState.
 */
export function startLocal2pRoundBattle(
  run: SkirmishRunState,
  playerPlacements: Readonly<Record<string, Coord>>,
  enemyPlacements: Readonly<Record<string, Coord>>,
): { nextRun: SkirmishRunState; error?: string } {
  const map = generateSkirmishMap(run.roundIndex, run.seed);
  const enforceBudget = run.roundIndex === 0;

  const p1 = buildValidatedSkirmishSidePieces(
    run.playerRoster,
    playerPlacements,
    map.tiles,
    map.width,
    map.height,
    'PLAYER',
    enforceBudget,
  );
  if (p1.error !== undefined) {
    return { nextRun: run, error: `1. Oyuncu: ${p1.error}` };
  }

  const p2 = buildValidatedSkirmishSidePieces(
    run.enemyRoster,
    enemyPlacements,
    map.tiles,
    map.width,
    map.height,
    'ENEMY',
    enforceBudget,
  );
  if (p2.error !== undefined) {
    return { nextRun: run, error: `2. Oyuncu: ${p2.error}` };
  }

  const battleState = createGameState({
    width: map.width,
    height: map.height,
    tiles: map.tiles,
    pieces: [...p1.pieces, ...p2.pieces],
    mode: 'SKIRMISH',
    turn: 'PLAYER',
    factions: {
      PLAYER: run.playerFaction,
      ENEMY: run.enemyFaction,
    },
    seed: `${run.seed}::local2p-battle:${run.roundIndex}`,
  });

  return {
    nextRun: {
      ...run,
      isLocal2P: true,
      playerRoster: run.playerRoster.map((u) => ({
        id: u.id,
        type: u.type,
        traits: u.traits.slice(),
      })),
      enemyRoster: run.enemyRoster.map((u) => ({
        id: u.id,
        type: u.type,
        traits: u.traits.slice(),
      })),
      currentBattle: battleState,
    },
  };
}

/**
 * Validates player's budget (round 1) & secret deployment, secretly deploys AI's asymmetric
 * roster on top 2 rows, and constructs the live Skirmish battle GameState.
 */
export function startSkirmishRoundBattle(
  run: SkirmishRunState,
  playerPlacements: Readonly<Record<string, Coord>>,
): { nextRun: SkirmishRunState; error?: string } {
  const map = generateSkirmishMap(run.roundIndex, run.seed);

  const hasKing = run.playerRoster.some((u) => u.type === 'KING');
  if (!hasKing) {
    return { nextRun: run, error: 'Orduda mutlaka 1 Şah bulunmalıdır.' };
  }

  if (run.roundIndex === 0) {
    const cost = computeSkirmishRosterCost(run.playerRoster);
    if (cost > SKIRMISH_BUDGET) {
      return {
        nextRun: run,
        error: `Ordu maliyeti (${cost}) 20 puanlık bütçeyi aşıyor!`,
      };
    }
  }

  const usedKeys: Record<string, true> = {};
  const playerPieces: Piece[] = [];

  for (let i = 0; i < run.playerRoster.length; i++) {
    const unit = run.playerRoster[i]!;
    const coord = playerPlacements[unit.id];
    if (coord === undefined) {
      return { nextRun: run, error: 'Tüm taşlar son 2 sıraya yerleştirilmelidir.' };
    }
    if (!isValidSkirmishDeployCoord(map.tiles, map.width, map.height, coord, 'PLAYER')) {
      return {
        nextRun: run,
        error: `Geçersiz dizilim karesi: (${coord.x}, ${coord.y}). Sadece son 2 sıradaki yürünebilir kareler kullanılabilir.`,
      };
    }
    const key = `${coord.x},${coord.y}`;
    if (usedKeys[key]) {
      return { nextRun: run, error: 'İki taş aynı kareye yerleştirilemez.' };
    }
    usedKeys[key] = true;

    playerPieces.push({
      id: unit.id,
      side: 'PLAYER',
      type: unit.type,
      pos: { x: coord.x, y: coord.y },
      traits: unit.traits.slice(),
      shieldActive: unit.traits.includes('SHIELDED'),
      frozenTurns: 0,
      hasMoved: false,
      aggro: 'ACTIVE',
      usedDashThisTurn: false,
      wasVisibleAtTurnStart: false,
    });
  }

  const aiDeploySeed = seedToRngState(`${run.seed}::ai-deploy:${run.roundIndex}`);
  const deployedAi = deploySkirmishAiArmy(
    map.tiles,
    map.width,
    map.height,
    run.enemyRoster,
    aiDeploySeed,
    'ENEMY',
  );

  const battleState = createGameState({
    width: map.width,
    height: map.height,
    tiles: map.tiles,
    pieces: [...playerPieces, ...deployedAi.pieces],
    mode: 'SKIRMISH',
    turn: 'PLAYER',
    factions: {
      PLAYER: run.playerFaction,
      ENEMY: run.enemyFaction,
    },
    seed: `${run.seed}::skirmish-battle:${run.roundIndex}`,
  });

  return {
    nextRun: {
      ...run,
      playerRoster: run.playerRoster.map((u) => ({
        id: u.id,
        type: u.type,
        traits: u.traits.slice(),
      })),
      enemyRoster: run.enemyRoster.map((u) => ({
        id: u.id,
        type: u.type,
        traits: u.traits.slice(),
      })),
      currentBattle: battleState,
    },
  };
}

export interface SkirmishRoundOutcome {
  nextRun: SkirmishRunState;
  status: 'MATCH_OVER' | 'NEXT_DRAFT';
  matchWinner: Side | 'DRAW' | null;
}

/**
 * Resolves a completed Skirmish round (Best-of-3: first to 2 wins, or score leader after round 3).
 */
export function resolveSkirmishRoundOutcome(
  run: SkirmishRunState,
  finishedBattle: GameState,
): SkirmishRoundOutcome {
  const playerWins = run.playerWins + (finishedBattle.winner === 'PLAYER' ? 1 : 0);
  const enemyWins = run.enemyWins + (finishedBattle.winner === 'ENEMY' ? 1 : 0);
  const lastRoundWinner: Side | null =
    finishedBattle.winner === 'PLAYER' || finishedBattle.winner === 'ENEMY'
      ? finishedBattle.winner
      : null;

  const nextRun: SkirmishRunState = {
    ...run,
    playerWins,
    enemyWins,
    lastRoundWinner,
    currentBattle: null,
  };

  if (playerWins >= 2 || enemyWins >= 2 || run.roundIndex >= 2) {
    const matchWinner: Side | 'DRAW' =
      playerWins > enemyWins ? 'PLAYER' : enemyWins > playerWins ? 'ENEMY' : 'DRAW';
    return { nextRun, status: 'MATCH_OVER', matchWinner };
  }

  return { nextRun, status: 'NEXT_DRAFT', matchWinner: null };
}

/**
 * Comeback-balanced (loser-picks-better) draft pool rule:
 * Previous round's loser picks from RARE pool; winner (or draw) picks from STANDARD pool.
 */
export function getSkirmishDraftPoolForSide(
  run: SkirmishRunState,
  side: Side,
): 'RARE' | 'STANDARD' {
  if (run.lastRoundWinner !== null && run.lastRoundWinner !== side) {
    return 'RARE';
  }
  return 'STANDARD';
}

export function generateSkirmishDraftChoices(
  run: SkirmishRunState,
  side: Side,
): { pool: 'RARE' | 'STANDARD'; cards: SkirmishDraftCard[]; nextRngState: number } {
  const pool = getSkirmishDraftPoolForSide(run, side);
  const currentFaction = side === 'PLAYER' ? run.playerFaction : run.enemyFaction;
  const source = pool === 'RARE' ? SKIRMISH_RARE_CARDS : SKIRMISH_STANDARD_CARDS;
  const filtered = source.filter(
    (c) => c.grantFaction === undefined || c.grantFaction !== currentFaction,
  );
  const shuffled = shuffle(run.rngState, filtered);
  return {
    pool,
    cards: shuffled.value.slice(0, 3),
    nextRngState: shuffled.nextState,
  };
}

export function applySkirmishDraftPick(
  run: SkirmishRunState,
  side: Side,
  card: SkirmishDraftCard,
  targetUnitId?: string,
): { nextRun: SkirmishRunState; error?: string } {
  const isPlayer = side === 'PLAYER';
  const roster = (isPlayer ? run.playerRoster : run.enemyRoster).map((u) => ({
    id: u.id,
    type: u.type,
    traits: u.traits.slice(),
  }));
  let faction = isPlayer ? run.playerFaction : run.enemyFaction;

  if (card.addUnit !== undefined) {
    const prefix = isPlayer ? 'sp' : 'se';
    roster.push({
      id: `${prefix}_d${run.roundIndex}_${roster.length + 1}`,
      type: card.addUnit.type,
      traits: card.addUnit.traits.slice(),
    });
  } else if (card.addTraitToAllOrTarget !== undefined) {
    const { trait, targetMode } = card.addTraitToAllOrTarget;
    if (targetMode === 'ALL_PAWNS') {
      for (let i = 0; i < roster.length; i++) {
        const u = roster[i]!;
        if (u.type === 'PAWN' && !u.traits.includes(trait) && u.traits.length < MAX_TRAITS_PER_PIECE) {
          u.traits.push(trait);
        }
      }
    } else {
      const target =
        targetUnitId !== undefined
          ? roster.find((u) => u.id === targetUnitId)
          : roster.find((u) => !u.traits.includes(trait) && u.traits.length < MAX_TRAITS_PER_PIECE);
      if (target === undefined) {
        return { nextRun: run, error: 'Trait eklenecek uygun taş bulunamadı.' };
      }
      if (target.traits.length >= MAX_TRAITS_PER_PIECE || target.traits.includes(trait)) {
        return { nextRun: run, error: 'Seçilen taş bu özelliği alamaz (dolu veya zaten var).' };
      }
      target.traits.push(trait);
    }
  } else if (card.grantFaction !== undefined) {
    faction = card.grantFaction;
  }

  return {
    nextRun: {
      ...run,
      playerRoster: isPlayer ? roster : run.playerRoster.map((u) => ({ ...u, traits: u.traits.slice() })),
      enemyRoster: isPlayer ? run.enemyRoster.map((u) => ({ ...u, traits: u.traits.slice() })) : roster,
      playerFaction: isPlayer ? faction : run.playerFaction,
      enemyFaction: isPlayer ? run.enemyFaction : faction,
    },
  };
}

/**
 * Deterministically drafts and applies 1 card for the Skirmish AI from its comeback-adjusted pool.
 */
export function chooseAndApplyAiSkirmishDraft(run: SkirmishRunState): {
  nextRun: SkirmishRunState;
  pool: 'RARE' | 'STANDARD';
  pickedCard: SkirmishDraftCard;
} {
  const gen = generateSkirmishDraftChoices(run, 'ENEMY');
  const withRng: SkirmishRunState = { ...run, rngState: gen.nextRngState };

  const scoreCard = (c: SkirmishDraftCard): number => {
    if (c.grantFaction !== undefined) return run.enemyFaction === 'NONE' ? 95 : 40;
    if (c.addUnit !== undefined) {
      if (c.addUnit.type === 'QUEEN') return 110;
      if (c.addUnit.type === 'ROOK') return 90;
      if (c.addUnit.type === 'KNIGHT' || c.addUnit.type === 'BISHOP') return 75;
      return 55;
    }
    if (c.addTraitToAllOrTarget !== undefined) return 65;
    return 10;
  };

  let bestCard = gen.cards[0]!;
  let bestVal = scoreCard(bestCard);
  for (let i = 1; i < gen.cards.length; i++) {
    const candidate = gen.cards[i]!;
    const val = scoreCard(candidate);
    if (val > bestVal) {
      bestVal = val;
      bestCard = candidate;
    }
  }

  // Pick highest-value eligible unit if trait card
  let targetId: string | undefined;
  if (bestCard.addTraitToAllOrTarget?.targetMode === 'PICK_UNIT') {
    const trait = bestCard.addTraitToAllOrTarget.trait;
    const priorityOrder: readonly PieceType[] = ['QUEEN', 'ROOK', 'KNIGHT', 'BISHOP', 'KING', 'PAWN'];
    for (let p = 0; p < priorityOrder.length; p++) {
      const found = withRng.enemyRoster.find(
        (u) =>
          u.type === priorityOrder[p] &&
          !u.traits.includes(trait) &&
          u.traits.length < MAX_TRAITS_PER_PIECE,
      );
      if (found !== undefined) {
        targetId = found.id;
        break;
      }
    }
  }

  const applied = applySkirmishDraftPick(withRng, 'ENEMY', bestCard, targetId);
  return {
    nextRun: applied.nextRun,
    pool: gen.pool,
    pickedCard: bestCard,
  };
}

export function advanceToNextSkirmishRound(run: SkirmishRunState): SkirmishRunState {
  return {
    ...run,
    roundIndex: Math.min(2, run.roundIndex + 1),
    currentBattle: null,
  };
}

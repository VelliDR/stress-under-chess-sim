/**
 * Parametric evaluation weights for S.U.C.S. Tactical Fog-of-War AI.
 * All weights are flat JSON-serializable numbers so offline Texel / SPSA / league trainers
 * can optimize them directly and emit zero-dependency production weights.
 */

export interface SucsEvalWeights {
  // Traits & status
  kingShieldBonus: number;
  unitShieldBonus: number;
  silencePenalty: number;
  frostTouchTrait: number;
  explosiveTrait: number;
  pusherTrait: number;
  scoutTrait: number;
  shadowWalkerTrait: number;
  dashOnRevealTrait: number;
  dashHiddenReadyBonus: number;
  berserkReadyBonus: number;

  // Aura & Chimera
  auraCharge2Bonus: number;
  auraCharge1Bonus: number;
  saintFaithBuffDensityScale: number;
  chimeraKnightForm: number;
  chimeraRookForm: number;
  chimeraQueenForm: number;
  chimeraBishopForm: number;
  chimeraSaintForm: number;
  chimeraSynergyCombo: number;

  // Frozen × Hazard lethal lock ("Kahpelik" freeze-kill)
  frozenBaseScale: number;
  frozenOnLethalTileRatio: number;
  frozenKingOnLethalPenalty: number;

  // Psychological warfare (Composure, Breakdown, Disobedience, Cascade)
  composureShakenPenalty: number;
  composureFragilePenalty: number;
  composureBreakdownPenalty: number;
  disobedienceIsolatedPenalty: number;
  disobedienceThreatenedLockBonus: number;
  allyDeathCascadeSetupBonus: number;

  // Fog-of-War Stealth & Ambush (100% fair)
  dashAmbushStagingBonus: number;
  shadowWalkerFlankBonus: number;
  chimeraMiasmaCoverBonus: number;

  // Dungeon Chemistry & Dirty Combos
  pusherPitKingBonus: number;
  pusherPitUnitBonus: number;
  pusherSpikeKingBonus: number;
  pusherSpikeUnitBonus: number;
  pusherBurnKingBonus: number;
  pusherBurnUnitBonus: number;
  pusherPlateBonus: number;
  pusherMiasmaChokeBonus: number;
  explosiveClusterBonus: number;
  explosiveKingAdjBonus: number;
  explosiveMiasmaBombBonus: number;
  plateCorridorZoneBonus: number;
  crackedUnderBlastPenalty: number;
  crackedNearEnemyKingBonus: number;

  // King safety, mobility, positional & fog
  watchtowerBonus: number;
  centerBonusScale: number;
  pawnProgressScale: number;
  enemyKingBoxSqueezeBonus: number;
  ownKingBoxDangerPenalty: number;
  beliefRiskScale: number;
  ghostAmbushCheckScale: number;
  trapComplexityTieBreak: number;
  visionTileScale: number;
  frontierScale: number;
  pursuitKingChase: number;
  pursuitUnitChase: number;
  kingEdgePushScale: number;
  bonusMoveTempo: number;
}

export const DEFAULT_EVAL_WEIGHTS: Readonly<SucsEvalWeights> = {
  // Traits & status
  kingShieldBonus: 145,
  unitShieldBonus: 85,
  silencePenalty: 90,
  frostTouchTrait: 52,
  explosiveTrait: 42,
  pusherTrait: 58,
  scoutTrait: 42,
  shadowWalkerTrait: 38,
  dashOnRevealTrait: 50,
  dashHiddenReadyBonus: 32,
  berserkReadyBonus: 265,

  // Aura & Chimera
  auraCharge2Bonus: 225,
  auraCharge1Bonus: 55,
  saintFaithBuffDensityScale: 45,
  chimeraKnightForm: 190,
  chimeraRookForm: 175,
  chimeraQueenForm: 250,
  chimeraBishopForm: 125,
  chimeraSaintForm: 175,
  chimeraSynergyCombo: 110,

  // Frozen × Hazard lethal lock
  frozenBaseScale: 1.0,
  frozenOnLethalTileRatio: 0.72,
  frozenKingOnLethalPenalty: 4200,

  // Psychological warfare
  composureShakenPenalty: 18,
  composureFragilePenalty: 48,
  composureBreakdownPenalty: 115,
  disobedienceIsolatedPenalty: 55,
  disobedienceThreatenedLockBonus: 42,
  allyDeathCascadeSetupBonus: 38,

  // Fog-of-War Stealth & Ambush
  dashAmbushStagingBonus: 52,
  shadowWalkerFlankBonus: 36,
  chimeraMiasmaCoverBonus: 44,

  // Dungeon Chemistry & Dirty Combos
  pusherPitKingBonus: 650,
  pusherPitUnitBonus: 265,
  pusherSpikeKingBonus: 560,
  pusherSpikeUnitBonus: 230,
  pusherBurnKingBonus: 245,
  pusherBurnUnitBonus: 118,
  pusherPlateBonus: 165,
  pusherMiasmaChokeBonus: 135,
  explosiveClusterBonus: 45,
  explosiveKingAdjBonus: 145,
  explosiveMiasmaBombBonus: 130,
  plateCorridorZoneBonus: 155,
  crackedUnderBlastPenalty: 120,
  crackedNearEnemyKingBonus: 34,

  // King safety, mobility, positional & fog
  watchtowerBonus: 78,
  centerBonusScale: 1.0,
  pawnProgressScale: 16,
  enemyKingBoxSqueezeBonus: 34,
  ownKingBoxDangerPenalty: 44,
  beliefRiskScale: 1.0,
  ghostAmbushCheckScale: 1.0,
  trapComplexityTieBreak: 18,
  visionTileScale: 1.2,
  frontierScale: 1.2,
  pursuitKingChase: 19,
  pursuitUnitChase: 12,
  kingEdgePushScale: 11,
  bonusMoveTempo: 95,
};

export const EVAL_WEIGHT_KEYS = Object.keys(DEFAULT_EVAL_WEIGHTS) as Array<keyof SucsEvalWeights>;

export const EVAL_WEIGHT_BOUNDS: Readonly<Record<keyof SucsEvalWeights, readonly [number, number]>> = {
  kingShieldBonus: [60, 320],
  unitShieldBonus: [30, 180],
  silencePenalty: [30, 220],
  frostTouchTrait: [15, 130],
  explosiveTrait: [10, 120],
  pusherTrait: [20, 140],
  scoutTrait: [10, 110],
  shadowWalkerTrait: [10, 110],
  dashOnRevealTrait: [15, 130],
  dashHiddenReadyBonus: [0, 90],
  berserkReadyBonus: [120, 480],

  auraCharge2Bonus: [80, 420],
  auraCharge1Bonus: [15, 140],
  saintFaithBuffDensityScale: [15, 110],
  chimeraKnightForm: [80, 360],
  chimeraRookForm: [80, 340],
  chimeraQueenForm: [120, 460],
  chimeraBishopForm: [50, 260],
  chimeraSaintForm: [70, 340],
  chimeraSynergyCombo: [20, 260],

  frozenBaseScale: [0.4, 2.2],
  frozenOnLethalTileRatio: [0.25, 1.4],
  frozenKingOnLethalPenalty: [1500, 7500],

  composureShakenPenalty: [0, 70],
  composureFragilePenalty: [10, 140],
  composureBreakdownPenalty: [40, 280],
  disobedienceIsolatedPenalty: [10, 150],
  disobedienceThreatenedLockBonus: [5, 120],
  allyDeathCascadeSetupBonus: [5, 110],

  dashAmbushStagingBonus: [5, 140],
  shadowWalkerFlankBonus: [5, 110],
  chimeraMiasmaCoverBonus: [5, 120],

  pusherPitKingBonus: [250, 1200],
  pusherPitUnitBonus: [100, 520],
  pusherSpikeKingBonus: [200, 1000],
  pusherSpikeUnitBonus: [80, 450],
  pusherBurnKingBonus: [80, 500],
  pusherBurnUnitBonus: [40, 260],
  pusherPlateBonus: [40, 360],
  pusherMiasmaChokeBonus: [40, 300],
  explosiveClusterBonus: [15, 120],
  explosiveKingAdjBonus: [40, 320],
  explosiveMiasmaBombBonus: [40, 320],
  plateCorridorZoneBonus: [40, 360],
  crackedUnderBlastPenalty: [30, 320],
  crackedNearEnemyKingBonus: [5, 100],

  watchtowerBonus: [25, 160],
  centerBonusScale: [0.3, 2.5],
  pawnProgressScale: [6, 35],
  enemyKingBoxSqueezeBonus: [5, 100],
  ownKingBoxDangerPenalty: [10, 120],
  beliefRiskScale: [0.2, 2.5],
  ghostAmbushCheckScale: [0.2, 2.5],
  trapComplexityTieBreak: [0, 45],
  visionTileScale: [0.3, 3.0],
  frontierScale: [0.3, 3.0],
  pursuitKingChase: [6, 42],
  pursuitUnitChase: [3, 28],
  kingEdgePushScale: [2, 28],
  bonusMoveTempo: [30, 220],
};

export function clampEvalWeights(raw: Partial<SucsEvalWeights>): SucsEvalWeights {
  const out: SucsEvalWeights = { ...DEFAULT_EVAL_WEIGHTS };
  for (let i = 0; i < EVAL_WEIGHT_KEYS.length; i++) {
    const k = EVAL_WEIGHT_KEYS[i]!;
    const v = raw[k];
    if (v !== undefined && Number.isFinite(v)) {
      const [lo, hi] = EVAL_WEIGHT_BOUNDS[k];
      out[k] = Math.max(lo, Math.min(hi, v));
    }
  }
  return out;
}

export function weightsToVector(w: Readonly<SucsEvalWeights>): number[] {
  return EVAL_WEIGHT_KEYS.map((k) => w[k]);
}

export function vectorToWeights(vec: readonly number[]): SucsEvalWeights {
  const partial: Partial<SucsEvalWeights> = {};
  for (let i = 0; i < EVAL_WEIGHT_KEYS.length; i++) {
    const k = EVAL_WEIGHT_KEYS[i]!;
    partial[k] = vec[i] ?? DEFAULT_EVAL_WEIGHTS[k];
  }
  return clampEvalWeights(partial);
}

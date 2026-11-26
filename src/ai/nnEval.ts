/**
 * Tiny quantized-style MLP residual evaluator (28 features -> 20 ClippedReLU -> 1).
 * Pure TypeScript, zero allocations per inference, <0.015 ms per leaf in browser Web Worker.
 * Trained offline via self-play in `scripts/train.ts` and exported as compact numeric arrays.
 */

export const NN_INPUT_DIM = 28;
export const NN_HIDDEN_DIM = 20;

export interface TinyMlpModel {
  enabled: boolean;
  /** Maximum centipawn magnitude of the neural residual (guards material/mate invariants) */
  maxResidualCp: number;
  /** Flattened W1 matrix [NN_HIDDEN_DIM * NN_INPUT_DIM] */
  w1: readonly number[];
  /** Hidden bias [NN_HIDDEN_DIM] */
  b1: readonly number[];
  /** Output weights [NN_HIDDEN_DIM] */
  w2: readonly number[];
  /** Output bias */
  b2: number;
}

export const EMPTY_MLP_MODEL: Readonly<TinyMlpModel> = {
  enabled: false,
  maxResidualCp: 160,
  w1: new Array<number>(NN_HIDDEN_DIM * NN_INPUT_DIM).fill(0),
  b1: new Array<number>(NN_HIDDEN_DIM).fill(0),
  w2: new Array<number>(NN_HIDDEN_DIM).fill(0),
  b2: 0,
};

/**
 * Evaluates the tiny MLP residual on a pre-filled Float32Array of length NN_INPUT_DIM.
 * Uses ClippedReLU in [0, 1] and smooth tanh clamping into [-maxResidualCp, +maxResidualCp].
 */
export function evaluateTinyMlp(
  features: Float32Array,
  model: Readonly<TinyMlpModel>,
): number {
  if (!model.enabled) return 0;

  const w1 = model.w1;
  const b1 = model.b1;
  const w2 = model.w2;
  let out = model.b2;

  for (let h = 0; h < NN_HIDDEN_DIM; h++) {
    const rowOff = h * NN_INPUT_DIM;
    let sum = b1[h]!;
    for (let i = 0; i < NN_INPUT_DIM; i++) {
      sum += w1[rowOff + i]! * features[i]!;
    }
    // ClippedReLU activation in [0, 2]
    const act = sum <= 0 ? 0 : sum >= 2 ? 2 : sum;
    out += w2[h]! * act;
  }

  return Math.round(Math.tanh(out) * model.maxResidualCp);
}

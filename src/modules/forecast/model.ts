import { FEATURE_NAMES, type FeatureVector } from "./features";

/**
 * Logistic regression baseline — deliberately simple and fully transparent.
 * A fancier model only earns its place by beating this out-of-sample;
 * until then an interpretable baseline is the honest choice.
 *
 * Train: full-batch gradient descent on log-loss with L2. Features are
 * standardized with TRAIN-only mean/std (stored in the model, reused at
 * inference — no leakage).
 */

export interface LogRegModel {
  kind: "LOGREG";
  featureNames: string[];
  w: number[];       // weights
  b: number;         // bias
  mean: number[];    // train-set feature means
  std: number[];     // train-set feature stds (>= 1e-8)
}

export function trainLogReg(
  X: FeatureVector[],
  y: (0 | 1)[],
  opts: { lr?: number; epochs?: number; l2?: number } = {},
): LogRegModel {
  const lr = opts.lr ?? 0.1;
  const epochs = opts.epochs ?? 800;
  const l2 = opts.l2 ?? 1e-3;
  const n = X.length;
  const d = X[0]?.length ?? 0;
  if (!n || !d) throw new Error("empty training set");

  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.max(Math.sqrt(std[j]), 1e-8);

  const z = (x: FeatureVector, j: number) => (x[j] - mean[j]) / std[j];

  let w = new Array(d).fill(0);
  let b = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let s = b;
      for (let j = 0; j < d; j++) s += w[j] * z(X[i], j);
      const p = 1 / (1 + Math.exp(-s));
      const err = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * z(X[i], j);
      gb += err;
    }
    for (let j = 0; j < d; j++) {
      w[j] -= lr * (gw[j] / n + l2 * w[j]);
    }
    b -= lr * (gb / n);
  }

  return { kind: "LOGREG", featureNames: [...FEATURE_NAMES], w, b, mean, std };
}

export function predictProba(model: LogRegModel, x: FeatureVector): number {
  let s = model.b;
  for (let j = 0; j < model.w.length; j++) {
    s += model.w[j] * ((x[j] - model.mean[j]) / model.std[j]);
  }
  return 1 / (1 + Math.exp(-s));
}

export function serializeModel(m: LogRegModel): string {
  return JSON.stringify({ w: m.w, b: m.b, mean: m.mean, std: m.std });
}

export function deserializeModel(json: string, featureNames: string[]): LogRegModel {
  const p = JSON.parse(json) as { w: number[]; b: number; mean: number[]; std: number[] };
  return { kind: "LOGREG", featureNames, w: p.w, b: p.b, mean: p.mean, std: p.std };
}

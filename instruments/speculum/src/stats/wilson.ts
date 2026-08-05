/**
 * Wilson score interval for a binomial proportion.
 *
 * Prefer Wilson over normal approximation: at small rates and small n the
 * normal form can dip below 0 or overshoot. Wilson stays well-behaved across
 * p ∈ [0, 1] and small samples.
 *
 * Reference: Wilson (1927). J. Am. Stat. Assoc. 22(158): 209-212.
 */

const Z_95 = 1.959963984540054;

export interface WilsonInterval {
  lower: number;
  upper: number;
}

/**
 * Wilson 95% CI for k successes in n trials.
 *
 * - n === 0 → [0, 1]
 * - k === 0 → lower clamped to 0
 * - k === n → upper clamped to 1
 */
export function wilson95(k: number, n: number): WilsonInterval {
  if (!Number.isFinite(k) || !Number.isFinite(n)) {
    throw new TypeError(`wilson95 requires finite numbers (got k=${k}, n=${n})`);
  }
  if (k < 0 || n < 0 || k > n) {
    throw new RangeError(`wilson95 requires 0 <= k <= n (got k=${k}, n=${n})`);
  }
  if (n === 0) return { lower: 0, upper: 1 };

  if (k === 0) {
    const z2 = Z_95 * Z_95;
    const denom = 1 + z2 / n;
    return { lower: 0, upper: z2 / n / denom };
  }
  if (k === n) {
    const z2 = Z_95 * Z_95;
    const denom = 1 + z2 / n;
    return { lower: 1 / denom, upper: 1 };
  }

  const z = Z_95;
  const z2 = z * z;
  const phat = k / n;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));

  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

/** Closed numeric interval. */
export type ConfidenceInterval = {
  /** Lower 95% bound. */
  low: number;
  /** Upper 95% bound. */
  high: number;
};

/** Mean and selected quantiles of one metric. */
export type MetricDistribution = {
  /** Arithmetic mean. */
  mean: number;
  /** Median. */
  p50: number;
  /** 90th percentile. */
  p90: number;
};

const Z_975 = 1.959963984540054;

/** Arithmetic mean of a nonempty sample. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error("Cannot take the mean of an empty sample");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Wilson score interval for a binomial proportion at 95% confidence.
 *
 * Wilson rather than the normal approximation because trial counts here are small and pass rates
 * cluster at 0 and 1, where the normal interval produces bounds outside [0, 1].
 */
export function wilsonInterval(successes: number, trials: number): ConfidenceInterval | null {
  if (trials === 0) return null;
  if (!Number.isInteger(successes) || !Number.isInteger(trials) ||
      successes < 0 || successes > trials) {
    throw new Error("Wilson interval requires integer successes between zero and trials");
  }
  const proportion = successes / trials;
  const denominator = 1 + Z_975 ** 2 / trials;
  const center = (proportion + Z_975 ** 2 / (2 * trials)) / denominator;
  const margin = Z_975 * Math.sqrt(
      (proportion * (1 - proportion) + Z_975 ** 2 / (4 * trials)) / trials) / denominator;
  return { low: center - margin, high: center + margin };
}

/** Sample standard deviation, or null with fewer than two observations. */
export function sampleStandardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(
      values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function tCritical(degreesOfFreedom: number): number {
  if (degreesOfFreedom <= T_975.length) return T_975[degreesOfFreedom - 1] ?? Z_975;
  const inverseDf = 1 / degreesOfFreedom;
  return Z_975 + (Z_975 ** 3 + Z_975) * inverseDf / 4 +
    (5 * Z_975 ** 5 + 16 * Z_975 ** 3 + 3 * Z_975) * inverseDf ** 2 / 96 +
    (3 * Z_975 ** 7 + 19 * Z_975 ** 5 + 17 * Z_975 ** 3 - 15 * Z_975) * inverseDf ** 3 / 384;
}

/** Student-t 95% confidence interval for a sample mean, or null below two observations. */
export function tMeanInterval(values: readonly number[]): ConfidenceInterval | null {
  const sd = sampleStandardDeviation(values);
  if (sd === null) return null;
  const margin = tCritical(values.length - 1) * sd / Math.sqrt(values.length);
  return { low: mean(values) - margin, high: mean(values) + margin };
}

function quantile(values: readonly number[], probability: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = sorted.at(Math.floor(index));
  const upper = sorted.at(Math.ceil(index));
  if (lower === undefined || upper === undefined) {
    throw new Error("Cannot take a quantile of an empty sample");
  }
  return lower + (upper - lower) * (index - Math.floor(index));
}

/** Mean, median, and p90 of a sample, or null when empty. */
export function metricDistribution(values: readonly number[]): MetricDistribution | null {
  if (values.length === 0) return null;
  return { mean: mean(values), p50: quantile(values, 0.5), p90: quantile(values, 0.9) };
}

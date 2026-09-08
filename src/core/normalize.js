/**
 * Turning raw criterion values into a 0..1 "desirability" score.
 *
 * Everything is scored *relative to the candidate set on screen*. A $780 fare
 * is neither good nor bad in the abstract - it is good if the other options are
 * $900 and bad if they are $500. Absolute curves are used only where the number
 * has a fixed human meaning (a layover count, a walk in minutes).
 */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Neutral score used when a criterion cannot discriminate between options. */
export const NEUTRAL = 0.5;

/**
 * Percentile of a sorted array using linear interpolation.
 * @param {number[]} sorted ascending
 * @param {number} p 0..1
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Build a scorer that maps a raw value to 0..1 by min-max scaling across the
 * candidate set.
 *
 * The scale is set by Tukey fences (Q1 - 1.5*IQR, Q3 + 1.5*IQR) rather than the
 * raw min and max, so one $8,000 first-class fare in a list of economy fares
 * can't squash every real difference into the bottom few percent of the scale.
 * When there are no outliers the fences fall outside the data and this is
 * plain min-max scaling. Values beyond the fences still score 0 or 1 - they are
 * just not allowed to set the scale.
 *
 * @param {number[]} values every candidate's raw value (NaN/null allowed)
 * @param {{direction?: 'lower'|'higher', fence?: number}} [opts]
 * @returns {(value: number) => number}
 */
export function relativeScorer(values, opts = {}) {
  const { direction = 'higher', fence = 1.5 } = opts;
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);

  if (finite.length === 0) return () => NEUTRAL;

  const min = finite[0];
  const max = finite[finite.length - 1];
  const q1 = percentile(finite, 0.25);
  const q3 = percentile(finite, 0.75);
  const iqr = q3 - q1;

  let lo = Math.max(min, q1 - fence * iqr);
  let hi = Math.min(max, q3 + fence * iqr);
  // A tight cluster plus outliers can collapse the fenced range; fall back to
  // the true range before giving up and calling everything equal.
  if (!(hi > lo)) {
    lo = min;
    hi = max;
  }
  if (!(hi > lo)) return () => NEUTRAL; // every candidate identical

  return (value) => {
    if (!Number.isFinite(value)) return NEUTRAL;
    const t = clamp01((value - lo) / (hi - lo));
    return direction === 'lower' ? 1 - t : t;
  };
}

/**
 * Score against a fixed, absolute curve given as ascending [value, score]
 * breakpoints, interpolating between them. Used where the raw number means
 * something on its own (2 layovers is bad however good the alternatives are).
 *
 * @param {[number, number][]} points ascending by value
 * @returns {(value: number) => number}
 */
export function curveScorer(points) {
  return (value) => {
    if (!Number.isFinite(value)) return NEUTRAL;
    if (value <= points[0][0]) return points[0][1];
    const last = points[points.length - 1];
    if (value >= last[0]) return last[1];
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x0, y0] = points[i - 1];
      if (value <= x1) return y0 + ((y1 - y0) * (value - x0)) / (x1 - x0);
    }
    return last[1];
  };
}

/** Mean of the finite numbers in an array, or NEUTRAL when there are none. */
export function mean(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return NEUTRAL;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

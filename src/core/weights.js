/**
 * Importance -> weight.
 *
 * The user rates every criterion 1-5, or marks it "n/a". "n/a" means the
 * criterion is dropped from scoring entirely (weight 0) rather than treated as
 * a 0-importance tie-breaker.
 *
 * Ratings are raised to an exponent before normalising so that a 5 genuinely
 * dominates a 1. With the default exponent of 1.6 a "5" carries ~13x the pull
 * of a "1"; a linear scale (5x) makes top-rated criteria feel ignored once
 * three or four mid-rated ones gang up on them.
 */

export const NA = 'na';
export const DEFAULT_EXPONENT = 1.6;

/** @typedef {1|2|3|4|5|'na'|null|undefined} Importance */

/** True when the user asked for this criterion to be ignored. */
export function isIgnored(importance) {
  return importance == null || importance === NA || importance === 'N/A' || importance === 0;
}

/**
 * Raw (un-normalised) weight for a single importance rating.
 * @param {Importance} importance
 * @param {number} [exponent]
 * @returns {number} 0 for n/a, otherwise a positive number
 */
export function importanceToWeight(importance, exponent = DEFAULT_EXPONENT) {
  if (isIgnored(importance)) return 0;
  const n = Number(importance);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.pow(Math.min(5, Math.max(1, n)), exponent);
}

/**
 * Turn a map of importance ratings into weights that sum to 1.
 *
 * @param {Record<string, Importance>} importances
 * @param {string[]} keys criteria to consider, in display order
 * @param {number} [exponent]
 * @returns {Record<string, number>} weights summing to 1 (or all-zero if
 *   every criterion was marked n/a)
 */
export function normalizeWeights(importances, keys, exponent = DEFAULT_EXPONENT) {
  const raw = {};
  let total = 0;
  for (const key of keys) {
    const w = importanceToWeight(importances?.[key], exponent);
    raw[key] = w;
    total += w;
  }
  if (total === 0) return raw; // caller decides how to handle "everything is n/a"
  for (const key of keys) raw[key] = raw[key] / total;
  return raw;
}

/** Criteria the user actually cares about, most important first. */
export function activeCriteria(importances, keys, exponent = DEFAULT_EXPONENT) {
  return keys
    .filter((k) => !isIgnored(importances?.[k]))
    .sort(
      (a, b) =>
        importanceToWeight(importances[b], exponent) -
        importanceToWeight(importances[a], exponent)
    );
}

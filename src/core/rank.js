/**
 * The generic weighted-criteria ranker shared by flights and hotels.
 *
 * Two passes, deliberately:
 *   1. Pull the raw value of every criterion for every candidate.
 *   2. Build each criterion's scorer from the *whole set*, then score.
 *
 * That second pass is what makes "cost: 5" mean "cheapest of what's actually
 * available today" instead of comparing against a number nobody chose.
 */

import { normalizeWeights, isIgnored, importanceToWeight } from './weights.js';
import { mean } from './normalize.js';

/**
 * @typedef {object} Criterion
 * @property {string} key
 * @property {string} label
 * @property {(candidate:any, ctx:any) => number} value raw value (NaN if unknown)
 * @property {(values:number[], ctx:any) => (value:number)=>number} scorer builds
 *   the 0..1 scorer from every candidate's raw value
 * @property {(candidate:any, raw:number, ctx:any) => string} [display] text for the UI
 * @property {string} [hint] one-line explanation of what the criterion measures
 */

/**
 * Rank candidates against the user's importance ratings.
 *
 * @param {object} args
 * @param {any[]} args.candidates
 * @param {Criterion[]} args.criteria
 * @param {Record<string, import('./weights.js').Importance>} args.importances
 * @param {any} [args.ctx] passed through to every criterion callback
 * @param {number} [args.exponent]
 * @returns {{results: any[], weights: Record<string,number>, ignored: string[]}}
 */
export function rank({ candidates, criteria, importances, ctx = {}, exponent }) {
  const keys = criteria.map((c) => c.key);
  const weights = normalizeWeights(importances, keys, exponent);
  const ignored = keys.filter((k) => isIgnored(importances?.[k]));
  const everythingIgnored = keys.every((k) => weights[k] === 0);

  // Pass 1: raw values.
  const rawByKey = {};
  for (const criterion of criteria) {
    rawByKey[criterion.key] = candidates.map((candidate) => {
      const v = criterion.value(candidate, ctx);
      return typeof v === 'number' ? v : NaN;
    });
  }

  // Pass 2: build scorers over the full field, then score each candidate.
  const scoreByKey = {};
  for (const criterion of criteria) {
    const scoreFn = criterion.scorer(rawByKey[criterion.key], ctx);
    scoreByKey[criterion.key] = rawByKey[criterion.key].map((raw) => scoreFn(raw));
  }

  const fieldMean = {};
  for (const key of keys) fieldMean[key] = mean(scoreByKey[key]);

  const results = candidates.map((candidate, i) => {
    const breakdown = criteria.map((criterion) => {
      const weight = weights[criterion.key];
      const raw = rawByKey[criterion.key][i];
      const score = scoreByKey[criterion.key][i];
      return {
        key: criterion.key,
        label: criterion.label,
        hint: criterion.hint,
        importance: isIgnored(importances?.[criterion.key])
          ? 'na'
          : Number(importances[criterion.key]),
        weight,
        raw,
        display: criterion.display ? criterion.display(candidate, raw, ctx) : formatRaw(raw),
        score,
        contribution: weight * score,
        // How this option compares with the rest of the field on this criterion.
        edge: score - fieldMean[criterion.key],
      };
    });

    const total = breakdown.reduce((sum, b) => sum + b.contribution, 0);

    return {
      candidate,
      score: Math.round((everythingIgnored ? 0 : total) * 1000) / 10, // 0-100, 1dp
      breakdown,
      ...highlights(breakdown),
    };
  });

  results.sort((a, b) => b.score - a.score || tieBreak(a, b));
  results.forEach((r, i) => {
    r.rank = i + 1;
  });

  return { results, weights, ignored, everythingIgnored };
}

/**
 * Pick the criteria worth mentioning: the ones the user weighted heavily *and*
 * where this option is clearly better or worse than the rest of the field.
 * A criterion rated n/a is never mentioned - the user said they don't care.
 */
function highlights(breakdown, { threshold = 0.08, limit = 3 } = {}) {
  const scored = breakdown
    .filter((b) => b.weight > 0 && Number.isFinite(b.edge))
    .map((b) => ({ ...b, pull: b.weight * b.edge }));

  const pros = scored
    .filter((b) => b.edge > threshold)
    .sort((a, b) => b.pull - a.pull)
    .slice(0, limit);
  const cons = scored
    .filter((b) => b.edge < -threshold)
    .sort((a, b) => a.pull - b.pull)
    .slice(0, limit);

  return {
    pros: pros.map((b) => ({ key: b.key, label: b.label, display: b.display, edge: b.edge })),
    cons: cons.map((b) => ({ key: b.key, label: b.label, display: b.display, edge: b.edge })),
  };
}

/** Deterministic ordering for exact ties: better on the heaviest criterion wins. */
function tieBreak(a, b) {
  const heaviest = [...a.breakdown].sort((x, y) => y.weight - x.weight)[0];
  if (!heaviest) return 0;
  const bSide = b.breakdown.find((x) => x.key === heaviest.key);
  return (bSide?.score ?? 0) - heaviest.score;
}

function formatRaw(raw) {
  if (!Number.isFinite(raw)) return '--';
  return Math.abs(raw) >= 100 ? String(Math.round(raw)) : String(Math.round(raw * 10) / 10);
}

/**
 * Plain-English reason this option landed where it did, built from the same
 * numbers the score came from (never a separate narrative that can drift).
 */
export function explain(result) {
  const parts = [];
  if (result.pros.length) {
    parts.push(`Wins on ${result.pros.map((p) => p.label.toLowerCase()).join(', ')}`);
  }
  if (result.cons.length) {
    parts.push(`gives up ${result.cons.map((c) => c.label.toLowerCase()).join(', ')}`);
  }
  if (parts.length === 0) return 'Middle of the pack on everything you rated.';
  return `${parts.join('; ')}.`;
}

/** Which criteria moved the total most - useful for a "why?" panel. */
export function topDrivers(result, limit = 3) {
  return [...result.breakdown]
    .filter((b) => b.weight > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, limit);
}

export { importanceToWeight };

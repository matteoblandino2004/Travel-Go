import test from 'node:test';
import assert from 'node:assert/strict';
import { rank, explain, topDrivers } from '../src/core/rank.js';
import { relativeScorer } from '../src/core/normalize.js';

/** Two criteria that pull in opposite directions, so weighting decides. */
const CRITERIA = [
  {
    key: 'cost',
    label: 'Cost',
    value: (c) => c.cost,
    scorer: (values) => relativeScorer(values, { direction: 'lower' }),
    display: (c) => `$${c.cost}`,
  },
  {
    key: 'comfort',
    label: 'Comfort',
    value: (c) => c.comfort,
    scorer: (values) => relativeScorer(values, { direction: 'higher' }),
    display: (c) => `${c.comfort}/10`,
  },
];

const CANDIDATES = [
  { id: 'cheap', cost: 200, comfort: 2 },
  { id: 'middle', cost: 500, comfort: 5 },
  { id: 'plush', cost: 900, comfort: 9 },
];

const rankBy = (importances) =>
  rank({ candidates: CANDIDATES, criteria: CRITERIA, importances }).results.map((r) => r.candidate.id);

test('the criterion you rate highest decides the winner', () => {
  assert.equal(rankBy({ cost: 5, comfort: 1 })[0], 'cheap');
  assert.equal(rankBy({ cost: 1, comfort: 5 })[0], 'plush');
});

test('flipping one rating flips the whole order', () => {
  assert.deepEqual(rankBy({ cost: 5, comfort: 1 }), ['cheap', 'middle', 'plush']);
  assert.deepEqual(rankBy({ cost: 1, comfort: 5 }), ['plush', 'middle', 'cheap']);
});

test('n/a removes a criterion entirely, not just softens it', () => {
  // With comfort ignored, only cost can matter - the ordering must be pure cost
  // and the ignored criterion must contribute nothing to any total.
  const { results } = rank({
    candidates: CANDIDATES,
    criteria: CRITERIA,
    importances: { cost: 3, comfort: 'na' },
  });
  assert.deepEqual(results.map((r) => r.candidate.id), ['cheap', 'middle', 'plush']);
  for (const result of results) {
    const comfort = result.breakdown.find((b) => b.key === 'comfort');
    assert.equal(comfort.weight, 0);
    assert.equal(comfort.contribution, 0);
    assert.equal(comfort.importance, 'na');
  }
});

test('an ignored criterion is never offered as a reason', () => {
  const { results } = rank({
    candidates: CANDIDATES,
    criteria: CRITERIA,
    importances: { cost: 4, comfort: 'na' },
  });
  for (const result of results) {
    assert.ok(!result.pros.some((p) => p.key === 'comfort'));
    assert.ok(!result.cons.some((c) => c.key === 'comfort'));
  }
});

test('rating everything n/a scores zero rather than producing NaN', () => {
  const ranked = rank({
    candidates: CANDIDATES,
    criteria: CRITERIA,
    importances: { cost: 'na', comfort: 'na' },
  });
  assert.equal(ranked.everythingIgnored, true);
  for (const result of ranked.results) assert.equal(result.score, 0);
});

test('scores land on a 0-100 scale and ranks are dense and ordered', () => {
  const { results } = rank({ candidates: CANDIDATES, criteria: CRITERIA, importances: { cost: 4, comfort: 2 } });
  assert.deepEqual(results.map((r) => r.rank), [1, 2, 3]);
  for (const result of results) {
    assert.ok(result.score >= 0 && result.score <= 100, `score out of range: ${result.score}`);
  }
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].score >= results[i].score);
  }
});

test('only relative importance matters, never the absolute numbers', () => {
  // Rating everything 3 must rank the same as rating everything 5: a user who
  // marks the whole form "very important" has expressed no preference at all.
  assert.deepEqual(rankBy({ cost: 3, comfort: 3 }), rankBy({ cost: 5, comfort: 5 }));

  // And two ratings in the same proportion must weigh the same.
  const { weights: a } = rank({ candidates: CANDIDATES, criteria: CRITERIA, importances: { cost: 4, comfort: 2 } });
  const { weights: b } = rank({ candidates: CANDIDATES, criteria: CRITERIA, importances: { cost: 2, comfort: 1 } });
  assert.ok(Math.abs(a.cost - b.cost) < 1e-9, `${a.cost} vs ${b.cost}`);
});

test('the explanation only cites criteria that actually moved the total', () => {
  const { results } = rank({ candidates: CANDIDATES, criteria: CRITERIA, importances: { cost: 5, comfort: 1 } });
  const winner = results[0];
  assert.match(explain(winner), /cost/i);
  const drivers = topDrivers(winner);
  assert.equal(drivers[0].key, 'cost');
  assert.ok(drivers.every((d) => d.weight > 0));
});

test('ranking is deterministic', () => {
  const once = rankBy({ cost: 4, comfort: 2 });
  const twice = rankBy({ cost: 4, comfort: 2 });
  assert.deepEqual(once, twice);
});

test('a criterion every candidate ties on cannot change the order', () => {
  const tied = CANDIDATES.map((c) => ({ ...c, comfort: 5 }));
  const order = (importances) =>
    rank({ candidates: tied, criteria: CRITERIA, importances }).results.map((r) => r.candidate.id);
  assert.deepEqual(order({ cost: 3, comfort: 1 }), order({ cost: 3, comfort: 5 }));
});

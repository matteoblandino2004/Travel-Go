import test from 'node:test';
import assert from 'node:assert/strict';
import { importanceToWeight, normalizeWeights, isIgnored, activeCriteria } from '../src/core/weights.js';

test('n/a means zero weight, in every spelling', () => {
  for (const value of ['na', 'N/A', null, undefined, 0]) {
    assert.equal(importanceToWeight(value), 0, `${value} should carry no weight`);
    assert.equal(isIgnored(value), true);
  }
});

test('a 5 dominates a 1 by more than a linear scale would', () => {
  const ratio = importanceToWeight(5) / importanceToWeight(1);
  assert.ok(ratio > 5, `expected superlinear separation, got ${ratio}`);
  assert.ok(ratio < 40, `separation should stay usable, got ${ratio}`);
});

test('weights are monotonic in importance', () => {
  const weights = [1, 2, 3, 4, 5].map((n) => importanceToWeight(n));
  for (let i = 1; i < weights.length; i++) assert.ok(weights[i] > weights[i - 1]);
});

test('normalised weights sum to 1 and exclude n/a criteria', () => {
  const weights = normalizeWeights({ a: 5, b: 3, c: 'na' }, ['a', 'b', 'c']);
  assert.equal(weights.c, 0);
  assert.ok(Math.abs(weights.a + weights.b - 1) < 1e-9);
  assert.ok(weights.a > weights.b);
});

test('all-n/a produces all-zero weights rather than NaN', () => {
  const weights = normalizeWeights({ a: 'na', b: 'na' }, ['a', 'b']);
  assert.deepEqual(weights, { a: 0, b: 0 });
});

test('activeCriteria lists what the user cares about, most important first', () => {
  assert.deepEqual(activeCriteria({ a: 2, b: 5, c: 'na' }, ['a', 'b', 'c']), ['b', 'a']);
});

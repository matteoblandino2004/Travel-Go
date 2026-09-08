import test from 'node:test';
import assert from 'node:assert/strict';
import { relativeScorer, curveScorer, percentile, NEUTRAL } from '../src/core/normalize.js';

test('lower-is-better inverts the scale', () => {
  const score = relativeScorer([100, 200, 300], { direction: 'lower' });
  assert.equal(score(100), 1);
  assert.equal(score(300), 0);
  assert.ok(Math.abs(score(200) - 0.5) < 1e-9);
});

test('identical candidates all score neutral instead of dividing by zero', () => {
  const score = relativeScorer([500, 500, 500], { direction: 'lower' });
  assert.equal(score(500), NEUTRAL);
});

test('a clean field is scaled between its own min and max', () => {
  const score = relativeScorer([10, 20, 30, 40, 50], { direction: 'higher' });
  assert.equal(score(10), 0);
  assert.equal(score(50), 1);
  assert.ok(Math.abs(score(30) - 0.5) < 1e-9);
});

test('one extreme outlier does not flatten the rest of the field', () => {
  // Nine fares between 400 and 600, plus one absurd 8000 first-class fare.
  const fares = [400, 425, 450, 475, 500, 525, 550, 575, 600, 8000];
  const score = relativeScorer(fares, { direction: 'lower' });
  const spread = score(400) - score(600);
  assert.ok(spread > 0.5, `the real fares should still separate, got spread ${spread}`);
  assert.equal(score(8000), 0, 'the outlier still scores worst');
});

test('unknown values score neutral rather than poisoning the total', () => {
  const score = relativeScorer([1, 2, 3], { direction: 'higher' });
  assert.equal(score(NaN), NEUTRAL);
  assert.equal(score(undefined), NEUTRAL);
});

test('curveScorer interpolates between breakpoints and clamps outside them', () => {
  const score = curveScorer([[0, 1], [1, 0.5], [2, 0]]);
  assert.equal(score(0), 1);
  assert.equal(score(1), 0.5);
  assert.ok(Math.abs(score(0.5) - 0.75) < 1e-9);
  assert.equal(score(-5), 1);
  assert.equal(score(99), 0);
});

test('percentile interpolates', () => {
  assert.equal(percentile([0, 10], 0.5), 5);
  assert.equal(percentile([7], 0.9), 7);
});

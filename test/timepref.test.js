import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTimeOfDay, toMinutes, minutesOutsideWindow, circularDistance } from '../src/core/timepref.js';

test('times parse to minutes past midnight', () => {
  assert.equal(toMinutes('00:00'), 0);
  assert.equal(toMinutes('09:30'), 570);
  assert.equal(toMinutes('23:59'), 1439);
  assert.ok(Number.isNaN(toMinutes('not a time')));
});

test('inside the requested window scores a perfect 1', () => {
  const window = { start: '08:00', end: '12:00' };
  assert.equal(scoreTimeOfDay('08:00', { window }), 1);
  assert.equal(scoreTimeOfDay('10:30', { window }), 1);
  assert.equal(scoreTimeOfDay('12:00', { window }), 1);
});

test('preference decays outside the window rather than falling off a cliff', () => {
  const window = { start: '08:00', end: '12:00' };
  const justOutside = scoreTimeOfDay('13:00', { window });
  const wellOutside = scoreTimeOfDay('17:00', { window });
  assert.ok(justOutside > wellOutside);
  assert.ok(justOutside > 0.4 && justOutside < 1, `expected a soft penalty, got ${justOutside}`);
  assert.ok(wellOutside < 0.2);
});

test('windows may wrap past midnight', () => {
  const redeye = { start: '22:00', end: '05:00' };
  assert.equal(minutesOutsideWindow(toMinutes('23:30'), toMinutes('22:00'), toMinutes('05:00')), 0);
  assert.equal(minutesOutsideWindow(toMinutes('03:00'), toMinutes('22:00'), toMinutes('05:00')), 0);
  assert.equal(scoreTimeOfDay('02:00', { window: redeye }), 1);
  assert.ok(scoreTimeOfDay('14:00', { window: redeye }) < 0.1);
});

test('clock distance wraps', () => {
  assert.equal(circularDistance(toMinutes('23:30'), toMinutes('00:30')), 60);
});

test('with no window, the default curve dislikes the small hours', () => {
  assert.ok(scoreTimeOfDay('04:00') < scoreTimeOfDay('09:00'));
  assert.ok(scoreTimeOfDay('01:00', { kind: 'arrival' }) < scoreTimeOfDay('14:00', { kind: 'arrival' }));
});

test('a named preset behaves like the equivalent window', () => {
  assert.equal(scoreTimeOfDay('09:00', { window: 'morning' }), 1);
  assert.ok(scoreTimeOfDay('23:00', { window: 'morning' }) < 0.1);
});

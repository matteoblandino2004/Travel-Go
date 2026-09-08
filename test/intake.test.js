import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWithRules } from '../src/nl/rules.js';
import { sanitize } from '../src/nl/parse.js';

test('reads a route out of plain English', () => {
  const parsed = parseWithRules('I want to fly from San Francisco to Tokyo for 5 nights');
  assert.equal(parsed.origin, 'San Francisco');
  assert.equal(parsed.destination, 'Tokyo');
  assert.equal(parsed.nights, 5);
});

test('picks up price sensitivity in either direction', () => {
  assert.equal(parseWithRules('as cheap as possible please').flight.cost, 5);
  assert.equal(parseWithRules("money is no object").flight.cost, 1);
});

test('"nonstop" is heard as caring a lot about layovers', () => {
  assert.equal(parseWithRules('nonstop only').flight.layovers, 5);
  assert.equal(parseWithRules("I don't mind a layover").flight.layovers, 1);
});

test('"I don\'t care about X" becomes n/a, not a low rating', () => {
  const parsed = parseWithRules("I don't care about miles or points");
  assert.equal(parsed.flight.miles, 'na');
  assert.equal(parsed.hotel.points, 'na');
});

test('a stated time of day becomes a window', () => {
  const morning = parseWithRules('morning flight please');
  assert.deepEqual(morning.departureWindow, { start: '07:00', end: '11:00' });
  assert.equal(parseWithRules('any time is fine').departureWindow, null);
});

test('named places are pulled out with their kind', () => {
  const parsed = parseWithRules('going to Tokyo, I want to see Senso-ji Temple and eat at Tsukiji Outer Market');
  const names = parsed.places.map((p) => p.name);
  assert.ok(names.includes('Senso-ji Temple'));
  assert.ok(names.includes('Tsukiji Outer Market'));
  assert.equal(parsed.places.find((p) => p.name === 'Tsukiji Outer Market').kind, 'food');
});

test('anything unsaid stays at the neutral 3', () => {
  const parsed = parseWithRules('Tokyo please');
  assert.equal(parsed.flight.lounge, 3);
  assert.equal(parsed.hotel.status, 3);
});

test('a month name resolves to a date in the future', () => {
  const parsed = parseWithRules('Tokyo in December');
  assert.match(parsed.departDate, /^\d{4}-12-01$/);
  assert.ok(new Date(parsed.departDate) > new Date(Date.now() - 86400000));
});

test('sanitize rejects anything that would poison the scorer', () => {
  const clean = sanitize({
    flight: { cost: 'very important', layovers: 9, lounge: 4 },
    hotel: { cost: 'na' },
    nights: 9999,
    cabin: 'first',
    departureWindow: { start: 'morning', end: '12:00' },
    places: [{ name: 'Fine', importance: 5 }, { name: '' }, null, 'nope'],
  });
  assert.equal(clean.flight.cost, 3, 'unparseable importance falls back to neutral');
  assert.equal(clean.flight.layovers, 3, 'out-of-range importance falls back to neutral');
  assert.equal(clean.flight.lounge, 4, 'valid values survive');
  assert.equal(clean.hotel.cost, 'na');
  assert.equal(clean.nights, null);
  assert.equal(clean.cabin, null);
  assert.equal(clean.departureWindow, null, 'a half-valid window is dropped whole');
  assert.equal(clean.places.length, 1);
});

test('sanitize fills in every criterion even from an empty object', () => {
  const clean = sanitize({});
  for (const value of [...Object.values(clean.flight), ...Object.values(clean.hotel)]) {
    assert.equal(value, 3);
  }
  assert.deepEqual(clean.places, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchPlaces, resolvePlace, describePlace, airportByCode, metroByCode,
  utcOffsetHours, airportsFor, datasetInfo, normalise,
} from '../src/data/airports.js';

test('the dataset covers the world, not a handful of cities', () => {
  const info = datasetInfo();
  assert.ok(info.airports > 7000, `only ${info.airports} airports`);
  assert.ok(info.countries > 200);
  assert.ok(info.metros >= 40);
});

test('cities that were never in the catalogue resolve', () => {
  for (const [query, code] of [
    ['Lisbon', 'LIS'], ['Tbilisi', 'TBS'], ['Kathmandu', 'KTM'], ['Hanoi', 'HAN'],
    ['Cusco', 'CUZ'], ['Reykjavik', 'KEF'], ['Chiang Mai', 'CNX'], ['Tallinn', 'TLL'],
  ]) {
    assert.equal(resolvePlace(query).place?.code, code, `${query} should resolve to ${code}`);
  }
});

test('a city name resolves to the metro, so every airport is searched', () => {
  for (const [query, code] of [['Tokyo', 'TYO'], ['London', 'LON'], ['New York', 'NYC'], ['Paris', 'PAR'], ['Milan', 'MIL']]) {
    const place = resolvePlace(query).place;
    assert.equal(place.code, code);
    assert.equal(place.kind, 'metro');
    assert.ok(place.airports.length > 1, `${code} should cover several airports`);
  }
  assert.deepEqual(resolvePlace('Tokyo').place.airports.map((a) => a.code), ['HND', 'NRT']);
});

test('an airport code resolves to that airport, not its metro', () => {
  assert.equal(resolvePlace('LGW').place.code, 'LGW');
  assert.equal(resolvePlace('HND').place.code, 'HND');
});

test('a major city outranks a tiny airport with the same name', () => {
  // "tok" exactly names Tok, Alaska. It is not what anyone means.
  assert.equal(searchPlaces('tok')[0].code, 'TYO');
  assert.equal(searchPlaces('lond')[0].code, 'LON');
  assert.equal(searchPlaces('bang')[0].code, 'BKK');
});

test('the busiest airport wins when a city has several', () => {
  // JAX is Jacksonville International; the others are municipal and military.
  assert.equal(resolvePlace('Jacksonville').place.code, 'JAX');
  assert.equal(resolvePlace('Reykjavik').place.code, 'KEF');
});

test('a genuinely ambiguous name offers the alternatives', () => {
  const london = resolvePlace('London');
  assert.equal(london.place.code, 'LON');
  const codes = london.alternatives.map((a) => a.code);
  assert.ok(codes.includes('YXU'), 'London, Ontario should be offered');
  assert.ok(codes.includes('LOZ'), 'London, Kentucky should be offered');

  const springfield = resolvePlace('Springfield');
  assert.ok(springfield.alternatives.length >= 2, 'there are a lot of Springfields');
});

test('airports serving one city collapse into a single choice', () => {
  // Heathrow, Gatwick and Stansted are one decision, not three.
  const results = searchPlaces('London');
  const gb = results.filter((p) => p.country === 'GB');
  assert.equal(gb.length, 1);
  assert.equal(gb[0].code, 'LON');
});

test('colloquial and former names work', () => {
  for (const [query, code] of [
    ['Haneda', 'HND'], ['Narita', 'NRT'], ['Orly', 'ORY'], ['Sheremetyevo', 'SVO'],
    ['Ben Gurion', 'TLV'], ['Saigon', 'SGN'], ['Bombay', 'BOM'], ['Tullamarine', 'MEL'],
  ]) {
    assert.equal(resolvePlace(query).place?.code, code, `${query} should resolve to ${code}`);
  }
});

test('accents and punctuation do not matter', () => {
  assert.equal(normalise('Düsseldorf'), 'dusseldorf');
  assert.equal(resolvePlace('Dusseldorf').place.code, 'DUS');
  assert.equal(resolvePlace('Krakow').place.code, 'KRK');
});

test('a timezone spelling can rescue a typo in the source data', () => {
  // The dataset's city field reads "Ushuahia"; its timezone reads "Ushuaia".
  assert.equal(resolvePlace('Ushuaia').place.code, 'USH');
});

test('a shared timezone is not treated as a shared city', () => {
  // Every Portuguese airport is Europe/Lisbon. Only one of them is in Lisbon.
  assert.equal(resolvePlace('Lisbon').place.code, 'LIS');
  // Every Japanese airport is Asia/Tokyo.
  assert.equal(resolvePlace('Tokyo').place.code, 'TYO');
  assert.ok(!searchPlaces('Tokyo').some((p) => p.city === 'Osaka'));
});

test('nowhere resolves to nothing, clearly', () => {
  assert.deepEqual(resolvePlace('qqzzxx nowhere'), { notFound: true });
  assert.deepEqual(searchPlaces(''), []);
});

test('timezone offsets are real, and handle DST and half-hours', () => {
  const january = new Date('2026-01-15T12:00:00Z');
  const july = new Date('2026-07-15T12:00:00Z');
  assert.equal(utcOffsetHours('Asia/Tokyo', january), 9, 'Japan has no DST');
  assert.equal(utcOffsetHours('Asia/Kathmandu', january), 5.75);
  assert.equal(utcOffsetHours('Europe/London', january), 0);
  assert.equal(utcOffsetHours('Europe/London', july), 1, 'BST');
  assert.equal(utcOffsetHours('America/New_York', january), -5);
  assert.equal(utcOffsetHours('America/New_York', july), -4, 'EDT');
  assert.equal(utcOffsetHours('Not/AZone'), 0, 'an unknown zone must not throw');
});

test('lookups by code work for airports and metros', () => {
  assert.equal(airportByCode('hnd').city, 'Tokyo');
  assert.equal(airportByCode('ZZZZ'), null);
  assert.equal(metroByCode('TYO').airports.length, 2);
  assert.equal(airportsFor(airportByCode('LIS')).length, 1);
  assert.equal(airportsFor(metroByCode('NYC')).length, 5);
});

test('descriptions say enough to choose between two Londons', () => {
  const [uk] = searchPlaces('LON');
  assert.match(describePlace(uk), /London \(LON\)/);
  assert.match(describePlace(resolvePlace('YXU').place), /Ontario/);
});

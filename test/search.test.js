import test from 'node:test';
import assert from 'node:assert/strict';
import { planTrip, resolvePlaces } from '../src/search.js';
import { searchFlights, clearCache } from '../src/data/providers/index.js';
import { searchHotels } from '../src/data/hotel-inventory.js';
import { rankFlights } from '../src/core/flights.js';
import { rankHotels } from '../src/core/hotels.js';
import { CITIES } from '../src/data/cities.js';

const neutralFlight = { cost: 3, departureTime: 3, arrivalTime: 3, layovers: 3, miles: 3, lounge: 3, duration: 3 };
const neutralHotel = { cost: 3, status: 3, access: 3, guestRating: 3, points: 3, cancellation: 3 };

test('the same query returns the same market twice', async () => {
  clearCache();
  const a = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  clearCache();
  const b = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  assert.deepEqual(a.offers, b.offers);
});

test('unknown cities are rejected rather than silently returning nothing', async () => {
  await assert.rejects(() => searchFlights({ from: 'SFO', to: 'Atlantis' }), /No sample inventory/);
  await assert.rejects(() => searchFlights({ from: 'SFO', to: 'SFO' }), /same city/);
  await assert.rejects(
    () => planTrip({ from: 'SFO', to: 'Atlantis', flight: neutralFlight, hotel: neutralHotel }),
    /don't have inventory/
  );
});

test('short-haul carriers are kept off intercontinental routes', async () => {
  const { offers } = await searchFlights({ from: 'SFO', to: 'TYO' });
  assert.ok(!offers.some((o) => o.airlineCode === 'FR'), 'Ryanair should not fly SFO-Tokyo');
});

test('caring only about price puts the cheapest flight first', async () => {
  const { offers } = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  const { results } = rankFlights(offers, { ...neutralFlight, cost: 5, departureTime: 'na', arrivalTime: 'na', layovers: 'na', miles: 'na', lounge: 'na', duration: 'na' });
  const cheapest = Math.min(...offers.map((o) => o.priceUsd));
  assert.equal(results[0].candidate.priceUsd, cheapest);
});

test('caring only about layovers puts a nonstop first', async () => {
  const { offers } = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  const { results } = rankFlights(offers, { cost: 'na', departureTime: 'na', arrivalTime: 'na', layovers: 5, miles: 'na', lounge: 'na', duration: 'na' });
  assert.equal(results[0].candidate.stops, 0);
});

test('a departure window pulls flights in that window up the list', async () => {
  const { offers } = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  const importances = { cost: 'na', departureTime: 5, arrivalTime: 'na', layovers: 'na', miles: 'na', lounge: 'na', duration: 'na' };
  const morning = rankFlights(offers, importances, { departureWindow: { start: '07:00', end: '11:00' } });
  const evening = rankFlights(offers, importances, { departureWindow: { start: '18:00', end: '22:00' } });

  const hour = (r) => Number(r.candidate.departLocal.slice(0, 2));
  assert.ok(hour(morning.results[0]) >= 6 && hour(morning.results[0]) <= 12, `got ${morning.results[0].candidate.departLocal}`);
  assert.ok(hour(evening.results[0]) >= 17 && hour(evening.results[0]) <= 23, `got ${evening.results[0].candidate.departLocal}`);
});

test('naming places changes which hotel wins', () => {
  const { hotels } = searchHotels({ city: 'TYO', nights: 3 });
  const onlyAccess = { cost: 'na', status: 'na', access: 5, guestRating: 'na', points: 'na', cancellation: 'na' };

  const nearSensoji = rankHotels(hotels, onlyAccess, {
    pois: [{ ...CITIES.TYO.pois[0], importance: 5 }], // Senso-ji, north-east
    transitQuality: CITIES.TYO.transitQuality,
  });
  const nearShibuya = rankHotels(hotels, onlyAccess, {
    pois: [{ ...CITIES.TYO.pois[1], importance: 5 }], // Shibuya, south-west
    transitQuality: CITIES.TYO.transitQuality,
  });

  assert.notEqual(nearSensoji.results[0].candidate.id, nearShibuya.results[0].candidate.id);
  // And the winner really is the closest one to what was asked for.
  const closest = (ranked) => ranked.results[0].access.legs[0].minutes;
  for (const ranked of [nearSensoji, nearShibuya]) {
    const best = Math.min(...ranked.results.map((r) => r.access.legs[0].minutes));
    assert.equal(closest(ranked), best);
  }
});

test('places that cannot be located are reported, not silently dropped', () => {
  const { resolved, unresolved } = resolvePlaces(
    [{ name: 'Senso-ji' }, { name: 'A cafe I saw once' }],
    CITIES.TYO
  );
  assert.equal(resolved.length, 1);
  assert.deepEqual(unresolved, ['A cafe I saw once']);
});

test('places given as raw coordinates are used as-is', () => {
  const { resolved } = resolvePlaces([{ name: 'Friend\'s flat', lat: 35.7, lng: 139.8 }], CITIES.TYO);
  assert.equal(resolved[0].source, 'coordinates');
  assert.equal(resolved[0].lat, 35.7);
});

test('planTrip returns both halves ranked, with reasons attached', async () => {
  const trip = await planTrip({
    from: 'San Francisco',
    to: 'Tokyo',
    date: '2026-10-12',
    nights: 4,
    flight: { ...neutralFlight, cost: 5, layovers: 4 },
    hotel: { ...neutralHotel, access: 5 },
    places: [{ name: 'Senso-ji', importance: 5 }],
  });

  assert.equal(trip.destination.name, 'Tokyo');
  assert.ok(trip.flights.results.length > 0);
  assert.ok(trip.hotels.results.length > 0);
  assert.equal(trip.flights.results[0].rank, 1);
  assert.ok(typeof trip.flights.results[0].why === 'string');
  assert.ok(trip.hotels.results[0].drivers.length > 0);
  assert.ok(trip.hotels.results[0].access.legs.length === 1);
  assert.equal(trip.provider.source, 'sample', 'and says where the flights came from');
});

test('elite status shows up as lounge access and richer earning', async () => {
  const plain = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  const elite = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12', profile: { alliances: { star: 'gold' } } });

  const starPlain = plain.offers.filter((o) => o.alliance === 'star');
  const starElite = elite.offers.filter((o) => o.alliance === 'star');
  assert.ok(starPlain.length > 0, 'fixture should include Star Alliance flights');
  assert.ok(starElite.every((o) => o.loungeAccess === 'full'));
  assert.ok(starElite[0].milesEarned > starPlain[0].milesEarned);
});

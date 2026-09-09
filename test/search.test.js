import test from 'node:test';
import assert from 'node:assert/strict';
import { planTrip, resolvePlaces, resolveEndpoint, destinationContext } from '../src/search.js';
import { searchFlights, clearCache } from '../src/data/providers/index.js';
import { searchHotels, clearCache as clearHotelCache } from '../src/data/hotels/index.js';
import { rankFlights } from '../src/core/flights.js';
import { rankHotels } from '../src/core/hotels.js';
import { resolvePlace } from '../src/data/airports.js';
import { CITIES } from '../src/data/cities.js';

const neutralFlight = { cost: 3, departureTime: 3, arrivalTime: 3, layovers: 3, miles: 3, lounge: 3, duration: 3 };
const neutralHotel = { cost: 3, status: 3, access: 3, guestRating: 3, points: 3, cancellation: 3 };
/** The sandbox has no geocoder; tests must not depend on one. */
const OFFLINE = { env: { TRAVELGO_GEOCODER: 'none' } };

test('the same query returns the same market twice', async () => {
  clearCache();
  const a = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  clearCache();
  const b = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  assert.deepEqual(a.offers, b.offers);
});

test('nowhere is rejected; anywhere real is not', async () => {
  await assert.rejects(() => searchFlights({ from: 'SFO', to: 'qqzzxx nowhere' }), /can't find anywhere/);
  await assert.rejects(() => searchFlights({ from: 'SFO', to: 'SFO' }), /both/);
  await assert.rejects(
    () => planTrip({ from: 'SFO', to: 'qqzzxx nowhere', flight: neutralFlight, hotel: neutralHotel }, OFFLINE),
    /can't find anywhere/
  );
});

test('short-haul carriers are kept off intercontinental routes', async () => {
  const { offers } = await searchFlights({ from: 'SFO', to: 'TYO' });
  assert.ok(!offers.some((o) => o.airlineCode === 'FR'), 'Ryanair should not fly SFO-Tokyo');
});

test('caring only about price puts the cheapest flight first', async () => {
  const { offers } = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  const { results } = rankFlights(offers, { ...neutralFlight, cost: 5, departureTime: 'na', arrivalTime: 'na', layovers: 'na', miles: 'na', lounge: 'na', duration: 'na' });
  assert.equal(results[0].candidate.priceUsd, Math.min(...offers.map((o) => o.priceUsd)));
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

/* ---------------------------------------------------------------- *
 * Worldwide coverage
 * ---------------------------------------------------------------- */

test('flights work for cities that were never in the catalogue', async () => {
  for (const [from, to] of [['Lisbon', 'Tbilisi'], ['Kathmandu', 'Dubai'], ['Reykjavik', 'Sao Paulo']]) {
    const result = await searchFlights({ from, to, date: '2026-10-12' });
    assert.ok(result.offers.length > 0, `${from} -> ${to} returned nothing`);
    for (const offer of result.offers) {
      assert.ok(offer.priceUsd > 0 && offer.durationMin > 0, `${from} -> ${to} produced an unusable offer`);
      assert.match(offer.departLocal, /^\d{2}:\d{2}$/);
    }
  }
});

test('local arrival times use the real timezone difference', async () => {
  // Lisbon (UTC+1 in October) to Tbilisi (UTC+4) is a +3 hour shift.
  const { offers } = await searchFlights({ from: 'Lisbon', to: 'Tbilisi', date: '2026-10-12' });
  const nonstop = offers.find((o) => o.stops === 0);
  assert.ok(nonstop, 'expected at least one nonstop');
  const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const expected = (toMinutes(nonstop.departLocal) + nonstop.durationMin + 3 * 60) % 1440;
  assert.equal(toMinutes(nonstop.arriveLocal), expected);
});

test('hotels work for cities that were never in the catalogue', async () => {
  clearHotelCache();
  for (const query of ['Tbilisi', 'Lisbon', 'Hanoi', 'Ushuaia']) {
    const place = resolvePlace(query).place;
    const result = await searchHotels({
      destination: { name: place.city, cityCode: place.code, country: place.country, centre: { lat: place.lat, lng: place.lng } },
      nights: 3,
    });
    assert.ok(result.hotels.length > 0, `${query} returned no hotels`);
    for (const hotel of result.hotels) {
      assert.ok(hotel.nightlyUsd > 0 && Number.isFinite(hotel.lat) && Number.isFinite(hotel.lng));
    }
  }
});

test('hotel prices track the local cost of a room', async () => {
  clearHotelCache();
  const priceIn = async (query) => {
    const place = resolvePlace(query).place;
    const { hotels } = await searchHotels({
      destination: { name: place.city, cityCode: place.code, country: place.country, centre: { lat: place.lat, lng: place.lng } },
      nights: 3,
    });
    return hotels.reduce((sum, h) => sum + h.nightlyUsd, 0) / hotels.length;
  };
  assert.ok(await priceIn('Zurich') > await priceIn('Hanoi'), 'Zurich should not price like Hanoi');
});

test('a metro searches every airport serving the city', async () => {
  const { offers, destination } = await searchFlights({ from: 'SFO', to: 'Tokyo', date: '2026-10-12' });
  assert.equal(destination.code, 'TYO');
  const arrivals = new Set(offers.map((o) => o.to));
  assert.ok(arrivals.has('HND') || arrivals.has('NRT'));
  for (const code of arrivals) assert.ok(['HND', 'NRT'].includes(code), `unexpected arrival airport ${code}`);
});

test('an ambiguous city resolves to the likeliest and offers the rest', async () => {
  const resolved = resolveEndpoint('London', 'destination');
  assert.equal(resolved.place.code, 'LON');
  const alternatives = resolved.alternatives.map((a) => a.code);
  assert.ok(alternatives.includes('YXU'), `expected London, Ontario among ${alternatives.join(',')}`);
});

test('transit quality is per-destination, and admits when it is guessing', async () => {
  const tokyo = await destinationContext(resolvePlace('Tokyo').place, OFFLINE);
  const houston = await destinationContext(resolvePlace('Houston').place, OFFLINE);
  assert.ok(tokyo.transit.value > houston.transit.value, 'Tokyo should be easier to cross than Houston');
  assert.equal(tokyo.transit.basis, 'city');
  assert.equal(houston.transit.basis, 'country');
});

test('without a geocoder the city centre falls back to the airport, and says so', async () => {
  const context = await destinationContext(resolvePlace('Tbilisi').place, OFFLINE);
  assert.equal(context.centre.approximate, true);
  assert.equal(context.centre.source, 'airport');
});

test('a curated city uses its real centre, no geocoder needed', async () => {
  const context = await destinationContext(resolvePlace('Tokyo').place, OFFLINE);
  assert.equal(context.centre.approximate, false);
  assert.equal(context.centre.source, 'catalogue');
  assert.ok(Math.abs(context.centre.lat - 35.68) < 0.1);
});

/* ---------------------------------------------------------------- *
 * Places
 * ---------------------------------------------------------------- */

test('naming places changes which hotel wins', async () => {
  clearHotelCache();
  const place = resolvePlace('Tokyo').place;
  const { hotels } = await searchHotels({
    destination: { name: place.city, cityCode: place.code, country: place.country, centre: { lat: 35.6812, lng: 139.7671 } },
    nights: 3,
  });
  const onlyAccess = { cost: 'na', status: 'na', access: 5, guestRating: 'na', points: 'na', cancellation: 'na' };

  const nearSensoji = rankHotels(hotels, onlyAccess, { pois: [{ ...CITIES.TYO.pois[0], importance: 5 }], transitQuality: 0.95 });
  const nearShibuya = rankHotels(hotels, onlyAccess, { pois: [{ ...CITIES.TYO.pois[1], importance: 5 }], transitQuality: 0.95 });

  assert.notEqual(nearSensoji.results[0].candidate.id, nearShibuya.results[0].candidate.id);
  for (const ranked of [nearSensoji, nearShibuya]) {
    const best = Math.min(...ranked.results.map((r) => r.access.legs[0].minutes));
    assert.equal(ranked.results[0].access.legs[0].minutes, best);
  }
});

test('curated places resolve with no geocoder', async () => {
  const { resolved, unresolved } = await resolvePlaces(
    [{ name: 'Senso-ji' }],
    resolvePlace('Tokyo').place,
    { lat: 35.68, lng: 139.76 },
    OFFLINE
  );
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].source, 'catalogue');
  assert.deepEqual(unresolved, []);
});

test('places the geocoder finds are used; places it cannot are reported', async () => {
  const fetchImpl = async (url) =>
    String(url).includes('Torre') || String(url).includes('torre')
      ? { ok: true, status: 200, json: async () => [{ name: 'Torre de Belém', display_name: 'Torre de Belém, Lisboa', lat: '38.6916', lon: '-9.2160', category: 'historic', type: 'castle', importance: 0.7 }] }
      : { ok: true, status: 200, json: async () => [] };

  const { resolved, unresolved } = await resolvePlaces(
    [{ name: 'Torre de Belem', importance: 5 }, { name: 'A cafe I once saw' }],
    resolvePlace('Lisbon').place,
    { lat: 38.72, lng: -9.14 },
    { fetchImpl }
  );
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].source, 'nominatim');
  assert.deepEqual(unresolved, ['A cafe I once saw']);
});

test('a geocoder that is down costs you the place, not the search', async () => {
  const { resolved, unresolved } = await resolvePlaces(
    [{ name: 'Somewhere' }],
    resolvePlace('Lisbon').place,
    { lat: 38.72, lng: -9.14 },
    { fetchImpl: async () => { throw new Error('offline'); } }
  );
  assert.deepEqual(resolved, []);
  assert.deepEqual(unresolved, ['Somewhere']);
});

test('places given as raw coordinates are used as-is', async () => {
  const { resolved } = await resolvePlaces(
    [{ name: "Friend's flat", lat: 41.7, lng: 44.8 }],
    resolvePlace('Tbilisi').place,
    { lat: 41.7, lng: 44.8 },
    OFFLINE
  );
  assert.equal(resolved[0].source, 'coordinates');
  assert.equal(resolved[0].lat, 41.7);
});

/* ---------------------------------------------------------------- *
 * End to end
 * ---------------------------------------------------------------- */

test('planTrip ranks both halves anywhere, with reasons and provenance', async () => {
  const trip = await planTrip(
    {
      from: 'Lisbon',
      to: 'Tbilisi',
      date: '2026-10-12',
      nights: 4,
      flight: { ...neutralFlight, cost: 5, layovers: 4 },
      hotel: { ...neutralHotel, access: 5 },
      places: [{ name: 'Narikala Fortress', lat: 41.6877, lng: 44.8092, importance: 5 }],
    },
    OFFLINE
  );

  assert.equal(trip.origin.code, 'LIS');
  assert.equal(trip.destination.code, 'TBS');
  assert.ok(trip.flights.results.length > 0);
  assert.ok(trip.hotels.results.length > 0);
  assert.equal(trip.flights.results[0].rank, 1);
  assert.ok(typeof trip.flights.results[0].why === 'string');
  assert.equal(trip.flights.provider.source, 'sample');
  assert.equal(trip.hotels.provider.source, 'sample');
  assert.equal(trip.hotels.results[0].access.legs.length, 1);
});

test('elite status shows up as lounge access and richer earning', async () => {
  clearCache();
  const plain = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12' });
  const elite = await searchFlights({ from: 'SFO', to: 'TYO', date: '2026-10-12', profile: { alliances: { star: 'gold' } } });

  const starPlain = plain.offers.filter((o) => o.alliance === 'star');
  const starElite = elite.offers.filter((o) => o.alliance === 'star');
  assert.ok(starPlain.length > 0, 'fixture should include Star Alliance flights');
  assert.ok(starElite.every((o) => o.loungeAccess === 'full'));
  assert.ok(starElite[0].milesEarned > starPlain[0].milesEarned);
});

/**
 * seats.aero adapter.
 *
 * Award space behaves differently from a cash fare in ways that are easy to
 * get quietly wrong: the price is in miles, the taxes are in minor units, the
 * timestamps are absolute rather than airport-local, and the ticket earns
 * nothing. Each of those has a test here because each would otherwise produce
 * a plausible-looking but wrong ranking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as seatsAero from '../src/data/providers/seatsaero.js';
import { enrichOffers } from '../src/data/enrich.js';
import { rankFlights } from '../src/core/flights.js';

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seatsaero.json'),
    'utf8',
  ),
);

const ENV = { SEATSAERO_API_KEY: 'test-key' };

/* ------------------------------------------------------------------ *
 * Money
 * ------------------------------------------------------------------ */

test('taxes are read as minor units', () => {
  assert.equal(seatsAero.parseTaxes(5600, ENV), 56);
  assert.equal(seatsAero.parseTaxes(0, ENV), 0);
});

test('the minor-unit reading can be turned off without touching the parser', () => {
  // The unit is not documented, so it has to be correctable in the field.
  const env = { ...ENV, SEATSAERO_TAXES_IN_CENTS: 'false' };
  assert.equal(seatsAero.parseTaxes(56, env), 56);
});

test('taxes that could not be a real award ticket are rejected, not ranked', () => {
  assert.ok(Number.isNaN(seatsAero.parseTaxes(9_000_00 * 100, ENV)));
  assert.ok(Number.isNaN(seatsAero.parseTaxes(-1, ENV)));
  assert.ok(Number.isNaN(seatsAero.parseTaxes('not a number', ENV)));
});

test('cost is taxes plus miles at the stated valuation', () => {
  // 60,000 miles at 1.4c is $840, plus $56 of taxes.
  assert.equal(seatsAero.awardCostUsd({ miles: 60000, taxesUsd: 56 }, ENV), 896);
});

test('the valuation is configurable, and changes the cost it produces', () => {
  const generous = { ...ENV, SEATSAERO_CENTS_PER_MILE: '2' };
  assert.equal(seatsAero.centsPerMile(generous), 2);
  assert.equal(seatsAero.awardCostUsd({ miles: 60000, taxesUsd: 56 }, generous), 1256);
});

test('a nonsense valuation falls back to the default rather than zeroing cost', () => {
  for (const bad of ['0', '-3', 'free', '']) {
    assert.equal(seatsAero.centsPerMile({ ...ENV, SEATSAERO_CENTS_PER_MILE: bad }), 1.4);
  }
});

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

test('absolute timestamps become airport-local wall-clock time', () => {
  // 22:30Z on 3 Nov is 17:30 at JFK: EST, because US DST ended on 1 Nov 2026.
  const departure = seatsAero.toAirportLocal('2026-11-03T22:30:00Z', 'JFK');
  assert.equal(departure.date, '2026-11-03');
  assert.equal(departure.time, '17:30');

  // London is on GMT by then, so the same instant reads unchanged.
  const arrival = seatsAero.toAirportLocal('2026-11-04T10:15:00Z', 'LHR');
  assert.equal(arrival.time, '10:15');
});

test('a timestamp with no zone is taken as already local', () => {
  const local = seatsAero.toAirportLocal('2026-11-03T08:05:00', 'JFK');
  assert.equal(local.time, '08:05');
});

test('duration is measured between instants, not between wall clocks', () => {
  // The clocks say 17:30 -> 10:15, which looks like 16h45m. It is 11h45m.
  const trip = { DepartsAt: '2026-11-03T22:30:00Z', ArrivesAt: '2026-11-04T10:15:00Z' };
  const departure = seatsAero.toAirportLocal(trip.DepartsAt, 'JFK');
  const arrival = seatsAero.toAirportLocal(trip.ArrivesAt, 'LHR');
  assert.equal(seatsAero.durationOf(trip, departure, arrival), 705);
});

test('a TotalDuration in the wrong unit is ignored rather than trusted', () => {
  const trip = { TotalDuration: 60 * 24 * 30 };
  assert.ok(Number.isNaN(seatsAero.durationOf(trip, null, null)));
  assert.equal(seatsAero.durationOf({ TotalDuration: 435 }, null, null), 435);
});

/* ------------------------------------------------------------------ *
 * Availability rows
 * ------------------------------------------------------------------ */

test('only the cabin asked for is offered', () => {
  const [businessRow, economyRow] = fixture.search.data;

  assert.equal(seatsAero.cabinAvailability(businessRow, 'business', ENV).miles, 60000);
  assert.equal(seatsAero.cabinAvailability(businessRow, 'economy', ENV), null);
  assert.equal(seatsAero.cabinAvailability(economyRow, 'business', ENV), null);
  assert.equal(seatsAero.cabinAvailability(economyRow, 'economy', ENV).miles, 33000);
});

test('a cabin flagged available but priced at zero is not an offer', () => {
  const row = { JAvailable: true, JMileageCostRaw: 0, JTotalTaxes: 100 };
  assert.equal(seatsAero.cabinAvailability(row, 'business', ENV), null);
});

/* ------------------------------------------------------------------ *
 * Whole response
 * ------------------------------------------------------------------ */

test('a cached row plus its trip becomes a rankable offer', () => {
  const { offers } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'business' },
    ENV,
  );

  assert.equal(offers.length, 1, 'only the business row should match');
  const [offer] = offers;

  assert.equal(offer.from, 'JFK');
  assert.equal(offer.to, 'LHR');
  assert.equal(offer.departLocal, '17:30');
  assert.equal(offer.arriveLocal, '10:15');
  assert.equal(offer.arrivesNextDay, true);
  assert.equal(offer.durationMin, 705);
  assert.equal(offer.stops, 0);
  assert.equal(offer.cabin, 'business');
  assert.equal(offer.airline, 'Air Canada');
  assert.equal(offer.priceUsd, 896);
  assert.deepEqual(offer.flightNumbers, ['AC856']);
  assert.equal(offer.segments[0].aircraft, 'Boeing 787-9');
});

test('award metadata is carried, so the UI need not re-derive it', () => {
  const { offers } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'business' },
    ENV,
  );
  const [offer] = offers;

  assert.equal(offer.award, true);
  assert.equal(offer.programme, 'aeroplan');
  assert.equal(offer.mileageCost, 60000);
  assert.equal(offer.taxesUsd, 56);
  assert.equal(offer.remainingSeats, 2);
  assert.equal(offer.centsPerMile, 1.4);
  assert.match(offer.priceBasis, /60,000 miles \+ \$56\.00 taxes/);
});

test('a multi-segment award reports its layover airport', () => {
  const { offers } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'economy' },
    ENV,
  );
  const [offer] = offers;

  assert.equal(offer.stops, 1);
  assert.deepEqual(offer.layoverAirports, ['ORD']);
  assert.equal(offer.segments.length, 2);
  assert.equal(offer.priceUsd, 33000 * 0.014 + 41.2);
});

test('real distance from the supplier is used rather than estimated', () => {
  const { offers } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'business' },
    ENV,
  );
  // 3,451 statute miles of great circle, in km.
  assert.equal(offers[0].distanceKm, 5554);
});

/* ------------------------------------------------------------------ *
 * The thing most likely to go quietly wrong
 * ------------------------------------------------------------------ */

test('an award ticket is not credited with earning miles it does not earn', () => {
  const { offers } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'business' },
    ENV,
  );

  // enrich.js derives earning from the fare whenever it is missing. A synthetic
  // award cost is not a fare, so the adapter states zero and enrichment must
  // leave it alone rather than invent a figure from a valuation.
  const [enriched] = enrichOffers(offers, { alliances: { star: 'gold' } });
  assert.equal(enriched.milesEarned, 0);
  assert.equal(enriched.eliteQualifyingPoints, 0);
  assert.ok(
    !enriched.estimatedFields.includes('milesEarned'),
    'earning was re-derived from a valued price',
  );
  assert.match(enriched.earningBasis, /earns no redeemable miles/i);
});

test('lounge access is still derived, because cabin and status do decide it', () => {
  const { offers } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'business' },
    ENV,
  );
  const [enriched] = enrichOffers(offers, {});
  assert.ok(enriched.loungeAccess, 'a business award should still price lounge access');
});

test('award offers rank without crashing, and cost reflects the miles', () => {
  const { offers: business } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'business' },
    ENV,
  );
  const { offers: economy } = seatsAero.parseResponse(
    { search: fixture.search, tripsById: fixture.trips },
    { cabin: 'economy' },
    ENV,
  );

  const { results } = rankFlights(enrichOffers([...business, ...economy], {}), {
    cost: 5,
    layovers: 4,
    departureTime: 3,
    arrivalTime: 3,
    miles: 'na',
    lounge: 'na',
    duration: 3,
  });

  assert.equal(results.length, 2);
  for (const entry of results) {
    assert.ok(Number.isFinite(entry.score), 'every award offer must score');
    assert.ok(entry.rank >= 1);
  }
  // The 33k economy award costs less than the 60k business one.
  const cheapest = results
    .map((r) => r.candidate)
    .sort((a, b) => a.priceUsd - b.priceUsd)[0];
  assert.equal(cheapest.mileageCost, 33000);
});

/* ------------------------------------------------------------------ *
 * Network behaviour
 * ------------------------------------------------------------------ */

test('the key goes in the Partner-Authorization header', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    if (String(url).includes('/search')) {
      return { ok: true, status: 200, json: async () => fixture.search };
    }
    const rowId = String(url).split('/trips/')[1];
    return { ok: true, status: 200, json: async () => fixture.trips[rowId] ?? { data: [] } };
  };

  const result = await seatsAero.searchFlights(
    { fromAirport: 'JFK', toAirport: 'LHR', date: '2026-11-03', cabin: 'business' },
    { env: ENV, fetchImpl },
  );

  assert.equal(seen[0].headers['Partner-Authorization'], 'test-key');
  assert.match(seen[0].url, /origin_airport=JFK/);
  assert.match(seen[0].url, /destination_airport=LHR/);
  assert.match(seen[0].url, /start_date=2026-11-03/);
  assert.equal(result.offers.length, 1);
  assert.match(result.note, /valued at 1\.4c/);
});

test('an unusable key says so, rather than falling through as "no availability"', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    json: async () => ({ message: 'unauthorized' }),
  });
  await assert.rejects(
    seatsAero.searchFlights(
      { fromAirport: 'JFK', toAirport: 'LHR', date: '2026-11-03' },
      { env: ENV, fetchImpl },
    ),
    /rejected the API key \(401\)/,
  );
});

test('a rate limit is reported as a rate limit', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    json: async () => null,
  });
  await assert.rejects(
    seatsAero.searchFlights(
      { fromAirport: 'JFK', toAirport: 'LHR', date: '2026-11-03' },
      { env: ENV, fetchImpl },
    ),
    /rate limit/i,
  );
});

test('no award space is an explained empty result, not an error', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [], count: 0, hasMore: false }),
  });
  const result = await seatsAero.searchFlights(
    { fromAirport: 'JFK', toAirport: 'LHR', date: '2026-11-03', cabin: 'first' },
    { env: ENV, fetchImpl },
  );
  assert.deepEqual(result.offers, []);
  assert.match(result.note, /No first award space/);
});

test('a row whose trip lookup fails is reported, not silently dropped', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/search')) {
      return { ok: true, status: 200, json: async () => fixture.search };
    }
    return { ok: false, status: 500, statusText: 'Server Error', json: async () => null };
  };
  const result = await seatsAero.searchFlights(
    { fromAirport: 'JFK', toAirport: 'LHR', date: '2026-11-03', cabin: 'business' },
    { env: ENV, fetchImpl },
  );
  assert.equal(result.offers.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].missing.join(), /trips/);
});

test('the trip lookups are bounded, because each one costs quota', async () => {
  let tripCalls = 0;
  const manyRows = {
    data: Array.from({ length: 40 }, (_, i) => ({
      ...fixture.search.data[0],
      ID: `row-${i}`,
      JMileageCostRaw: 50000 + i,
    })),
  };
  const fetchImpl = async (url) => {
    if (String(url).includes('/search')) {
      return { ok: true, status: 200, json: async () => manyRows };
    }
    tripCalls += 1;
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };

  await seatsAero.searchFlights(
    { fromAirport: 'JFK', toAirport: 'LHR', date: '2026-11-03', cabin: 'business' },
    { env: { ...ENV, SEATSAERO_TRIP_LIMIT: '5' }, fetchImpl },
  );
  assert.equal(tripCalls, 5);
});

test('the cheapest rows are the ones resolved when the shortlist is capped', async () => {
  const requested = [];
  const rows = {
    data: [80000, 30000, 55000].map((miles, i) => ({
      ...fixture.search.data[0],
      ID: `row-${miles}`,
      JMileageCostRaw: miles,
    })),
  };
  const fetchImpl = async (url) => {
    if (String(url).includes('/search')) {
      return { ok: true, status: 200, json: async () => rows };
    }
    requested.push(String(url).split('/trips/')[1]);
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };

  await seatsAero.searchFlights(
    { fromAirport: 'JFK', toAirport: 'LHR', date: '2026-11-03', cabin: 'business' },
    { env: { ...ENV, SEATSAERO_TRIP_LIMIT: '1' }, fetchImpl },
  );
  assert.deepEqual(requested, ['row-30000']);
});

test('the provider is registered and advertises what it needs', async () => {
  const { PROVIDERS, resolveProvider, providerStatus } = await import(
    '../src/data/providers/index.js'
  );
  assert.ok(PROVIDERS.some((p) => p.id === 'seatsaero'));

  // It answers a different question to a cash supplier, so it is opt-in.
  assert.equal(resolveProvider({ SEATSAERO_API_KEY: 'k' }).id, 'seatsaero');
  assert.equal(
    resolveProvider({ TRAVELGO_FLIGHT_PROVIDER: 'seatsaero', SEATSAERO_API_KEY: 'k' }).id,
    'seatsaero',
  );
  assert.throws(
    () => resolveProvider({ TRAVELGO_FLIGHT_PROVIDER: 'seatsaero' }),
    /SEATSAERO_API_KEY/,
  );

  const status = providerStatus({ SEATSAERO_API_KEY: 'k' });
  const entry = status.available.find((p) => p.id === 'seatsaero');
  assert.deepEqual(entry.credentials, ['SEATSAERO_API_KEY']);
  assert.equal(entry.configured, true);
});

/* ------------------------------------------------------------------ *
 * Metro codes
 * ------------------------------------------------------------------ */

test('a metropolitan code is expanded into real airports', async () => {
  // Upstream resolution prefers NYC/LON, but seats.aero indexes airports.
  // Querying the metro code would return nothing, which reads as "no award
  // space" rather than "wrong question".
  const { resolvePlace } = await import('../src/data/airports.js');

  const nyc = seatsAero.airportCodesFor(resolvePlace('New York').place);
  assert.ok(nyc.includes('JFK'), `expected JFK in ${nyc.join(',')}`);
  assert.ok(nyc.includes('EWR'));
  assert.ok(!nyc.includes('NYC'), 'the metro code itself is not an airport');

  // The big international fields come first, and the list stays bounded.
  assert.ok(nyc.length <= 5);
  assert.ok(['JFK', 'EWR'].includes(nyc[0]));

  const lon = seatsAero.airportCodesFor(resolvePlace('London').place);
  assert.ok(lon.includes('LHR'));
  assert.ok(!lon.includes('LON'));
});

test('a single airport is passed through unchanged', async () => {
  const { resolvePlace } = await import('../src/data/airports.js');
  assert.deepEqual(seatsAero.airportCodesFor(resolvePlace('LHR').place), ['LHR']);
});

test('with no resolved place, the plain code is still used', () => {
  assert.deepEqual(seatsAero.airportCodesFor(null, 'SFO'), ['SFO']);
  assert.deepEqual(seatsAero.airportCodesFor(undefined, undefined), []);
});

test('the request asks about the expanded airports, not the metro', async () => {
  const { resolvePlace } = await import('../src/data/airports.js');
  let searchUrl = '';
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/search')) {
      searchUrl = u;
      return { ok: true, status: 200, json: async () => fixture.search };
    }
    const rowId = u.split('/trips/')[1];
    return { ok: true, status: 200, json: async () => fixture.trips[rowId] ?? { data: [] } };
  };

  await seatsAero.searchFlights(
    {
      origin: resolvePlace('New York').place,
      destination: resolvePlace('London').place,
      fromAirport: 'NYC',
      toAirport: 'LON',
      date: '2026-11-03',
      cabin: 'business',
    },
    { env: ENV, fetchImpl },
  );

  const params = new URLSearchParams(searchUrl.split('?')[1]);
  assert.ok(params.get('origin_airport').split(',').includes('JFK'));
  assert.ok(params.get('destination_airport').split(',').includes('LHR'));
  assert.ok(!params.get('origin_airport').includes('NYC'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as googleFlights from '../src/data/providers/serpapi.js';
import * as amadeus from '../src/data/providers/amadeus.js';
import * as sample from '../src/data/providers/sample.js';
import { searchFlights, resolveProvider, resolveLocationCode, providerStatus, clearCache } from '../src/data/providers/index.js';
import { resolvePlace } from '../src/data/airports.js';
import { deriveEarning, deriveLounge, enrichOffer } from '../src/data/enrich.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

/* ---------------------------------------------------------------- *
 * Google Flights (SerpApi)
 * ---------------------------------------------------------------- */

test('Google Flights: both result groups are ranked, not just Google\'s shortlist', () => {
  const { offers } = googleFlights.parseResponse(fixture('google-flights.json'));
  assert.equal(offers.length, 3, 'one best_flight plus two other_flights');
  assert.equal(offers.filter((o) => o.googleShortlisted).length, 1);
});

test('Google Flights: a nonstop is parsed into the canonical shape', () => {
  const { offers } = googleFlights.parseResponse(fixture('google-flights.json'));
  const nonstop = offers.find((o) => o.id === 'gf-0');

  assert.equal(nonstop.airline, 'ANA');
  assert.equal(nonstop.airlineCode, 'NH');
  assert.equal(nonstop.from, 'SFO');
  assert.equal(nonstop.to, 'HND');
  assert.equal(nonstop.departLocal, '11:05');
  assert.equal(nonstop.arriveLocal, '14:40');
  assert.equal(nonstop.dayShift, 1, 'lands the next calendar day');
  assert.equal(nonstop.arrivesNextDay, true);
  assert.equal(nonstop.durationMin, 695);
  assert.equal(nonstop.stops, 0);
  assert.equal(nonstop.priceUsd, 842);
  assert.equal(nonstop.cabin, 'economy');
  assert.equal(nonstop.carbonKg, 1243, 'grams converted to kg');
});

test('Google Flights: a connection collapses to stops, layover airports and layover time', () => {
  const { offers } = googleFlights.parseResponse(fixture('google-flights.json'));
  const connecting = offers.find((o) => o.id === 'gf-1');

  assert.equal(connecting.stops, 1);
  assert.deepEqual(connecting.layoverAirports, ['SEA']);
  assert.equal(connecting.layoverMinutes, 155);
  assert.equal(connecting.from, 'SFO', 'origin is the first segment');
  assert.equal(connecting.to, 'NRT', 'destination is the last segment');
  assert.equal(connecting.durationMin, 905);
  assert.equal(connecting.oftenDelayed, true, 'a flagged segment flags the itinerary');
  assert.equal(connecting.segments.length, 2);
});

test('Google Flights: cabin is read per result, not assumed from the query', () => {
  const { offers } = googleFlights.parseResponse(fixture('google-flights.json'), { cabin: 'economy' });
  assert.equal(offers.find((o) => o.id === 'gf-2').cabin, 'business');
});

test('Google Flights: request is built with the codes the API expects', async () => {
  let calledUrl = null;
  await googleFlights.searchFlights(
    { fromAirport: 'SFO', toAirport: 'TYO', date: '2026-10-12', cabin: 'business', maxStops: 'nonstop' },
    {
      env: { SERPAPI_API_KEY: 'test-key' },
      fetchImpl: async (url) => {
        calledUrl = new URL(url);
        return { ok: true, status: 200, json: async () => fixture('google-flights.json') };
      },
    }
  );

  const params = calledUrl.searchParams;
  assert.equal(params.get('engine'), 'google_flights');
  assert.equal(params.get('departure_id'), 'SFO');
  assert.equal(params.get('arrival_id'), 'TYO');
  assert.equal(params.get('type'), '2', 'one way');
  assert.equal(params.get('travel_class'), '3', 'business');
  assert.equal(params.get('stops'), '1', 'nonstop only');
  assert.equal(params.get('api_key'), 'test-key');
});

test('Google Flights: an API error surfaces its message', async () => {
  await assert.rejects(
    () =>
      googleFlights.searchFlights(
        { fromAirport: 'SFO', toAirport: 'TYO', date: '2026-10-12' },
        {
          env: { SERPAPI_API_KEY: 'k' },
          fetchImpl: async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'Invalid API key' }) }),
        }
      ),
    /Invalid API key/
  );
});

/* ---------------------------------------------------------------- *
 * Amadeus
 * ---------------------------------------------------------------- */

test('Amadeus: ISO durations and local times are parsed', () => {
  const { offers } = amadeus.parseResponse(fixture('amadeus.json'));
  const nonstop = offers.find((o) => o.id === 'am-1');

  assert.equal(nonstop.airline, 'All Nippon Airways');
  assert.equal(nonstop.airlineCode, 'NH');
  assert.equal(nonstop.durationMin, 695, 'PT11H35M');
  assert.equal(nonstop.departLocal, '11:05');
  assert.equal(nonstop.arriveLocal, '14:40');
  assert.equal(nonstop.dayShift, 1);
  assert.equal(nonstop.priceUsd, 842.3, 'grandTotal, not base');
  assert.equal(nonstop.cabin, 'economy');
  assert.equal(nonstop.includedCheckedBags, 2);
});

test('Amadeus: layover time is total duration minus time in the air', () => {
  const { offers } = amadeus.parseResponse(fixture('amadeus.json'));
  const connecting = offers.find((o) => o.id === 'am-2');

  assert.equal(connecting.stops, 1);
  assert.deepEqual(connecting.layoverAirports, ['SEA']);
  assert.equal(connecting.durationMin, 905, 'PT15H05M');
  assert.equal(connecting.layoverMinutes, 905 - (135 + 615));
});

test('Amadeus: the same trip parses to the same numbers as Google Flights', () => {
  // Both fixtures describe the same two itineraries. Whatever supplier is
  // configured, the ranker must see identical facts.
  const fromGoogle = googleFlights.parseResponse(fixture('google-flights.json')).offers;
  const fromAmadeus = amadeus.parseResponse(fixture('amadeus.json')).offers;

  const compare = (a, b) => {
    assert.equal(a.from, b.from);
    assert.equal(a.to, b.to);
    assert.equal(a.departLocal, b.departLocal);
    assert.equal(a.arriveLocal, b.arriveLocal);
    assert.equal(a.stops, b.stops);
    assert.equal(a.durationMin, b.durationMin);
    assert.equal(a.cabin, b.cabin);
    assert.equal(a.airlineCode, b.airlineCode);
  };
  compare(fromGoogle[0], fromAmadeus[0]);
  compare(fromGoogle[1], fromAmadeus[1]);
});

test('Amadeus: the token is fetched once and reused', async () => {
  amadeus.resetTokenCache();
  let tokenCalls = 0;
  const env = { AMADEUS_CLIENT_ID: 'id', AMADEUS_CLIENT_SECRET: 'secret' };
  const fetchImpl = async (url) => {
    if (String(url).includes('/oauth2/token')) {
      tokenCalls += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 1799 }) };
    }
    assert.equal(new URL(url).searchParams.get('originLocationCode'), 'SFO');
    return { ok: true, status: 200, json: async () => fixture('amadeus.json') };
  };

  const query = { fromAirport: 'SFO', toAirport: 'TYO', date: '2026-10-12' };
  await amadeus.searchFlights(query, { env, fetchImpl });
  await amadeus.searchFlights(query, { env, fetchImpl });
  assert.equal(tokenCalls, 1, 'the second search reuses the cached token');
  amadeus.resetTokenCache();
});

test('Amadeus: a failed auth says so clearly', async () => {
  amadeus.resetTokenCache();
  await assert.rejects(
    () =>
      amadeus.searchFlights(
        { fromAirport: 'SFO', toAirport: 'TYO', date: '2026-10-12' },
        {
          env: { AMADEUS_CLIENT_ID: 'id', AMADEUS_CLIENT_SECRET: 'bad' },
          fetchImpl: async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error_description: 'invalid client' }) }),
        }
      ),
    /invalid client/
  );
  amadeus.resetTokenCache();
});

/* ---------------------------------------------------------------- *
 * Shape guard
 * ---------------------------------------------------------------- */

test('a supplier that changes shape fails loudly instead of ranking nothing', () => {
  const broken = { data: [{ id: '1', itineraries: [{ duration: 'PT2H', segments: [{ departure: { iataCode: 'SFO' }, arrival: { iataCode: 'LAX' }, carrierCode: 'UA' }] }] }] };
  assert.throws(() => amadeus.parseResponse(broken), /response shape has probably changed/);
});

test('one malformed offer among good ones is dropped, not fatal', () => {
  const payload = fixture('google-flights.json');
  payload.other_flights.push({ flights: [{ departure_airport: { id: 'SFO' } }], total_duration: 100 });
  const parsed = googleFlights.parseResponse(payload);
  assert.equal(parsed.offers.length, 3);
  assert.equal(parsed.dropped.length, 1);
});

/* ---------------------------------------------------------------- *
 * Derived fields
 * ---------------------------------------------------------------- */

test('miles are derived because no feed supplies them', () => {
  const { offers } = googleFlights.parseResponse(fixture('google-flights.json'));
  const raw = offers[0];
  assert.equal(raw.milesEarned, undefined, 'Google Flights carries no earning data');

  const enriched = enrichOffer(raw, {});
  assert.ok(enriched.milesEarned > 0);
  assert.ok(enriched.estimatedFields.includes('milesEarned'), 'and it is marked as an estimate');
});

test('revenue programmes earn on fare, distance programmes on miles flown', () => {
  const base = { cabin: 'economy', priceUsd: 800, durationMin: 660, stops: 0 };
  assert.equal(deriveEarning({ ...base, airlineCode: 'UA' }).basis, 'revenue');
  assert.equal(deriveEarning({ ...base, airlineCode: 'NH' }).basis, 'distance');
});

test('status increases earning', () => {
  const offer = { airlineCode: 'UA', cabin: 'economy', priceUsd: 800, durationMin: 660, stops: 0 };
  const plain = deriveEarning(offer, {});
  const elite = deriveEarning(offer, { alliances: { star: 'gold' } });
  assert.ok(elite.milesEarned > plain.milesEarned);
});

test('lounge access follows cabin, then alliance status, then membership', () => {
  const economy = { airlineCode: 'UA', cabin: 'economy', priceUsd: 500 };
  assert.equal(deriveLounge({ ...economy, cabin: 'business' }), 'full');
  assert.equal(deriveLounge(economy, {}), 'none');
  assert.equal(deriveLounge(economy, { alliances: { star: 'gold' } }), 'full');
  assert.equal(deriveLounge(economy, { alliances: { star: 'silver' } }), 'partner');
  assert.equal(deriveLounge(economy, { loungeMembership: true }), 'full');
  // Status with the wrong alliance does nothing for you here.
  assert.equal(deriveLounge(economy, { alliances: { oneworld: 'gold' } }), 'none');
});

test('a supplied value is never overwritten by an estimate', () => {
  const enriched = enrichOffer(
    { airlineCode: 'UA', cabin: 'economy', priceUsd: 500, durationMin: 300, stops: 0, milesEarned: 12345, loungeAccess: 'partner' },
    {}
  );
  assert.equal(enriched.milesEarned, 12345);
  assert.equal(enriched.loungeAccess, 'partner');
  assert.deepEqual(enriched.estimatedFields, ['distanceKm']);
});

test('an unknown carrier still ranks, just with no alliance benefits', () => {
  const enriched = enrichOffer(
    { airlineCode: 'ZZ', airline: 'Some Regional', cabin: 'economy', priceUsd: 300, durationMin: 120, stops: 0 },
    { alliances: { star: 'gold' } }
  );
  assert.equal(enriched.alliance, null);
  assert.equal(enriched.loungeAccess, 'none');
  assert.ok(enriched.milesEarned > 0);
});

/* ---------------------------------------------------------------- *
 * Registry
 * ---------------------------------------------------------------- */

test('with no credentials the sample provider is used', () => {
  assert.equal(resolveProvider({}).id, 'sample');
  assert.equal(providerStatus({}).live, false);
});

test('a configured supplier is preferred over sample data', () => {
  assert.equal(resolveProvider({ SERPAPI_API_KEY: 'k' }).id, 'google-flights');
  assert.equal(resolveProvider({ AMADEUS_CLIENT_ID: 'a', AMADEUS_CLIENT_SECRET: 'b' }).id, 'amadeus');
  assert.equal(providerStatus({ SERPAPI_API_KEY: 'k' }).live, true);
});

test('an explicit choice is honoured, and refused when unconfigured', () => {
  assert.equal(resolveProvider({ TRAVELGO_FLIGHT_PROVIDER: 'amadeus', AMADEUS_CLIENT_ID: 'a', AMADEUS_CLIENT_SECRET: 'b' }).id, 'amadeus');
  assert.throws(() => resolveProvider({ TRAVELGO_FLIGHT_PROVIDER: 'amadeus' }), /AMADEUS_CLIENT_ID/);
  assert.throws(() => resolveProvider({ TRAVELGO_FLIGHT_PROVIDER: 'nope' }), /Unknown flight provider/);
});

test('city names become the metro codes a supplier expects', () => {
  assert.equal(resolveLocationCode('Tokyo'), 'TYO', 'metro code covers Haneda and Narita');
  assert.equal(resolveLocationCode('New York'), 'NYC');
  assert.equal(resolveLocationCode('Haneda'), 'HND', 'a named airport resolves to that airport');
  assert.equal(resolveLocationCode('lax'), 'LAX');
  // Cities that were never in the hand-written catalogue now resolve too.
  assert.equal(resolveLocationCode('Lisbon'), 'LIS');
  assert.equal(resolveLocationCode('Tbilisi'), 'TBS');
  assert.equal(resolveLocationCode('Kathmandu'), 'KTM');
  assert.throws(() => resolveLocationCode('qqzzxx nowhere'), /can't find anywhere/);
});

test('a live supplier failing falls back to sample data with a note', async () => {
  clearCache();
  const result = await searchFlights(
    { from: 'SFO', to: 'Tokyo', date: '2026-10-12' },
    {
      env: { SERPAPI_API_KEY: 'k' },
      fetchImpl: async () => { throw new Error('network down'); },
    }
  );
  assert.equal(result.source, 'sample');
  assert.equal(result.live, false);
  assert.match(result.notes[0], /network down/);
  assert.ok(result.offers.length > 0, 'the user still gets a ranked page');
});

test('results are cached so a paid supplier is not re-billed per keystroke', async () => {
  clearCache();
  let calls = 0;
  const env = { SERPAPI_API_KEY: 'k' };
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => fixture('google-flights.json') };
  };
  const query = { from: 'SFO', to: 'Tokyo', date: '2026-10-12' };

  const first = await searchFlights(query, { env, fetchImpl });
  const second = await searchFlights(query, { env, fetchImpl });
  assert.equal(calls, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.offers.length, first.offers.length);

  // A different date is a different search.
  await searchFlights({ ...query, date: '2026-10-13' }, { env, fetchImpl });
  assert.equal(calls, 2);
  clearCache();
});

test('the profile is applied after caching, so status changes are not stale', async () => {
  clearCache();
  const env = { SERPAPI_API_KEY: 'k' };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => fixture('google-flights.json') });
  const query = { from: 'SFO', to: 'Tokyo', date: '2026-10-12' };

  const plain = await searchFlights(query, { env, fetchImpl });
  const elite = await searchFlights({ ...query, profile: { alliances: { star: 'gold' } } }, { env, fetchImpl });

  assert.equal(elite.cached, true, 'the market itself was reused');
  const nhPlain = plain.offers.find((o) => o.airlineCode === 'NH');
  const nhElite = elite.offers.find((o) => o.airlineCode === 'NH');
  assert.equal(nhPlain.loungeAccess, 'none');
  assert.equal(nhElite.loungeAccess, 'full', 'but the traveller-specific fields were recomputed');
  clearCache();
});

test('the sample provider emits the same partial shape a real feed does', async () => {
  const { offers } = await sample.searchFlights({
    origin: resolvePlace('SFO').place,
    destination: resolvePlace('Tokyo').place,
    date: '2026-10-12',
  });
  assert.ok(offers.length > 0);
  for (const offer of offers) {
    assert.equal(offer.milesEarned, undefined, 'earning is derived, never generated');
    assert.equal(offer.loungeAccess, undefined);
    assert.ok(offer.departLocal && offer.priceUsd > 0);
  }
});

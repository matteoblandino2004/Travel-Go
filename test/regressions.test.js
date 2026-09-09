/**
 * Regressions found by review. Each of these shipped, and each was wrong in a
 * way the rest of the suite didn't catch - live-supplier fields, cities that
 * share a name with a catalogued one, and the offline parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as amadeusHotels from '../src/data/hotels/amadeus.js';
import { enrichHotel } from '../src/data/hotels/index.js';
import { rankHotels } from '../src/core/hotels.js';
import { resolvePlace } from '../src/data/airports.js';
import { destinationContext } from '../src/search.js';
import { curatedCityFor } from '../src/data/cities.js';
import { parseWithRules } from '../src/nl/rules.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const OFFLINE = { env: { TRAVELGO_GEOCODER: 'none' } };

test('a hotel with no review score still ranks and renders', () => {
  // Amadeus carries no guest ratings. The UI used to read reviewCount blindly.
  const { hotels } = amadeusHotels.parseResponse(fixture('amadeus-hotels.json'), [], { nights: 3 });
  const enriched = hotels.map((h) => enrichHotel(h, {}));
  assert.ok(enriched.some((h) => h.guestRating === undefined));

  const ranked = rankHotels(enriched, { cost: 4, status: 3, access: 3, guestRating: 3, points: 3, cancellation: 3 }, { pois: [] });
  assert.equal(ranked.results.length, enriched.length);
  for (const result of ranked.results) {
    assert.ok(Number.isFinite(result.score));
    for (const row of result.breakdown) {
      assert.ok(!String(row.display).includes('undefined'), `${row.key} rendered "${row.display}"`);
    }
  }
});

test('hotel prices reflect the stay that was actually priced', async () => {
  // Without checkOutDate, Amadeus prices one night; dividing that by three
  // reported every rate at a third of reality.
  let params = null;
  await amadeusHotels.searchHotels(
    { destination: { centre: { lat: 38.7, lng: -9.1 } }, nights: 3, checkIn: '2026-10-12' },
    {
      env: { AMADEUS_CLIENT_ID: 'a', AMADEUS_CLIENT_SECRET: 'b' },
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 1799 }) };
        if (u.includes('by-geocode')) return { ok: true, status: 200, json: async () => ({ data: [{ hotelId: 'MCLIS123' }] }) };
        params = new URL(u).searchParams;
        return { ok: true, status: 200, json: async () => fixture('amadeus-hotels.json') };
      },
    }
  );
  assert.equal(params.get('checkInDate'), '2026-10-12');
  assert.equal(params.get('checkOutDate'), '2026-10-15', 'three nights after check-in');

  const { hotels } = amadeusHotels.parseResponse(fixture('amadeus-hotels.json'), [], { nights: 3 });
  const marriott = hotels.find((h) => h.id === 'MCLIS123');
  assert.equal(marriott.totalUsd, 540);
  assert.equal(marriott.nightlyUsd, 180, '540 over three nights, not over one');
});

test('a city that merely shares a name gets its own data', async () => {
  // Paris, Texas was given the centre of Paris, France and eight French
  // landmarks; London, Ontario was given central London and nine UK ones.
  for (const [code, country] of [['PRX', 'US'], ['YXU', 'CA']]) {
    const place = resolvePlace(code).place;
    const context = await destinationContext(place, OFFLINE);
    assert.equal(context.summary.pois.length, 0, `${code} borrowed another city's places`);
    assert.ok(
      Math.abs(context.centre.lat - place.lat) < 1 && Math.abs(context.centre.lng - place.lng) < 1,
      `${code} centre is on the wrong continent`
    );
  }
});

test('the real city still gets its curated data', async () => {
  for (const [query, poiCount] of [['Tokyo', 10], ['London', 9], ['Paris', 8]]) {
    const context = await destinationContext(resolvePlace(query).place, OFFLINE);
    assert.equal(context.centre.source, 'catalogue', `${query} lost its curated centre`);
    assert.equal(context.summary.pois.length, poiCount);
  }
});

test('curatedCityFor requires the country and the coordinates to agree', () => {
  assert.equal(curatedCityFor({ code: 'TYO', city: 'Tokyo', country: 'JP', lat: 35.68, lng: 139.76 })?.code, 'TYO');
  assert.equal(curatedCityFor({ city: 'Paris', country: 'US', lat: 33.6, lng: -95.4 }), null);
  assert.equal(curatedCityFor({ city: 'London', country: 'CA', lat: 43.0, lng: -81.1 }), null);
  // Right country, wrong hemisphere - the distance guard still catches it.
  assert.equal(curatedCityFor({ city: 'Paris', country: 'FR', lat: -20, lng: 100 }), null);
});

test('a city code inside an ordinary word is not a city', () => {
  // "a long trip" contains "LON", and the parser used to read it as London.
  assert.equal(parseWithRules('a long trip to Tokyo').origin, null);
  assert.equal(parseWithRules('a long trip to Tokyo').destination, 'Tokyo');
  assert.equal(parseWithRules('a long weekend in Barcelona').destination, 'Barcelona');
  assert.equal(parseWithRules('sparingly priced flights to Paris').destination, 'Paris');
  // Real codes still work.
  assert.equal(parseWithRules('from SFO to Tokyo').origin, 'San Francisco');
});

test('a bare month never resolves to a date in the past', () => {
  const months = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const today = new Date().toISOString().slice(0, 10);
  for (const month of months) {
    const parsed = parseWithRules(`Tokyo in ${month}`);
    assert.ok(parsed.departDate >= today, `"${month}" gave ${parsed.departDate}, which is in the past`);
  }
});

test('.env is loaded by the start scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  for (const script of ['start', 'dev']) {
    assert.match(pkg.scripts[script], /--env-file-if-exists=\.env/, `npm run ${script} ignores .env`);
  }
});

/* ---------------------------------------------------------------- *
 * Getting around is the traveller's choice, not only the city's
 * ---------------------------------------------------------------- */

test('restricting how you travel changes the estimate', async () => {
  const { estimateTravel } = await import('../src/core/geo.js');
  const from = { lat: 35.6812, lng: 139.7671 };
  const to = { lat: 35.6595, lng: 139.7005 }; // ~7.5 km across Tokyo

  const anything = estimateTravel(from, to, { transitQuality: 0.95 });
  const onFoot = estimateTravel(from, to, { transitQuality: 0.95, modes: ['walk'] });
  const noTaxi = estimateTravel(from, to, { transitQuality: 0.95, modes: ['walk', 'transit'] });
  const driving = estimateTravel(from, to, { transitQuality: 0.95, modes: ['walk', 'taxi'] });

  assert.equal(anything.mode, 'transit');
  assert.equal(onFoot.mode, 'walk');
  assert.ok(onFoot.minutes > anything.minutes * 3, 'walking across Tokyo is not quick');
  assert.equal(noTaxi.mode, 'transit');
  assert.equal(driving.mode, 'taxi');
});

test('walking-only ranking prefers hotels you can actually walk from', async () => {
  const { scoreHotelAccess } = await import('../src/core/poi.js');
  const poi = { name: 'Museum', lat: 35.7148, lng: 139.7967, importance: 5 };
  const nextDoor = { lat: 35.7135, lng: 139.7950 };
  const acrossTown = { lat: 35.6595, lng: 139.7005 };

  const onFoot = { transitQuality: 0.95, modes: ['walk'] };
  const near = scoreHotelAccess(nextDoor, [poi], onFoot);
  const far = scoreHotelAccess(acrossTown, [poi], onFoot);

  assert.ok(near.score > far.score);
  // With excellent transit available, the gap should narrow considerably.
  const anyMode = scoreHotelAccess(acrossTown, [poi], { transitQuality: 0.95 });
  assert.ok(anyMode.score > far.score, 'transit should rescue the far hotel');
});

test('an impossible constraint still scores, badly, rather than not at all', async () => {
  const { estimateTravel } = await import('../src/core/geo.js');
  const leg = estimateTravel({ lat: 35.68, lng: 139.76 }, { lat: 35.0, lng: 139.0 }, { modes: [] });
  assert.ok(Number.isFinite(leg.minutes) && leg.minutes > 0);
});

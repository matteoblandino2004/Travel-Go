import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as amadeusHotels from '../src/data/hotels/amadeus.js';
import * as sampleHotels from '../src/data/hotels/sample.js';
import { searchHotels, enrichHotel, resolveProvider, providerStatus, clearCache } from '../src/data/hotels/index.js';
import { resolvePlace } from '../src/data/airports.js';
import { transitQualityFor } from '../src/data/transit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

const destinationFor = (query) => {
  const place = resolvePlace(query).place;
  return { name: place.city, cityCode: place.code, country: place.country, centre: { lat: place.lat, lng: place.lng } };
};

/* ---------------------------------------------------------------- *
 * Generated inventory, anywhere
 * ---------------------------------------------------------------- */

test('hotels are generated for any city, not a fixed list', async () => {
  for (const city of ['Tbilisi', 'Lisbon', 'Ushuaia', 'Kathmandu', 'Reykjavik']) {
    const { hotels } = await sampleHotels.searchHotels({ destination: destinationFor(city), nights: 3 });
    assert.ok(hotels.length > 0, `${city} produced no hotels`);
    for (const hotel of hotels) {
      assert.ok(Number.isFinite(hotel.lat) && Number.isFinite(hotel.lng));
      assert.ok(hotel.nightlyUsd > 0);
    }
  }
});

test('generated hotels sit near the centre they were given', async () => {
  const destination = { name: 'Tbilisi', cityCode: 'TBS', country: 'GE', centre: { lat: 41.6934, lng: 44.8015 } };
  const { hotels } = await sampleHotels.searchHotels({ destination, nights: 3 });
  for (const hotel of hotels) {
    assert.ok(Math.abs(hotel.lat - 41.6934) < 0.2, `${hotel.name} is nowhere near the centre`);
    assert.ok(Math.abs(hotel.lng - 44.8015) < 0.2);
  }
});

test('curated cities keep their real neighbourhood names', async () => {
  const { hotels } = await sampleHotels.searchHotels({ destination: destinationFor('Tokyo'), nights: 3 });
  const areas = new Set(hotels.map((h) => h.neighbourhood));
  assert.ok([...areas].some((a) => ['Ginza', 'Shibuya', 'Shinjuku', 'Marunouchi', 'Asakusa', 'Shinagawa'].includes(a)));
});

test('the same query generates the same market twice', async () => {
  const destination = destinationFor('Lisbon');
  const a = await sampleHotels.searchHotels({ destination, nights: 3, checkIn: '2026-10-12' });
  const b = await sampleHotels.searchHotels({ destination, nights: 3, checkIn: '2026-10-12' });
  assert.deepEqual(a.hotels, b.hotels);
});

/* ---------------------------------------------------------------- *
 * Amadeus
 * ---------------------------------------------------------------- */

test('Amadeus hotels parse into the shape the ranker consumes', () => {
  const { hotels } = amadeusHotels.parseResponse(fixture('amadeus-hotels.json'), [], { nights: 3 });
  assert.equal(hotels.length, 2, 'the sold-out property is excluded');

  const marriott = hotels.find((h) => h.id === 'MCLIS123');
  assert.equal(marriott.name, 'Marriott Lisbon Hotel', 'SHOUTING is normalised');
  assert.equal(marriott.program, 'marriott', 'chain code maps to a loyalty programme');
  assert.equal(marriott.stars, 5);
  assert.equal(marriott.totalUsd, 540, 'the cheapest offer is used');
  assert.equal(marriott.nightlyUsd, 180, 'a stay total becomes a nightly rate');
  assert.equal(marriott.lat, 38.7405);
});

test('cancellation terms are read from the policy, not assumed', () => {
  const { hotels } = amadeusHotels.parseResponse(fixture('amadeus-hotels.json'), [], { nights: 3 });
  // The cheapest Marriott offer forfeits half; the Hilton forfeits everything.
  assert.equal(hotels.find((h) => h.id === 'MCLIS123').cancellation, 'partial');
  assert.equal(hotels.find((h) => h.id === 'HLLIS456').cancellation, 'nonrefundable');
});

test('missing supplier fields are reported, not invented', () => {
  const { hotels, notes } = amadeusHotels.parseResponse(fixture('amadeus-hotels.json'), [], { nights: 3 });
  for (const hotel of hotels) {
    assert.equal(hotel.guestRating, undefined, 'this API carries no review scores');
  }
  const hilton = hotels.find((h) => h.id === 'HLLIS456');
  assert.equal(hilton.stars, undefined, 'and not every property has a star rating');
  assert.ok(Array.isArray(notes));
});

test('a hotel with no usable price is dropped', () => {
  const payload = { data: [{ hotel: { hotelId: 'X', name: 'No Price', latitude: 1, longitude: 1 }, available: true, offers: [{ id: 'o', price: {} }] }] };
  assert.equal(amadeusHotels.parseResponse(payload, [], {}).hotels.length, 0);
});

/* ---------------------------------------------------------------- *
 * Derived loyalty fields
 * ---------------------------------------------------------------- */

test('status and points are derived, because no supplier carries them', () => {
  const base = { id: 'H1', program: 'marriott', totalUsd: 600, stars: 4 };
  const plain = enrichHotel(base, {});
  assert.equal(plain.eliteRecognition, 'none');
  assert.equal(plain.pointsEarned, 6000);
  assert.ok(plain.estimatedFields.includes('pointsEarned'));

  const elite = enrichHotel(base, { hotels: { marriott: 'gold' } });
  assert.equal(elite.eliteRecognition, 'gold');
  assert.ok(elite.perks.includes('upgrade'));
  assert.ok(elite.pointsEarned > plain.pointsEarned);
});

test('status with a different chain earns nothing here', () => {
  const hotel = enrichHotel({ id: 'H1', program: 'hilton', totalUsd: 600 }, { hotels: { marriott: 'platinum' } });
  assert.equal(hotel.eliteRecognition, 'none');
});

test('an unrated property is scored as mid-range, and flagged', () => {
  const hotel = enrichHotel({ id: 'H1', program: null, totalUsd: 400 }, {});
  assert.equal(hotel.stars, 3);
  assert.ok(hotel.estimatedFields.includes('stars'));
  assert.equal(hotel.pointsEarned, 0, 'an independent earns nothing');
});

/* ---------------------------------------------------------------- *
 * Registry
 * ---------------------------------------------------------------- */

test('a configured supplier is preferred, and an unconfigured one is refused', () => {
  assert.equal(resolveProvider({}).id, 'sample');
  assert.equal(resolveProvider({ AMADEUS_CLIENT_ID: 'a', AMADEUS_CLIENT_SECRET: 'b' }).id, 'amadeus');
  assert.equal(providerStatus({}).live, false);
  assert.throws(() => resolveProvider({ TRAVELGO_HOTEL_PROVIDER: 'amadeus' }), /AMADEUS_CLIENT_ID/);
});

test('a live supplier failing falls back to generated data with a note', async () => {
  clearCache();
  const result = await searchHotels(
    { destination: destinationFor('Lisbon'), nights: 3 },
    { env: { AMADEUS_CLIENT_ID: 'a', AMADEUS_CLIENT_SECRET: 'b' }, fetchImpl: async () => { throw new Error('network down'); } }
  );
  assert.equal(result.source, 'sample');
  assert.match(result.notes[0], /network down/);
  assert.ok(result.hotels.length > 0, 'the user still gets a ranked page');
});

test('a supplier with no content for the area falls back too', async () => {
  clearCache();
  const result = await searchHotels(
    { destination: destinationFor('Ushuaia'), nights: 3 },
    {
      env: { AMADEUS_CLIENT_ID: 'a', AMADEUS_CLIENT_SECRET: 'b' },
      fetchImpl: async (url) =>
        String(url).includes('oauth2/token')
          ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 1799 }) }
          : { ok: true, status: 200, json: async () => ({ data: [] }) },
    }
  );
  assert.equal(result.source, 'sample');
  assert.match(result.notes.join(' '), /nothing for this area/);
});

test('results are cached so a paid supplier is not re-billed per keystroke', async () => {
  clearCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 1799 }) };
    calls += 1;
    if (String(url).includes('by-geocode')) {
      return { ok: true, status: 200, json: async () => ({ data: [{ hotelId: 'MCLIS123' }, { hotelId: 'HLLIS456' }] }) };
    }
    return { ok: true, status: 200, json: async () => fixture('amadeus-hotels.json') };
  };
  const opts = { env: { AMADEUS_CLIENT_ID: 'a', AMADEUS_CLIENT_SECRET: 'b' }, fetchImpl };
  const query = { destination: destinationFor('Lisbon'), nights: 3, checkIn: '2026-10-12' };

  const first = await searchHotels(query, opts);
  const second = await searchHotels(query, opts);
  assert.equal(first.source, 'amadeus');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 2, 'one list call plus one offers call, then nothing');
  clearCache();
});

/* ---------------------------------------------------------------- *
 * Transit quality
 * ---------------------------------------------------------------- */

test('transit quality is specific where we know, and broad where we do not', () => {
  assert.equal(transitQualityFor({ cityCode: 'TYO' }).basis, 'city');
  assert.equal(transitQualityFor({ cityCode: 'ZZZ', country: 'DE' }).basis, 'country');
  assert.equal(transitQualityFor({ cityCode: 'ZZZ', country: 'ZZ' }).basis, 'default');
});

test('transit quality orders cities the way anyone who has been would', () => {
  const q = (dest) => transitQualityFor(dest).value;
  assert.ok(q({ cityCode: 'TYO' }) > q({ cityCode: 'NYC' }));
  assert.ok(q({ cityCode: 'NYC' }) > q({ cityCode: 'LAX' }));
  assert.ok(q({ cityCode: 'ZZZ', country: 'NL' }) > q({ cityCode: 'ZZZ', country: 'US' }));
  for (const value of [q({ cityCode: 'TYO' }), q({ cityCode: 'ZZZ', country: 'ZZ' })]) {
    assert.ok(value > 0 && value <= 1);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodePlace, geocodeCityCentre, geocoderStatus, clearCache } from '../src/data/geocode/index.js';
import * as nominatim from '../src/data/geocode/nominatim.js';
import { resolvePlace } from '../src/data/airports.js';

const OFFLINE = { env: { TRAVELGO_GEOCODER: 'none' } };

const stub = (results) => async () => ({ ok: true, status: 200, json: async () => results });

const OSM_TOWER = {
  name: 'Torre de Belém', display_name: 'Torre de Belém, Lisboa, Portugal',
  lat: '38.6916', lon: '-9.2160', category: 'historic', type: 'castle', importance: 0.72,
};

test('a geocoder is on by default and can be switched off', () => {
  assert.equal(geocoderStatus({}).enabled, true);
  assert.equal(geocoderStatus({}).id, 'nominatim');
  assert.equal(geocoderStatus({ TRAVELGO_GEOCODER: 'none' }).enabled, false);
  assert.equal(geocoderStatus({ TRAVELGO_GEOCODER: 'nope' }).enabled, false);
});

test('the curated catalogue answers without any network call', async () => {
  let called = false;
  const located = await geocodePlace('Senso-ji', { city: 'Tokyo' }, {
    fetchImpl: async () => { called = true; throw new Error('should not be called'); },
  });
  assert.equal(located.source, 'catalogue');
  assert.equal(located.name, 'Senso-ji Temple');
  assert.equal(called, false);
});

test('anywhere else goes to the geocoder', async () => {
  clearCache();
  const located = await geocodePlace('Torre de Belem', { city: 'Lisbon', country: 'PT' }, { fetchImpl: stub([OSM_TOWER]) });
  assert.equal(located.source, 'nominatim');
  assert.equal(located.lat, 38.6916);
  assert.equal(located.kind, 'sight');
});

test('OSM categories map onto the kinds the ranking understands', async () => {
  clearCache();
  const cafe = await geocodePlace('A Brasileira', { city: 'Lisbon' }, {
    fetchImpl: stub([{ name: 'A Brasileira', lat: '38.71', lon: '-9.14', category: 'amenity', type: 'cafe' }]),
  });
  assert.equal(cafe.kind, 'food');

  clearCache();
  const museum = await geocodePlace('Museu', { city: 'Lisbon' }, {
    fetchImpl: stub([{ name: 'Museu', lat: '38.7', lon: '-9.1', category: 'tourism', type: 'museum' }]),
  });
  assert.equal(museum.kind, 'sight');
});

test('the nearest plausible match wins over the most famous one', async () => {
  clearCache();
  const results = [
    { name: 'Victoria', display_name: 'Victoria, British Columbia, Canada', lat: '48.4284', lon: '-123.3656', category: 'place', type: 'city', importance: 0.9 },
    { name: 'Victoria Harbour', display_name: 'Victoria Harbour, Hong Kong', lat: '22.2908', lon: '114.1501', category: 'natural', type: 'bay', importance: 0.5 },
  ];
  const located = await geocodePlace('Victoria', { city: 'Hong Kong', near: { lat: 22.3, lng: 114.17 } }, { fetchImpl: stub(results) });
  assert.equal(located.name, 'Victoria Harbour');
});

test('a geocoder that fails returns nothing rather than throwing', async () => {
  clearCache();
  assert.equal(await geocodePlace('Anywhere', { city: 'Lisbon' }, { fetchImpl: async () => { throw new Error('down'); } }), null);
  clearCache();
  assert.equal(await geocodePlace('Anywhere', { city: 'Lisbon' }, { fetchImpl: async () => ({ ok: false, status: 429, statusText: 'Too Many Requests' }) }), null);
});

test('with the geocoder off, only curated places resolve', async () => {
  clearCache();
  assert.equal((await geocodePlace('Senso-ji', { city: 'Tokyo' }, OFFLINE)).source, 'catalogue');
  assert.equal(await geocodePlace('Torre de Belem', { city: 'Lisbon' }, OFFLINE), null);
});

test('results are cached, so the same place is looked up once', async () => {
  clearCache();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => [OSM_TOWER] }; };
  await geocodePlace('Torre de Belem', { city: 'Lisbon' }, { fetchImpl });
  await geocodePlace('Torre de Belem', { city: 'Lisbon' }, { fetchImpl });
  assert.equal(calls, 1);
});

test('a curated city centre needs no geocoder', async () => {
  const centre = await geocodeCityCentre(resolvePlace('Tokyo').place, OFFLINE);
  assert.equal(centre.source, 'catalogue');
  assert.equal(centre.approximate, false);
});

test('an uncatalogued city centre is geocoded, or admits to being the airport', async () => {
  clearCache();
  const tbilisi = resolvePlace('Tbilisi').place;

  const geocoded = await geocodeCityCentre(tbilisi, {
    fetchImpl: stub([{ name: 'Tbilisi', display_name: 'Tbilisi, Georgia', lat: '41.6934', lon: '44.8015', category: 'place', type: 'city' }]),
  });
  assert.equal(geocoded.approximate, false);
  assert.equal(geocoded.lat, 41.6934);

  clearCache();
  const fallback = await geocodeCityCentre(tbilisi, OFFLINE);
  assert.equal(fallback.approximate, true);
  assert.equal(fallback.source, 'airport');
  assert.equal(fallback.lat, tbilisi.lat);
});

test('the request identifies itself and respects the usage policy', async () => {
  let request = null;
  await nominatim.geocode('Torre de Belem', { city: 'Lisbon', country: 'PT', near: { lat: 38.72, lng: -9.14 } }, {
    env: {},
    fetchImpl: async (url, init) => {
      request = { url: new URL(url), init };
      return { ok: true, status: 200, json: async () => [OSM_TOWER] };
    },
  });
  assert.match(request.init.headers['user-agent'], /travel-go/, 'Nominatim rejects anonymous clients');
  assert.equal(request.url.searchParams.get('q'), 'Torre de Belem, Lisbon');
  assert.equal(request.url.searchParams.get('countrycodes'), 'pt');
  assert.ok(request.url.searchParams.get('viewbox'), 'searches are biased to the destination');
});

test('a self-hosted or commercial endpoint can be substituted', async () => {
  let calledUrl = null;
  await nominatim.geocode('Somewhere', {}, {
    env: { NOMINATIM_URL: 'https://geocoder.internal' },
    fetchImpl: async (url) => { calledUrl = String(url); return { ok: true, status: 200, json: async () => [] }; },
  });
  assert.match(calledUrl, /^https:\/\/geocoder\.internal\/search\?/);
});

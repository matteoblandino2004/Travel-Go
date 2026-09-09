/**
 * Geocoding seam: names of places -> coordinates, for any city on earth.
 *
 * Three layers, tried in order:
 *   1. the curated catalogue in cities.js - instant, offline, hand-checked
 *   2. a geocoder (Nominatim by default; keyless)
 *   3. nothing, reported honestly as unresolved
 *
 * Layer 1 exists because the six catalogued cities cover the common demo path
 * and shouldn't need a network round trip. Layer 3 exists because a place we
 * silently drop is a place the user thinks is affecting their ranking.
 */

import * as nominatim from './nominatim.js';
import { findPoi, findCity } from '../cities.js';

const GEOCODERS = { nominatim };

/** Nominatim's usage policy is one request per second. Respect it. */
const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // a museum does not move

const cache = new Map();
let queue = Promise.resolve();
let lastCallAt = 0;

export function clearCache() {
  cache.clear();
}

export function geocoderStatus(env = process.env) {
  const choice = env.TRAVELGO_GEOCODER ?? 'nominatim';
  if (choice === 'none') return { id: 'none', label: 'Disabled', enabled: false };
  const geocoder = GEOCODERS[choice];
  if (!geocoder) return { id: choice, label: 'Unknown', enabled: false, error: `Unknown geocoder "${choice}".` };
  return { id: geocoder.id, label: geocoder.label, enabled: true };
}

function resolveGeocoder(env) {
  const choice = env.TRAVELGO_GEOCODER ?? 'nominatim';
  if (choice === 'none') return null;
  return GEOCODERS[choice] ?? null;
}

/**
 * Serialise geocoder calls and space them out.
 * Interactive searches send a handful of places at once; without this they'd
 * all fire at once and get the app rate-limited or banned.
 */
function schedule(task) {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    return task();
  });
  // Keep the chain alive even when one call rejects.
  queue = run.then(() => {}, () => {});
  return run;
}

/**
 * Locate one named place.
 *
 * @param {string} name
 * @param {object} context `{city, country, near}` - the destination, to bias results
 * @param {object} [opts] `{env, fetchImpl, signal}`
 * @returns {Promise<{lat,lng,name,kind,source}|null>}
 */
export async function geocodePlace(name, context = {}, opts = {}) {
  const env = opts.env ?? process.env;
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return null;

  // 1. Curated catalogue for the cities we hold places for.
  const city = context.cityCode ? findCity(context.cityCode) : findCity(context.city);
  const curated = city ? findPoi(city, trimmed) : null;
  if (curated) {
    return { name: curated.name, lat: curated.lat, lng: curated.lng, kind: curated.kind, source: 'catalogue' };
  }

  const key = `${trimmed.toLowerCase()}|${context.city ?? ''}|${context.country ?? ''}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const geocoder = resolveGeocoder(env);
  if (!geocoder) return null;

  try {
    const results = await schedule(() => geocoder.geocode(trimmed, context, { ...opts, env }));
    const best = pickBest(results, context);
    const value = best
      ? { name: best.name, lat: best.lat, lng: best.lng, kind: best.kind, source: geocoder.id, fullName: best.fullName }
      : null;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    // A geocoder that's down must not fail the whole search - the place is
    // simply reported as unlocated, which the UI already surfaces.
    return null;
  }
}

/**
 * Prefer a nearby result over a globally famous one.
 * Someone searching "Victoria" while planning Hong Kong means the harbour, not
 * the Canadian city, even though the latter ranks higher in the abstract.
 */
function pickBest(results, context) {
  if (!results?.length) return null;
  if (!context.near) return results[0];
  const scored = results.map((r) => ({
    r,
    // Rough degrees-squared is fine for ordering candidates.
    distance: (r.lat - context.near.lat) ** 2 + (r.lng - context.near.lng) ** 2,
  }));
  scored.sort((a, b) => a.distance - b.distance || b.r.confidence - a.r.confidence);
  return scored[0].r;
}

/**
 * Locate a city centre - the reference point for generated hotels and for
 * biasing place lookups.
 *
 * Falls back to the centroid of the airports serving the place, which is
 * approximate (Haneda is 15 km from central Tokyo) and flagged as such.
 *
 * @param {object} place a resolved airport/metro from airports.js
 */
export async function geocodeCityCentre(place, opts = {}) {
  const curated = findCity(place.city) ?? findCity(place.code);
  if (curated) {
    return { lat: curated.center.lat, lng: curated.center.lng, source: 'catalogue', approximate: false };
  }

  const located = await geocodePlace(
    `${place.city}${place.state ? `, ${place.state}` : ''}`,
    { country: place.country, near: { lat: place.lat, lng: place.lng } },
    opts
  );
  if (located) return { lat: located.lat, lng: located.lng, source: located.source, approximate: false };

  return {
    lat: place.lat,
    lng: place.lng,
    source: 'airport',
    approximate: true,
  };
}

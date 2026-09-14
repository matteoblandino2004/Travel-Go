/**
 * Hotel provider registry - the same shape as the flight one.
 *
 * Picks a supplier, fills in the loyalty fields no supplier carries, and
 * caches. Falls back to generated data when a live supplier fails, so a hotel
 * outage never takes the page down.
 */

import * as sample from './sample.js';
import * as amadeus from './amadeus.js';
import { enrichHotel } from './enrich.js';

export { enrichHotel };

export const PROVIDERS = [amadeus, sample];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

export function resolveProvider(env = process.env) {
  const requested = env.TRAVELGO_HOTEL_PROVIDER;
  if (requested) {
    const provider = BY_ID.get(requested);
    if (!provider) {
      throw new Error(`Unknown hotel provider "${requested}". Available: ${[...BY_ID.keys()].join(', ')}.`);
    }
    if (!provider.isConfigured(env)) {
      throw new Error(`Hotel provider "${requested}" needs ${provider.credentials.join(' and ')} to be set.`);
    }
    return provider;
  }
  return PROVIDERS.find((p) => p !== sample && p.isConfigured(env)) ?? sample;
}

export function providerStatus(env = process.env) {
  let active = null;
  let error = null;
  try {
    active = resolveProvider(env).id;
  } catch (e) {
    error = e.message;
    active = sample.id;
  }
  return {
    active,
    error,
    live: active !== sample.id,
    available: PROVIDERS.map((p) => ({
      id: p.id, label: p.label, configured: p.isConfigured(env), credentials: p.credentials,
    })),
  };
}

const cache = new Map();
export function clearCache() {
  cache.clear();
}


/**
 * @param {object} query `{destination:{name,cityCode,country,centre}, nights, checkIn, profile}`
 * @param {object} [opts] `{env, fetchImpl, provider, timeoutMs, cacheTtlMs}`
 */
export async function searchHotels(query, opts = {}) {
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? resolveProvider(env);
  const destination = query.destination;

  const key = [
    provider.id, destination?.cityCode ?? destination?.name,
    Math.round((destination?.centre?.lat ?? 0) * 100),
    Math.round((destination?.centre?.lng ?? 0) * 100),
    query.checkIn ?? '', query.nights ?? 3, query.adults ?? 1,
  ].join('|');

  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const hit = cache.get(key);
  const notes = [];
  let result;
  let cached = false;

  if (hit && hit.expiresAt > Date.now()) {
    result = hit.result;
    cached = true;
  } else {
    const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      result = await provider.searchHotels(query, { ...opts, env, signal });
      if (result.hotels.length === 0 && provider !== sample) {
        notes.push(`${provider.label} had nothing for this area. Showing generated sample data instead.`);
        result = await sample.searchHotels(query, opts);
      } else {
        cache.set(key, { result, expiresAt: Date.now() + ttl });
      }
    } catch (error) {
      if (provider === sample) throw error;
      notes.push(`${provider.label} failed (${error.message}). Showing generated sample data instead.`);
      result = await sample.searchHotels(query, opts);
    }
  }

  return {
    source: result.source,
    label: result.label,
    live: result.source !== sample.id,
    cached,
    hotels: result.hotels.map((hotel) => enrichHotel(hotel, query.profile ?? {})),
    notes: [...notes, ...(result.notes ?? [])],
  };
}

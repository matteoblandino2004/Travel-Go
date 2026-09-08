/**
 * Provider registry.
 *
 * Picks a flight supplier, normalises its output, fills in the fields it
 * doesn't carry, and caches the result. Everything above this line - the
 * ranking engine, the API, the UI - is supplier-agnostic.
 *
 * Selection order:
 *   1. TRAVELGO_FLIGHT_PROVIDER, if set (fails loudly if it isn't configured)
 *   2. the first supplier whose credentials are present
 *   3. generated sample data
 */

import * as sample from './sample.js';
import * as googleFlights from './serpapi.js';
import * as amadeus from './amadeus.js';
import { enrichOffers } from '../enrich.js';
import { findCity } from '../cities.js';

/** Real suppliers first: if a key is present, that's what the user wants used. */
export const PROVIDERS = [googleFlights, amadeus, sample];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

const DEFAULT_TIMEOUT_MS = 20000;
/** Live fares don't move minute to minute, and paid calls shouldn't either. */
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

export function resolveProvider(env = process.env) {
  const requested = env.TRAVELGO_FLIGHT_PROVIDER;
  if (requested) {
    const provider = BY_ID.get(requested);
    if (!provider) {
      throw new Error(
        `Unknown flight provider "${requested}". Available: ${[...BY_ID.keys()].join(', ')}.`
      );
    }
    if (!provider.isConfigured(env)) {
      throw new Error(
        `Flight provider "${requested}" needs ${provider.credentials.join(' and ')} to be set.`
      );
    }
    return provider;
  }
  return PROVIDERS.find((p) => p !== sample && p.isConfigured(env)) ?? sample;
}

/** What the UI shows about where the data came from. */
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
      id: p.id,
      label: p.label,
      configured: p.isConfigured(env),
      credentials: p.credentials,
    })),
  };
}

/**
 * Real suppliers want IATA codes, not "San Francisco".
 *
 * A city in the catalogue resolves to its metro code (TYO covers Haneda and
 * Narita, NYC covers all three), which is what makes the result set match what
 * you'd see on Google Flights. Anything else is accepted as a raw code, so a
 * live provider isn't limited to the six cities the sample data knows.
 */
export function resolveLocationCode(value, { label = 'location' } = {}) {
  const city = findCity(value);
  if (city) return city.code;
  const raw = String(value ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(raw)) return raw;
  throw new Error(
    `I don't recognise "${value}" as a ${label}. Use a city name I know, or a 3-letter airport code (e.g. LAX).`
  );
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

const cache = new Map();

function cacheKey(providerId, query) {
  return [
    providerId, query.fromAirport, query.toAirport, query.date,
    query.returnDate ?? '', query.cabin, query.adults ?? 1, query.maxStops ?? 'any',
  ].join('|');
}

export function clearCache() {
  cache.clear();
}

/* ------------------------------------------------------------------ *
 * The one function the rest of the app calls
 * ------------------------------------------------------------------ */

/**
 * @param {object} query
 * @param {string} query.from origin city name or airport code
 * @param {string} query.to destination
 * @param {string} [query.date] YYYY-MM-DD
 * @param {'economy'|'premium'|'business'|'first'} [query.cabin]
 * @param {object} [query.profile] loyalty profile, used to derive miles/lounge
 * @param {object} [opts] `{env, fetchImpl, timeoutMs, cacheTtlMs, provider}`
 * @returns {Promise<{source, label, live, offers, dropped, cached, notes}>}
 */
export async function searchFlights(query, opts = {}) {
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? resolveProvider(env);

  const normalised = {
    ...query,
    fromAirport: provider === sample ? query.from : resolveLocationCode(query.from, { label: 'origin' }),
    toAirport: provider === sample ? query.to : resolveLocationCode(query.to, { label: 'destination' }),
    cabin: query.cabin ?? 'economy',
    date: query.date ?? defaultDate(),
  };

  const key = cacheKey(provider.id, normalised);
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const hit = cache.get(key);
  const notes = [];
  let result;
  let cached = false;

  if (hit && hit.expiresAt > Date.now()) {
    result = hit.result;
    cached = true;
  } else {
    // A slow supplier must not hang the page; the sample market is a usable
    // answer and a clear note beats a spinner that never resolves.
    const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      result = await provider.searchFlights(normalised, { ...opts, env, signal });
      cache.set(key, { result, expiresAt: Date.now() + ttl });
    } catch (error) {
      if (provider === sample) throw error;
      notes.push(`${provider.label} failed (${error.message}). Showing generated sample data instead.`);
      result = await sample.searchFlights(
        { ...normalised, from: query.from, to: query.to },
        opts
      );
    }
  }

  const offers = enrichOffers(result.offers, query.profile ?? {});
  if (result.dropped?.length) {
    notes.push(`${result.dropped.length} offer(s) from ${result.label} were unusable and skipped.`);
  }

  return {
    source: result.source,
    label: result.label,
    live: result.source !== sample.id,
    cached,
    offers,
    dropped: result.dropped ?? [],
    priceInsights: result.priceInsights ?? null,
    notes,
  };
}

function defaultDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

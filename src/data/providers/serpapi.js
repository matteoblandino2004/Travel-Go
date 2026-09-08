/**
 * Google Flights, via SerpApi.
 *
 * Google has no flight API - QPX Express was retired in 2018 and nothing
 * public replaced it. SerpApi runs the Google Flights search and returns the
 * results as JSON, which is the practical way to rank the same options you'd
 * see in the browser. It is a paid service and it is scraping Google, so read
 * the note in the README before pointing this at production.
 *
 * Field mapping is table-driven and kept together at the top of the file: if
 * SerpApi changes a key, this is the only place that needs editing.
 *
 * Docs: https://serpapi.com/google-flights-api
 */

import { toOffer, keepUsable, parseLocalDateTime } from './normalize.js';
import { airlineByName } from '../airlines.js';

const ENDPOINT = 'https://serpapi.com/search.json';

/** SerpApi encodes these as numbers rather than words. */
const TRIP_TYPE = { round: 1, oneway: 2, multi: 3 };
const TRAVEL_CLASS = { economy: 1, premium: 2, business: 3, first: 4 };
/** 0 = any, 1 = nonstop only, 2 = 1 stop or fewer, 3 = 2 stops or fewer. */
const STOP_FILTER = { any: 0, nonstop: 1, one: 2, two: 3 };

export const id = 'google-flights';
export const label = 'Google Flights (via SerpApi)';
export const credentials = ['SERPAPI_API_KEY'];

export function isConfigured(env = process.env) {
  return Boolean(env.SERPAPI_API_KEY);
}

/**
 * @param {object} query
 * @param {string} query.fromAirport IATA code
 * @param {string} query.toAirport IATA code
 * @param {string} query.date YYYY-MM-DD
 * @param {string} [query.returnDate] set for a round trip
 * @param {'economy'|'premium'|'business'|'first'} [query.cabin]
 * @param {number} [query.adults]
 * @param {'any'|'nonstop'|'one'|'two'} [query.maxStops]
 * @param {{env?:object, fetchImpl?:Function, signal?:AbortSignal}} [opts]
 */
export async function searchFlights(query, opts = {}) {
  const env = opts.env ?? process.env;
  const apiKey = env.SERPAPI_API_KEY;
  if (!apiKey) throw new Error('SERPAPI_API_KEY is not set.');

  const params = new URLSearchParams({
    engine: 'google_flights',
    api_key: apiKey,
    departure_id: query.fromAirport,
    arrival_id: query.toAirport,
    outbound_date: query.date,
    type: String(query.returnDate ? TRIP_TYPE.round : TRIP_TYPE.oneway),
    travel_class: String(TRAVEL_CLASS[query.cabin ?? 'economy'] ?? TRAVEL_CLASS.economy),
    adults: String(query.adults ?? 1),
    currency: 'USD',
    hl: 'en',
    // Google's own ordering is a ranking too - ask for the deeper result set so
    // we're re-ranking everything available, not Google's shortlist.
    deep_search: 'true',
  });
  if (query.returnDate) params.set('return_date', query.returnDate);
  if (query.maxStops && query.maxStops !== 'any') {
    params.set('stops', String(STOP_FILTER[query.maxStops]));
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(`${ENDPOINT}?${params}`, { signal: opts.signal });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.error) {
    throw new Error(`SerpApi ${response.status}: ${payload?.error ?? response.statusText}`);
  }

  return parseResponse(payload, query);
}

/**
 * Exported so the adapter can be tested against a recorded response without a
 * key or a network call.
 */
export function parseResponse(payload, query = {}) {
  // Google splits results into its own "best" shortlist and everything else.
  // We want the lot - deciding what's best is this app's whole job.
  const groups = [
    ...(payload?.best_flights ?? []).map((r) => ({ result: r, googleShortlisted: true })),
    ...(payload?.other_flights ?? []).map((r) => ({ result: r, googleShortlisted: false })),
  ];

  const offers = groups
    .map(({ result, googleShortlisted }, index) => buildOffer(result, index, googleShortlisted, query))
    .filter(Boolean);

  const { offers: usable, dropped } = keepUsable(offers, { source: 'Google Flights' });

  return {
    source: id,
    label,
    offers: usable,
    dropped,
    priceInsights: payload?.price_insights ?? null,
  };
}

function buildOffer(result, index, googleShortlisted, query) {
  const segments = result?.flights ?? [];
  if (segments.length === 0) return null;

  const first = segments[0];
  const last = segments[segments.length - 1];
  const layovers = result.layovers ?? [];

  // "NH 7" -> "NH". Google gives the carrier name in full and the code only
  // inside the flight number.
  const codeFromNumber = /^([A-Z0-9]{2})\s?\d/.exec(String(first.flight_number ?? '').toUpperCase());
  const byName = airlineByName(first.airline);

  const offer = toOffer({
    id: `gf-${index}`,
    source: id,
    airline: first.airline ?? byName?.name,
    airlineCode: byName?.code ?? codeFromNumber?.[1] ?? null,
    cabin: first.travel_class ?? query.cabin,
    from: first.departure_airport?.id,
    to: last.arrival_airport?.id,
    departure: parseLocalDateTime(first.departure_airport?.time),
    arrival: parseLocalDateTime(last.arrival_airport?.time),
    durationMin: result.total_duration,
    stops: segments.length - 1,
    layoverAirports: layovers.map((l) => l.id).filter(Boolean),
    layoverMinutes: layovers.reduce((sum, l) => sum + (Number(l.duration) || 0), 0),
    priceUsd: result.price,
    // Google reports grams; everything else in the app talks kilograms.
    carbonKg: Number.isFinite(result.carbon_emissions?.this_flight)
      ? Math.round(result.carbon_emissions.this_flight / 1000)
      : undefined,
    oftenDelayed: segments.some((s) => s.often_delayed_by_over_30_min === true),
    bookingToken: result.booking_token ?? null,
    segments: segments.map((s) => ({
      from: s.departure_airport?.id,
      to: s.arrival_airport?.id,
      departure: s.departure_airport?.time,
      arrival: s.arrival_airport?.time,
      flightNumber: s.flight_number,
      airline: s.airline,
      aircraft: s.airplane,
      cabin: s.travel_class,
      durationMin: s.duration,
      legroom: s.legroom,
      overnight: Boolean(s.overnight),
    })),
  });

  // Whether Google put this in its own "Best departing flights" shortlist -
  // kept for reference, deliberately not an input to our ranking.
  offer.googleShortlisted = googleShortlisted;
  return offer;
}

/**
 * Validating a parsed trip request before it reaches the scorer.
 *
 * Pure and dependency-free on purpose: it is the only thing standing between a
 * model's output and the ranking engine, and it is reused by the browser build
 * where the Claude call itself lives behind a different API.
 */

import { neutralImportances } from './schema.js';
import { FLIGHT_CRITERIA_KEYS } from '../core/flights.js';
import { HOTEL_CRITERIA_KEYS } from '../core/hotels.js';

/**
 * Never trust the shape coming back over the wire. Anything unrecognised is
 * replaced with the neutral default rather than allowed into the scorer, where
 * a stray string would quietly become NaN.
 */
export function sanitize(raw) {
  const base = blank();
  const out = {
    ...base,
    origin: str(raw?.origin),
    destination: str(raw?.destination),
    departDate: /^\d{4}-\d{2}-\d{2}$/.test(raw?.departDate ?? '') ? raw.departDate : null,
    nights: Number.isInteger(raw?.nights) && raw.nights > 0 && raw.nights <= 60 ? raw.nights : null,
    cabin: ['economy', 'premium', 'business'].includes(raw?.cabin) ? raw.cabin : null,
    departureWindow: window(raw?.departureWindow),
    arrivalWindow: window(raw?.arrivalWindow),
    places: Array.isArray(raw?.places)
      ? raw.places
          .filter((p) => p && typeof p.name === 'string' && p.name.trim())
          .slice(0, 25)
          .map((p) => ({
            name: p.name.trim().slice(0, 120),
            kind: ['sight', 'food', 'other'].includes(p.kind) ? p.kind : 'other',
            importance: importance(p.importance),
          }))
      : [],
    assumptions: Array.isArray(raw?.assumptions)
      ? raw.assumptions.filter((a) => typeof a === 'string').slice(0, 10)
      : [],
  };

  for (const key of FLIGHT_CRITERIA_KEYS) out.flight[key] = importance(raw?.flight?.[key]);
  for (const key of HOTEL_CRITERIA_KEYS) out.hotel[key] = importance(raw?.hotel?.[key]);
  return out;
}

function blank() {
  const { flight, hotel } = neutralImportances();
  return {
    origin: null, destination: null, departDate: null, nights: null, cabin: null,
    flight, hotel, departureWindow: null, arrivalWindow: null,
    places: [], assumptions: [], source: 'default',
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

function importance(value) {
  if (value === 'na' || value === 'NA' || value === 'N/A') return 'na';
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 3;
}

function window(w) {
  const ok = (t) => typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t.trim());
  return w && ok(w.start) && ok(w.end) ? { start: w.start.trim(), end: w.end.trim() } : null;
}

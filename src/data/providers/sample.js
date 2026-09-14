/**
 * Generated flight inventory - for any route, not just catalogued cities.
 *
 * Deterministic per query, so changing an importance rating re-ranks the same
 * market instead of shuffling in new options. It works off resolved airports
 * from airports.js, which is what lets it invent a plausible Lisbon-Tbilisi
 * market as readily as San Francisco-Tokyo.
 *
 * It deliberately emits the same *partial* shape a real feed does - no miles,
 * no lounge field - so the enrichment path is exercised in development rather
 * than only in production.
 */

import { AIRLINES_BY_CODE } from '../airlines.js';
import { utcOffsetHours, airportsFor } from '../airports.js';
import { haversineKm } from '../../core/geo.js';
import { toOffer, keepUsable } from './normalize.js';

export const id = 'sample';
export const label = 'Generated sample data';
export const credentials = [];
export const isConfigured = () => true;

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 - small, fast, good enough for fixtures. */
export function rng(seed) {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const between = (rand, lo, hi) => lo + rand() * (hi - lo);

const CONNECTION_HUBS = {
  star: ['FRA', 'ORD', 'MUC', 'NRT', 'IAD'],
  oneworld: ['LHR', 'DFW', 'HND', 'MAD'],
  skyteam: ['CDG', 'AMS', 'ATL', 'DTW'],
  none: ['STN', 'BGY'],
};

const SAMPLE_CARRIERS = ['UA', 'NH', 'LH', 'AA', 'BA', 'JL', 'DL', 'AF', 'KL', 'FR', 'VS', 'EK', 'QR', 'TK', 'SQ', 'QF', 'LA', 'ET']
  .map((code) => AIRLINES_BY_CODE[code])
  .filter(Boolean);

const PRICE_INDEX = {
  UA: 1.0, NH: 1.12, LH: 1.06, AA: 0.97, BA: 1.05, JL: 1.1, DL: 1.03, AF: 1.02,
  KL: 1.0, FR: 0.62, VS: 1.04, EK: 1.08, QR: 1.06, TK: 0.92, SQ: 1.14, QF: 1.09,
  LA: 0.95, ET: 0.88,
};
const QUALITY = {
  UA: 0.72, NH: 0.93, LH: 0.8, AA: 0.68, BA: 0.78, JL: 0.92, DL: 0.81, AF: 0.76,
  KL: 0.77, FR: 0.42, VS: 0.83, EK: 0.88, QR: 0.91, TK: 0.75, SQ: 0.94, QF: 0.85,
  LA: 0.7, ET: 0.65,
};

/**
 * Which part of the world an airport is in, from its IANA timezone.
 *
 * Cheaper and more current than a country-to-continent table, and it only
 * needs to be right enough to decide which carriers plausibly serve a route.
 */
export function regionOf(airport) {
  const zone = String(airport.tz ?? '');
  const area = zone.split('/')[0];
  switch (area) {
    case 'Europe': return 'europe';
    case 'Asia': return zone.startsWith('Asia/Dubai') || /Asia\/(Qatar|Riyadh|Kuwait|Bahrain|Muscat|Tehran|Jerusalem|Amman|Beirut|Baghdad)/.test(zone) ? 'meast' : 'asia';
    case 'Africa': return 'africa';
    case 'Australia': return 'oceania';
    case 'Pacific': return 'oceania';
    case 'Indian': return 'asia';
    case 'America':
      // One zone name covers two continents; latitude separates them.
      return airport.lat > 12 ? 'namerica' : 'samerica';
    case 'Atlantic': return 'europe';
    default: return null;
  }
}

/**
 * @param {object} query
 * @param {object} query.origin resolved place from airports.js
 * @param {object} query.destination resolved place from airports.js
 */
export async function searchFlights(query) {
  const origin = query.origin;
  const destination = query.destination;
  if (!origin || !destination) throw new Error('Sample flights need resolved origin and destination places.');
  if (origin.code === destination.code) throw new Error('Origin and destination are the same place.');

  const originAirports = airportsFor(origin);
  const destAirports = airportsFor(destination);
  const cabin = query.cabin ?? 'economy';
  const count = query.count ?? 14;
  const date = query.date ?? 'anyday';
  const rand = rng(`flights:${origin.code}:${destination.code}:${date}:${cabin}`);

  const routeKm = haversineKm(originAirports[0], destAirports[0]);
  if (routeKm < 80) throw new Error('Origin and destination are the same place.');

  const endpoints = new Set([regionOf(originAirports[0]), regionOf(destAirports[0])].filter(Boolean));
  const carriers = [];
  for (const carrier of SAMPLE_CARRIERS) {
    if (carrier.shortHaulOnly && routeKm > 3000) continue;
    const copies = endpoints.has(carrier.region) ? 3 : 1; // weighted draw
    for (let c = 0; c < copies; c++) carriers.push(carrier);
  }
  if (carriers.length === 0) carriers.push(...SAMPLE_CARRIERS);

  // Real local arrival times need the real offset on the day of travel.
  const when = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00Z`) : new Date();
  const offsetDelta =
    (utcOffsetHours(destAirports[0].tz, when) - utcOffsetHours(originAirports[0].tz, when)) * 60;

  const offers = [];
  for (let i = 0; i < count; i++) {
    const carrier = pick(rand, carriers);
    const originAirport = pick(rand, originAirports);
    const destAirport = pick(rand, destAirports);
    const km = haversineKm(originAirport, destAirport);

    // Long thin routes are rarely nonstop; short ones usually are.
    const nonstopChance = km > 11000 ? 0.12 : km > 7000 ? 0.35 : km > 2000 ? 0.5 : 0.72;
    const stopRoll = rand();
    const stops = stopRoll < nonstopChance ? 0 : stopRoll < nonstopChance + 0.45 ? 1 : 2;

    const airborneMin = Math.round((km / 830) * 60 * between(rand, 0.95, 1.07) + 35);
    const layoverMin = stops === 0 ? 0 : Math.round(between(rand, 65, 220) * stops);
    const durationMin = airborneMin + layoverMin;

    const cabinMultiplier = { economy: 1, premium: 1.75, business: 3.4, first: 5.5 }[cabin] ?? 1;
    const base = 58 + km * (km > 6000 ? 0.052 : 0.085);
    const price = Math.round(
      base * (PRICE_INDEX[carrier.code] ?? 1) * cabinMultiplier * (1 - stops * 0.11) * between(rand, 0.82, 1.32)
    );

    const departMinutes = Math.round(between(rand, 0, 1439) / 5) * 5;
    const arriveAbsolute = departMinutes + durationMin + offsetDelta;
    const dayShift = Math.floor(arriveAbsolute / 1440);
    const departDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '2026-01-01';

    offers.push(
      toOffer({
        id: `${carrier.code}${100 + i}`,
        source: id,
        airline: carrier.name,
        airlineCode: carrier.code,
        alliance: carrier.alliance,
        cabin,
        from: originAirport.code,
        to: destAirport.code,
        departure: { date: departDate, time: fmt(departMinutes), dayNumber: 0 },
        arrival: { date: departDate, time: fmt(((arriveAbsolute % 1440) + 1440) % 1440), dayNumber: dayShift },
        dayShift: Math.max(0, dayShift),
        durationMin,
        stops,
        layoverAirports:
          stops === 0
            ? []
            : Array.from({ length: stops }, () => pick(rand, CONNECTION_HUBS[carrier.alliance ?? 'none'])),
        layoverMinutes: layoverMin,
        priceUsd: price,
        distanceKm: Math.round(km),
        onTimePct: Math.round(55 + (QUALITY[carrier.code] ?? 0.7) * 35 + between(rand, -6, 6)),
      })
    );
  }

  const seen = new Set();
  const unique = offers.filter((o) => {
    const key = `${o.airlineCode}:${o.departLocal}:${o.from}:${o.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const { offers: usable, dropped } = keepUsable(unique, { source: 'Sample data' });
  return { source: id, label, offers: usable, dropped };
}

const fmt = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * seats.aero Partner API - award availability.
 *
 * This is a different kind of supplier to the others here. Google Flights and
 * Amadeus quote *cash* fares. seats.aero quotes *award* space: what a seat
 * costs in miles from a particular mileage programme, plus the cash taxes.
 * That difference runs through everything below, and two parts of it matter
 * enough to state up front.
 *
 * 1. Two calls, not one. `/search` returns cached availability keyed by route,
 *    date, programme and cabin - "there is business space on JFK-LHR on the
 *    3rd via Aeroplan for 60k". It carries no departure time, no arrival time,
 *    no stops and no duration, which are four of the seven things this app
 *    ranks on. The real itinerary lives behind `/trips/{id}`, so we fetch it.
 *    An availability row we can't resolve to a trip is dropped rather than
 *    ranked on absent times.
 *
 * 2. Miles are converted to a cash-equivalent. The ranker needs one positive
 *    number for cost, and an award ticket's cash outlay is only its taxes -
 *    ranking on that alone would make a 120,000-mile seat look free because
 *    the taxes are $5.60. So cost becomes `taxes + miles x valuation`, with
 *    the valuation stated on every offer so the arithmetic is visible rather
 *    than buried. Change it with SEATSAERO_CENTS_PER_MILE.
 *
 * Award tickets also earn nothing - no redeemable miles, no elite credit - so
 * those are set to zero explicitly here. Left undefined, enrich.js would
 * derive an earning figure from a price that is itself a valuation, which
 * would be a guess built on a guess.
 *
 * Docs: https://developers.seats.aero (Partner API; a paid Pro plan)
 */

import {
  toOffer,
  keepUsable,
  normalizeCabin,
  parseLocalDateTime,
} from './normalize.js';
import { airportByCode, airportsFor, utcOffsetHours } from '../airports.js';

const BASE_URL = 'https://seats.aero/partnerapi';

export const id = 'seatsaero';
export const label = 'seats.aero (award availability, in miles)';
export const credentials = ['SEATSAERO_API_KEY'];

export function isConfigured(env = process.env) {
  return Boolean(env.SEATSAERO_API_KEY);
}

/**
 * Which response fields hold each cabin.
 *
 * The request-side `cabin` parameter is documented inconsistently across
 * seats.aero's own docs and its client libraries (some say `Y,W,J,F`, others
 * say `economy,business`), so this asks for every cabin and filters here
 * instead. The response field prefixes are unambiguous, and the extra rows
 * cost nothing - it is one cached call either way.
 */
const CABIN_FIELD = {
  economy: 'Y',
  premium: 'W',
  business: 'J',
  first: 'F',
};

/** What a mile is worth, in cents, when comparing an award seat to a fare. */
const DEFAULT_CENTS_PER_MILE = 1.4;

/**
 * seats.aero returns taxes as an integer and does not document the unit. Every
 * client treats it as minor units (560 -> $5.60), which matches the shape of
 * real award taxes, so that is the default - but it is an assumption, not a
 * documented fact, so it is one constant and one env var rather than a literal
 * buried in the parser. If taxes come out 100x wrong, this is the dial.
 */
const TAXES_ARE_MINOR_UNITS = true;

/** Award taxes above this are treated as a unit misread rather than a fare. */
const IMPLAUSIBLE_TAXES_USD = 5000;

const KM_PER_MILE = 1.609344;

/** How many availability rows we resolve to real itineraries. Each is a call. */
const DEFAULT_TRIP_LIMIT = 15;
const TRIP_CONCURRENCY = 4;

export function centsPerMile(env = process.env) {
  const raw = Number(env.SEATSAERO_CENTS_PER_MILE);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CENTS_PER_MILE;
}

function taxesAreMinorUnits(env = process.env) {
  if (env.SEATSAERO_TAXES_IN_CENTS === 'false') return false;
  if (env.SEATSAERO_TAXES_IN_CENTS === 'true') return true;
  return TAXES_ARE_MINOR_UNITS;
}

/** @returns {number} taxes in whole currency units, or NaN */
export function parseTaxes(raw, env = process.env) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return NaN;
  const usd = taxesAreMinorUnits(env) ? value / 100 : value;
  return usd > IMPLAUSIBLE_TAXES_USD ? NaN : usd;
}

/**
 * Cash-equivalent cost of an award seat.
 * Taxes are real money; the miles are valued, not spent in dollars.
 */
export function awardCostUsd({ miles, taxesUsd }, env = process.env) {
  const cpm = centsPerMile(env);
  const milesValue = Number.isFinite(miles) ? (miles * cpm) / 100 : 0;
  const cash = Number.isFinite(taxesUsd) ? taxesUsd : 0;
  const total = milesValue + cash;
  return total > 0 ? Math.round(total * 100) / 100 : NaN;
}

/**
 * A supplier timestamp as naive airport-local time.
 *
 * Time-of-day scoring is about the clock on the wall at the airport, so an
 * instant in UTC has to be placed in the airport's own zone first. A value
 * that already carries no offset is taken as local, which is what the other
 * adapters here receive.
 */
export function toAirportLocal(value, airportCode) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  const isAbsolute = /(Z|[+-]\d{2}:?\d{2})$/.test(text);
  if (!isAbsolute) return parseLocalDateTime(text);

  const at = new Date(text);
  if (Number.isNaN(at.getTime())) return null;

  const tz = airportByCode(airportCode)?.tz;
  if (!tz) return null;

  const shifted = new Date(at.getTime() + utcOffsetHours(tz, at) * 3600000);
  return parseLocalDateTime(shifted.toISOString().slice(0, 16));
}

function headers(apiKey) {
  /* seats.aero's published clients send the bare key in this header, while
   * some of its docs pages show a `Bearer ` prefix. The key is forwarded
   * exactly as configured, so whichever form the account needs, putting it in
   * SEATSAERO_API_KEY works - including a value pasted with the prefix. */
  return { accept: 'application/json', 'Partner-Authorization': String(apiKey).trim() };
}

async function getJson(url, { apiKey, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(url, { headers: headers(apiKey), signal });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `seats.aero rejected the API key (${response.status}). The Partner API needs a ` +
          `paid Pro plan - check SEATSAERO_API_KEY.`
      );
    }
    if (response.status === 429) {
      throw new Error('seats.aero rate limit reached (429). Try again shortly.');
    }
    const detail = payload?.message ?? payload?.error ?? response.statusText;
    throw new Error(`seats.aero ${response.status}: ${detail}`);
  }
  return payload;
}

/** One availability row -> the figures for the cabin we want, or null. */
export function cabinAvailability(row, cabin, env = process.env) {
  const prefix = CABIN_FIELD[cabin];
  if (!prefix) return null;
  if (row?.[`${prefix}Available`] !== true) return null;

  const miles = Number(row[`${prefix}MileageCostRaw`] ?? row[`${prefix}MileageCost`]);
  if (!Number.isFinite(miles) || miles <= 0) return null;

  return {
    miles,
    taxesUsd: parseTaxes(row[`${prefix}TotalTaxes`], env),
    currency: row.TaxesCurrency || 'USD',
    remainingSeats: Number(row[`${prefix}RemainingSeats`]) || null,
    airlines: splitList(row[`${prefix}Airlines`]),
  };
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Biggest first: award space lives at the international airports, not at Luton. */
const MAX_AIRPORTS_PER_END = 5;

/**
 * The airport codes to ask about for one end of the trip.
 *
 * Resolution upstream prefers metropolitan codes, because "Tokyo" meaning both
 * Haneda and Narita is what makes a cash search match what a traveller sees.
 * seats.aero indexes real airports, so a bare `NYC` or `LON` finds nothing -
 * and "no award space" is exactly the wrong answer to give someone. The metro
 * is expanded into its members instead, which the endpoint accepts as a
 * comma-separated list.
 */
export function airportCodesFor(place, fallbackCode) {
  if (!place) return fallbackCode ? [fallbackCode] : [];
  const airports = airportsFor(place);
  if (airports.length <= 1) return [place.code ?? fallbackCode].filter(Boolean);

  return airports
    .slice()
    .sort((a, b) => significanceOf(b) - significanceOf(a) || a.code.localeCompare(b.code))
    .slice(0, MAX_AIRPORTS_PER_END)
    .map((a) => a.code);
}

/** The same "International beats Municipal" heuristic the resolver uses. */
function significanceOf(airport) {
  const name = String(airport?.name ?? '');
  if (/\bInternational\b/i.test(name)) return 2;
  if (/\b(Municipal|Regional|County|RAF|Air (Base|Force))\b/i.test(name)) return 0;
  return 1;
}

export async function searchFlights(query, opts = {}) {
  const env = opts.env ?? process.env;
  const apiKey = env.SEATSAERO_API_KEY;
  if (!apiKey) throw new Error('SEATSAERO_API_KEY must be set.');

  const cabin = normalizeCabin(query.cabin ?? 'economy');
  const origins = airportCodesFor(query.origin, query.fromAirport);
  const destinations = airportCodesFor(query.destination, query.toAirport);

  const params = new URLSearchParams({
    origin_airport: origins.join(','),
    destination_airport: destinations.join(','),
    start_date: query.date,
    end_date: query.returnDate ?? query.date,
    take: String(Math.min(1000, Math.max(20, query.limit ?? 200))),
  });
  if (env.SEATSAERO_SOURCES) params.set('sources', env.SEATSAERO_SOURCES);
  if (env.SEATSAERO_CARRIERS) params.set('carriers', env.SEATSAERO_CARRIERS);

  const search = await getJson(`${BASE_URL}/search?${params}`, { apiKey, ...opts });

  const rows = (search?.data ?? [])
    .map((row) => ({ row, cabinData: cabinAvailability(row, cabin, env) }))
    .filter((entry) => entry.cabinData);

  if (rows.length === 0) {
    return {
      source: id,
      label,
      offers: [],
      dropped: [],
      note:
        `No ${cabin} award space found on this route for that date. Award ` +
        `availability is far sparser than cash fares - try another date or cabin.`,
    };
  }

  // Cheapest first, so the trip calls we can afford go on the best rows.
  rows.sort((a, b) => a.cabinData.miles - b.cabinData.miles);
  const limit = Number(env.SEATSAERO_TRIP_LIMIT) || DEFAULT_TRIP_LIMIT;
  const shortlist = rows.slice(0, Math.max(1, limit));

  const trips = await mapWithConcurrency(shortlist, TRIP_CONCURRENCY, async (entry) => {
    try {
      const payload = await getJson(`${BASE_URL}/trips/${encodeURIComponent(entry.row.ID)}`, {
        apiKey,
        ...opts,
      });
      return { entry, trips: payload?.data ?? [] };
    } catch (error) {
      return { entry, trips: [], error };
    }
  });

  const offers = [];
  const unresolved = [];
  for (const { entry, trips: list, error } of trips) {
    const built = list
      .map((trip) => buildOffer(trip, entry, cabin, env))
      .filter(Boolean);
    if (built.length === 0) {
      unresolved.push({ id: entry.row.ID, missing: [error ? 'trips (request failed)' : 'itinerary'] });
      continue;
    }
    offers.push(...built);
  }

  const { offers: usable, dropped } = keepUsable(offers, { source: 'seats.aero' });
  const result = { source: id, label, offers: usable, dropped: [...dropped, ...unresolved] };

  const notes = [
    `Award space priced in miles. Cost ranks on taxes plus miles valued at ` +
      `${centsPerMile(env)}c each - change with SEATSAERO_CENTS_PER_MILE.`,
    // Every award option earns nothing, so the criterion can only dilute the
    // spread between scores. It cannot reorder anything - identical values all
    // score neutral - but the weight is better spent elsewhere.
    `Award tickets earn no miles or elite credit, so rate "Miles & points" N/A.`,
  ];
  if (rows.length > shortlist.length) {
    notes.push(
      `${rows.length} availability rows found; the ${shortlist.length} cheapest were ` +
        `resolved to itineraries (SEATSAERO_TRIP_LIMIT).`
    );
  }
  result.note = notes.join(' ');
  return result;
}

/** AvailabilityData (one real itinerary) -> a canonical offer. */
export function buildOffer(trip, entry, cabin, env = process.env) {
  const row = entry.row;
  const from = firstSegmentAirport(trip, 'OriginAirport') ?? row?.Route?.OriginAirport;
  const to = lastSegmentAirport(trip, 'DestinationAirport') ?? row?.Route?.DestinationAirport;

  const departure = toAirportLocal(trip?.DepartsAt, from);
  const arrival = toAirportLocal(trip?.ArrivesAt, to);

  // seats.aero's own cabin for the trip is more specific than the row's.
  const tripCabin = normalizeCabin(trip?.Cabin, cabin);

  const miles = Number(trip?.MileageCost);
  const taxesUsd = parseTaxes(trip?.TotalTaxes, env);
  const fallback = entry.cabinData ?? {};

  const resolvedMiles = Number.isFinite(miles) && miles > 0 ? miles : fallback.miles;
  const resolvedTaxes = Number.isFinite(taxesUsd) ? taxesUsd : fallback.taxesUsd;

  const durationMin = durationOf(trip, departure, arrival);
  const segments = (trip?.AvailabilitySegments ?? [])
    .slice()
    .sort((a, b) => (Number(a?.Order) || 0) - (Number(b?.Order) || 0));

  const carriers = splitList(trip?.Carriers).length
    ? splitList(trip.Carriers)
    : fallback.airlines ?? [];

  const distanceMi = Number(trip?.TotalSegmentDistance) || Number(row?.Route?.Distance);

  const offer = toOffer({
    id: `sa-${trip?.ID ?? trip?.AvailabilityID ?? row?.ID}`,
    source: id,
    airline: carriers[0] ?? null,
    airlineCode: segments[0]?.FlightNumber?.slice(0, 2) ?? null,
    cabin: tripCabin,
    from,
    to,
    departure,
    arrival,
    durationMin,
    stops: Number.isFinite(Number(trip?.Stops))
      ? Number(trip.Stops)
      : Math.max(0, segments.length - 1),
    layoverAirports: segments.slice(0, -1).map((s) => s?.DestinationAirport).filter(Boolean),
    priceUsd: awardCostUsd({ miles: resolvedMiles, taxesUsd: resolvedTaxes }, env),
    currency: 'USD',
    distanceKm: Number.isFinite(distanceMi) ? Math.round(distanceMi * KM_PER_MILE) : undefined,
    // An award ticket earns no redeemable miles and no elite credit. Stated,
    // not left undefined, so nothing downstream invents a figure.
    milesEarned: 0,
    eliteQualifyingPoints: 0,
    segments: segments.map((s) => ({
      from: s?.OriginAirport,
      to: s?.DestinationAirport,
      departure: s?.DepartsAt,
      arrival: s?.ArrivesAt,
      flightNumber: s?.FlightNumber,
      airline: s?.FlightNumber?.slice(0, 2),
      aircraft: s?.AircraftName ?? s?.AircraftCode,
      fareClass: s?.FareClass,
      cabin: normalizeCabin(s?.Cabin, tripCabin),
    })),
  });

  offer.award = true;
  offer.programme = trip?.Source ?? row?.Source ?? null;
  offer.mileageCost = Number.isFinite(resolvedMiles) ? resolvedMiles : null;
  offer.taxesUsd = Number.isFinite(resolvedTaxes) ? resolvedTaxes : null;
  offer.taxesCurrency = trip?.TaxesCurrency || fallback.currency || 'USD';
  offer.centsPerMile = centsPerMile(env);
  offer.remainingSeats = Number(trip?.RemainingSeats) || fallback.remainingSeats || null;
  offer.flightNumbers = splitList(trip?.FlightNumbers);
  offer.earningBasis = 'Award ticket - earns no redeemable miles or elite credit.';
  offer.priceBasis =
    `${(offer.mileageCost ?? 0).toLocaleString('en-US')} miles + ` +
    `$${(offer.taxesUsd ?? 0).toFixed(2)} taxes, miles valued at ${offer.centsPerMile}c`;
  return offer;
}

function firstSegmentAirport(trip, key) {
  const segments = trip?.AvailabilitySegments ?? [];
  if (segments.length === 0) return null;
  const sorted = segments.slice().sort((a, b) => (Number(a?.Order) || 0) - (Number(b?.Order) || 0));
  return sorted[0]?.[key] ?? null;
}

function lastSegmentAirport(trip, key) {
  const segments = trip?.AvailabilitySegments ?? [];
  if (segments.length === 0) return null;
  const sorted = segments.slice().sort((a, b) => (Number(a?.Order) || 0) - (Number(b?.Order) || 0));
  return sorted[sorted.length - 1]?.[key] ?? null;
}

/** An instant in ms, but only for a timestamp that actually carries a zone. */
function absoluteMs(value) {
  const text = String(value ?? '').trim();
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Duration in minutes.
 *
 * Measured between the two *absolute* instants. Subtracting local clock times
 * instead would be wrong by the difference between the zones - JFK-LHR leaves
 * at 17:30 and lands at 10:15, which looks like 16h45m on the wall clocks and
 * is really 7h45m. `TotalDuration` is the documented field but its unit isn't
 * stated, so it is a last resort and only when it could plausibly be minutes.
 */
export function durationOf(trip, departure, arrival) {
  const departAt = absoluteMs(trip?.DepartsAt);
  const arriveAt = absoluteMs(trip?.ArrivesAt);
  if (departAt != null && arriveAt != null) {
    const minutes = (arriveAt - departAt) / 60000;
    if (minutes > 0) return minutes;
  }

  // Zone-less timestamps: each is local to its own airport and there is no
  // offset to apply, so the clock difference is the only figure available.
  if (departure && arrival) {
    const depart = Date.parse(`${departure.date}T${departure.time}:00Z`);
    const arrive = Date.parse(`${arrival.date}T${arrival.time}:00Z`);
    const minutes = (arrive - depart) / 60000;
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }

  const declared = Number(trip?.TotalDuration);
  // A long-haul is hours, not days: anything over a week is the wrong unit.
  if (Number.isFinite(declared) && declared > 0 && declared < 60 * 24 * 7) return declared;
  return NaN;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Test seam: the parsing, without the network. */
export function parseResponse({ search, tripsById }, query = {}, env = process.env) {
  const cabin = normalizeCabin(query.cabin ?? 'economy');
  const offers = [];
  for (const row of search?.data ?? []) {
    const cabinData = cabinAvailability(row, cabin, env);
    if (!cabinData) continue;
    for (const trip of tripsById?.[row.ID]?.data ?? []) {
      const offer = buildOffer(trip, { row, cabinData }, cabin, env);
      if (offer) offers.push(offer);
    }
  }
  const { offers: usable, dropped } = keepUsable(offers, { source: 'seats.aero' });
  return { source: id, label, offers: usable, dropped };
}

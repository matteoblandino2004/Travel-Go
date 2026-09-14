/**
 * Amadeus Flight Offers Search.
 *
 * Licensed GDS inventory rather than a scrape of someone's website: real fares,
 * real terms, a free self-service tier, and offers you can actually go on to
 * price and book. Coverage is not identical to Google Flights - Amadeus sees
 * what's in the GDS, so some low-cost carriers that Google shows direct are
 * missing - but it is the honest choice for anything user-facing.
 *
 * Two calls: an OAuth2 client-credentials token, then the search. Tokens last
 * about 30 minutes and are cached here.
 *
 * Docs: https://developers.amadeus.com/self-service
 */

import { toOffer, keepUsable, parseIsoDuration, parseLocalDateTime } from './normalize.js';

const HOSTS = {
  test: 'https://test.api.amadeus.com',
  production: 'https://api.amadeus.com',
};

const CABIN_TO_AMADEUS = {
  economy: 'ECONOMY',
  premium: 'PREMIUM_ECONOMY',
  business: 'BUSINESS',
  first: 'FIRST',
};

export const id = 'amadeus';
export const label = 'Amadeus (licensed GDS inventory)';
export const credentials = ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'];

export function isConfigured(env = process.env) {
  return Boolean(env.AMADEUS_CLIENT_ID && env.AMADEUS_CLIENT_SECRET);
}

/** Cached access token, keyed by client id so tests can't poison each other. */
const tokenCache = new Map();

export async function getAccessToken(opts = {}) {
  const env = opts.env ?? process.env;
  const clientId = env.AMADEUS_CLIENT_ID;
  const clientSecret = env.AMADEUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET must both be set.');
  }

  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const host = HOSTS[env.AMADEUS_ENV === 'production' ? 'production' : 'test'];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(`${host}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal: opts.signal,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(`Amadeus auth ${response.status}: ${payload?.error_description ?? response.statusText}`);
  }

  tokenCache.set(clientId, {
    token: payload.access_token,
    // Retire the token a minute early rather than racing its expiry.
    expiresAt: Date.now() + Math.max(60, (payload.expires_in ?? 1799) - 60) * 1000,
  });
  return payload.access_token;
}

/** Test seam: clear cached tokens. */
export function resetTokenCache() {
  tokenCache.clear();
}

export async function searchFlights(query, opts = {}) {
  const env = opts.env ?? process.env;
  const host = HOSTS[env.AMADEUS_ENV === 'production' ? 'production' : 'test'];
  const token = await getAccessToken(opts);

  const params = new URLSearchParams({
    originLocationCode: query.fromAirport,
    destinationLocationCode: query.toAirport,
    departureDate: query.date,
    adults: String(query.adults ?? 1),
    travelClass: CABIN_TO_AMADEUS[query.cabin ?? 'economy'] ?? 'ECONOMY',
    currencyCode: 'USD',
    max: String(query.limit ?? 50),
  });
  if (query.returnDate) params.set('returnDate', query.returnDate);
  if (query.maxStops === 'nonstop') params.set('nonStop', 'true');

  const fetchImpl = opts.fetchImpl ?? fetch;
  const response = await fetchImpl(`${host}/v2/shopping/flight-offers?${params}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: opts.signal,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload?.errors?.[0];
    throw new Error(
      `Amadeus ${response.status}: ${detail?.detail ?? detail?.title ?? response.statusText}`
    );
  }

  return parseResponse(payload, query);
}

export function parseResponse(payload, query = {}) {
  const carriers = payload?.dictionaries?.carriers ?? {};
  const offers = (payload?.data ?? [])
    .map((raw, index) => buildOffer(raw, index, carriers, query))
    .filter(Boolean);

  const { offers: usable, dropped } = keepUsable(offers, { source: 'Amadeus' });
  return { source: id, label, offers: usable, dropped };
}

function buildOffer(raw, index, carriers, query) {
  // One-way and round-trip both come back as itineraries; we rank the outbound.
  const itinerary = raw?.itineraries?.[0];
  const segments = itinerary?.segments ?? [];
  if (segments.length === 0) return null;

  const first = segments[0];
  const last = segments[segments.length - 1];

  const durationMin = parseIsoDuration(itinerary.duration);
  const flyingMin = segments.reduce((sum, s) => sum + (parseIsoDuration(s.duration) || 0), 0);

  const carrierCode = raw.validatingAirlineCodes?.[0] ?? first.carrierCode;
  const fareDetail = raw.travelerPricings?.[0]?.fareDetailsBySegment?.[0];

  // A segment can itself contain a technical stop that isn't a connection.
  const technicalStops = segments.reduce((sum, s) => sum + (Number(s.numberOfStops) || 0), 0);

  const offer = toOffer({
    id: `am-${raw.id ?? index}`,
    source: id,
    airline: carriers[carrierCode] ? titleCase(carriers[carrierCode]) : undefined,
    airlineCode: carrierCode,
    cabin: fareDetail?.cabin ?? query.cabin,
    from: first.departure?.iataCode,
    to: last.arrival?.iataCode,
    departure: parseLocalDateTime(first.departure?.at),
    arrival: parseLocalDateTime(last.arrival?.at),
    durationMin,
    stops: segments.length - 1 + technicalStops,
    layoverAirports: segments.slice(0, -1).map((s) => s.arrival?.iataCode).filter(Boolean),
    layoverMinutes: Number.isFinite(durationMin) && flyingMin > 0 ? Math.max(0, durationMin - flyingMin) : 0,
    priceUsd: Number(raw.price?.grandTotal ?? raw.price?.total),
    currency: raw.price?.currency ?? 'USD',
    segments: segments.map((s) => ({
      from: s.departure?.iataCode,
      to: s.arrival?.iataCode,
      departure: s.departure?.at,
      arrival: s.arrival?.at,
      flightNumber: `${s.carrierCode}${s.number}`,
      airline: carriers[s.carrierCode] ? titleCase(carriers[s.carrierCode]) : s.carrierCode,
      aircraft: s.aircraft?.code,
      durationMin: parseIsoDuration(s.duration),
    })),
  });

  offer.bookableSeats = raw.numberOfBookableSeats;
  offer.fareBasis = fareDetail?.fareBasis ?? null;
  offer.includedCheckedBags = fareDetail?.includedCheckedBags?.quantity ?? null;
  return offer;
}

/** Amadeus shouts carrier names: "ALL NIPPON AIRWAYS" -> "All Nippon Airways". */
function titleCase(value) {
  return String(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

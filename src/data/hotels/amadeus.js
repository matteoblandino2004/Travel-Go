/**
 * Real hotels, anywhere, via Amadeus Hotel Search.
 *
 * Same free self-service credentials as the flight adapter, and global
 * coverage - which is the point: it removes the last thing tying the app to a
 * hand-written city list.
 *
 * Two calls, as the API is arranged: list the hotels near a point, then price
 * the ones we're going to show. Pricing every hotel in a city would be slow
 * and wasteful, so the list is trimmed first.
 *
 * Docs: https://developers.amadeus.com/self-service/category/hotels
 */

import { getAccessToken } from '../providers/amadeus.js';

const HOSTS = { test: 'https://test.api.amadeus.com', production: 'https://api.amadeus.com' };

export const id = 'amadeus';
export const label = 'Amadeus hotel content';
export const credentials = ['AMADEUS_CLIENT_ID', 'AMADEUS_CLIENT_SECRET'];

export function isConfigured(env = process.env) {
  return Boolean(env.AMADEUS_CLIENT_ID && env.AMADEUS_CLIENT_SECRET);
}

/** Amadeus chain codes -> the loyalty programmes the ranking understands. */
const CHAIN_PROGRAMMES = {
  MC: 'marriott', BW: null, HL: 'hilton', HI: 'ihg', IC: 'ihg', CP: 'ihg',
  HY: 'hyatt', RT: 'accor', AC: 'accor', NN: 'accor', SB: 'accor',
  WI: 'marriott', SI: 'marriott', WH: 'wyndham', RD: 'wyndham', EH: 'hilton',
  GA: 'hyatt', LC: 'hilton', DT: 'hilton', HP: 'hilton', CY: 'marriott',
  FN: 'marriott', RC: 'marriott', WV: 'marriott', OZ: 'ihg', YZ: 'ihg',
};

export async function searchHotels(query, opts = {}) {
  const env = opts.env ?? process.env;
  const host = HOSTS[env.AMADEUS_ENV === 'production' ? 'production' : 'test'];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = await getAccessToken(opts);
  const auth = { authorization: `Bearer ${token}` };

  const centre = query.destination?.centre;
  if (!centre) throw new Error('A destination centre is required to search hotels.');

  // 1. What hotels are near the centre.
  const listParams = new URLSearchParams({
    latitude: String(centre.lat),
    longitude: String(centre.lng),
    radius: String(query.radiusKm ?? 8),
    radiusUnit: 'KM',
    hotelSource: 'ALL',
  });
  const listResponse = await fetchImpl(
    `${host}/v1/reference-data/locations/hotels/by-geocode?${listParams}`,
    { headers: auth, signal: opts.signal }
  );
  const listPayload = await listResponse.json().catch(() => null);
  if (!listResponse.ok) {
    const detail = listPayload?.errors?.[0];
    throw new Error(`Amadeus hotel list ${listResponse.status}: ${detail?.detail ?? listResponse.statusText}`);
  }

  const candidates = (listPayload?.data ?? []).filter((h) => h.hotelId);
  if (candidates.length === 0) {
    return { source: id, label, hotels: [], notes: ['Amadeus has no hotel content for this area.'] };
  }

  // 2. Price a bounded slice of them. The API caps hotelIds per request, and
  //    we only ever show a page of results anyway.
  const wanted = candidates.slice(0, query.count ?? 20);
  const offerParams = new URLSearchParams({
    hotelIds: wanted.map((h) => h.hotelId).join(','),
    adults: String(query.adults ?? 1),
    currency: 'USD',
    bestRateOnly: 'true',
  });
  if (query.checkIn) offerParams.set('checkInDate', query.checkIn);
  if (query.checkOut) offerParams.set('checkOutDate', query.checkOut);

  const offersResponse = await fetchImpl(`${host}/v3/shopping/hotel-offers?${offerParams}`, {
    headers: auth,
    signal: opts.signal,
  });
  const offersPayload = await offersResponse.json().catch(() => null);
  if (!offersResponse.ok) {
    const detail = offersPayload?.errors?.[0];
    throw new Error(`Amadeus hotel offers ${offersResponse.status}: ${detail?.detail ?? offersResponse.statusText}`);
  }

  return parseResponse(offersPayload, wanted, query);
}

/** Exported for fixture tests - no key, no network. */
export function parseResponse(offersPayload, candidates = [], query = {}) {
  const nights = query.nights ?? 3;
  const byId = new Map(candidates.map((c) => [c.hotelId, c]));
  const notes = [];

  const hotels = (offersPayload?.data ?? [])
    .filter((entry) => entry.available !== false && entry.offers?.length)
    .map((entry) => {
      const hotel = entry.hotel ?? {};
      const listed = byId.get(hotel.hotelId) ?? {};
      const offer = cheapest(entry.offers);

      const total = Number(offer?.price?.total);
      if (!Number.isFinite(total) || total <= 0) return null;

      const lat = Number(hotel.latitude ?? listed.geoCode?.latitude);
      const lng = Number(hotel.longitude ?? listed.geoCode?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const chainCode = hotel.chainCode ?? listed.chainCode ?? null;

      return {
        id: hotel.hotelId ?? listed.hotelId,
        source: id,
        name: titleCase(hotel.name ?? listed.name ?? 'Hotel'),
        brand: chainCode,
        program: chainCode ? CHAIN_PROGRAMMES[chainCode] ?? null : null,
        neighbourhood: hotel.address?.cityName ? titleCase(hotel.address.cityName) : query.destination?.name,
        lat,
        lng,
        // Amadeus prices the whole stay; the ranking compares nightly rates.
        nightlyUsd: Math.round(total / Math.max(1, nights)),
        totalUsd: Math.round(total),
        nights,
        stars: Number(hotel.rating ?? listed.rating) || undefined,
        // Not in this API. Left undefined so the criterion scores neutral for
        // everyone rather than inventing review scores.
        guestRating: undefined,
        reviewCount: undefined,
        cancellation: cancellationOf(offer, total),
        roomType: offer?.room?.typeEstimated?.category ?? null,
        boardType: offer?.boardType ?? null,
        offerId: offer?.id ?? null,
      };
    })
    .filter(Boolean);

  if (hotels.length === 0 && (offersPayload?.data ?? []).length > 0) {
    notes.push('Amadeus returned hotels but none were bookable for these dates.');
  }
  if (hotels.length > 0 && hotels.every((h) => h.stars === undefined)) {
    notes.push('Amadeus did not return star ratings for these properties.');
  }

  return { source: id, label, hotels, notes };
}

function cheapest(offers) {
  return [...offers].sort(
    (a, b) => (Number(a.price?.total) || Infinity) - (Number(b.price?.total) || Infinity)
  )[0];
}

/**
 * Amadeus expresses cancellation as a deadline and a forfeit amount rather
 * than a category. The amount has to be read against the price: forfeiting the
 * whole stay is non-refundable however the policy is worded, and only a
 * genuine part-forfeit is "partial".
 */
function cancellationOf(offer, total) {
  const policy = offer?.policies?.cancellations?.[0];
  if (!policy) {
    return offer?.policies?.refundable?.cancellationRefund === 'REFUNDABLE_UP_TO_DEADLINE'
      ? 'free'
      : 'nonrefundable';
  }

  const amount = Number(policy.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return policy.deadline ? 'free' : 'nonrefundable';
  }
  // Within a rounding error of the full price is not a partial refund.
  if (Number.isFinite(total) && amount >= total - 0.5) return 'nonrefundable';
  return 'partial';
}

function titleCase(value) {
  const s = String(value);
  // Only rewrite the SHOUTING that Amadeus tends to return.
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

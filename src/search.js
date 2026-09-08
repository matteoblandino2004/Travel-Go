/**
 * Orchestration: take a trip request, fetch candidates, rank both halves.
 *
 * This is the only place that knows about both the provider and the engine.
 */

import { searchFlights, searchHotels } from './data/provider.js';
import { findCity, findPoi } from './data/cities.js';
import { rankFlights } from './core/flights.js';
import { rankHotels } from './core/hotels.js';
import { explain, topDrivers } from './core/rank.js';

/**
 * Attach coordinates to the places the traveller named.
 *
 * Places that can't be located are returned separately rather than dropped, so
 * the UI can say "I couldn't find Blue Bottle Kiyosumi" instead of quietly
 * ranking hotels against a shorter list than the user thinks they gave.
 */
export function resolvePlaces(places, city) {
  const resolved = [];
  const unresolved = [];
  for (const place of places ?? []) {
    if (!place?.name) continue;
    if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
      resolved.push({ ...place, source: 'coordinates' });
      continue;
    }
    const match = findPoi(city, place.name);
    if (match) {
      resolved.push({
        ...place,
        lat: match.lat,
        lng: match.lng,
        kind: place.kind ?? match.kind,
        matchedName: match.name,
        source: 'catalogue',
      });
    } else {
      unresolved.push(place.name);
    }
  }
  return { resolved, unresolved };
}

/**
 * @param {object} request
 * @param {string} request.from
 * @param {string} request.to
 * @param {string} [request.date]
 * @param {number} [request.nights]
 * @param {'economy'|'premium'|'business'} [request.cabin]
 * @param {object} request.flight importance ratings for flight criteria
 * @param {object} request.hotel importance ratings for hotel criteria
 * @param {Array} [request.places]
 * @param {object} [request.departureWindow]
 * @param {object} [request.arrivalWindow]
 * @param {object} [request.profile] loyalty profile
 */
export function planTrip(request) {
  const destination = findCity(request.to);
  if (!destination) throw new Error(`I don't have inventory for "${request.to}" yet.`);

  const { resolved, unresolved } = resolvePlaces(request.places, destination);

  const flightSearch = searchFlights({
    from: request.from,
    to: request.to,
    date: request.date,
    cabin: request.cabin ?? 'economy',
    profile: request.profile,
  });

  const rankedFlights = rankFlights(flightSearch.offers, request.flight, {
    departureWindow: request.departureWindow,
    arrivalWindow: request.arrivalWindow,
  });

  const hotelSearch = searchHotels({
    city: request.to,
    nights: request.nights ?? 3,
    checkIn: request.date,
    profile: request.profile,
  });

  const rankedHotels = rankHotels(hotelSearch.hotels, request.hotel, {
    pois: resolved,
    transitQuality: destination.transitQuality,
  });

  return {
    destination: { code: destination.code, name: destination.name, country: destination.country },
    places: { resolved, unresolved },
    flights: decorate(rankedFlights),
    hotels: decorate(rankedHotels),
  };
}

/** Add the human-facing "why" to every result, from the scored numbers. */
function decorate(ranked) {
  return {
    ...ranked,
    results: ranked.results.map((r) => ({
      ...r,
      why: explain(r),
      drivers: topDrivers(r).map((d) => ({
        key: d.key,
        label: d.label,
        display: d.display,
        share: Math.round((d.contribution / Math.max(1e-9, r.score / 100)) * 100),
      })),
    })),
  };
}

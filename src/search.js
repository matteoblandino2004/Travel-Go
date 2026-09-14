/**
 * Orchestration: take a trip request, resolve it against the world, fetch
 * candidates, rank both halves.
 *
 * This is the only place that knows about the resolver, the geocoder, both
 * provider registries and the engine.
 */

import { searchFlights } from './data/providers/index.js';
import { searchHotels } from './data/hotels/index.js';
import { resolvePlace, describePlace } from './data/airports.js';
import { geocodePlace, geocodeCityCentre } from './data/geocode/index.js';
import { transitQualityFor } from './data/transit.js';
import { curatedCityFor } from './data/cities.js';
import { rankFlights } from './core/flights.js';
import { rankHotels } from './core/hotels.js';
import { explain, topDrivers } from './core/rank.js';

/**
 * Resolve what the user typed to somewhere real, or say why not.
 * @returns {{place: object, alternatives: object[]}}
 */
export function resolveEndpoint(value, label) {
  const resolved = resolvePlace(value);
  if (resolved.notFound) {
    throw new Error(
      `I can't find anywhere called "${value}". Try a city name or a 3-letter airport code (e.g. LIS).`
    );
  }
  return resolved;
}

/**
 * Attach coordinates to the places the traveller named.
 *
 * Curated catalogue first, then the geocoder, then reported as unresolved.
 * Places we can't locate are returned separately rather than dropped, so the
 * UI can say "I couldn't find Blue Bottle Kiyosumi" instead of quietly ranking
 * hotels against a shorter list than the user thinks they gave.
 *
 * @param {Array} places
 * @param {object} destination resolved place from airports.js
 * @param {{lat:number,lng:number}} centre city centre, to bias the geocoder
 */
export async function resolvePlaces(places, destination, centre, opts = {}) {
  const resolved = [];
  const unresolved = [];

  for (const place of places ?? []) {
    if (!place?.name) continue;

    // Coordinates given outright win - the user knows where their friend lives.
    if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
      resolved.push({ ...place, source: 'coordinates' });
      continue;
    }

    const located = await geocodePlace(
      place.name,
      {
        city: destination?.city,
        cityCode: destination?.code,
        country: destination?.country,
        near: centre,
      },
      opts
    );

    if (located) {
      resolved.push({
        ...place,
        lat: located.lat,
        lng: located.lng,
        kind: place.kind ?? located.kind,
        matchedName: located.name,
        source: located.source,
      });
    } else {
      unresolved.push(place.name);
    }
  }

  return { resolved, unresolved };
}

/**
 * @param {object} request
 * @param {string} request.from origin city or airport
 * @param {string} request.to destination
 * @param {string} [request.date]
 * @param {number} [request.nights]
 * @param {'economy'|'premium'|'business'|'first'} [request.cabin]
 * @param {object} request.flight importance ratings for flight criteria
 * @param {object} request.hotel importance ratings for hotel criteria
 * @param {Array} [request.places]
 * @param {object} [request.departureWindow]
 * @param {object} [request.arrivalWindow]
 * @param {object} [request.profile] loyalty profile
 * @param {object} [opts] passed to providers and the geocoder (`env`, `fetchImpl`, ...)
 */
export async function planTrip(request, opts = {}) {
  const origin = resolveEndpoint(request.from, 'origin');
  const destination = resolveEndpoint(request.to, 'destination');

  const context = await destinationContext(destination.place, opts);
  const { resolved, unresolved } = await resolvePlaces(request.places, destination.place, context.centre, opts);

  const flightSearch = await searchFlights(
    {
      origin: origin.place,
      destination: destination.place,
      date: request.date,
      cabin: request.cabin ?? 'economy',
      adults: request.adults,
      maxStops: request.maxStops,
      profile: request.profile,
    },
    opts
  );

  const rankedFlights = rankFlights(flightSearch.offers, request.flight, {
    departureWindow: request.departureWindow,
    arrivalWindow: request.arrivalWindow,
  });

  const hotelSearch = await searchHotels(
    {
      destination: context.destination,
      nights: request.nights ?? 3,
      checkIn: request.date,
      adults: request.adults,
      profile: request.profile,
    },
    opts
  );

  const rankedHotels = rankHotels(hotelSearch.hotels, request.hotel, {
    pois: resolved,
    transitQuality: context.transit.value,
    modes: request.modes,
  });

  return {
    origin: summarise(origin),
    destination: { ...summarise(destination), ...context.summary },
    places: { resolved, unresolved },
    flights: { ...decorate(rankedFlights), provider: providerSummary(flightSearch) },
    hotels: { ...decorate(rankedHotels), provider: providerSummary(hotelSearch) },
  };
}

/**
 * Everything about a destination that isn't flights: where its centre is, how
 * easy it is to get around, and any places we already hold for it.
 */
export async function destinationContext(place, opts = {}) {
  const centre = await geocodeCityCentre(place, opts);
  const transit = transitQualityFor({ cityCode: place.code, country: place.country });
  const curated = curatedCityFor(place);

  return {
    centre,
    transit,
    destination: {
      name: place.city,
      cityCode: place.code,
      country: place.country,
      centre,
    },
    summary: {
      centre: { lat: centre.lat, lng: centre.lng, source: centre.source, approximate: centre.approximate },
      transitQuality: transit.value,
      transitBasis: transit.basis,
      // Curated places, where we have them; elsewhere the geocoder handles
      // whatever the user types and this is simply empty.
      pois: curated?.pois ?? [],
    },
  };
}

function summarise({ place, alternatives }) {
  return {
    code: place.code,
    name: place.city,
    label: describePlace(place),
    country: place.country,
    kind: place.kind,
    airports: place.kind === 'metro' ? place.airports.map((a) => a.code) : [place.code],
    // "Did you mean London, Ontario?" - surfaced, never silently applied.
    alternatives: (alternatives ?? []).map((a) => ({ code: a.code, label: describePlace(a) })),
  };
}

const providerSummary = (search) => ({
  source: search.source,
  label: search.label,
  live: search.live,
  cached: search.cached,
  notes: search.notes ?? [],
});

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

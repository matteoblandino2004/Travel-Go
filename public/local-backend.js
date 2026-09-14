/**
 * The in-page backend, for the single-file build.
 *
 * No server, so no network at all: the airport dataset is inlined, flights and
 * hotels are generated in the browser, and pasted flights are parsed here.
 * Two things genuinely can't work without a server and are handled honestly
 * rather than faked:
 *
 *  - Geocoding arbitrary place names. A hosted page can't call Nominatim (the
 *    viewer's content policy blocks outbound requests), so places resolve from
 *    the curated catalogue, or from coordinates typed in directly.
 *  - Live suppliers. SerpApi and Amadeus need secret keys, which have no
 *    business in a page anyone can open. Pasting real fares in covers this,
 *    and needs no key.
 *
 * Where the page can ask Claude, the plain-English intake uses that; otherwise
 * it falls back to the same offline keyword parser the server uses.
 */

import { FLIGHT_CRITERIA, rankFlights } from '/src/core/flights.js';
import { HOTEL_CRITERIA } from '/src/core/hotels.js';
import { WINDOW_PRESETS } from '/src/core/timepref.js';
import {
  setAirportData, searchPlaces, resolvePlace, describePlace, datasetInfo,
} from '/src/data/airports.js';
import { searchFlights as generateFlights } from '/src/data/providers/sample.js';
import { searchHotels as generateHotels } from '/src/data/hotels/sample.js';
import { importFlights as parsePastedFlights } from '/src/data/providers/paste.js';
import { enrichOffers } from '/src/data/enrich.js';
import { enrichHotel } from '/src/data/hotels/enrich.js';
import { transitQualityFor } from '/src/data/transit.js';
import { curatedCityFor, findPoi } from '/src/data/cities.js';
import { parseWithRules } from '/src/nl/rules.js';
import { sanitize } from '/src/nl/sanitize.js';

const criteriaMeta = (criteria) => criteria.map(({ key, label, hint }) => ({ key, label, hint }));

/** "35.6812, 139.7671" - the way to place somewhere the catalogue doesn't hold. */
const COORDINATES = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function createLocalBackend(airportData) {
  setAirportData(airportData);

  const resolveEndpoint = (value, label) => {
    const resolved = resolvePlace(value);
    if (resolved.notFound) {
      throw new Error(
        `I can't find anywhere called "${value}". Try a city name or a 3-letter airport code (e.g. LIS).`
      );
    }
    return resolved;
  };

  const endpointSummary = ({ place, alternatives }) => ({
    code: place.code,
    name: place.city,
    label: describePlace(place),
    country: place.country,
    kind: place.kind,
    airports: place.kind === 'metro' ? place.airports.map((a) => a.code) : [place.code],
    alternatives: (alternatives ?? []).map((a) => ({ code: a.code, label: describePlace(a) })),
  });

  /** The destination's centre, transit assumption and curated places. */
  const contextFor = (place) => {
    const curated = curatedCityFor(place);
    const transit = transitQualityFor({ cityCode: place.code, country: place.country });
    const centre = curated
      ? { lat: curated.center.lat, lng: curated.center.lng, source: 'catalogue', approximate: false }
      : { lat: place.lat, lng: place.lng, source: 'airport', approximate: true };
    return { centre, transit, curated };
  };

  const locate = (name, place) => {
    const coordinates = COORDINATES.exec(name);
    if (coordinates) {
      return {
        name: `${coordinates[1]}, ${coordinates[2]}`,
        lat: Number(coordinates[1]),
        lng: Number(coordinates[2]),
        kind: 'other',
        source: 'coordinates',
      };
    }
    const curated = curatedCityFor(place);
    const match = curated ? findPoi(curated, name) : null;
    return match ? { ...match, source: 'catalogue' } : null;
  };

  return {
    id: 'in-page',

    async reference() {
      return {
        flightCriteria: criteriaMeta(FLIGHT_CRITERIA),
        hotelCriteria: criteriaMeta(HOTEL_CRITERIA),
        windowPresets: WINDOW_PRESETS,
        aiAvailable: Boolean(globalThis.claude?.use),
        flightProvider: { active: 'sample', live: false, available: [] },
        hotelProvider: { active: 'sample', live: false, available: [] },
        geocoder: { id: 'none', label: 'Curated places and coordinates', enabled: false },
        coverage: datasetInfo(),
        standalone: true,
      };
    },

    async places(query, limit = 8) {
      return {
        results: searchPlaces(query, { limit }).map((place) => ({
          code: place.code,
          name: place.city,
          label: describePlace(place),
          country: place.country,
          kind: place.kind,
          airports: place.kind === 'metro' ? place.airports.map((a) => a.code) : [place.code],
        })),
      };
    },

    async search(body) {
      const origin = resolveEndpoint(body.from, 'origin');
      const destination = resolveEndpoint(body.to, 'destination');
      if (origin.place.code === destination.place.code) {
        throw new Error(`Origin and destination are both ${describePlace(origin.place)}.`);
      }

      const context = contextFor(destination.place);

      const resolved = [];
      const unresolved = [];
      for (const place of body.places ?? []) {
        if (!place?.name) continue;
        if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) {
          resolved.push({ ...place, source: place.source ?? 'coordinates' });
          continue;
        }
        const located = locate(place.name, destination.place);
        if (located) resolved.push({ ...place, ...located });
        else unresolved.push(place.name);
      }

      const flights = await generateFlights({
        origin: origin.place,
        destination: destination.place,
        date: body.date,
        cabin: body.cabin ?? 'economy',
      });
      const hotels = await generateHotels({
        destination: {
          name: destination.place.city,
          cityCode: destination.place.code,
          country: destination.place.country,
          centre: context.centre,
        },
        nights: body.nights ?? 3,
        checkIn: body.date,
      });

      return {
        origin: endpointSummary(origin),
        destination: {
          ...endpointSummary(destination),
          centre: context.centre,
          transitQuality: context.transit.value,
          transitBasis: context.transit.basis,
          pois: context.curated?.pois ?? [],
        },
        places: { resolved, unresolved },
        provider: {
          source: 'sample',
          label: 'Generated sample data',
          live: false,
          cached: false,
          notes: [],
        },
        hotelProvider: { source: 'sample', label: 'Generated sample data', live: false, cached: false, notes: [] },
        offers: enrichOffers(flights.offers, body.profile ?? {}),
        hotels: hotels.hotels.map((hotel) => enrichHotel(hotel, body.profile ?? {})),
      };
    },

    async geocode(body) {
      let place = null;
      try {
        place = resolveEndpoint(body.to, 'destination').place;
      } catch {
        place = null;
      }
      return { place: place ? locate(body.name, place) : locate(body.name, {}) };
    },

    /** Claude reads the trip where the page is allowed to ask it; otherwise keywords. */
    async parse(body) {
      const text = String(body.text ?? '').trim();
      if (!text) return { ...parseWithRules(''), warnings: ['Nothing to read.'] };

      const sample = await globalThis.claude?.use?.('sample').catch(() => null);
      if (!sample) {
        return {
          ...parseWithRules(text),
          warnings: ['Read with the offline keyword parser - anything you did not spell out stays at 3.'],
        };
      }

      try {
        const parsed = await sample.json(
          [{ role: 'user', content: `${intakePrompt()}\n\nToday is ${new Date().toISOString().slice(0, 10)}.\n\nTrip request:\n${text}` }],
          { modelTier: 'quick' }
        );
        return { ...sanitize(parsed), source: 'claude', warnings: [] };
      } catch (error) {
        return {
          ...parseWithRules(text),
          warnings: [`Claude couldn't read that (${error?.message ?? 'unavailable'}) - used the offline parser instead.`],
        };
      }
    },

    async importFlights(body) {
      let origin = null;
      let destination = null;
      try {
        origin = resolveEndpoint(body.from, 'origin').place;
        destination = resolveEndpoint(body.to, 'destination').place;
      } catch {
        // A paste that names its own airports doesn't need the search boxes.
      }
      const firstAirport = (place) =>
        place ? (place.kind === 'metro' ? place.airports[0].code : place.code) : undefined;

      const result = await parsePastedFlights(body.text, {
        from: firstAirport(origin),
        to: firstAirport(destination),
        date: body.date,
        cabin: body.cabin,
      });

      return {
        source: result.source,
        label: result.label,
        format: result.format,
        offers: enrichOffers(result.offers, body.profile ?? {}),
        skipped: result.skipped,
        notes: result.notes,
      };
    },
  };
}

/** The same instructions the server sends, built from the criteria themselves. */
function intakePrompt() {
  const brief = (criteria) => criteria.map((c) => `- ${c.key} (${c.label}): ${c.hint}`).join('\n');
  return `You read a traveller's description of a trip and turn it into search parameters and importance ratings for a booking tool.

Flight criteria:
${brief(FLIGHT_CRITERIA)}

Hotel criteria:
${brief(HOTEL_CRITERIA)}

Rate every criterion 1-5, or "na" to drop it from scoring entirely.

Rules:
- 3 is the neutral default. Use it when the traveller said nothing that bears on a criterion. Do not invent preferences.
- Use "na" only when they said the criterion is irrelevant to them, not merely when they failed to mention it.
- Reserve 5 for something they made central to the trip, and 1 for something they explicitly downplayed.
- Set departureWindow/arrivalWindow only from a stated time preference, as {"start":"HH:MM","end":"HH:MM"} in local time, else null.
- List every specific place they want to visit or eat at, with how much it matters.
- Record anything you inferred rather than read in "assumptions", in the second person.

Reply with JSON only, in exactly this shape:
{"origin":string|null,"destination":string|null,"departDate":"YYYY-MM-DD"|null,"nights":number|null,
 "cabin":"economy"|"premium"|"business"|null,
 "flight":{${FLIGHT_CRITERIA.map((c) => `"${c.key}":1-5|"na"`).join(',')}},
 "hotel":{${HOTEL_CRITERIA.map((c) => `"${c.key}":1-5|"na"`).join(',')}},
 "departureWindow":{"start":"HH:MM","end":"HH:MM"}|null,
 "arrivalWindow":{"start":"HH:MM","end":"HH:MM"}|null,
 "places":[{"name":string,"kind":"sight"|"food"|"other","importance":1-5|"na"}],
 "assumptions":[string]}`;
}

/**
 * Zero-dependency HTTP server: JSON API plus the static front end.
 *
 * The browser imports the same modules from src/core that the API uses, so
 * moving a slider re-ranks instantly on the client with no round trip and no
 * risk of the two implementations drifting apart. The server's job is to hand
 * over candidates once, and to do the things the browser can't (call Claude).
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchFlights, providerStatus as flightProviderStatus } from '../data/providers/index.js';
import { searchHotels, providerStatus as hotelProviderStatus } from '../data/hotels/index.js';
import { searchPlaces, describePlace, datasetInfo } from '../data/airports.js';
import { enrichOffers } from '../data/enrich.js';
import { geocoderStatus, geocodePlace } from '../data/geocode/index.js';
import { FLIGHT_CRITERIA } from '../core/flights.js';
import { HOTEL_CRITERIA } from '../core/hotels.js';
import { WINDOW_PRESETS } from '../core/timepref.js';
import { planTrip, resolvePlaces, resolveEndpoint, destinationContext } from '../search.js';
import { importFlights } from '../data/providers/paste.js';
import { parseTripRequest } from '../nl/parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Criterion metadata the UI needs; the scoring functions stay server/module side. */
const criteriaMeta = (criteria) =>
  criteria.map(({ key, label, hint }) => ({ key, label, hint }));

const routes = {
  'GET /api/reference': async () => ({
    flightCriteria: criteriaMeta(FLIGHT_CRITERIA),
    hotelCriteria: criteriaMeta(HOTEL_CRITERIA),
    windowPresets: WINDOW_PRESETS,
    aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
    flightProvider: flightProviderStatus(),
    hotelProvider: hotelProviderStatus(),
    geocoder: geocoderStatus(),
    coverage: datasetInfo(),
  }),

  /** Autocomplete over every airport and metropolitan area on earth. */
  'GET /api/places': async (_body, url) => {
    const query = url.searchParams.get('q') ?? '';
    const limit = Math.min(20, Number(url.searchParams.get('limit')) || 8);
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

  /** Candidates only - the browser ranks them itself. */
  /** Candidates only - the browser ranks them itself. */
  'POST /api/search': async (body) => {
    let origin;
    let destination;
    try {
      origin = resolveEndpoint(body.from, 'origin');
      destination = resolveEndpoint(body.to, 'destination');
    } catch (error) {
      throw httpError(400, error.message);
    }
    if (origin.place.code === destination.place.code) {
      throw httpError(400, `Origin and destination are both ${describePlace(origin.place)}.`);
    }

    const context = await destinationContext(destination.place);
    const { resolved, unresolved } = await resolvePlaces(
      body.places,
      destination.place,
      context.centre
    );

    const [flights, hotels] = await Promise.all([
      searchFlights({
        origin: origin.place,
        destination: destination.place,
        date: body.date,
        cabin: body.cabin ?? 'economy',
        adults: body.adults,
        maxStops: body.maxStops,
        profile: body.profile,
      }),
      searchHotels({
        destination: context.destination,
        nights: body.nights ?? 3,
        checkIn: body.date,
        adults: body.adults,
        profile: body.profile,
      }),
    ]);

    return {
      origin: endpointSummary(origin),
      destination: { ...endpointSummary(destination), ...context.summary },
      places: { resolved, unresolved },
      provider: summariseProvider(flights),
      hotelProvider: summariseProvider(hotels),
      offers: flights.offers,
      hotels: hotels.hotels,
    };
  },

  /**
   * Locate one named place near a destination.
   * The browser calls this as places are added, then keeps re-ranking locally
   * as ratings change - geocoding needs the server, re-scoring doesn't.
   */
  'POST /api/geocode': async (body) => {
    let destination = null;
    if (body.to) {
      try {
        destination = resolveEndpoint(body.to, 'destination').place;
      } catch {
        destination = null;
      }
    }
    const located = await geocodePlace(body.name, {
      city: destination?.city,
      cityCode: destination?.code,
      country: destination?.country,
      near: destination ? { lat: destination.lat, lng: destination.lng } : undefined,
    });
    return { place: located };
  },

  /**
   * Flights pasted from a search page. No supplier, no key, no bill - the
   * traveller has already run the search themselves and copied the results.
   */
  'POST /api/import/flights': async (body) => {
    let origin = null;
    let destination = null;
    try {
      origin = resolveEndpoint(body.from, 'origin').place;
      destination = resolveEndpoint(body.to, 'destination').place;
    } catch {
      // A paste that names its own airports doesn't need the search boxes.
    }

    let result;
    try {
      result = await importFlights(body.text, {
        from: body.fromCode ?? firstAirport(origin),
        to: body.toCode ?? firstAirport(destination),
        date: body.date,
        cabin: body.cabin,
      });
    } catch (error) {
      // Unreadable input is the caller's problem, not a server fault.
      throw httpError(400, error.message);
    }

    return {
      source: result.source,
      label: result.label,
      format: result.format,
      offers: enrichOffers(result.offers, body.profile ?? {}),
      skipped: result.skipped,
      notes: result.notes,
    };
  },

  /** Candidates *and* ranking, for API clients that don't run the core in-process. */
  'POST /api/plan': async (body) => planTrip(body),

  'POST /api/parse': async (body) => parseTripRequest(body.text, { model: body.model }),
};

/** A pasted flight that omits its route inherits the one in the search boxes. */
const firstAirport = (place) =>
  place ? (place.kind === 'metro' ? place.airports[0].code : place.code) : undefined;

function endpointSummary({ place, alternatives }) {
  return {
    code: place.code,
    name: place.city,
    label: describePlace(place),
    country: place.country,
    kind: place.kind,
    airports: place.kind === 'metro' ? place.airports.map((a) => a.code) : [place.code],
    alternatives: (alternatives ?? []).map((a) => ({ code: a.code, label: describePlace(a) })),
  };
}

const summariseProvider = (search) => ({
  source: search.source,
  label: search.label,
  live: search.live,
  cached: search.cached,
  notes: search.notes ?? [],
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Body was not valid JSON.');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Static files, restricted to public/ and src/ so nothing else can be read. */
async function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // Anything under /src/ is served from the repo (the browser imports the
  // scoring core directly); everything else resolves inside public/.
  const target = relative.startsWith('src/')
    ? path.resolve(ROOT, relative)
    : path.resolve(ROOT, 'public', relative);
  const allowed = [path.join(ROOT, 'public'), path.join(ROOT, 'src')];
  if (!allowed.some((dir) => target === dir || target.startsWith(dir + path.sep))) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: `Not found: ${urlPath}` });
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;

    if (routes[key]) {
      try {
        const body = req.method === 'POST' ? await readBody(req) : {};
        sendJson(res, 200, await routes[key](body, url));
      } catch (error) {
        sendJson(res, error.status ?? 500, { error: error.message });
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    await serveStatic(req, res, url.pathname);
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(PORT, () => {
    console.log(`Travel-Go listening on http://localhost:${PORT}`);
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.log('No ANTHROPIC_API_KEY set - plain-English intake will use the offline parser.');
    }
  });
}

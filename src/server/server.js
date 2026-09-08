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

import { CITIES } from '../data/cities.js';
import { searchFlights, providerStatus } from '../data/providers/index.js';
import { searchHotels } from '../data/hotel-inventory.js';
import { FLIGHT_CRITERIA } from '../core/flights.js';
import { HOTEL_CRITERIA } from '../core/hotels.js';
import { WINDOW_PRESETS } from '../core/timepref.js';
import { planTrip, resolvePlaces } from '../search.js';
import { parseTripRequest } from '../nl/parse.js';
import { findCity } from '../data/cities.js';

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
    cities: Object.values(CITIES).map((c) => ({
      code: c.code,
      name: c.name,
      country: c.country,
      airports: c.airports.map((a) => ({ code: a.code, name: a.name })),
      pois: c.pois,
    })),
    flightCriteria: criteriaMeta(FLIGHT_CRITERIA),
    hotelCriteria: criteriaMeta(HOTEL_CRITERIA),
    windowPresets: WINDOW_PRESETS,
    aiAvailable: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
    flightProvider: providerStatus(),
  }),

  /** Candidates only - the browser ranks them itself. */
  'POST /api/search': async (body) => {
    // Hotels still need a city we hold places and neighbourhoods for; flights
    // don't, so a live provider isn't limited to the sample catalogue.
    const destination = findCity(body.to);
    if (!destination) throw httpError(400, `No hotel inventory for "${body.to}".`);
    const { resolved, unresolved } = resolvePlaces(body.places, destination);

    const flights = await searchFlights({
      from: body.from,
      to: body.to,
      date: body.date,
      cabin: body.cabin ?? 'economy',
      adults: body.adults,
      maxStops: body.maxStops,
      profile: body.profile,
    });
    const hotels = searchHotels({
      city: body.to,
      nights: body.nights ?? 3,
      checkIn: body.date,
      profile: body.profile,
    });

    return {
      destination: {
        code: destination.code,
        name: destination.name,
        country: destination.country,
        transitQuality: destination.transitQuality,
        pois: destination.pois,
      },
      places: { resolved, unresolved },
      provider: {
        source: flights.source,
        label: flights.label,
        live: flights.live,
        cached: flights.cached,
        notes: flights.notes,
      },
      offers: flights.offers,
      hotels: hotels.hotels,
    };
  },

  /** Candidates *and* ranking, for API clients that don't run the core in-process. */
  'POST /api/plan': async (body) => planTrip(body),

  'POST /api/parse': async (body) => parseTripRequest(body.text, { model: body.model }),
};

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

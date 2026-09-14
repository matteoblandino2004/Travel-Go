/**
 * Geocoding via Nominatim (OpenStreetMap).
 *
 * Free and keyless, which is why it's the default - the app should work for
 * every city without anyone signing up for anything. In exchange it has a
 * strict usage policy: at most one request per second, a real User-Agent, and
 * no bulk work. The rate limiter in index.js enforces the first; set
 * GEOCODER_USER_AGENT for the second.
 *
 * For anything with real traffic, self-host Nominatim or point NOMINATIM_URL
 * at a commercial endpoint - the request shape is the same.
 *
 * Policy: https://operations.osmfoundation.org/policies/nominatim/
 */

const DEFAULT_URL = 'https://nominatim.openstreetmap.org';

export const id = 'nominatim';
export const label = 'OpenStreetMap / Nominatim';

export function isConfigured() {
  return true; // no key required
}

/**
 * @param {string} query free text, e.g. "Senso-ji Temple"
 * @param {object} [context]
 * @param {string} [context.city] bias the search to a city
 * @param {string} [context.country] ISO-3166-1 alpha-2
 * @param {{lat:number,lng:number}} [context.near] bias toward a point
 * @param {object} [opts] `{env, fetchImpl, signal, limit}`
 * @returns {Promise<Array<{name,lat,lng,kind,confidence}>>}
 */
export async function geocode(query, context = {}, opts = {}) {
  const env = opts.env ?? process.env;
  const base = (env.NOMINATIM_URL ?? DEFAULT_URL).replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const params = new URLSearchParams({
    q: context.city ? `${query}, ${context.city}` : query,
    format: 'jsonv2',
    limit: String(opts.limit ?? 5),
    addressdetails: '1',
  });
  if (context.country) params.set('countrycodes', String(context.country).toLowerCase());
  // A viewbox around the destination stops "Central Park" resolving to a pub
  // in another hemisphere, without hard-excluding a legitimate outlying match.
  if (context.near) {
    const { lat, lng } = context.near;
    const pad = 0.9; // roughly 100 km
    params.set('viewbox', [lng - pad, lat + pad, lng + pad, lat - pad].join(','));
  }

  const response = await fetchImpl(`${base}/search?${params}`, {
    headers: {
      // Nominatim rejects requests without a meaningful User-Agent.
      'user-agent': env.GEOCODER_USER_AGENT ?? 'travel-go/0.1 (https://github.com/matteoblandino2004/Travel-Go)',
      'accept-language': 'en',
    },
    signal: opts.signal,
  });

  if (!response.ok) {
    throw new Error(`Nominatim ${response.status}: ${response.statusText}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('Nominatim returned an unexpected body.');

  return payload
    .map((entry) => ({
      name: shortName(entry),
      fullName: entry.display_name,
      lat: Number(entry.lat),
      lng: Number(entry.lon),
      kind: classify(entry),
      // Nominatim's own ranking, normalised - used only to pick between its
      // results, never compared across providers.
      confidence: Number(entry.importance ?? 0),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

/** "Sensō-ji, 2-3-1, Asakusa, ..." -> "Sensō-ji" */
function shortName(entry) {
  return entry.name || String(entry.display_name ?? '').split(',')[0].trim();
}

/** Map OSM categories onto the three kinds the ranking understands. */
function classify(entry) {
  const category = entry.category ?? entry.class;
  const type = entry.type;
  if (category === 'amenity' && ['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'food_court', 'ice_cream'].includes(type)) {
    return 'food';
  }
  if (category === 'shop' && ['bakery', 'deli', 'butcher', 'greengrocer'].includes(type)) return 'food';
  if (['tourism', 'historic', 'leisure', 'natural'].includes(category)) return 'sight';
  if (category === 'amenity' && ['theatre', 'cinema', 'arts_centre', 'place_of_worship'].includes(type)) return 'sight';
  return 'other';
}

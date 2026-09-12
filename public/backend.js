/**
 * Where the front end gets its data.
 *
 * Two implementations, one interface. Running `npm start` you get the HTTP
 * one, talking to the Node server - live suppliers, geocoding, the lot. The
 * single-file build has no server at all and installs an in-page backend
 * instead, so the same UI code works in both without knowing which it is.
 */

/** Talks to the Node server. */
const httpBackend = {
  id: 'server',
  reference: () => getJson('/api/reference'),
  places: (query, limit = 8) => getJson(`/api/places?q=${encodeURIComponent(query)}&limit=${limit}`),
  search: (body) => postJson('/api/search', body),
  geocode: (body) => postJson('/api/geocode', body),
  parse: (body) => postJson('/api/parse', body),
  importFlights: (body) => postJson('/api/import/flights', body),
};

/**
 * The standalone build sets `window.TRAVELGO_BACKEND` before the app boots.
 * Everything else falls through to the server.
 */
export function getBackend() {
  return globalThis.TRAVELGO_BACKEND ?? httpBackend;
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

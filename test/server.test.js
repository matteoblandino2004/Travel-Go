import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/server.js';

/** Start on an ephemeral port so tests never collide with a running dev server. */
async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('serves the app shell and the scoring modules the browser imports', async () => {
  await withServer(async (base) => {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);

    const module = await fetch(base + '/src/core/flights.js');
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
  });
});

test('will not serve files outside public/ and src/', async () => {
  await withServer(async (base) => {
    for (const path of ['/../package.json', '/src/../package.json', '/%2e%2e/package.json']) {
      const res = await fetch(base + path);
      assert.ok(res.status === 403 || res.status === 404, `${path} returned ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('"name": "travel-go"'), `${path} leaked package.json`);
    }
  });
});

test('/api/reference describes the criteria the UI has to render', async () => {
  await withServer(async (base) => {
    const ref = await (await fetch(base + '/api/reference')).json();
    assert.ok(ref.coverage.airports > 7000, 'reports worldwide airport coverage');
    assert.ok(ref.coverage.metros > 40);
    assert.ok(ref.flightProvider.active);
    assert.ok(ref.hotelProvider.active);
    assert.ok(ref.flightCriteria.some((c) => c.key === 'lounge'));
    assert.ok(ref.hotelCriteria.some((c) => c.key === 'access'));
    for (const criterion of [...ref.flightCriteria, ...ref.hotelCriteria]) {
      assert.ok(criterion.label && criterion.hint, `${criterion.key} needs a label and a hint`);
    }
  });
});

test('/api/search returns candidates plus resolved places', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/search', {
      from: 'SFO', to: 'Tokyo', nights: 3,
      places: [{ name: 'Senso-ji', importance: 5 }, { name: 'Somewhere imaginary' }],
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.destination.code, 'TYO');
    assert.ok(data.offers.length > 0);
    assert.ok(data.hotels.length > 0);
    assert.equal(data.places.resolved.length, 1);
    assert.deepEqual(data.places.unresolved, ['Somewhere imaginary']);
  });
});

test('/api/plan ranks server-side for non-browser clients', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/plan', {
      from: 'SFO', to: 'Tokyo', nights: 3,
      flight: { cost: 5, departureTime: 3, arrivalTime: 3, layovers: 4, miles: 'na', lounge: 2, duration: 3 },
      hotel: { cost: 4, status: 3, access: 5, guestRating: 3, points: 'na', cancellation: 2 },
      places: [{ name: 'Senso-ji', importance: 5 }],
    });
    const data = await res.json();
    assert.equal(data.flights.results[0].rank, 1);
    assert.ok(data.flights.results[0].score >= data.flights.results[1].score);
    assert.ok(data.hotels.results[0].why.length > 0);
  });
});

test('bad input gets a clear error, not a stack trace', async () => {
  await withServer(async (base) => {
    const unknown = await post(base, '/api/search', { from: 'SFO', to: 'Atlantis' });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /Atlantis/);

    const malformed = await fetch(base + '/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(malformed.status, 400);

    const missing = await fetch(base + '/api/nope');
    assert.equal(missing.status, 404);
  });
});

test('/api/parse works with no API key configured', async () => {
  await withServer(async (base) => {
    const res = await post(base, '/api/parse', { text: 'SFO to Tokyo, cheapest, nonstop' });
    assert.equal(res.status, 200);
    const parsed = await res.json();
    assert.equal(parsed.flight.cost, 5);
    assert.equal(parsed.flight.layovers, 5);
    // Whichever path ran, the caller gets a complete, usable object.
    assert.ok(['claude', 'rules'].includes(parsed.source));
  });
});

#!/usr/bin/env node
/**
 * Verify that everything this app depends on actually works, here, now.
 *
 *   npm run doctor
 *
 * The supplier adapters in this repo are written against published API
 * documentation. That is not the same as knowing they work against your
 * account, so this makes one real call per configured supplier and reports
 * exactly what came back - including, when a response doesn't parse, which
 * fields were missing.
 *
 * It costs a small amount on metered suppliers (roughly one search each), and
 * it says so before spending anything.
 */

import process from 'node:process';
import { datasetInfo, resolvePlace, describePlace } from '../src/data/airports.js';
import {
  searchFlights, PROVIDERS as FLIGHT_PROVIDERS,
  resolveProvider as resolveFlightProvider, clearCache as clearFlightCache,
} from '../src/data/providers/index.js';
import {
  searchHotels, PROVIDERS as HOTEL_PROVIDERS,
  resolveProvider as resolveHotelProvider, clearCache as clearHotelCache,
} from '../src/data/hotels/index.js';
import { geocodePlace, geocoderStatus, clearCache as clearGeocodeCache } from '../src/data/geocode/index.js';
import { destinationContext } from '../src/search.js';

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColour ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);

const results = [];
function record(status, name, detail) {
  results.push({ status, name, detail });
  const mark = status === 'pass' ? green('PASS') : status === 'fail' ? red('FAIL') : yellow('----');
  console.log(`  ${mark}  ${name}`);
  if (detail) console.log(`        ${dim(detail)}`);
}

const nextMonth = () => {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
};

console.log(bold('\nTravel-Go doctor\n'));

/* ---------------------------------------------------------------- *
 * Runtime and data
 * ---------------------------------------------------------------- */

console.log(bold('Runtime'));
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) record('pass', `Node ${process.versions.node}`);
else record('fail', `Node ${process.versions.node}`, 'Node 20 or newer is required.');

try {
  const info = datasetInfo();
  record(
    'pass',
    'Airport dataset',
    `${info.airports.toLocaleString('en-US')} airports, ${info.metros} metro areas, ` +
      `${info.countries} countries (built ${info.generated})`
  );
  const tokyo = resolvePlace('Tokyo').place;
  if (tokyo?.code === 'TYO') record('pass', 'Place resolution', describePlace(tokyo));
  else record('fail', 'Place resolution', `"Tokyo" resolved to ${tokyo?.code ?? 'nothing'}`);
} catch (error) {
  record('fail', 'Airport dataset', `${error.message} - rebuild with scripts/build-airports.mjs`);
}

/* ---------------------------------------------------------------- *
 * What is configured
 * ---------------------------------------------------------------- */

console.log(bold('\nConfiguration'));
const geo = geocoderStatus();
let metered = 0;

for (const [kind, providers] of [['Flights', FLIGHT_PROVIDERS], ['Hotels', HOTEL_PROVIDERS]]) {
  for (const provider of providers) {
    if (provider.id === 'sample') continue;
    const configured = provider.isConfigured(process.env);
    if (configured) metered += 1;
    record(
      configured ? 'pass' : 'warn',
      `${kind}: ${provider.label}`,
      configured ? 'credentials present' : `not configured - set ${provider.credentials.join(' and ')}`
    );
  }
}

record(
  geo.enabled ? 'pass' : 'warn',
  `Geocoding: ${geo.label}`,
  geo.enabled ? 'enabled' : 'disabled - only curated places will resolve'
);

const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
record(
  hasClaude ? 'pass' : 'warn',
  'Plain-English intake: Claude',
  hasClaude ? 'credentials present' : 'not configured - the offline keyword parser will be used'
);

if (metered > 0) {
  console.log(
    dim(`\n  Making ${metered} live request${metered > 1 ? 's' : ''} (about one search each). Metered suppliers will bill for these.`)
  );
}

/* ---------------------------------------------------------------- *
 * Live checks - the real code path, not a mock
 * ---------------------------------------------------------------- */

console.log(bold('\nLive checks'));

try {
  clearFlightCache();
  const provider = resolveFlightProvider(process.env);
  const result = await searchFlights({ from: 'SFO', to: 'Tokyo', date: nextMonth(), cabin: 'economy' });
  const dropped = result.dropped.length;

  if (result.source !== provider.id) {
    record('fail', `Flight search via ${provider.label}`, result.notes.join(' ') || 'fell back to sample data');
  } else if (result.offers.length === 0) {
    record('fail', `Flight search via ${result.label}`, 'no usable offers returned');
  } else {
    record(
      'pass',
      `Flight search via ${result.label}`,
      `${result.offers.length} offers, cheapest $${Math.min(...result.offers.map((o) => o.priceUsd))}`
    );
    if (dropped > 0) {
      const missing = [...new Set(result.dropped.flatMap((d) => d.missing))];
      record(
        'warn',
        `${dropped} flight offer(s) did not parse`,
        `missing: ${missing.join(', ')} - correct the mapping table at the top of the adapter`
      );
    }
  }
} catch (error) {
  record('fail', 'Flight search', error.message);
}

try {
  clearGeocodeCache();
  if (!geo.enabled) {
    record('warn', 'Geocoder lookup', 'skipped - geocoding is disabled');
  } else {
    const located = await geocodePlace('Torre de Belem', {
      city: 'Lisbon', country: 'PT', near: { lat: 38.77, lng: -9.13 },
    });
    if (!located) {
      record('fail', 'Geocoder lookup', 'no result for a place that definitely exists - check network access and GEOCODER_USER_AGENT');
    } else if (Math.abs(located.lat - 38.69) > 0.2 || Math.abs(located.lng + 9.21) > 0.2) {
      record('fail', 'Geocoder lookup', `resolved to ${located.lat}, ${located.lng} - expected roughly 38.69, -9.21`);
    } else {
      record('pass', 'Geocoder lookup', `"Torre de Belem" -> ${located.lat.toFixed(4)}, ${located.lng.toFixed(4)} (${located.source})`);
    }
  }
} catch (error) {
  record('fail', 'Geocoder lookup', error.message);
}

let centre = null;
try {
  const place = resolvePlace('Lisbon').place;
  const context = await destinationContext(place);
  centre = context.centre;
  record(
    centre.approximate ? 'warn' : 'pass',
    'City centre',
    centre.approximate
      ? `falling back to ${place.code} - hotels will be placed around the airport, not the city`
      : `${centre.lat.toFixed(4)}, ${centre.lng.toFixed(4)} (${centre.source})`
  );
} catch (error) {
  record('fail', 'City centre', error.message);
}

try {
  clearHotelCache();
  const provider = resolveHotelProvider(process.env);
  const place = resolvePlace('Lisbon').place;
  const result = await searchHotels({
    destination: {
      name: place.city, cityCode: place.code, country: place.country,
      centre: centre ?? { lat: place.lat, lng: place.lng },
    },
    nights: 3,
    checkIn: nextMonth(),
  });

  if (result.source !== provider.id) {
    record('fail', `Hotel search via ${provider.label}`, result.notes.join(' ') || 'fell back to generated data');
  } else if (result.hotels.length === 0) {
    record('fail', `Hotel search via ${result.label}`, 'no hotels returned');
  } else {
    const rates = result.hotels.map((h) => h.nightlyUsd).filter(Number.isFinite);
    record('pass', `Hotel search via ${result.label}`, `${result.hotels.length} hotels, $${Math.min(...rates)}-$${Math.max(...rates)} per night`);
    for (const note of result.notes) record('warn', 'Hotel supplier note', note);
  }
} catch (error) {
  record('fail', 'Hotel search', error.message);
}

/* ---------------------------------------------------------------- *
 * Summary
 * ---------------------------------------------------------------- */

const failed = results.filter((r) => r.status === 'fail');
const warned = results.filter((r) => r.status === 'warn');
const passed = results.filter((r) => r.status === 'pass');

console.log(bold('\nSummary'));
console.log(`  ${green(`${passed.length} passed`)}, ${warned.length} warnings, ${failed.length ? red(`${failed.length} failed`) : '0 failed'}`);

if (failed.length === 0 && warned.length === 0) {
  console.log(green('\n  Everything is configured and working.'));
  console.log(bold('  Run: npm start\n'));
} else if (failed.length === 0) {
  console.log('\n  Nothing is broken. The warnings are optional features you have not configured;');
  console.log('  anything unconfigured falls back to generated sample data.');
  console.log(bold('\n  Run: npm start   then open http://localhost:3000\n'));
} else {
  console.log(red('\n  Fix the failures above and run this again.'));
  console.log('  The app will still start - a failing supplier falls back to sample data.\n');
}

process.exit(failed.length > 0 ? 1 : 0);

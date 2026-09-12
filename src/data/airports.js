/**
 * Every airport with an IATA code - 7,916 of them, in 236 countries.
 *
 * This is what turns Travel-Go from a six-city demo into something that
 * answers for anywhere. It replaces the hand-written city catalogue as the
 * resolver for flight searches; `cities.js` remains only as a source of
 * curated places for the cities it happens to cover.
 *
 * Server-side only. The browser never imports this - 654 KB is not something
 * to make a page download in order to render a text field.
 *
 * Data: github.com/mwgg/Airports (MIT). Rebuild with scripts/build-airports.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolved lazily, and only on the Node path: the single-file browser build
 * injects the dataset instead, and has no filesystem to point at.
 */
const dataPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), 'airports.json');

/**
 * Names people actually use that the source data doesn't carry.
 *
 * The dataset calls HND "Tokyo International Airport" - nobody does. These are
 * the colloquial and former names worth accepting; the source already covers
 * Heathrow, Schiphol, O'Hare, Changi and most of the rest in its `name` field.
 */
const ALIASES = {
  haneda: 'HND', narita: 'NRT', kansai: 'KIX', itami: 'ITM', centrair: 'NGO',
  orly: 'ORY', beauvais: 'BVA', ciampino: 'CIA', malpensa: 'MXP', linate: 'LIN',
  'el prat': 'BCN', brandenburg: 'BER', tegel: 'BER',
  laguardia: 'LGA', 'la guardia': 'LGA', midway: 'MDW', reagan: 'DCA',
  'national airport': 'DCA', 'sky harbor': 'PHX', 'harry reid': 'LAS',
  mccarran: 'LAS', trudeau: 'YUL', 'ben gurion': 'TLV',
  ataturk: 'IST', istanbul: 'IST', sabiha: 'SAW', 'sabiha gokcen': 'SAW',
  'don mueang': 'DMK', gimpo: 'GMP', pudong: 'PVG', hongqiao: 'SHA',
  'beijing capital': 'PEK', daxing: 'PKX', 'tan son nhat': 'SGN', 'noi bai': 'HAN',
  'soekarno hatta': 'CGK', 'ninoy aquino': 'MNL', guarulhos: 'GRU',
  congonhas: 'CGH', galeao: 'GIG', ezeiza: 'EZE', tocumen: 'PTY',
  'el dorado': 'BOG', 'jorge chavez': 'LIM', 'or tambo': 'JNB',
  'jomo kenyatta': 'NBO', arlanda: 'ARN', kastrup: 'CPH', gardermoen: 'OSL',
  vantaa: 'HEL', zaventem: 'BRU', chopin: 'WAW', 'vaclav havel': 'PRG',
  'ferenc liszt': 'BUD', sheremetyevo: 'SVO', domodedovo: 'DME', vnukovo: 'VKO',
  boryspil: 'KBP', tullamarine: 'MEL', hamad: 'DOH', 'al maktoum': 'DWC',
  'indira gandhi': 'DEL', 'chhatrapati shivaji': 'BOM', kempegowda: 'BLR',
  taoyuan: 'TPE', 'humberto delgado': 'LIS', portela: 'LIS',
  'saigon': 'SGN', 'bombay': 'BOM', 'calcutta': 'CCU', 'madras': 'MAA',
  'peking': 'PEK', 'rangoon': 'RGN', 'kiev': 'IEV',
};

/** Built once, on first use - most requests never touch it. */
let index = null;
/** Set by the browser build, which inlines the dataset instead of reading it. */
let injected = null;

/**
 * Supply the dataset directly, for environments with no filesystem.
 * The standalone single-file build calls this with the JSON inlined.
 */
export function setAirportData(raw) {
  injected = raw;
  index = null;
}

function load() {
  if (index) return index;

  const raw = injected ?? JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
  const byCode = new Map();
  const byNormalisedName = new Map();

  const add = (map, key, value) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };

  for (const row of raw.rows) {
    const [iata, name, city, state, countryIdx, lat, lon, tzIdx, metro] = row;
    const airport = {
      kind: 'airport',
      code: iata,
      name,
      city,
      state,
      country: raw.countries[countryIdx],
      lat,
      lng: lon,
      tz: raw.timezones[tzIdx],
      metro: metro || null,
    };
    byCode.set(iata, airport);
    add(byNormalisedName, normalise(city), airport);
    if (normalise(name) !== normalise(city)) add(byNormalisedName, normalise(name), airport);
    // The IANA zone sometimes carries a correctly-spelled version of the
    // city ("America/Argentina/Ushuaia" against a city field reading
    // "Ushuahia"). Only accept it as a *spelling correction* for this
    // airport's own city, never as a general alias - every airport in
    // Portugal is Europe/Lisbon, and only one of them is in Lisbon.
    const zoneCity = normalise(airport.tz.split('/').pop().replace(/_/g, ' '));
    if (zoneCity && zoneCity !== normalise(city) && isNearSpelling(zoneCity, normalise(city))) {
      add(byNormalisedName, zoneCity, airport);
    }
  }

  // A metro is a first-class destination: searching it searches every airport
  // in it, which is what a city search means to a traveller.
  const metros = new Map();
  for (const airport of byCode.values()) {
    if (!airport.metro) continue;
    if (!metros.has(airport.metro)) {
      metros.set(airport.metro, {
        kind: 'metro',
        code: airport.metro,
        name: raw.metroNames[airport.metro] ?? airport.city,
        city: raw.metroNames[airport.metro] ?? airport.city,
        state: airport.state,
        country: airport.country,
        tz: airport.tz,
        airports: [],
      });
    }
    metros.get(airport.metro).airports.push(airport);
  }
  for (const metro of metros.values()) {
    // EWR sorts first in NYC but "New Jersey" is a poor label for New York.
    const namesake = metro.airports.find((a) => normalise(a.city) === normalise(metro.name));
    metro.state = namesake?.state ?? '';
    metro.country = namesake?.country ?? metro.country;
    metro.tz = namesake?.tz ?? metro.tz;
    // Centre of the airports serving it - a rough stand-in for the city centre
    // when no geocoder is configured.
    metro.lat = mean(metro.airports.map((a) => a.lat));
    metro.lng = mean(metro.airports.map((a) => a.lng));
    metro.airports.sort((a, b) => a.code.localeCompare(b.code));
    add(byNormalisedName, normalise(metro.name), metro);
  }

  // Aliases resolve to whatever that code turned out to be - an airport, or a
  // metro when the code names one.
  for (const [alias, code] of Object.entries(ALIASES)) {
    const target = metros.get(code) ?? byCode.get(code);
    if (target) add(byNormalisedName, normalise(alias), target);
  }

  index = { raw, byCode, byNormalisedName, metros };
  return index;
}

/** Test seam. */
export function reset() {
  index = null;
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/** Same city, spelled differently - not merely two names of similar length. */
function isNearSpelling(a, b) {
  if (Math.abs(a.length - b.length) > 2 || Math.min(a.length, b.length) < 4) return false;
  return editDistance(a, b) <= 2;
}

/** Levenshtein, capped - only ever called on short city names. */
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/**
 * How likely an airport is to be the one someone typing this city name meant.
 *
 * The dataset has no passenger figures, but the *name* is a strong proxy:
 * "Jacksonville International" is the airport people fly to, "Jacksonville
 * Municipal" and "RAF Northolt" are not.
 */
function significance(place) {
  // A metropolitan area is by definition somewhere lots of people fly. It has
  // to outweigh an exact-name match on a tiny airfield, or typing "tok" offers
  // Tok, Alaska ahead of Tokyo.
  if (place.kind === 'metro') return 400;
  const name = place.name;
  let score = 0;
  if (/\bInternational\b/i.test(name)) score += 80;
  if (/\b(RAF|AFB|Air Force|Naval|Army|Marine|NOLF|Auxiliary)\b/i.test(name)) score -= 120;
  if (/\b(Municipal|Regional|County|Airstrip|Airfield|Heliport|Seaplane|Field)\b/i.test(name)) score -= 40;
  if (place.metro) score += 30;
  return score;
}

/** Fold case, accents and punctuation so "Dusseldorf" finds "Düsseldorf". */
export function normalise(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** One airport by IATA code. */
export function airportByCode(code) {
  const { byCode } = load();
  return byCode.get(String(code ?? '').toUpperCase().trim()) ?? null;
}

/** One metro by IATA metropolitan code (LON, NYC, TYO...). */
export function metroByCode(code) {
  const { metros } = load();
  return metros.get(String(code ?? '').toUpperCase().trim()) ?? null;
}

/**
 * Search for a place to fly to or from.
 *
 * Returns ranked candidates rather than one answer, because "Jacksonville" is
 * three different American cities and picking one silently is how a search
 * sends someone to Illinois.
 *
 * @param {string} query
 * @param {{limit?: number}} [opts]
 */
export function searchPlaces(query, opts = {}) {
  const { limit = 8 } = opts;
  const { byCode, byNormalisedName, metros } = load();
  const q = normalise(query);
  if (!q) return [];

  const scored = new Map(); // code -> {place, score}
  const consider = (place, matchScore) => {
    const score = matchScore + significance(place);
    const existing = scored.get(place.code);
    if (!existing || score > existing.score) scored.set(place.code, { place, score });
  };

  // An exact code wins outright - someone typing "LGW" means Gatwick.
  const upper = String(query).toUpperCase().trim();
  if (/^[A-Z]{3}$/.test(upper)) {
    if (metros.has(upper)) consider(metros.get(upper), 1000);
    if (byCode.has(upper)) consider(byCode.get(upper), 990);
  }

  for (const place of byNormalisedName.get(q) ?? []) {
    consider(place, place.kind === 'metro' ? 900 : 800);
  }

  // Prefix and substring matches, so partial typing still gets there.
  if (q.length >= 3) {
    for (const [name, places] of byNormalisedName) {
      if (name === q) continue;
      const prefix = name.startsWith(q);
      if (!prefix && !name.includes(q)) continue;
      for (const place of places) {
        const base = prefix ? 500 : 300;
        consider(place, base + (place.kind === 'metro' ? 60 : 0) - Math.min(50, name.length - q.length));
      }
    }
  }

  const ranked = [...scored.values()].sort(
    (a, b) => b.score - a.score || a.place.code.localeCompare(b.place.code)
  );

  // Collapse each *actual* place to one entry. Several airports serving one
  // city is one choice, not five; three different Jacksonvilles is three.
  // Grouping on city + state + country separates those two cases cleanly.
  const groups = new Map();
  for (const { place, score } of ranked) {
    const key = [normalise(place.city), normalise(place.state), place.country].join('|');
    const existing = groups.get(key);
    if (!existing || score > existing.score) groups.set(key, { place, score });
  }

  const results = [...groups.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ place }) => place);

  // An airport already covered by a listed metro is noise.
  const metroCodes = new Set(results.filter((p) => p.kind === 'metro').map((p) => p.code));
  return results.filter((p) => p.kind === 'metro' || !metroCodes.has(p.metro)).slice(0, limit);
}

/**
 * Resolve a query to one place, plus anything else it could plausibly have
 * meant.
 *
 * Deliberately not "refuse until the user is specific": typing "London" should
 * search London, with a quiet note that London, Ontario also exists. The UI
 * shows `alternatives` as one-click corrections.
 *
 * @returns {{place: object, alternatives: object[]}|{notFound: true}}
 */
export function resolvePlace(query) {
  const candidates = searchPlaces(query, { limit: 6 });
  if (candidates.length === 0) return { notFound: true };

  const q = normalise(query);
  const upper = String(query).toUpperCase().trim();
  // An exact code or city-name match outranks a merely similar one.
  const exact = candidates.filter(
    (c) => c.code === upper || normalise(c.city) === q || normalise(c.name) === q
  );
  const pool = exact.length > 0 ? exact : candidates;

  return {
    place: pool[0],
    alternatives: candidates.filter((c) => c !== pool[0]).slice(0, 4),
  };
}

/** Short label for a picker: "Jacksonville (JAX) — Florida, US". */
export function describePlace(place) {
  const where = [place.state, place.country].filter(Boolean).join(', ');
  const suffix = place.kind === 'metro' ? ` — all airports (${place.airports.map((a) => a.code).join(', ')})` : '';
  return `${place.city} (${place.code})${where ? ` — ${where}` : ''}${suffix}`;
}

/**
 * Current UTC offset in hours for an IANA timezone.
 * Replaces the hand-written per-city offsets, and gets DST right.
 */
export function utcOffsetHours(timezone, at = new Date()) {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(formatted ?? '');
    if (!match) return 0; // "GMT" itself
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) + Number(match[3] ?? 0) / 60);
  } catch {
    return 0;
  }
}

/** Every airport a place covers - one for an airport, several for a metro. */
export function airportsFor(place) {
  return place.kind === 'metro' ? place.airports : [place];
}

export function datasetInfo() {
  const { raw, byCode, metros } = load();
  return { airports: byCode.size, metros: metros.size, countries: raw.countries.length, generated: raw.generated };
}

/**
 * Offline trip parser.
 *
 * Keyword matching, no model, no network. It exists so the app is fully usable
 * with no API key, and so the Claude path has something to fall back to when a
 * call fails. It is deliberately conservative: it only sets an importance when
 * the traveller clearly said something, and leaves the rest at the neutral 3
 * for the user to adjust with the sliders.
 */

import { CITIES } from '../data/cities.js';
import { neutralImportances } from './schema.js';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Phrase -> importance edits. First match per criterion wins. */
const CUES = [
  { re: /\b(cheap(est)?|budget|save money|low ?cost|as little as possible|tight budget)\b/, set: { flight: { cost: 5 }, hotel: { cost: 5 } } },
  { re: /\b(money is no object|price doesn'?t matter|cost doesn'?t matter|splurge|whatever it costs)\b/, set: { flight: { cost: 1 }, hotel: { cost: 1 } } },
  { re: /\b(nonstop|non-stop|direct flight|no layovers?|no connections?|avoid connections?)\b/, set: { flight: { layovers: 5 } } },
  { re: /\b(don'?t mind (a )?(stop|layover)|happy to connect)\b/, set: { flight: { layovers: 1 } } },
  { re: /\blounge/, set: { flight: { lounge: 5 } } },
  { re: /\b(miles|points|status|elite|qualifying|frequent flyer)\b/, set: { flight: { miles: 5 }, hotel: { points: 4 } } },
  { re: /\b(red[- ]?eye|overnight flight)\b/, set: { flight: { departureTime: 4 } }, departureWindow: { start: '21:00', end: '01:00' } },
  { re: /\b(early (morning|flight)|first flight out|crack of dawn)\b/, set: { flight: { departureTime: 5 } }, departureWindow: { start: '05:00', end: '08:00' } },
  { re: /\b(morning (flight|departure)|leave in the morning)\b/, set: { flight: { departureTime: 4 } }, departureWindow: { start: '07:00', end: '11:00' } },
  { re: /\b(afternoon (flight|departure)|leave in the afternoon)\b/, set: { flight: { departureTime: 4 } }, departureWindow: { start: '12:00', end: '17:00' } },
  { re: /\b(evening (flight|departure)|leave in the evening)\b/, set: { flight: { departureTime: 4 } }, departureWindow: { start: '17:00', end: '22:00' } },
  { re: /\b(land|arrive)\s+(early|in the morning)\b/, set: { flight: { arrivalTime: 4 } }, arrivalWindow: { start: '06:00', end: '11:00' } },
  { re: /\b(don'?t want to (fly|travel) all day|short(est)? flight|quick(est)? (flight|trip)|get there fast)\b/, set: { flight: { duration: 5 } } },
  { re: /\b(business class|lie[- ]?flat)\b/, cabin: 'business', set: { flight: { cost: 2 } } },
  { re: /\bpremium economy\b/, cabin: 'premium' },
  { re: /\b(nice hotel|luxur(y|ious)|5[- ]star|five[- ]star|fancy hotel|suite)\b/, set: { hotel: { status: 5 } } },
  { re: /\b(walk(able|ing distance)|close to everything|central|centrally located|near the sights?)\b/, set: { hotel: { access: 5 } } },
  { re: /\b(free cancellation|flexible (dates|booking)|might change)\b/, set: { hotel: { cancellation: 5 } } },
  { re: /\b(reviews?|well[- ]reviewed|highly rated)\b/, set: { hotel: { guestRating: 4 } } },
];

/** "I don't care about X" - phrased generically, applied per criterion. */
const DONT_CARE = [
  { re: /\b(don'?t care about|doesn'?t matter|not fussed about|no preference on)\b[^.,;]{0,40}\b(miles|points)\b/, keys: { flight: ['miles'], hotel: ['points'] } },
  { re: /\b(don'?t care about|doesn'?t matter|not fussed about|no preference on)\b[^.,;]{0,40}\blounges?\b/, keys: { flight: ['lounge'] } },
  { re: /\b(don'?t care about|doesn'?t matter|not fussed about|no preference on)\b[^.,;]{0,40}\b(departure|arrival|time)s?\b/, keys: { flight: ['departureTime', 'arrivalTime'] } },
  { re: /\b(don'?t care about|doesn'?t matter|not fussed about|no preference on)\b[^.,;]{0,40}\b(hotel status|brand|stars?)\b/, keys: { hotel: ['status'] } },
];

function findCityMention(text, exclude = null) {
  let best = null;
  for (const city of Object.values(CITIES)) {
    const names = [city.name, ...city.airports.map((a) => a.code), city.code];
    for (const name of names) {
      const idx = text.indexOf(name.toLowerCase());
      if (idx === -1) continue;
      if (exclude && city.code === exclude) continue;
      if (!best || idx < best.idx) best = { city, idx };
    }
  }
  return best;
}

function extractDate(text) {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return iso[0];
  const named = new RegExp(`\\b(\\d{1,2})?\\s*(${MONTHS.join('|')})\\s*(\\d{1,2})?\\b`).exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[2]) + 1;
    const day = Number(named[1] ?? named[3] ?? 1);
    const now = new Date();
    let year = now.getFullYear();
    if (month < now.getMonth() + 1) year += 1; // "in April" means the next April
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function extractPlaces(text, destinationCity) {
  const places = [];
  const seen = new Set();
  const catalogue = destinationCity ? destinationCity.pois : Object.values(CITIES).flatMap((c) => c.pois);
  for (const poi of catalogue) {
    const head = poi.name.toLowerCase().split(/[,(]/)[0].trim();
    if (head.length < 4) continue;
    if (text.includes(head) && !seen.has(poi.name)) {
      seen.add(poi.name);
      places.push({ name: poi.name, kind: poi.kind, importance: 4 });
    }
  }
  return places;
}

/**
 * @param {string} text free-form trip description
 * @returns {object} same shape as TRIP_REQUEST_SCHEMA, plus `source: 'rules'`
 */
export function parseWithRules(text) {
  const lower = String(text ?? '').toLowerCase();
  const { flight, hotel } = neutralImportances();
  const result = {
    origin: null,
    destination: null,
    departDate: extractDate(lower),
    nights: null,
    cabin: null,
    flight,
    hotel,
    departureWindow: null,
    arrivalWindow: null,
    places: [],
    assumptions: [],
    source: 'rules',
  };

  // "from X to Y" is the reliable signal; otherwise take the first two cities named.
  const fromTo = /\bfrom\s+([a-z\s]{2,30}?)\s+to\s+([a-z\s]{2,30}?)(?:[,.]|\s+(?:on|in|for|next|this)\b|$)/.exec(lower);
  if (fromTo) {
    result.origin = findCityMention(fromTo[1])?.city.name ?? fromTo[1].trim();
    result.destination = findCityMention(fromTo[2])?.city.name ?? fromTo[2].trim();
  } else {
    const first = findCityMention(lower);
    const second = first ? findCityMention(lower.slice(first.idx + 3), first.city.code) : null;
    if (first && second) {
      result.origin = first.city.name;
      result.destination = second.city.name;
    } else if (first) {
      result.destination = first.city.name;
      result.assumptions.push('Only one city was named; treated it as the destination.');
    }
  }

  const nights = /\b(\d{1,2})\s*(nights?|days?)\b/.exec(lower);
  if (nights) result.nights = Number(nights[1]);

  for (const cue of CUES) {
    if (!cue.re.test(lower)) continue;
    for (const [group, edits] of Object.entries(cue.set ?? {})) {
      for (const [key, value] of Object.entries(edits)) result[group][key] = value;
    }
    if (cue.cabin) result.cabin = cue.cabin;
    if (cue.departureWindow && !result.departureWindow) result.departureWindow = cue.departureWindow;
    if (cue.arrivalWindow && !result.arrivalWindow) result.arrivalWindow = cue.arrivalWindow;
  }

  for (const rule of DONT_CARE) {
    if (!rule.re.test(lower)) continue;
    for (const [group, keys] of Object.entries(rule.keys)) {
      for (const key of keys) result[group][key] = 'na';
    }
  }

  const destinationCity = result.destination ? findCityMention(result.destination.toLowerCase())?.city : null;
  result.places = extractPlaces(lower, destinationCity);
  result.assumptions.push('Read without a model: anything you did not spell out is left at importance 3.');

  return result;
}

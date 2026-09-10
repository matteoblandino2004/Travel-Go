/**
 * Import flights by pasting them in.
 *
 * The point of this is to need nothing: no API key, no supplier account, no
 * monthly bill. You run a search on Google Flights (or Kayak, or Skyscanner,
 * or your airline's own site), select the results, copy, and paste them here.
 * What you paste is what gets ranked against your weights.
 *
 * That makes it the one route to real fares that is free and immediate. It is
 * also the one that requires you to do something by hand each time, which is
 * why the API adapters still exist.
 *
 * The parser is deliberately format-agnostic. Every site lays its results out
 * differently and all of them change; rather than a template per site, this
 * looks for the *shapes* of the facts - a time range, a duration, an airport
 * pair, a stop count, a price - wherever they appear in a record, in any
 * order. Anything it can't read is reported back rather than dropped.
 */

import { toOffer, normalizeCabin, keepUsable } from './normalize.js';
import { AIRLINES_BY_CODE, airlineByName } from '../airlines.js';

export const id = 'pasted';
export const label = 'Pasted from a flight search';

/* ------------------------------------------------------------------ *
 * The shapes of the facts
 * ------------------------------------------------------------------ */

/** "10:15 AM – 2:30 PM+1", "07:20–15:45", "10:15 AM - 2:30 PM (+1)" */
const TIME_RANGE =
  /(\d{1,2}:\d{2})\s*([AaPp][Mm])?\s*(?:[–\-—~]|to)\s*(\d{1,2}:\d{2})\s*([AaPp][Mm])?\s*(?:\(?\+\s?(\d)\)?)?/;

/** "11 hr 25 min", "11h 25m", "11:25" (as a duration), "685 min" */
const DURATION =
  /(?:(\d{1,2})\s*(?:hr|hrs|hours?|h)\s*(?:(\d{1,2})\s*(?:min|mins|minutes?|m)\b)?|(\d{2,4})\s*(?:min|minutes)\b)/i;

/** "SFO–NRT", "SFO-NRT", "SFO to NRT", "SFO → HND" */
const ROUTE = /\b([A-Z]{3})\s*(?:[–\-—>→]|to)\s*([A-Z]{3})\b/;

/** "Nonstop", "1 stop", "2 stops", "Direct" */
const STOPS = /\b(nonstop|non-stop|direct)\b|\b(\d)\s*stops?\b/i;

/**
 * "$1,043", "1 043 €", "USD 1043", "£812", "289 €".
 * The symbol can lead or trail, and a trailing \b after a currency symbol
 * never matches at end of line - which is why "289 €" used to be missed.
 */
const CURRENCY = '[$£€¥₹]|\\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NOK|DKK|INR)\\b';
const NUMBER = '\\d[\\d,. ]*\\d|\\d';
const PRICE = new RegExp(`(?:(?:${CURRENCY})\\s?(${NUMBER}))|(?:(${NUMBER})\\s?(?:${CURRENCY}))`);
const CURRENCY_TOKEN = new RegExp(CURRENCY);

/** "1,043 kg CO2e" */
const CARBON = /([\d,]+)\s*kg\s*CO2/i;

/**
 * Layover airports, written as any of: "1 hr 35 min ORD", "Layover in ORD",
 * "1 stop LHR", "via AMS", "Connect in DFW".
 */
// Case-insensitive on the keywords only: airport codes are always uppercase,
// and an /i flag here lets [A-Z]{3} match the "min" in "2 hr 5 min ORD".
const LAYOVER_AIRPORT =
  /(?:[Ll]ayover(?:\s+in)?\s+|[Cc]onnect(?:s|ion)?(?:\s+in)?\s+|[Vv]ia\s+|\b\d\s*[Ss]tops?\s+|\b\d+\s*hr[^A-Z]{0,12})\(?([A-Z]{3})\)?/g;

/** Lines that are chrome rather than data, and never carry a fact we want. */
const NOISE =
  /^(?:round\s?trip|one\s?way|per\s?person|select|book|details|show\s+details|price\s+unavailable|cheapest|best|fastest|emissions?|avg\s+emissions|typical|save|deal|\d+%\s*(?:less|more)\s*emissions?|sort|filter)$/i;

/** Cabin words, when a paste happens to mention one. */
const CABIN = /\b(economy|premium economy|premium|business|first)\s*(?:class)?\b/i;

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/**
 * Turn pasted text into offers.
 *
 * @param {string} text whatever was on the clipboard
 * @param {object} [context] fills gaps the paste doesn't state
 * @param {string} [context.from] origin code, if the paste omits routes
 * @param {string} [context.to] destination code
 * @param {string} [context.date] YYYY-MM-DD, for the departure date
 * @param {string} [context.cabin]
 * @param {number} [context.nights] unused here, accepted for symmetry
 * @returns {{offers: object[], skipped: object[], format: string}}
 */
export function parseFlightText(text, context = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return { offers: [], skipped: [], format: 'empty' };

  // A structured paste is unambiguous - use it in preference to guessing.
  const structured = tryStructured(raw, context);
  if (structured) return structured;

  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !NOISE.test(line));

  const records = splitRecords(lines);
  const priced = attachPrices(records, lines);

  const offers = [];
  const skipped = [];
  for (const [index, record] of priced.entries()) {
    const parsed = parseRecord(record.lines, index, context, record.price);
    if (parsed.offer) offers.push(parsed.offer);
    else skipped.push({ text: record.lines.join(' · ').slice(0, 140), missing: parsed.missing });
  }

  const currencies = new Set(offers.map((o) => o.currencySymbol).filter(Boolean));
  return { offers, skipped, format: 'text', currencies: [...currencies] };
}

/**
 * Split a flat list of lines into one group per flight.
 *
 * Sites disagree about the order within a result. Google Flights ends each
 * one with the price; Kayak starts with it, and puts the airline before the
 * times too. Splitting on time ranges alone therefore mis-assigns every field
 * that a site chooses to print first.
 *
 * The price is the reliable anchor, because there is exactly one per flight.
 * Whether it opens or closes the record is decided by looking at where the
 * first price sits relative to the first time range - which is the same
 * question, asked once, instead of per field.
 */
function splitRecords(lines) {
  const timeRanges = indicesWhere(lines, (line) => TIME_RANGE.test(line));
  const prices = indicesWhere(lines, (line) => Number.isFinite(parsePrice(line)));

  // One price per flight is what makes price-anchored splitting safe.
  if (prices.length > 1 && prices.length === timeRanges.length) {
    const priceLeads = prices[0] < timeRanges[0];
    return priceLeads ? sliceFrom(lines, prices) : sliceEndingAt(lines, prices);
  }

  if (timeRanges.length > 0) {
    // Anything before the first time range is a header, not a flight.
    return sliceFrom(lines, timeRanges);
  }

  if (prices.length > 1) return sliceEndingAt(lines, prices);

  return lines.length ? [{ start: 0, end: lines.length, lines }] : [];
}

const indicesWhere = (lines, predicate) =>
  lines.reduce((acc, line, i) => (predicate(line) ? [...acc, i] : acc), []);

/** Records that begin at each anchor and run to just before the next. */
const sliceFrom = (lines, anchors) =>
  anchors.map((start, i) => {
    const end = anchors[i + 1] ?? lines.length;
    return { start, end, lines: lines.slice(start, end) };
  });

/** Records that end at each anchor, starting where the previous one stopped. */
function sliceEndingAt(lines, anchors) {
  let from = 0;
  const records = anchors.map((anchor) => {
    const record = { start: from, end: anchor + 1, lines: lines.slice(from, anchor + 1) };
    from = anchor + 1;
    return record;
  });
  // Trailing lines after the last price belong to nothing; drop them.
  return records;
}

/**
 * Work out which price belongs to which flight.
 *
 * Sites disagree about where the price goes: Google Flights puts it after the
 * itinerary, Kayak puts it before. Splitting on time ranges therefore leaves
 * Kayak's prices one record out of step - the first flight got the second
 * flight's fare, and the last had none at all.
 *
 * When the paste contains exactly as many prices as flights, pair them in
 * order and the layout stops mattering. Otherwise fall back to the price
 * inside each record.
 */
function attachPrices(records, lines) {
  const priceLines = lines
    .map((line, index) => ({ index, price: parsePrice(line), symbol: CURRENCY_TOKEN.exec(line)?.[0] }))
    .filter((entry) => Number.isFinite(entry.price));

  if (priceLines.length === records.length && records.length > 0) {
    return records.map((record, i) => ({ ...record, price: priceLines[i].price, symbol: priceLines[i].symbol }));
  }

  return records.map((record) => {
    const inside = priceLines.find((entry) => entry.index >= record.start && entry.index < record.end);
    return { ...record, price: inside?.price, symbol: inside?.symbol };
  });
}

/** Pull every fact we can find out of one record, in whatever order it appears. */
function parseRecord(lines, index, context, pairedPrice) {
  const joined = lines.join(' \n ');
  const flat = lines.join(' ');

  const times = TIME_RANGE.exec(flat);
  const duration = parseDuration(flat);
  const route = ROUTE.exec(flat);
  const price = Number.isFinite(pairedPrice) ? pairedPrice : parsePrice(flat);
  const stops = parseStops(flat);
  const airline = findAirline(lines);

  const missing = [];
  if (!times) missing.push('departure and arrival times');
  if (!Number.isFinite(price)) missing.push('price');
  if (!Number.isFinite(duration) && !times) missing.push('duration');

  if (missing.length > 0) return { missing };

  const departLocal = to24Hour(times[1], times[2]);
  const arriveLocal = to24Hour(times[3], times[4]);

  // If the site didn't print a duration, the clock times give it - assuming
  // the same timezone, which is wrong for long hauls, so it's marked estimated.
  const estimated = [];
  let durationMin = duration;
  if (!Number.isFinite(durationMin)) {
    durationMin = minutesBetween(departLocal, arriveLocal, Number(times[5] ?? 0));
    estimated.push('durationMin');
  }

  const carbon = CARBON.exec(flat);
  const cabin = CABIN.exec(flat);

  const offer = toOffer({
    id: `paste-${index + 1}`,
    source: id,
    airline: airline?.name ?? guessAirlineName(lines),
    airlineCode: airline?.code ?? null,
    alliance: airline?.alliance ?? null,
    cabin: normalizeCabin(cabin?.[1] ?? context.cabin),
    from: route?.[1] ?? normaliseCode(context.from),
    to: route?.[2] ?? normaliseCode(context.to),
    departure: { date: context.date ?? null, time: departLocal, dayNumber: 0 },
    arrival: { date: context.date ?? null, time: arriveLocal, dayNumber: Number(times[5] ?? 0) },
    dayShift: Number(times[5] ?? 0),
    durationMin,
    stops,
    layoverAirports: findLayovers(joined, route),
    layoverMinutes: 0,
    priceUsd: price,
    carbonKg: carbon ? Number(carbon[1].replace(/,/g, '')) : undefined,
  });

  offer.estimatedFields = estimated;
  offer.pastedFrom = flat.slice(0, 160);
  offer.currencySymbol = CURRENCY_TOKEN.exec(flat)?.[0] ?? null;
  return { offer };
}

/* ------------------------------------------------------------------ *
 * Field parsers
 * ------------------------------------------------------------------ */

function parseDuration(text) {
  const match = DURATION.exec(text);
  if (!match) return NaN;
  if (match[3]) return Number(match[3]);
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const total = hours * 60 + minutes;
  return total > 0 ? total : NaN;
}

/**
 * Prices are written every way imaginable. The one rule that always holds is
 * that a comma or space every three digits is a thousands separator, and a
 * trailing two-digit group after a dot or comma is cents.
 */
function parsePrice(text, { bareNumbersAreMoney = false } = {}) {
  const match = PRICE.exec(text);
  if (!match) {
    // In free text a bare number could be anything - a duration, a seat pitch,
    // a CO2 figure. In a column headed "price" it is money.
    if (!bareNumbersAreMoney) return NaN;
    const bare = /(\d[\d,. ]*\d|\d)/.exec(String(text));
    return bare ? toAmount(bare[1]) : NaN;
  }
  return toAmount(match[1] ?? match[2] ?? '');
}

/**
 * A comma, dot or space every three digits is a thousands separator; a
 * trailing two-digit group after a dot or comma is cents.
 */
function toAmount(digits) {
  const trimmed = String(digits).trim();
  if (!trimmed) return NaN;
  const cents = /[.,](\d{2})$/.exec(trimmed);
  const whole = cents ? trimmed.slice(0, -3) : trimmed;
  const value = Number(whole.replace(/[,. ]/g, '')) + (cents ? Number(cents[1]) / 100 : 0);
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

function parseStops(text) {
  const match = STOPS.exec(text);
  if (!match) return 0;
  return match[1] ? 0 : Number(match[2]);
}

/** Match a line against the 84 carriers we know, so we get a code and alliance. */
function findAirline(lines) {
  for (const line of lines) {
    // A whole line that is just a carrier name is the strongest signal.
    const exact = airlineByName(line);
    if (exact) return exact;
  }
  for (const line of lines) {
    for (const carrier of Object.values(AIRLINES_BY_CODE)) {
      if (new RegExp(`\\b${escapeRegExp(carrier.name)}\\b`, 'i').test(line)) return carrier;
    }
  }
  // "UA 837" / "NH7" style flight numbers.
  for (const line of lines) {
    const flight = /\b([A-Z]{2})\s?\d{1,4}\b/.exec(line);
    if (flight && AIRLINES_BY_CODE[flight[1]]) return AIRLINES_BY_CODE[flight[1]];
  }
  return null;
}

/**
 * When the carrier isn't one we know, keep whatever the paste called it rather
 * than showing a blank - an unknown carrier still ranks, it just earns no
 * alliance benefits.
 */
function guessAirlineName(lines) {
  const candidate = lines.find(
    (line) =>
      !TIME_RANGE.test(line) &&
      !PRICE.test(line) &&
      !DURATION.test(line) &&
      !ROUTE.test(line) &&
      !STOPS.test(line) &&
      !CARBON.test(line) &&
      /^[A-Za-z][A-Za-z .'&\-]{2,40}$/.test(line)
  );
  return candidate ?? 'Unknown carrier';
}

function findLayovers(text, route) {
  const found = new Set();
  for (const match of text.matchAll(LAYOVER_AIRPORT)) {
    const code = match[1];
    if (code !== route?.[1] && code !== route?.[2]) found.add(code);
  }
  return [...found];
}

/** "2:30" + "PM" -> "14:30"; a 24-hour time passes through. */
function to24Hour(time, meridiem) {
  const [hoursRaw, minutes] = time.split(':');
  let hours = Number(hoursRaw);
  if (meridiem) {
    const pm = /p/i.test(meridiem);
    if (pm && hours !== 12) hours += 12;
    if (!pm && hours === 12) hours = 0;
  }
  return `${String(hours % 24).padStart(2, '0')}:${minutes}`;
}

function minutesBetween(from, to, dayShift = 0) {
  const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return toMinutes(to) + dayShift * 1440 - toMinutes(from);
}

const normaliseCode = (value) => {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ *
 * Structured pastes
 * ------------------------------------------------------------------ */

/** JSON or CSV/TSV, when someone has real data to hand rather than a web page. */
function tryStructured(raw, context) {
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : parsed.offers ?? parsed.flights ?? [];
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return fromRows(rows, context, 'json');
    } catch {
      return null;
    }
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].split(',').length > 2 ? ',' : null;
  if (!delimiter) return null;

  const header = lines[0].split(delimiter).map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  // Only treat it as a table if the header names things we recognise.
  const known = ['price', 'fare', 'cost', 'airline', 'carrier', 'depart', 'departure', 'arrive', 'arrival', 'stops', 'duration', 'from', 'to'];
  if (!header.some((h) => known.some((k) => h.includes(k)))) return null;

  const rows = lines.slice(1).map((line) => {
    const cells = line.split(delimiter).map((c) => c.trim());
    return Object.fromEntries(header.map((key, i) => [key, cells[i] ?? '']));
  });
  return fromRows(rows, context, delimiter === '\t' ? 'tsv' : 'csv');
}

const FIELD_ALIASES = {
  price: ['price', 'fare', 'cost', 'priceusd', 'total', 'amount'],
  airline: ['airline', 'carrier', 'operator', 'marketingcarrier'],
  depart: ['depart', 'departure', 'departtime', 'departuretime', 'departlocal', 'out'],
  arrive: ['arrive', 'arrival', 'arrivetime', 'arrivaltime', 'arrivelocal', 'in'],
  duration: ['duration', 'durationmin', 'totaltime', 'elapsed'],
  stops: ['stops', 'stopcount', 'connections', 'numberofstops'],
  from: ['from', 'origin', 'departureairport', 'fromairport'],
  to: ['to', 'destination', 'arrivalairport', 'toairport'],
  cabin: ['cabin', 'class', 'travelclass', 'fareclass'],
  miles: ['miles', 'milesearned', 'points'],
};

const pickField = (row, field) => {
  for (const alias of FIELD_ALIASES[field]) {
    for (const [key, value] of Object.entries(row)) {
      if (key.toLowerCase().replace(/[^a-z]/g, '') === alias && value !== '' && value != null) return value;
    }
  }
  return undefined;
};

function fromRows(rows, context, format) {
  const offers = [];
  const skipped = [];

  for (const [index, row] of rows.entries()) {
    const price = parsePrice(String(pickField(row, 'price') ?? ''), { bareNumbersAreMoney: true });
    const departRaw = String(pickField(row, 'depart') ?? '');
    const arriveRaw = String(pickField(row, 'arrive') ?? '');

    const departMatch = /(\d{1,2}:\d{2})\s*([AaPp][Mm])?/.exec(departRaw);
    const arriveMatch = /(\d{1,2}:\d{2})\s*([AaPp][Mm])?/.exec(arriveRaw);

    const missing = [];
    if (!Number.isFinite(price)) missing.push('price');
    if (!departMatch) missing.push('departure time');
    if (!arriveMatch) missing.push('arrival time');
    if (missing.length > 0) {
      skipped.push({ text: JSON.stringify(row).slice(0, 140), missing });
      continue;
    }

    const departLocal = to24Hour(departMatch[1], departMatch[2]);
    const arriveLocal = to24Hour(arriveMatch[1], arriveMatch[2]);
    const dayShift = /\+\s?(\d)/.exec(arriveRaw)?.[1] ?? 0;

    const durationRaw = String(pickField(row, 'duration') ?? '');
    const estimated = [];
    let durationMin = parseDuration(durationRaw) || Number(durationRaw) || NaN;
    if (!Number.isFinite(durationMin)) {
      durationMin = minutesBetween(departLocal, arriveLocal, Number(dayShift));
      estimated.push('durationMin');
    }

    const airlineName = String(pickField(row, 'airline') ?? '').trim();
    const carrier = airlineByName(airlineName) ?? AIRLINES_BY_CODE[airlineName.toUpperCase()];
    const milesRaw = pickField(row, 'miles');

    const offer = toOffer({
      id: `paste-${index + 1}`,
      source: id,
      airline: carrier?.name ?? airlineName ?? 'Unknown carrier',
      airlineCode: carrier?.code ?? null,
      alliance: carrier?.alliance ?? null,
      cabin: normalizeCabin(pickField(row, 'cabin') ?? context.cabin),
      from: normaliseCode(pickField(row, 'from') ?? context.from),
      to: normaliseCode(pickField(row, 'to') ?? context.to),
      departure: { date: context.date ?? null, time: departLocal, dayNumber: 0 },
      arrival: { date: context.date ?? null, time: arriveLocal, dayNumber: Number(dayShift) },
      dayShift: Number(dayShift),
      durationMin,
      stops: Number(pickField(row, 'stops') ?? 0) || parseStops(String(pickField(row, 'stops') ?? '')),
      layoverAirports: [],
      layoverMinutes: 0,
      priceUsd: price,
      milesEarned: Number.isFinite(Number(milesRaw)) && milesRaw !== undefined && milesRaw !== '' ? Number(milesRaw) : undefined,
    });
    offer.estimatedFields = estimated;
    offers.push(offer);
  }

  return { offers, skipped, format };
}

/**
 * The importer, in the shape the rest of the app expects from a provider.
 * There is no query - the traveller has already run the search themselves.
 */
export async function importFlights(text, context = {}) {
  const { offers, skipped, format } = parseFlightText(text, context);
  const notes = [];

  if (offers.length === 0) {
    throw new Error(
      "I couldn't find any flights in that. Select the result rows on the search " +
        'page (including the prices) and copy the whole block, or paste a CSV.'
    );
  }

  const { offers: usable, dropped } = keepUsable(offers, { source: 'Pasted flights' });
  if (skipped.length > 0) {
    notes.push(
      `${skipped.length} block(s) couldn't be read (missing ${[...new Set(skipped.flatMap((s) => s.missing))].join(', ')}).`
    );
  }
  const withoutRoute = usable.filter((o) => !o.from || !o.to).length;
  if (withoutRoute > 0) {
    notes.push(`${withoutRoute} flight(s) didn't state their airports; using the route in the search box.`);
  }

  // Ranking on cost is relative, so one consistent currency is fine whatever
  // it is. Two currencies in one list is not, and is worth saying out loud.
  const currencies = [...new Set(usable.map((o) => o.currencySymbol).filter(Boolean))];
  if (currencies.length > 1) {
    notes.push(
      `These prices mix ${currencies.join(' and ')} - no conversion is applied, so the cost ranking will be wrong. Re-copy them in one currency.`
    );
  } else if (currencies.length === 1 && !['$', 'USD'].includes(currencies[0])) {
    notes.push(`Prices are in ${currencies[0]} and are compared as-is, which is fine as long as they all are.`);
  }

  return { source: id, label, offers: usable, dropped, skipped, format, notes };
}

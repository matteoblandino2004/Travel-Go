/**
 * The canonical offer shape, and the parsing every adapter needs.
 *
 * Adapters translate a supplier's response into `toOffer()` and nothing
 * downstream ever sees supplier-specific field names. `validateOffer` is the
 * guard: a feed that changes shape should produce a loud, specific error, not
 * a silently mis-ranked list.
 */

/** @typedef {'economy'|'premium'|'business'|'first'} Cabin */

const CABIN_ALIASES = {
  economy: 'economy', eco: 'economy', coach: 'economy', y: 'economy',
  'economy class': 'economy', standard: 'economy',
  premium: 'premium', 'premium economy': 'premium', premium_economy: 'premium',
  'premium-economy': 'premium', w: 'premium',
  business: 'business', 'business class': 'business', c: 'business', j: 'business',
  first: 'first', 'first class': 'first', f: 'first',
};

/** Map whatever a supplier calls a cabin onto our four. */
export function normalizeCabin(raw, fallback = 'economy') {
  if (!raw) return fallback;
  const key = String(raw).toLowerCase().replace(/_/g, ' ').trim();
  return CABIN_ALIASES[key] ?? CABIN_ALIASES[key.replace(/ /g, '_')] ?? fallback;
}

/** ISO-8601 duration ("PT11H30M") -> minutes. Amadeus and Duffel both use it. */
export function parseIsoDuration(value) {
  if (typeof value === 'number') return value;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(String(value ?? '').trim());
  if (!match) return NaN;
  const [, days, hours, minutes] = match;
  const total = Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0);
  return total > 0 ? total : NaN;
}

/**
 * Parse a local date-time into a date and an "HH:MM" clock time.
 * Handles both "2026-10-12 11:30" (Google Flights) and "2026-10-12T11:30:00"
 * (Amadeus). Both are *local to the airport*, with no offset - which is
 * exactly what the time-of-day scoring wants.
 */
export function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, y, m, d, hh, mm] = match;
  return {
    date: `${y}-${m}-${d}`,
    time: `${hh.padStart(2, '0')}:${mm}`,
    dayNumber: Date.UTC(Number(y), Number(m) - 1, Number(d)) / 86400000,
  };
}

/** Whole days between two parsed date-times (0 = same calendar day). */
export function dayShiftBetween(from, to) {
  if (!from || !to) return 0;
  return Math.max(0, to.dayNumber - from.dayNumber);
}

/**
 * Build a canonical offer. Adapters should route everything through this so
 * the shape is defined in exactly one place.
 */
export function toOffer(fields) {
  const departure = typeof fields.departure === 'string' ? parseLocalDateTime(fields.departure) : fields.departure;
  const arrival = typeof fields.arrival === 'string' ? parseLocalDateTime(fields.arrival) : fields.arrival;
  const dayShift = fields.dayShift ?? dayShiftBetween(departure, arrival);

  return {
    id: String(fields.id),
    source: fields.source,
    airline: fields.airline ?? null,
    airlineCode: fields.airlineCode ?? null,
    alliance: fields.alliance ?? null,
    cabin: normalizeCabin(fields.cabin),
    from: fields.from ?? null,
    to: fields.to ?? null,
    departDate: departure?.date ?? null,
    departLocal: departure?.time ?? null,
    arriveLocal: arrival?.time ?? null,
    dayShift,
    arrivesNextDay: dayShift > 0,
    durationMin: Number(fields.durationMin),
    stops: Number(fields.stops ?? 0),
    layoverAirports: fields.layoverAirports ?? [],
    layoverMinutes: Number(fields.layoverMinutes ?? 0),
    priceUsd: Number(fields.priceUsd),
    currency: fields.currency ?? 'USD',
    // Left undefined on purpose when the feed doesn't carry them - enrich.js
    // fills them in and records that it did.
    milesEarned: fields.milesEarned,
    eliteQualifyingPoints: fields.eliteQualifyingPoints,
    loungeAccess: fields.loungeAccess,
    distanceKm: fields.distanceKm,
    onTimePct: fields.onTimePct,
    oftenDelayed: fields.oftenDelayed ?? false,
    carbonKg: fields.carbonKg,
    bookingUrl: fields.bookingUrl ?? null,
    bookingToken: fields.bookingToken ?? null,
    segments: fields.segments ?? [],
    estimatedFields: [],
  };
}

/**
 * Everything the ranker needs in order to score an offer at all.
 * Anything missing means the offer is unusable, not merely incomplete.
 */
const REQUIRED = ['id', 'departLocal', 'arriveLocal', 'durationMin', 'priceUsd'];

export function validateOffer(offer) {
  const problems = [];
  for (const key of REQUIRED) {
    const value = offer[key];
    if (value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) {
      problems.push(key);
    }
  }
  if (Number.isFinite(offer.priceUsd) && offer.priceUsd <= 0) problems.push('priceUsd');
  if (Number.isFinite(offer.durationMin) && offer.durationMin <= 0) problems.push('durationMin');
  return problems;
}

/**
 * Drop unusable offers, and report how many went and why.
 * A supplier changing its response shape shows up here as "42 of 44 offers
 * dropped (missing priceUsd)" instead of an empty page.
 */
export function keepUsable(offers, { source }) {
  const kept = [];
  const dropped = [];
  for (const offer of offers) {
    const problems = validateOffer(offer);
    if (problems.length === 0) kept.push(offer);
    else dropped.push({ id: offer.id, missing: problems });
  }
  if (kept.length === 0 && dropped.length > 0) {
    const fields = [...new Set(dropped.flatMap((d) => d.missing))].join(', ');
    throw new Error(
      `${source} returned ${dropped.length} offers but none were usable (missing: ${fields}). ` +
        `The supplier's response shape has probably changed.`
    );
  }
  return { offers: kept, dropped };
}

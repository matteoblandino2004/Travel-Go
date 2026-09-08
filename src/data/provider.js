/**
 * Inventory provider.
 *
 * This is the seam between the ranking engine and the outside world. Today it
 * synthesises a plausible market from the reference data in cities.js; swapping
 * in Amadeus/Duffel/Booking means reimplementing `searchFlights` and
 * `searchHotels` to return the same shapes. Nothing in src/core imports this
 * file, so the engine never has to know where the offers came from.
 *
 * Results are deterministic for a given search: the same query returns the same
 * market, so changing an importance slider re-ranks the *same* options instead
 * of shuffling in new ones.
 */

import { CITIES, NEIGHBOURHOODS, findCity } from './cities.js';
import { haversineKm } from '../core/geo.js';

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 - small, fast, good enough for fixtures. */
function rng(seed) {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const between = (rand, lo, hi) => lo + rand() * (hi - lo);

/* ------------------------------------------------------------------ *
 * Airlines
 * ------------------------------------------------------------------ */

/** `shortHaulOnly` carriers are kept off intercontinental routes. */
export const AIRLINES = [
  { region: 'namerica', code: 'UA', name: 'United', alliance: 'star', quality: 0.72, priceIndex: 1.0 },
  { region: 'asia', code: 'NH', name: 'ANA', alliance: 'star', quality: 0.93, priceIndex: 1.12 },
  { region: 'europe', code: 'LH', name: 'Lufthansa', alliance: 'star', quality: 0.8, priceIndex: 1.06 },
  { region: 'namerica', code: 'AA', name: 'American', alliance: 'oneworld', quality: 0.68, priceIndex: 0.97 },
  { region: 'europe', code: 'BA', name: 'British Airways', alliance: 'oneworld', quality: 0.78, priceIndex: 1.05 },
  { region: 'asia', code: 'JL', name: 'Japan Airlines', alliance: 'oneworld', quality: 0.92, priceIndex: 1.1 },
  { region: 'namerica', code: 'DL', name: 'Delta', alliance: 'skyteam', quality: 0.81, priceIndex: 1.03 },
  { region: 'europe', code: 'AF', name: 'Air France', alliance: 'skyteam', quality: 0.76, priceIndex: 1.02 },
  { region: 'europe', code: 'KL', name: 'KLM', alliance: 'skyteam', quality: 0.77, priceIndex: 1.0 },
  { region: 'europe', code: 'FR', name: 'Ryanair', alliance: null, quality: 0.42, priceIndex: 0.62, shortHaulOnly: true },
  { region: 'europe', code: 'VS', name: 'Virgin Atlantic', alliance: 'skyteam', quality: 0.83, priceIndex: 1.04 },
];

const CONNECTION_HUBS = {
  star: ['FRA', 'ORD', 'MUC', 'NRT', 'IAD'],
  oneworld: ['LHR', 'DFW', 'HND', 'MAD'],
  skyteam: ['CDG', 'AMS', 'ATL', 'DTW'],
  null: ['STN', 'BGY'],
};

/** Miles per mile flown, by cabin and elite tier. */
const CABIN_EARNING = { economy: 5, premium: 7, business: 11 };
const TIER_BONUS = { none: 0, member: 0, silver: 0.4, gold: 0.8, platinum: 1.1 };

/**
 * What lounge access this itinerary actually grants.
 * Business class always; otherwise it comes from the traveller's alliance tier.
 */
function loungeFor(cabin, airline, profile) {
  if (cabin === 'business') return 'full';
  const tier = profile?.alliances?.[airline.alliance];
  if (tier === 'gold' || tier === 'platinum') return 'full';
  if (tier === 'silver') return 'partner';
  const airlineTier = profile?.airlines?.[airline.code];
  if (airlineTier && airlineTier !== 'none') return 'partner';
  return profile?.loungeMembership ? 'paid' : 'none';
}

/* ------------------------------------------------------------------ *
 * Flights
 * ------------------------------------------------------------------ */

/**
 * @param {object} query
 * @param {string} query.from origin city name / code / airport code
 * @param {string} query.to destination
 * @param {string} [query.date] YYYY-MM-DD, used only as a seed here
 * @param {'economy'|'premium'|'business'} [query.cabin]
 * @param {object} [query.profile] traveller loyalty profile
 * @param {number} [query.count]
 * @returns {{query:object, offers:object[]}}
 */
export function searchFlights(query) {
  const origin = findCity(query.from);
  const destination = findCity(query.to);
  if (!origin) throw new Error(`Unknown origin: ${query.from}`);
  if (!destination) throw new Error(`Unknown destination: ${query.to}`);
  if (origin.code === destination.code) throw new Error('Origin and destination are the same city');

  const cabin = query.cabin ?? 'economy';
  const count = query.count ?? 14;
  const profile = query.profile ?? {};
  const rand = rng(`flights:${origin.code}:${destination.code}:${query.date ?? 'anyday'}:${cabin}`);

  // Low-cost short-haul carriers don't sell tickets across an ocean, and a
  // route is mostly served by carriers based at one end of it.
  const routeKm = haversineKm(origin.airports[0], destination.airports[0]);
  const endpoints = new Set([origin.region, destination.region]);
  const carriers = [];
  for (const airline of AIRLINES) {
    if (airline.shortHaulOnly && routeKm > 3000) continue;
    const copies = endpoints.has(airline.region) ? 3 : 1; // weighted draw
    for (let c = 0; c < copies; c++) carriers.push(airline);
  }

  const offers = [];
  for (let i = 0; i < count; i++) {
    const airline = pick(rand, carriers);
    const originAirport = pick(rand, origin.airports);
    const destAirport = pick(rand, destination.airports);
    const km = haversineKm(originAirport, destAirport);

    // Long-haul is mostly nonstop or one stop; short-haul rarely needs two.
    const stopRoll = rand();
    const stops = stopRoll < 0.42 ? 0 : stopRoll < 0.85 ? 1 : 2;

    // Routing, aircraft and winds move block time around by a few percent -
    // without this, every nonstop on a route reports an identical duration and
    // the criterion can't discriminate.
    const airborneMin = Math.round((km / 830) * 60 * between(rand, 0.95, 1.07) + 35);
    const connectionMin = stops === 0 ? 0 : Math.round(between(rand, 65, 220) * stops);
    const durationMin = airborneMin + connectionMin;

    // Price: distance-driven, discounted for connections, marked up by carrier
    // quality and cabin, with genuine day-to-day noise on top.
    const cabinMultiplier = { economy: 1, premium: 1.75, business: 3.4 }[cabin];
    const base = 58 + km * (km > 6000 ? 0.052 : 0.085);
    const stopDiscount = 1 - stops * 0.11;
    const price = Math.round(
      base * airline.priceIndex * cabinMultiplier * stopDiscount * between(rand, 0.82, 1.32)
    );

    const departMinutes = Math.round(between(rand, 0, 1439) / 5) * 5;
    const offsetDelta = (destination.utcOffset - origin.utcOffset) * 60;
    const arriveAbsolute = departMinutes + durationMin + offsetDelta;
    const arriveMinutes = ((arriveAbsolute % 1440) + 1440) % 1440;
    const dayShift = Math.floor(arriveAbsolute / 1440);

    const miles = Math.round(
      km * 0.621371 * (CABIN_EARNING[cabin] / 5) *
        (1 + (TIER_BONUS[profile?.alliances?.[airline.alliance] ?? 'none'] ?? 0))
    );

    offers.push({
      id: `${airline.code}${100 + i}`,
      airline: airline.name,
      airlineCode: airline.code,
      alliance: airline.alliance,
      cabin,
      from: originAirport.code,
      to: destAirport.code,
      distanceKm: Math.round(km),
      stops,
      layoverAirports:
        stops === 0
          ? []
          : Array.from({ length: stops }, () => pick(rand, CONNECTION_HUBS[airline.alliance] ?? CONNECTION_HUBS.null)),
      departLocal: fmt(departMinutes),
      arriveLocal: fmt(arriveMinutes),
      arrivesNextDay: dayShift > 0,
      durationMin,
      priceUsd: price,
      milesEarned: miles,
      eliteQualifyingPoints: Math.round(price * (cabin === 'business' ? 1.5 : 0.6)),
      loungeAccess: loungeFor(cabin, airline, profile),
      onTimePct: Math.round(55 + airline.quality * 35 + between(rand, -6, 6)),
    });
  }

  // Two carriers can't run the identical itinerary at the identical price.
  const seen = new Set();
  const unique = offers.filter((o) => {
    const key = `${o.airlineCode}:${o.departLocal}:${o.from}:${o.to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    query: { origin: origin.code, destination: destination.code, cabin, date: query.date ?? null },
    offers: unique,
  };
}

const fmt = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/* ------------------------------------------------------------------ *
 * Hotels
 * ------------------------------------------------------------------ */

const HOTEL_BRANDS = [
  { name: 'Park Hyatt', program: 'hyatt', tierFloor: 5, priceIndex: 2.4 },
  { name: 'Grand Hyatt', program: 'hyatt', tierFloor: 4, priceIndex: 1.5 },
  { name: 'Hyatt Place', program: 'hyatt', tierFloor: 3, priceIndex: 0.9 },
  { name: 'Ritz-Carlton', program: 'marriott', tierFloor: 5, priceIndex: 2.6 },
  { name: 'Marriott', program: 'marriott', tierFloor: 4, priceIndex: 1.4 },
  { name: 'Moxy', program: 'marriott', tierFloor: 3, priceIndex: 0.85 },
  { name: 'Courtyard', program: 'marriott', tierFloor: 3, priceIndex: 0.95 },
  { name: 'Conrad', program: 'hilton', tierFloor: 5, priceIndex: 2.1 },
  { name: 'Hilton', program: 'hilton', tierFloor: 4, priceIndex: 1.35 },
  { name: 'Hampton Inn', program: 'hilton', tierFloor: 3, priceIndex: 0.8 },
  { name: 'InterContinental', program: 'ihg', tierFloor: 5, priceIndex: 1.9 },
  { name: 'Kimpton', program: 'ihg', tierFloor: 4, priceIndex: 1.45 },
  { name: 'Holiday Inn Express', program: 'ihg', tierFloor: 3, priceIndex: 0.72 },
  { name: 'Independent boutique', program: null, tierFloor: 3, priceIndex: 1.0 },
];

const TIER_PERKS = {
  none: [],
  member: ['wifi'],
  silver: ['wifi', 'breakfast'],
  gold: ['wifi', 'breakfast', 'upgrade'],
  platinum: ['wifi', 'breakfast', 'upgrade', 'lounge'],
};
const TIER_POINTS_MULTIPLIER = { none: 1, member: 1, silver: 1.2, gold: 1.5, platinum: 1.75 };

/**
 * @param {object} query
 * @param {string} query.city
 * @param {number} [query.nights]
 * @param {object} [query.profile] `{hotels: {marriott: 'gold', ...}}`
 * @param {number} [query.count]
 */
export function searchHotels(query) {
  const city = findCity(query.city);
  if (!city) throw new Error(`Unknown city: ${query.city}`);
  const nights = query.nights ?? 3;
  const count = query.count ?? 16;
  const profile = query.profile ?? {};
  const rand = rng(`hotels:${city.code}:${query.checkIn ?? 'anyday'}:${nights}`);
  const areas = NEIGHBOURHOODS[city.code] ?? [{ name: 'Centre', ...city.center, premium: 1 }];

  const hotels = [];
  for (let i = 0; i < count; i++) {
    const brand = pick(rand, HOTEL_BRANDS);
    const area = pick(rand, areas);

    // Scatter within roughly 1.2 km of the neighbourhood's centre.
    const lat = area.lat + between(rand, -0.011, 0.011);
    const lng = area.lng + between(rand, -0.014, 0.014);

    const stars = Math.min(5, Math.max(2, brand.tierFloor + (rand() < 0.25 ? -1 : 0)));
    const nightly = Math.round(
      95 * brand.priceIndex * area.premium * between(rand, 0.82, 1.3) * (1 + (stars - 3) * 0.12)
    );

    const tier = brand.program ? profile?.hotels?.[brand.program] ?? 'none' : 'none';
    const reviewCount = Math.round(between(rand, 40, 4200));

    hotels.push({
      id: `H${String(i + 1).padStart(2, '0')}`,
      name: `${brand.name} ${city.name} ${area.name}`,
      brand: brand.name,
      program: brand.program,
      neighbourhood: area.name,
      lat,
      lng,
      stars,
      nightlyUsd: nightly,
      totalUsd: nightly * nights,
      nights,
      eliteRecognition: tier,
      perks: TIER_PERKS[tier] ?? [],
      pointsEarned: brand.program
        ? Math.round(nightly * nights * 10 * (TIER_POINTS_MULTIPLIER[tier] ?? 1))
        : 0,
      guestRating: Math.round((6.4 + stars * 0.55 + between(rand, -0.7, 0.7)) * 10) / 10,
      reviewCount,
      cancellation: rand() < 0.55 ? 'free' : rand() < 0.6 ? 'partial' : 'nonrefundable',
    });
  }

  return { query: { city: city.code, nights }, city, hotels };
}

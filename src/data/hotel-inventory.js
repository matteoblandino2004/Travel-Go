/**
 * Hotel inventory.
 *
 * Generated sample data, same seam idea as the flight providers: this is the
 * only place that knows where properties come from. Deterministic per query so
 * a rating change re-ranks the same market.
 */

import { NEIGHBOURHOODS, findCity } from './cities.js';

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

/**
 * Generated hotel inventory - for anywhere, not just catalogued cities.
 *
 * The previous version could only invent hotels in six cities, because it drew
 * neighbourhoods from a hand-written table. This one places them on rings
 * around whatever centre it's given, so it works for Lisbon, Tbilisi or
 * Ushuaia. Where a curated neighbourhood list exists it's still used, purely
 * because "Shibuya" reads better than "Central district".
 */

import { NEIGHBOURHOODS, findCity } from '../cities.js';

export const id = 'sample';
export const label = 'Generated sample data';
export const credentials = [];
export const isConfigured = () => true;

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

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

/**
 * Rough cost-of-a-hotel-room index by country, so a night in Oslo isn't priced
 * like a night in Hanoi. Anywhere unlisted sits at the middle of the range.
 */
const COUNTRY_PRICE_INDEX = {
  CH: 1.7, NO: 1.5, IS: 1.5, US: 1.3, GB: 1.3, SG: 1.3, AU: 1.25, DK: 1.25,
  IE: 1.2, NL: 1.2, FR: 1.2, JP: 1.05, DE: 1.1, CA: 1.1, AE: 1.2, IL: 1.25,
  IT: 1.05, ES: 0.95, KR: 0.95, NZ: 1.1, AT: 1.1, BE: 1.1, SE: 1.15, FI: 1.15,
  PT: 0.85, GR: 0.85, CZ: 0.8, PL: 0.7, HU: 0.7, HR: 0.85, TR: 0.6, MX: 0.7,
  BR: 0.7, AR: 0.6, CL: 0.75, ZA: 0.6, TH: 0.55, VN: 0.45, ID: 0.5, MY: 0.55,
  IN: 0.45, PH: 0.5, EG: 0.5, MA: 0.6, GE: 0.55, RS: 0.6, RO: 0.65, BG: 0.6,
  CN: 0.7, TW: 0.75, LK: 0.4, NP: 0.35, PE: 0.6, CO: 0.6, KE: 0.6, TZ: 0.6,
};

/** Directional labels used when we have no real neighbourhood names. */
const RINGS = [
  { label: 'Central', km: 0.7, premium: 1.25 },
  { label: 'Old town', km: 1.4, premium: 1.15 },
  { label: 'Inner north', km: 2.4, bearing: 0, premium: 0.95 },
  { label: 'Inner east', km: 2.4, bearing: 90, premium: 0.95 },
  { label: 'Inner south', km: 2.6, bearing: 180, premium: 0.9 },
  { label: 'Inner west', km: 2.6, bearing: 270, premium: 0.9 },
  { label: 'Business district', km: 3.6, bearing: 45, premium: 1.05 },
  { label: 'Outer district', km: 5.5, bearing: 200, premium: 0.7 },
];

/** Offset a point by a distance and compass bearing. */
function offsetPoint(centre, km, bearingDeg) {
  const latDegPerKm = 1 / 110.574;
  const lngDegPerKm = 1 / (111.32 * Math.cos((centre.lat * Math.PI) / 180) || 1);
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    lat: centre.lat + km * Math.cos(rad) * latDegPerKm,
    lng: centre.lng + km * Math.sin(rad) * lngDegPerKm,
  };
}

/**
 * Neighbourhoods to place hotels in: the curated list where we have one,
 * otherwise rings around the centre.
 */
function areasFor(destination, rand) {
  const curated = NEIGHBOURHOODS[destination.cityCode];
  if (curated) return curated;

  return RINGS.map((ring) => {
    const point =
      ring.bearing === undefined
        ? offsetPoint(destination.centre, ring.km * rand(), rand() * 360)
        : offsetPoint(destination.centre, ring.km, ring.bearing);
    return { name: ring.label, lat: point.lat, lng: point.lng, premium: ring.premium };
  });
}

/**
 * @param {object} query
 * @param {object} query.destination `{name, cityCode, country, centre:{lat,lng}}`
 * @param {number} [query.nights]
 * @param {string} [query.checkIn]
 * @param {number} [query.count]
 */
export async function searchHotels(query) {
  const destination = query.destination;
  if (!destination?.centre) throw new Error('A destination centre is required to place hotels.');

  const nights = query.nights ?? 3;
  const count = query.count ?? 16;
  const rand = rng(`hotels:${destination.cityCode ?? destination.name}:${query.checkIn ?? 'anyday'}:${nights}`);
  const areas = areasFor(destination, rand);
  const countryIndex = COUNTRY_PRICE_INDEX[destination.country] ?? 0.9;

  const hotels = [];
  for (let i = 0; i < count; i++) {
    const brand = pick(rand, HOTEL_BRANDS);
    const area = pick(rand, areas);

    // Scatter within roughly 1 km of the area's centre.
    const lat = area.lat + between(rand, -0.009, 0.009);
    const lng = area.lng + between(rand, -0.011, 0.011);

    const stars = Math.min(5, Math.max(2, brand.tierFloor + (rand() < 0.25 ? -1 : 0)));
    const nightly = Math.round(
      98 * brand.priceIndex * area.premium * countryIndex * between(rand, 0.82, 1.3) * (1 + (stars - 3) * 0.12)
    );

    hotels.push({
      id: `H${String(i + 1).padStart(2, '0')}`,
      source: id,
      name: `${brand.name} ${destination.name} ${area.name}`,
      brand: brand.name,
      program: brand.program,
      neighbourhood: area.name,
      lat,
      lng,
      stars,
      nightlyUsd: nightly,
      totalUsd: nightly * nights,
      nights,
      guestRating: Math.round((6.4 + stars * 0.55 + between(rand, -0.7, 0.7)) * 10) / 10,
      reviewCount: Math.round(between(rand, 40, 4200)),
      cancellation: rand() < 0.55 ? 'free' : rand() < 0.6 ? 'partial' : 'nonrefundable',
      // Left for the enrichment step, exactly as the flight providers do.
      eliteRecognition: undefined,
      perks: undefined,
      pointsEarned: undefined,
    });
  }

  return { source: id, label, hotels };
}

export { findCity };

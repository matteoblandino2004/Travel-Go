/**
 * Filling in what real flight feeds don't carry.
 *
 * Google Flights, Amadeus and Duffel all return roughly the same facts: price,
 * times, stops, duration, carrier, cabin. None of them return the three things
 * a frequent flyer ranks on - miles earned, elite-qualifying credit, and
 * whether you get into a lounge - because all three depend on *who is flying*,
 * not on the fare.
 *
 * So we derive them from the itinerary plus the traveller's loyalty profile,
 * and mark every derived value as an estimate so the UI never presents a guess
 * as a quoted number. If a provider ever does supply a real figure, it wins.
 */

import { airline } from './airlines.js';

/* ------------------------------------------------------------------ *
 * Earning
 * ------------------------------------------------------------------ */

/**
 * Revenue-based programmes (the US majors and a growing number of others)
 * pay per dollar of base fare. Multipliers are the published base-member rate
 * and the usual elite bonuses.
 */
const REVENUE_PROGRAMMES = new Set(['UA', 'AA', 'DL', 'AS', 'B6', 'WN', 'AC', 'QF', 'VS']);
const REVENUE_RATE = { none: 5, member: 5, silver: 7, gold: 8, platinum: 9, top: 11 };

/** Distance-based programmes pay per mile flown, scaled by cabin. */
const CABIN_EARNING_RATE = { economy: 0.7, premium: 1.1, business: 1.5, first: 2 };
const DISTANCE_TIER_BONUS = { none: 0, member: 0, silver: 0.25, gold: 0.5, platinum: 0.75, top: 1 };

/** Taxes don't earn. A rough but stable split beats pretending the whole fare does. */
const BASE_FARE_SHARE = 0.78;

/**
 * Estimate great-circle distance from the time actually spent in the air.
 *
 * Feeds give duration, not distance, and shipping a worldwide airport
 * coordinate table for this one number isn't worth it. ~830 km/h block speed
 * with 35 minutes of taxi and climb-out matches real schedules closely enough
 * to rank on.
 */
export function estimateDistanceKm(offer) {
  if (Number.isFinite(offer.distanceKm)) return offer.distanceKm;
  const layoverMin = Number(offer.layoverMinutes ?? 0);
  const airborne = Number(offer.durationMin ?? 0) - layoverMin - 35 * Math.max(1, (offer.stops ?? 0) + 1);
  return airborne > 0 ? (airborne / 60) * 830 : NaN;
}

/**
 * @param {object} offer normalised offer
 * @param {object} [profile] `{alliances: {star: 'gold'}, airlines: {UA: 'silver'}}`
 * @returns {{milesEarned:number, eliteQualifyingPoints:number, basis:string}}
 */
export function deriveEarning(offer, profile = {}) {
  const carrier = airline(offer.airlineCode, offer.airline);
  const tier = tierFor(carrier, profile);
  const fare = Number(offer.priceUsd);
  const cabin = offer.cabin ?? 'economy';

  if (!Number.isFinite(fare) || fare <= 0) {
    return { milesEarned: 0, eliteQualifyingPoints: 0, basis: 'unknown' };
  }

  const baseFare = fare * BASE_FARE_SHARE;

  if (REVENUE_PROGRAMMES.has(carrier.code)) {
    return {
      milesEarned: Math.round(baseFare * (REVENUE_RATE[tier] ?? REVENUE_RATE.none)),
      // Elite credit on revenue programmes tracks spend roughly 1:1.
      eliteQualifyingPoints: Math.round(baseFare),
      basis: 'revenue',
    };
  }

  const km = estimateDistanceKm(offer);
  if (!Number.isFinite(km)) {
    return { milesEarned: Math.round(baseFare * 5), eliteQualifyingPoints: Math.round(baseFare), basis: 'revenue' };
  }
  const miles = km * 0.621371;
  const earned = miles * (CABIN_EARNING_RATE[cabin] ?? 0.7) * (1 + (DISTANCE_TIER_BONUS[tier] ?? 0));
  return {
    milesEarned: Math.round(earned),
    eliteQualifyingPoints: Math.round(miles * (cabin === 'economy' ? 0.5 : 1.5)),
    basis: 'distance',
  };
}

/* ------------------------------------------------------------------ *
 * Lounge access
 * ------------------------------------------------------------------ */

/**
 * Whether this itinerary actually gets the traveller into a lounge.
 *
 * Premium cabins always do. Otherwise it comes from status: alliance gold
 * opens partner lounges worldwide, alliance silver opens some, and status with
 * the operating carrier itself usually opens its own. A paid membership
 * (Priority Pass, a credit card) is a fallback that works nearly everywhere.
 */
export function deriveLounge(offer, profile = {}) {
  const cabin = offer.cabin ?? 'economy';
  if (cabin === 'business' || cabin === 'first') return 'full';

  const carrier = airline(offer.airlineCode, offer.airline);
  const allianceTier = carrier.alliance ? profile?.alliances?.[carrier.alliance] : null;
  if (allianceTier === 'gold' || allianceTier === 'platinum' || allianceTier === 'top') return 'full';
  if (allianceTier === 'silver') return 'partner';

  const ownTier = profile?.airlines?.[carrier.code];
  if (ownTier && ownTier !== 'none') return 'partner';

  if (profile?.loungeMembership) return 'full';
  return 'none';
}

/** Best status the traveller holds that this carrier would recognise. */
function tierFor(carrier, profile) {
  const own = profile?.airlines?.[carrier.code];
  if (own && own !== 'none') return own;
  const alliance = carrier.alliance ? profile?.alliances?.[carrier.alliance] : null;
  return alliance ?? 'none';
}

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

/**
 * Fill in the fields a feed didn't supply, recording which ones we invented.
 * A provider that returns a real `milesEarned` keeps it untouched.
 */
export function enrichOffer(offer, profile = {}) {
  const estimated = [];
  const out = { ...offer };

  const carrier = airline(offer.airlineCode, offer.airline);
  out.airline = offer.airline ?? carrier.name;
  out.airlineCode = carrier.code;
  out.alliance = offer.alliance ?? carrier.alliance;

  if (!Number.isFinite(out.milesEarned)) {
    const earning = deriveEarning(out, profile);
    out.milesEarned = earning.milesEarned;
    out.eliteQualifyingPoints = Number.isFinite(out.eliteQualifyingPoints)
      ? out.eliteQualifyingPoints
      : earning.eliteQualifyingPoints;
    out.earningBasis = earning.basis;
    estimated.push('milesEarned');
  }

  if (!out.loungeAccess) {
    out.loungeAccess = deriveLounge(out, profile);
    estimated.push('loungeAccess');
  }

  if (!Number.isFinite(out.distanceKm)) {
    const km = estimateDistanceKm(out);
    if (Number.isFinite(km)) {
      out.distanceKm = Math.round(km);
      estimated.push('distanceKm');
    }
  }

  out.estimatedFields = [...(offer.estimatedFields ?? []), ...estimated];
  return out;
}

export function enrichOffers(offers, profile = {}) {
  return offers.map((offer) => enrichOffer(offer, profile));
}

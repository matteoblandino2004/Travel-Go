/**
 * "How well does this hotel serve the places I actually want to go?"
 *
 * The user lists places - sights, restaurants, a conference venue - and rates
 * each 1-5 or n/a, exactly like every other criterion. Each hotel is then
 * scored on how reachable that list is from its front door.
 */

import { estimateTravel, accessScoreForMinutes, DEFAULT_TRANSIT_QUALITY } from './geo.js';
import { importanceToWeight, isIgnored } from './weights.js';

/**
 * @typedef {object} Poi
 * @property {string} name
 * @property {number} lat
 * @property {number} lng
 * @property {'sight'|'food'|'other'} [kind]
 * @property {1|2|3|4|5|'na'} [importance] defaults to 3
 */

/**
 * Score one hotel against the user's list of places.
 *
 * Two components, because an average hides the deal-breaker:
 *  - `weightedMean` (75%): typical convenience across the whole list.
 *  - `worstMustSee` (25%): the least reachable of the places rated 4-5. A hotel
 *    that is 8 minutes from four cafes and 70 minutes from the one museum the
 *    user is actually flying in for should not out-rank a hotel that is 20
 *    minutes from everything.
 *
 * @param {{lat:number,lng:number}} hotel
 * @param {Poi[]} pois
 * @param {{transitQuality?:number, modes?:string[]}} [opts]
 * @returns {{score:number, legs:Array<object>, worstMustSee:object|null}}
 */
export function scoreHotelAccess(hotel, pois, opts = {}) {
  const { transitQuality = DEFAULT_TRANSIT_QUALITY, modes } = opts;
  const considered = (pois ?? []).filter(
    (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && !isIgnored(p.importance ?? 3)
  );

  if (considered.length === 0) {
    return { score: 0.5, legs: [], worstMustSee: null };
  }

  const legs = considered.map((poi) => {
    const travel = estimateTravel(hotel, poi, { transitQuality, modes });
    return {
      poi,
      name: poi.name,
      kind: poi.kind ?? 'other',
      importance: poi.importance ?? 3,
      km: travel.km,
      minutes: travel.minutes,
      mode: travel.mode,
      score: accessScoreForMinutes(travel.minutes),
      weight: importanceToWeight(poi.importance ?? 3),
    };
  });

  const totalWeight = legs.reduce((sum, leg) => sum + leg.weight, 0);
  const weightedMean =
    totalWeight > 0
      ? legs.reduce((sum, leg) => sum + leg.weight * leg.score, 0) / totalWeight
      : 0.5;

  const mustSees = legs.filter((leg) => Number(leg.importance) >= 4);
  const worstMustSee = mustSees.length
    ? mustSees.reduce((worst, leg) => (leg.score < worst.score ? leg : worst))
    : null;

  const score = worstMustSee ? 0.75 * weightedMean + 0.25 * worstMustSee.score : weightedMean;

  legs.sort((a, b) => a.minutes - b.minutes);
  return { score, legs, worstMustSee };
}

/** Human-readable summary of a leg, e.g. "12 min walk". */
export function describeLeg(leg) {
  const verb = leg.mode === 'walk' ? 'walk' : leg.mode === 'transit' ? 'by transit' : 'by taxi';
  return `${Math.round(leg.minutes)} min ${verb}`;
}

/**
 * Distance and door-to-door travel time estimates.
 *
 * This is a *model*, not a routing engine: it turns straight-line distance into
 * a plausible walk/transit/taxi time so hotels can be compared against each
 * other. Swap `estimateTravel` for a real directions API when one is wired up -
 * everything downstream only consumes `{minutes, mode}`.
 */

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Streets are not straight lines. Manhattan-ish grids add roughly 25% over the
 * crow-flies distance; this factor is applied to every ground mode.
 */
const DETOUR_FACTOR = 1.25;

const WALK_KMH = 4.8;
const WALK_MAX_KM = 2.5; // beyond this, nobody is walking on holiday

/**
 * Transit quality, 0..1, per city. Higher means denser network, shorter waits.
 * Feeds both the effective speed and the fixed access/wait overhead.
 */
export const DEFAULT_TRANSIT_QUALITY = 0.6;

/**
 * Estimate door-to-door time for one leg by the best available mode.
 *
 * @param {{lat:number,lng:number}} from
 * @param {{lat:number,lng:number}} to
 * @param {{transitQuality?: number, taxi?: boolean}} [opts]
 * @returns {{km:number, minutes:number, mode:'walk'|'transit'|'taxi', options:Record<string,number>}}
 */
export function estimateTravel(from, to, opts = {}) {
  const { transitQuality = DEFAULT_TRANSIT_QUALITY, taxi = true } = opts;
  const km = haversineKm(from, to);
  const routeKm = km * DETOUR_FACTOR;

  const walk = routeKm <= WALK_MAX_KM ? (routeKm / WALK_KMH) * 60 : Infinity;

  // Better networks mean shorter walks to the stop and shorter headways.
  const transitOverhead = 14 - 8 * transitQuality; // ~6 min excellent, ~14 min poor
  const transitSpeed = 14 + 18 * transitQuality; // ~14 km/h poor, ~32 km/h excellent
  const transit = routeKm < 0.6 ? Infinity : transitOverhead + (routeKm / transitSpeed) * 60;

  // Taxis lose their edge in the same traffic that slows buses, and the fixed
  // cost of hailing and getting going means nobody sensibly takes one four
  // blocks - the overhead has to be big enough for walking to win short hops.
  const taxiSpeed = 26 - 6 * transitQuality;
  const taxiTime = taxi ? 8 + (routeKm / taxiSpeed) * 60 : Infinity;

  const options = { walk, transit, taxi: taxiTime };
  let mode = 'walk';
  let minutes = walk;
  for (const [candidateMode, candidateMinutes] of Object.entries(options)) {
    if (candidateMinutes < minutes) {
      minutes = candidateMinutes;
      mode = candidateMode;
    }
  }
  if (!Number.isFinite(minutes)) {
    minutes = taxiTime;
    mode = 'taxi';
  }
  return { km, minutes, mode, options };
}

/**
 * Desirability of a journey of `minutes`, 0..1.
 *
 * Tuned so a 5-minute stroll is ~0.95, 15 minutes ~0.77, half an hour ~0.45,
 * and an hour ~0.11 - i.e. "across town" is a real cost, not a rounding error.
 */
export function accessScoreForMinutes(minutes) {
  if (!Number.isFinite(minutes)) return 0.5;
  return Math.exp(-Math.pow(Math.max(0, minutes) / 35, 1.5));
}

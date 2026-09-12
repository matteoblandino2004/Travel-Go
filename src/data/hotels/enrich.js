/**
 * Filling in the loyalty fields no hotel supplier carries.
 *
 * Elite recognition, perks and points all depend on who is staying rather than
 * on the property, so they are derived here from the traveller's profile -
 * exactly as the flight side derives miles and lounge access. Kept out of the
 * provider registry so a browser build can use it without pulling in the
 * network adapters.
 */

const TIER_PERKS = {
  none: [],
  member: ['wifi'],
  silver: ['wifi', 'breakfast'],
  gold: ['wifi', 'breakfast', 'upgrade'],
  platinum: ['wifi', 'breakfast', 'upgrade', 'lounge'],
  top: ['wifi', 'breakfast', 'upgrade', 'lounge'],
};
/** Base earning is ~10 points per dollar across the big programmes. */
const TIER_POINTS_MULTIPLIER = { none: 1, member: 1, silver: 1.2, gold: 1.5, platinum: 1.75, top: 2 };

/**
 * Loyalty standing is a property of the traveller, not the hotel - so, as with
 * flights, it's derived here rather than expected from a supplier.
 */
export function enrichHotel(hotel, profile = {}) {
  const out = { ...hotel };
  const estimated = [];

  const tier = hotel.program ? profile?.hotels?.[hotel.program] ?? 'none' : 'none';
  if (out.eliteRecognition === undefined) {
    out.eliteRecognition = tier;
    out.perks = TIER_PERKS[tier] ?? [];
    if (tier !== 'none') estimated.push('eliteRecognition');
  }
  if (out.pointsEarned === undefined) {
    out.pointsEarned = hotel.program
      ? Math.round((hotel.totalUsd ?? 0) * 10 * (TIER_POINTS_MULTIPLIER[tier] ?? 1))
      : 0;
    estimated.push('pointsEarned');
  }
  // A property with no star rating shouldn't be scored as a zero-star hotel.
  if (out.stars === undefined || out.stars === null) {
    out.stars = 3;
    estimated.push('stars');
  }

  out.estimatedFields = [...(hotel.estimatedFields ?? []), ...estimated];
  return out;
}

/**
 * Hotel criteria: cost, status, and - the one that actually decides most
 * trips - how easy it is to get from the hotel to the places on your list.
 */

import { relativeScorer, curveScorer } from './normalize.js';
import { rank } from './rank.js';
import { scoreHotelAccess, describeLeg } from './poi.js';

/**
 * "Hotel status" folds together the two things people mean by it: the property
 * itself (stars) and what your loyalty tier gets you there (upgrades, breakfast,
 * lounge). Weighted toward the recognition, since that is the part that changes
 * between two otherwise identical 4-star hotels.
 */
const ELITE_TIERS = { none: 0, member: 0.2, silver: 0.45, gold: 0.7, platinum: 0.9, top: 1 };

export function statusValue(hotel) {
  const stars = (Math.min(5, Math.max(1, hotel.stars ?? 3)) - 1) / 4; // 1-5 stars -> 0..1
  const elite = ELITE_TIERS[hotel.eliteRecognition ?? 'none'] ?? 0;
  const perks =
    (hotel.perks?.includes('lounge') ? 0.4 : 0) +
    (hotel.perks?.includes('breakfast') ? 0.3 : 0) +
    (hotel.perks?.includes('upgrade') ? 0.3 : 0);
  return 0.4 * stars + 0.4 * elite + 0.2 * Math.min(1, perks);
}

export const HOTEL_CRITERIA = [
  {
    key: 'cost',
    label: 'Cost',
    hint: 'Nightly rate including taxes and fees, compared with the other properties found.',
    value: (h) => h.nightlyUsd,
    scorer: (values) => relativeScorer(values, { direction: 'lower' }),
    display: (h) => `$${Math.round(h.nightlyUsd).toLocaleString('en-US')}/night`,
  },
  {
    key: 'status',
    label: 'Hotel status',
    hint: 'Star rating combined with what your loyalty tier earns you here.',
    value: (h) => statusValue(h),
    scorer: () => (v) => v,
    display: (h) => {
      const tier = h.eliteRecognition && h.eliteRecognition !== 'none' ? `, ${h.eliteRecognition}` : '';
      return `${h.stars}★ ${h.brand ?? 'independent'}${tier}`;
    },
  },
  {
    key: 'access',
    label: 'Getting around',
    hint: 'Travel time from this hotel to every place you listed, weighted by how much each matters.',
    value: (h, ctx) => {
      const detail = ctx.accessByHotel?.get(h.id);
      return detail ? detail.score : 0.5;
    },
    scorer: () => (v) => v,
    display: (h, _raw, ctx) => {
      const detail = ctx.accessByHotel?.get(h.id);
      if (!detail || detail.legs.length === 0) return 'No places listed';
      // legs are sorted nearest-first
      const nearest = Math.round(detail.legs[0].minutes);
      if (detail.legs.length === 1) return `${nearest} min to ${detail.legs[0].name}`;
      const furthest = Math.round(detail.legs[detail.legs.length - 1].minutes);
      return `${nearest}-${furthest} min to your ${detail.legs.length} places`;
    },
  },
  {
    key: 'guestRating',
    label: 'Guest rating',
    hint: 'Average review score, discounted when barely anyone has reviewed it.',
    value: (h) => {
      const score = h.guestRating ?? NaN;
      if (!Number.isFinite(score)) return NaN;
      // Shrink thin sample sizes toward the middle so a lone 9.8 doesn't win.
      const n = h.reviewCount ?? 0;
      const confidence = n / (n + 60);
      return 7.5 + (score - 7.5) * confidence;
    },
    scorer: (values) => relativeScorer(values, { direction: 'higher' }),
    display: (h) =>
      Number.isFinite(h.guestRating)
        ? `${h.guestRating.toFixed(1)}/10 (${(h.reviewCount ?? 0).toLocaleString('en-US')})`
        : 'unrated',
  },
  {
    key: 'points',
    label: 'Points earned',
    hint: 'Loyalty points credited for the stay, at the rate for your tier.',
    value: (h) => h.pointsEarned ?? 0,
    scorer: (values) => relativeScorer(values, { direction: 'higher' }),
    display: (h) => `${Math.round(h.pointsEarned ?? 0).toLocaleString('en-US')} pts`,
  },
  {
    key: 'cancellation',
    label: 'Flexibility',
    hint: 'How late you can cancel without losing the money.',
    value: (h) => ({ nonrefundable: 0, partial: 0.5, free: 1 })[h.cancellation ?? 'partial'] ?? 0.5,
    scorer: () => curveScorer([[0, 0], [0.5, 0.5], [1, 1]]),
    display: (h) =>
      ({ nonrefundable: 'Non-refundable', partial: 'Partial refund', free: 'Free cancellation' })[
        h.cancellation ?? 'partial'
      ],
  },
];

export const HOTEL_CRITERIA_KEYS = HOTEL_CRITERIA.map((c) => c.key);

/**
 * Rank hotels. Access is computed once per hotel up front rather than inside
 * the criterion, so the per-place breakdown can be shown in the UI.
 *
 * @param {object[]} hotels
 * @param {Record<string, import('./weights.js').Importance>} importances
 * @param {{pois?: import('./poi.js').Poi[], transitQuality?: number}} [opts]
 */
export function rankHotels(hotels, importances, opts = {}) {
  const { pois = [], transitQuality } = opts;
  const accessByHotel = new Map();
  for (const hotel of hotels) {
    accessByHotel.set(hotel.id, scoreHotelAccess(hotel, pois, { transitQuality }));
  }

  const ctx = { accessByHotel, pois };
  const ranked = rank({ candidates: hotels, criteria: HOTEL_CRITERIA, importances, ctx });

  // Attach the per-place detail so the UI can show "8 min walk to Senso-ji".
  for (const result of ranked.results) {
    const detail = accessByHotel.get(result.candidate.id);
    result.access = detail
      ? {
          score: detail.score,
          worstMustSee: detail.worstMustSee
            ? { name: detail.worstMustSee.name, summary: describeLeg(detail.worstMustSee) }
            : null,
          legs: detail.legs.map((leg) => ({
            name: leg.name,
            kind: leg.kind,
            importance: leg.importance,
            minutes: Math.round(leg.minutes),
            km: Math.round(leg.km * 10) / 10,
            mode: leg.mode,
            summary: describeLeg(leg),
          })),
        }
      : null;
  }

  return ranked;
}

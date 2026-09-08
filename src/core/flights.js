/**
 * Flight criteria - the six the user asked to rank, plus total trip time.
 *
 * Each criterion knows three things: how to pull its raw number off an offer,
 * how to turn that number into 0..1, and how to print it. Adding a criterion
 * (seat pitch, on-time record, CO2) means adding one entry here and one control
 * in the UI - nothing else changes.
 */

import { relativeScorer, curveScorer } from './normalize.js';
import { scoreTimeOfDay, formatMinutes, toMinutes } from './timepref.js';
import { rank } from './rank.js';

/** Lounge access is a small ladder, not a number. */
const LOUNGE_TIERS = { none: 0, paid: 0.35, partner: 0.7, full: 1 };

export const FLIGHT_CRITERIA = [
  {
    key: 'cost',
    label: 'Cost',
    hint: 'Total fare including taxes, compared with the other options found.',
    value: (f) => f.priceUsd,
    scorer: (values) => relativeScorer(values, { direction: 'lower' }),
    display: (f) => `$${Math.round(f.priceUsd).toLocaleString('en-US')}`,
  },
  {
    key: 'departureTime',
    label: 'Departure time',
    hint: 'How close departure is to the window you want to leave in.',
    value: (f) => toMinutes(f.departLocal),
    scorer: (_values, ctx) => (minutes) =>
      scoreTimeOfDay(minutes, { kind: 'departure', window: ctx?.departureWindow }),
    display: (f) => formatMinutes(toMinutes(f.departLocal)),
  },
  {
    key: 'arrivalTime',
    label: 'Arrival time',
    hint: 'How close arrival is to the window you want to land in.',
    value: (f) => toMinutes(f.arriveLocal),
    scorer: (_values, ctx) => (minutes) =>
      scoreTimeOfDay(minutes, { kind: 'arrival', window: ctx?.arrivalWindow }),
    display: (f) => `${formatMinutes(toMinutes(f.arriveLocal))}${f.arrivesNextDay ? ' +1' : ''}`,
  },
  {
    key: 'layovers',
    label: 'Layovers',
    hint: 'Number of stops. Scored on a fixed curve - a connection costs the same whoever else is flying.',
    value: (f) => f.stops,
    // Absolute, not relative: the jump from nonstop to one stop is the big one.
    scorer: () => curveScorer([[0, 1], [1, 0.55], [2, 0.22], [3, 0.05], [4, 0]]),
    display: (f) =>
      f.stops === 0
        ? 'Nonstop'
        : `${f.stops} stop${f.stops > 1 ? 's' : ''}${f.layoverAirports?.length ? ` (${f.layoverAirports.join(', ')})` : ''}`,
  },
  {
    key: 'miles',
    label: 'Miles & points',
    hint: 'Redeemable miles plus the cash value of any elite-qualifying credit.',
    value: (f) => (f.milesEarned ?? 0) + (f.eliteQualifyingPoints ?? 0) * 2,
    scorer: (values) => relativeScorer(values, { direction: 'higher' }),
    display: (f) =>
      `${Math.round(f.milesEarned ?? 0).toLocaleString('en-US')} mi` +
      (f.eliteQualifyingPoints ? ` + ${Math.round(f.eliteQualifyingPoints).toLocaleString('en-US')} EQP` : ''),
  },
  {
    key: 'lounge',
    label: 'Lounge access',
    hint: 'Access included with this fare, at the departure airport and on connections.',
    value: (f) => LOUNGE_TIERS[f.loungeAccess] ?? 0,
    scorer: () => (v) => v,
    display: (f) =>
      ({ none: 'None', paid: 'Paid entry', partner: 'Partner lounge', full: 'Full access' })[
        f.loungeAccess
      ] ?? 'None',
  },
  {
    key: 'duration',
    label: 'Total trip time',
    hint: 'Gate to gate, including connections.',
    value: (f) => f.durationMin,
    scorer: (values) => relativeScorer(values, { direction: 'lower' }),
    display: (f) => `${Math.floor(f.durationMin / 60)}h ${String(f.durationMin % 60).padStart(2, '0')}m`,
  },
];

export const FLIGHT_CRITERIA_KEYS = FLIGHT_CRITERIA.map((c) => c.key);

/**
 * @param {object[]} offers
 * @param {Record<string, import('./weights.js').Importance>} importances
 * @param {{departureWindow?:object, arrivalWindow?:object}} [ctx]
 */
export function rankFlights(offers, importances, ctx = {}) {
  return rank({ candidates: offers, criteria: FLIGHT_CRITERIA, importances, ctx });
}

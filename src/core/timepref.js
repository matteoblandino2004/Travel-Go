/**
 * Scoring times of day.
 *
 * "Departure time: importance 5" only says how much the user cares, not what
 * they want. So each time criterion takes an optional preferred window
 * ({start, end} in local HH:MM) or a named preset. With no window given we fall
 * back to a generic curve: most people would rather not leave at 4am, and
 * would rather not land at 1am.
 */

import { clamp01 } from './normalize.js';

/** Minutes past local midnight for "HH:MM" (or a number already in minutes). */
export function toMinutes(time) {
  if (typeof time === 'number') return ((time % 1440) + 1440) % 1440;
  if (typeof time !== 'string') return NaN;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return NaN;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(mins) ? ((mins % 1440) + 1440) % 1440 : NaN;
}

export function formatMinutes(mins) {
  if (!Number.isFinite(mins)) return '--:--';
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Named windows, so the UI can offer "morning" instead of a time picker. */
export const WINDOW_PRESETS = {
  redeye: { start: '22:00', end: '05:00', label: 'Red-eye (22:00-05:00)' },
  early: { start: '05:00', end: '08:00', label: 'Early (05:00-08:00)' },
  morning: { start: '08:00', end: '12:00', label: 'Morning (08:00-12:00)' },
  midday: { start: '11:00', end: '15:00', label: 'Midday (11:00-15:00)' },
  afternoon: { start: '12:00', end: '17:00', label: 'Afternoon (12:00-17:00)' },
  evening: { start: '17:00', end: '22:00', label: 'Evening (17:00-22:00)' },
};

export function resolveWindow(window) {
  if (!window) return null;
  if (typeof window === 'string') return WINDOW_PRESETS[window] ?? null;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return window;
}

/** Shortest distance in minutes between two times on a 24h clock. */
export function circularDistance(a, b) {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

/**
 * How far (in minutes) a time sits outside a window. 0 when inside.
 * Windows may wrap past midnight (22:00-05:00).
 */
export function minutesOutsideWindow(minutes, start, end) {
  const inside =
    start <= end
      ? minutes >= start && minutes <= end
      : minutes >= start || minutes <= end;
  if (inside) return 0;
  return Math.min(circularDistance(minutes, start), circularDistance(minutes, end));
}

/**
 * Default desirability of a departure/arrival hour when the user gave no
 * window. Deliberately gentle - it should break ties, not overrule the field.
 */
const DEFAULT_DEPARTURE_CURVE = [
  [0, 0.15], [4, 0.15], [6, 0.55], [8, 0.95], [11, 1.0],
  [15, 0.9], [18, 0.7], [21, 0.4], [23, 0.2], [24, 0.15],
];
const DEFAULT_ARRIVAL_CURVE = [
  [0, 0.1], [5, 0.25], [8, 0.7], [11, 0.95], [15, 1.0],
  [18, 0.9], [21, 0.55], [23, 0.2], [24, 0.1],
];

function interpolateHourCurve(points, minutes) {
  const hour = minutes / 60;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (hour <= x1) return y0 + ((y1 - y0) * (hour - x0)) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

/**
 * Score a time of day in 0..1.
 *
 * Inside the requested window scores 1.0. Outside, the score decays on a
 * half-life of `toleranceMin` (default 90 minutes) - so 90 minutes off target
 * scores 0.5, three hours off scores 0.25. Nobody's preference is a cliff edge.
 *
 * @param {string|number} time "HH:MM" local
 * @param {object} [opts]
 * @param {object|string} [opts.window] preferred window or preset name
 * @param {'departure'|'arrival'} [opts.kind] which default curve to use
 * @param {number} [opts.toleranceMin] half-life of the decay outside the window
 */
export function scoreTimeOfDay(time, opts = {}) {
  const { kind = 'departure', toleranceMin = 90 } = opts;
  const minutes = toMinutes(time);
  if (!Number.isFinite(minutes)) return 0.5;

  const window = resolveWindow(opts.window);
  if (!window) {
    const curve = kind === 'arrival' ? DEFAULT_ARRIVAL_CURVE : DEFAULT_DEPARTURE_CURVE;
    return clamp01(interpolateHourCurve(curve, minutes));
  }

  const off = minutesOutsideWindow(minutes, toMinutes(window.start), toMinutes(window.end));
  if (off === 0) return 1;
  return clamp01(Math.pow(0.5, off / Math.max(1, toleranceMin)));
}

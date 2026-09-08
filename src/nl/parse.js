/**
 * Turn "I want to go to Tokyo in October, cheap, nonstop, near Senso-ji" into
 * the importance ratings the ranking engine consumes.
 *
 * Claude does the reading when credentials are available; the keyword parser in
 * rules.js takes over otherwise, so the app never hard-depends on the network
 * or on a key being present. Either way the output shape is identical, and the
 * user can override every value with the sliders afterwards - the model sets
 * the starting position, it does not get the final say.
 */

import { TRIP_REQUEST_SCHEMA, neutralImportances } from './schema.js';
import { parseWithRules } from './rules.js';
import { FLIGHT_CRITERIA, FLIGHT_CRITERIA_KEYS } from '../core/flights.js';
import { HOTEL_CRITERIA, HOTEL_CRITERIA_KEYS } from '../core/hotels.js';

const MODEL = 'claude-opus-5';

function criteriaBrief(criteria) {
  return criteria.map((c) => `- ${c.key} (${c.label}): ${c.hint}`).join('\n');
}

const SYSTEM_PROMPT = `You read a traveller's description of a trip and turn it into search parameters and importance ratings for a booking tool.

Flight criteria:
${criteriaBrief(FLIGHT_CRITERIA)}

Hotel criteria:
${criteriaBrief(HOTEL_CRITERIA)}

Rate every criterion 1-5, or "na" to drop it from scoring entirely.

Rules:
- 3 is the neutral default. Use it when the traveller said nothing that bears on a criterion. Do not invent preferences.
- Use "na" only when they said the criterion is irrelevant to them ("I don't care about miles"), not merely when they failed to mention it.
- Reserve 5 for something they made central to the trip, and 1 for something they explicitly downplayed.
- Set departureWindow/arrivalWindow only from a stated time preference. Local time, "HH:MM".
- List every specific place they want to visit or eat at, with how much it matters. A place they are flying in for rates 5; an idle "maybe" rates 2.
- Record anything you inferred rather than read in "assumptions", in the second person ("Assumed you meant...").`;

/**
 * @param {string} text
 * @param {{apiKey?: string, model?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<object>} parsed request, with `source` and `warnings`
 */
export async function parseTripRequest(text, opts = {}) {
  const input = String(text ?? '').trim();
  if (!input) return { ...blank(), warnings: ['Nothing to read.'] };

  const credentialed = Boolean(opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  if (!credentialed) {
    return { ...parseWithRules(input), warnings: ['No ANTHROPIC_API_KEY set - read with the offline keyword parser.'] };
  }

  try {
    const parsed = await parseWithClaude(input, opts);
    return { ...parsed, warnings: [] };
  } catch (error) {
    // A parsing failure must never cost the user their search.
    return {
      ...parseWithRules(input),
      warnings: [`Claude parse failed (${error.message}) - fell back to the offline parser.`],
    };
  }
}

async function parseWithClaude(input, opts) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});

  const response = await client.beta.messages.create(
    {
      model: opts.model ?? MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'low', // a short extraction; the schema does the heavy lifting
        format: { type: 'json_schema', schema: TRIP_REQUEST_SCHEMA },
      },
      // Server-side fallback: if a safety classifier declines, the same request
      // is retried on a fallback model inside this call rather than returning
      // the user an empty search.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [
        { role: 'user', content: `Today is ${new Date().toISOString().slice(0, 10)}.\n\nTrip request:\n${input}` },
      ],
    },
    opts.signal ? { signal: opts.signal } : undefined
  );

  if (response.stop_reason === 'refusal') {
    throw new Error(`declined: ${response.stop_details?.category ?? 'unspecified'}`);
  }

  const json = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!json.trim()) throw new Error('empty response');

  return { ...sanitize(JSON.parse(json)), source: 'claude' };
}

/**
 * Never trust the shape coming back over the wire. Anything unrecognised is
 * replaced with the neutral default rather than allowed into the scorer, where
 * a stray string would quietly become NaN.
 */
export function sanitize(raw) {
  const base = blank();
  const out = {
    ...base,
    origin: str(raw?.origin),
    destination: str(raw?.destination),
    departDate: /^\d{4}-\d{2}-\d{2}$/.test(raw?.departDate ?? '') ? raw.departDate : null,
    nights: Number.isInteger(raw?.nights) && raw.nights > 0 && raw.nights <= 60 ? raw.nights : null,
    cabin: ['economy', 'premium', 'business'].includes(raw?.cabin) ? raw.cabin : null,
    departureWindow: window(raw?.departureWindow),
    arrivalWindow: window(raw?.arrivalWindow),
    places: Array.isArray(raw?.places)
      ? raw.places
          .filter((p) => p && typeof p.name === 'string' && p.name.trim())
          .slice(0, 25)
          .map((p) => ({
            name: p.name.trim().slice(0, 120),
            kind: ['sight', 'food', 'other'].includes(p.kind) ? p.kind : 'other',
            importance: importance(p.importance),
          }))
      : [],
    assumptions: Array.isArray(raw?.assumptions)
      ? raw.assumptions.filter((a) => typeof a === 'string').slice(0, 10)
      : [],
  };

  for (const key of FLIGHT_CRITERIA_KEYS) out.flight[key] = importance(raw?.flight?.[key]);
  for (const key of HOTEL_CRITERIA_KEYS) out.hotel[key] = importance(raw?.hotel?.[key]);
  return out;
}

function blank() {
  const { flight, hotel } = neutralImportances();
  return {
    origin: null, destination: null, departDate: null, nights: null, cabin: null,
    flight, hotel, departureWindow: null, arrivalWindow: null,
    places: [], assumptions: [], source: 'default',
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

function importance(value) {
  if (value === 'na' || value === 'NA' || value === 'N/A') return 'na';
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 3;
}

function window(w) {
  const ok = (t) => typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t.trim());
  return w && ok(w.start) && ok(w.end) ? { start: w.start.trim(), end: w.end.trim() } : null;
}

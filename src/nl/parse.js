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

import { TRIP_REQUEST_SCHEMA } from './schema.js';
import { sanitize } from './sanitize.js';
import { parseWithRules } from './rules.js';
import { FLIGHT_CRITERIA } from '../core/flights.js';
import { HOTEL_CRITERIA } from '../core/hotels.js';

export { sanitize };

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

/** Everything mid-importance - the shape a failed parse falls back to. */
function blank() {
  return { ...sanitize({}), source: 'default' };
}

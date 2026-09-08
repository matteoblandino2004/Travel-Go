/**
 * The shape a trip request gets turned into, shared by the Claude-backed parser
 * and the offline keyword parser so both produce interchangeable output.
 */

import { FLIGHT_CRITERIA_KEYS } from '../core/flights.js';
import { HOTEL_CRITERIA_KEYS } from '../core/hotels.js';

const importance = {
  type: ['integer', 'string'],
  enum: [1, 2, 3, 4, 5, 'na'],
  description: 'How much the traveller cares: 1 = barely, 5 = decisive, "na" = ignore entirely.',
};

const importanceMap = (keys) => ({
  type: 'object',
  properties: Object.fromEntries(keys.map((k) => [k, importance])),
  required: keys,
  additionalProperties: false,
});

export const TRIP_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    origin: { type: ['string', 'null'], description: 'Origin city or airport, as written.' },
    destination: { type: ['string', 'null'], description: 'Destination city or airport.' },
    departDate: { type: ['string', 'null'], description: 'YYYY-MM-DD if stated, else null.' },
    nights: { type: ['integer', 'null'], description: 'Nights in the hotel if stated.' },
    cabin: { type: ['string', 'null'], enum: ['economy', 'premium', 'business', null] },
    flight: importanceMap(FLIGHT_CRITERIA_KEYS),
    hotel: importanceMap(HOTEL_CRITERIA_KEYS),
    departureWindow: {
      type: ['object', 'null'],
      description: 'Preferred local departure window, null if not stated.',
      properties: { start: { type: 'string' }, end: { type: 'string' } },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    arrivalWindow: {
      type: ['object', 'null'],
      description: 'Preferred local arrival window, null if not stated.',
      properties: { start: { type: 'string' }, end: { type: 'string' } },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    places: {
      type: 'array',
      description: 'Specific places named: things to see, eat, or get to.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ['sight', 'food', 'other'] },
          importance,
        },
        required: ['name', 'kind', 'importance'],
        additionalProperties: false,
      },
    },
    assumptions: {
      type: 'array',
      description: 'Anything inferred rather than stated, so the UI can show it.',
      items: { type: 'string' },
    },
  },
  required: [
    'origin', 'destination', 'departDate', 'nights', 'cabin',
    'flight', 'hotel', 'departureWindow', 'arrivalWindow', 'places', 'assumptions',
  ],
  additionalProperties: false,
};

/** Everything mid-importance - the starting point before anyone says anything. */
export function neutralImportances() {
  return {
    flight: Object.fromEntries(FLIGHT_CRITERIA_KEYS.map((k) => [k, 3])),
    hotel: Object.fromEntries(HOTEL_CRITERIA_KEYS.map((k) => [k, 3])),
  };
}

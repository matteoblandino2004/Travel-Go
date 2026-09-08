/**
 * Library entry point.
 *
 * Import from here to use the ranking engine without the server or the UI:
 *
 *   import { planTrip, rankFlights, rankHotels } from 'travel-go';
 */

export { planTrip, resolvePlaces } from './search.js';
export { rankFlights, FLIGHT_CRITERIA, FLIGHT_CRITERIA_KEYS } from './core/flights.js';
export { rankHotels, HOTEL_CRITERIA, HOTEL_CRITERIA_KEYS } from './core/hotels.js';
export { rank, explain, topDrivers } from './core/rank.js';
export { importanceToWeight, normalizeWeights, isIgnored } from './core/weights.js';
export { scoreHotelAccess } from './core/poi.js';
export { estimateTravel, haversineKm, accessScoreForMinutes } from './core/geo.js';
export { scoreTimeOfDay, WINDOW_PRESETS } from './core/timepref.js';
export { searchFlights, searchHotels } from './data/provider.js';
export { CITIES, findCity, findPoi } from './data/cities.js';
export { parseTripRequest } from './nl/parse.js';
export { createServer } from './server/server.js';

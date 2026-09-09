/**
 * How good is getting around, per city?
 *
 * The travel-time model needs one number per destination: 0 is "you will be
 * driving", 1 is "a train comes every three minutes". It used to be a
 * hand-written field on each of six cities, which is not a scheme that
 * extends to everywhere.
 *
 * Three tiers, most specific first: a curated value for metros where the
 * answer is well known, a country default, then a global default. It is a
 * blunt instrument and it is documented as one - but "Tokyo is easier to get
 * around than Houston" is the part that actually moves a hotel ranking, and
 * that part it gets right.
 */

const GLOBAL_DEFAULT = 0.5;

/** By IATA metro/airport code - the resolver's identifier for a destination. */
const BY_CITY = {
  TYO: 0.95, OSA: 0.9, SEL: 0.92, HKG: 0.93, SIN: 0.9, TPE: 0.85, BJS: 0.82,
  SHA: 0.85, KUL: 0.7, BKK: 0.72, JKT: 0.55, MNL: 0.45, DEL: 0.68, BOM: 0.68,
  LON: 0.88, PAR: 0.9, BER: 0.88, MAD: 0.85, BCN: 0.82, MIL: 0.78, ROM: 0.7,
  AMS: 0.85, BRU: 0.78, VIE: 0.88, ZRH: 0.88, MUC: 0.85, FRA: 0.82, HAM: 0.82,
  CPH: 0.82, STO: 0.85, OSL: 0.78, HEL: 0.78, PRG: 0.85, BUD: 0.82, WAW: 0.78,
  LIS: 0.72, ATH: 0.68, IST: 0.72, MOW: 0.9, LED: 0.85, DUB: 0.6, EDI: 0.65,
  GLA: 0.62, MAN: 0.62, IEV: 0.8,
  NYC: 0.85, CHI: 0.72, WAS: 0.72, BOS: 0.68, SFO: 0.6, PHL: 0.6, YTO: 0.7,
  YMQ: 0.7, YVR: 0.65, LAX: 0.4, SEA: 0.55, MIA: 0.4, ATL: 0.45, DFW: 0.3,
  IAH: 0.28, PHX: 0.3, DEN: 0.45, LAS: 0.35, SAN: 0.4, AUS: 0.3, MEX: 0.7,
  SYD: 0.68, MEL: 0.7, BNE: 0.55, PER: 0.5, AKL: 0.45,
  SAO: 0.65, RIO: 0.6, BUE: 0.68, SCL: 0.7, BOG: 0.55, LIM: 0.5,
  DXB: 0.62, AUH: 0.4, DOH: 0.5, TLV: 0.6, CAI: 0.5, JNB: 0.35, CPT: 0.4,
  NBO: 0.35, LOS: 0.3, CAS: 0.45,
};

/**
 * Country fallbacks. Broad, but the between-country spread is real: a
 * mid-sized German city is genuinely easier to cross without a car than a
 * mid-sized American one.
 */
const BY_COUNTRY = {
  JP: 0.8, KR: 0.78, SG: 0.9, HK: 0.9, TW: 0.7, CH: 0.82, AT: 0.78, NL: 0.8,
  DE: 0.75, DK: 0.72, SE: 0.72, NO: 0.68, FI: 0.68, BE: 0.72, FR: 0.72,
  ES: 0.7, IT: 0.62, GB: 0.65, IE: 0.5, PT: 0.62, CZ: 0.75, PL: 0.68,
  HU: 0.72, RU: 0.7, UA: 0.65, GR: 0.55, TR: 0.6, IL: 0.55,
  US: 0.35, CA: 0.5, AU: 0.5, NZ: 0.4, MX: 0.5, BR: 0.5, AR: 0.6, CL: 0.6,
  CN: 0.75, IN: 0.55, TH: 0.5, VN: 0.4, ID: 0.4, MY: 0.5, PH: 0.35,
  AE: 0.5, QA: 0.45, SA: 0.35, EG: 0.45, ZA: 0.35, KE: 0.35, MA: 0.45,
  GE: 0.55, AM: 0.5, RS: 0.55, HR: 0.55, RO: 0.6, BG: 0.6, SK: 0.65, SI: 0.6,
  EE: 0.65, LV: 0.65, LT: 0.6, IS: 0.45, LU: 0.7, MT: 0.5, CY: 0.4,
  PE: 0.5, CO: 0.55, EC: 0.5, UY: 0.55, CR: 0.4, PA: 0.45, GT: 0.35,
  NP: 0.35, LK: 0.4, PK: 0.4, BD: 0.4, KH: 0.35, LA: 0.3, MM: 0.35,
  TZ: 0.35, UG: 0.35, GH: 0.35, ET: 0.35, SN: 0.4, TN: 0.45, JO: 0.4, OM: 0.4,
};

/**
 * @param {{code?:string, cityCode?:string, country?:string}} destination
 * @returns {{value:number, basis:'city'|'country'|'default'}}
 */
export function transitQualityFor(destination = {}) {
  const code = String(destination.cityCode ?? destination.code ?? '').toUpperCase();
  if (BY_CITY[code] !== undefined) return { value: BY_CITY[code], basis: 'city' };

  const country = String(destination.country ?? '').toUpperCase();
  if (BY_COUNTRY[country] !== undefined) return { value: BY_COUNTRY[country], basis: 'country' };

  return { value: GLOBAL_DEFAULT, basis: 'default' };
}

export { GLOBAL_DEFAULT };

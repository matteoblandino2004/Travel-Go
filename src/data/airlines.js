/**
 * IATA carrier codes -> name, alliance, home region.
 *
 * Real feeds return whatever carrier sells the ticket, so this has to cover a
 * lot more than the sample generator does. Alliance membership is the part that
 * matters most to scoring: it's what decides whether the traveller's status
 * actually opens a lounge door on this itinerary.
 *
 * Membership as of 2026. Unlisted carriers resolve to `alliance: null`, which
 * is handled everywhere - an unknown carrier means "no alliance benefits",
 * never a crash.
 */

/** code: [name, region, shortHaulOnly?] */
const STAR = {
  A3: ['Aegean', 'europe'], AC: ['Air Canada', 'namerica'], CA: ['Air China', 'asia'],
  AI: ['Air India', 'asia'], NZ: ['Air New Zealand', 'oceania'], NH: ['ANA', 'asia'],
  OZ: ['Asiana', 'asia'], OS: ['Austrian', 'europe'], AV: ['Avianca', 'samerica'],
  SN: ['Brussels Airlines', 'europe'], CM: ['Copa', 'namerica'], OU: ['Croatia Airlines', 'europe'],
  MS: ['EgyptAir', 'africa'], ET: ['Ethiopian', 'africa'], BR: ['EVA Air', 'asia'],
  LO: ['LOT', 'europe'], LH: ['Lufthansa', 'europe'], SQ: ['Singapore Airlines', 'asia'],
  SA: ['South African', 'africa'], LX: ['SWISS', 'europe'], TP: ['TAP Portugal', 'europe'],
  TG: ['Thai Airways', 'asia'], TK: ['Turkish Airlines', 'europe'], UA: ['United', 'namerica'],
  ZH: ['Shenzhen Airlines', 'asia'],
};

const ONEWORLD = {
  AS: ['Alaska Airlines', 'namerica'], AA: ['American', 'namerica'], BA: ['British Airways', 'europe'],
  CX: ['Cathay Pacific', 'asia'], AY: ['Finnair', 'europe'], IB: ['Iberia', 'europe'],
  JL: ['Japan Airlines', 'asia'], MH: ['Malaysia Airlines', 'asia'], WY: ['Oman Air', 'meast'],
  QF: ['Qantas', 'oceania'], QR: ['Qatar Airways', 'meast'], RJ: ['Royal Jordanian', 'meast'],
  UL: ['SriLankan', 'asia'], FJ: ['Fiji Airways', 'oceania'],
};

const SKYTEAM = {
  AR: ['Aerolineas Argentinas', 'samerica'], AM: ['Aeromexico', 'namerica'], UX: ['Air Europa', 'europe'],
  AF: ['Air France', 'europe'], CI: ['China Airlines', 'asia'], MU: ['China Eastern', 'asia'],
  OK: ['Czech Airlines', 'europe'], DL: ['Delta', 'namerica'], GA: ['Garuda Indonesia', 'asia'],
  AZ: ['ITA Airways', 'europe'], KQ: ['Kenya Airways', 'africa'], KL: ['KLM', 'europe'],
  KE: ['Korean Air', 'asia'], ME: ['Middle East Airlines', 'meast'], SV: ['Saudia', 'meast'],
  RO: ['TAROM', 'europe'], VN: ['Vietnam Airlines', 'asia'], VS: ['Virgin Atlantic', 'europe'],
  MF: ['Xiamen Air', 'asia'],
};

/** Carriers with no alliance. `true` marks short-haul-only operators. */
const UNALIGNED = {
  EK: ['Emirates', 'meast'], EY: ['Etihad', 'meast'], B6: ['JetBlue', 'namerica'],
  WN: ['Southwest', 'namerica', true], F9: ['Frontier', 'namerica', true],
  NK: ['Spirit', 'namerica', true], G4: ['Allegiant', 'namerica', true],
  HA: ['Hawaiian', 'namerica'], AS_: ['', ''], WS: ['WestJet', 'namerica'],
  FR: ['Ryanair', 'europe', true], U2: ['easyJet', 'europe', true],
  W6: ['Wizz Air', 'europe', true], VY: ['Vueling', 'europe', true],
  DY: ['Norwegian', 'europe', true], TO: ['Transavia', 'europe', true],
  LA: ['LATAM', 'samerica'], G3: ['GOL', 'samerica'], AD: ['Azul', 'samerica'],
  PR: ['Philippine Airlines', 'asia'], VA: ['Virgin Australia', 'oceania'],
  JQ: ['Jetstar', 'oceania', true], TR: ['Scoot', 'asia', true],
  AK: ['AirAsia', 'asia', true], '6E': ['IndiGo', 'asia', true],
  SU: ['Aeroflot', 'europe'], PC: ['Pegasus', 'europe', true],
};

function build() {
  const table = {};
  const groups = [[STAR, 'star'], [ONEWORLD, 'oneworld'], [SKYTEAM, 'skyteam'], [UNALIGNED, null]];
  for (const [group, alliance] of groups) {
    for (const [code, [name, region, shortHaulOnly]] of Object.entries(group)) {
      if (!name) continue;
      table[code] = { code, name, alliance, region, shortHaulOnly: Boolean(shortHaulOnly) };
    }
  }
  return table;
}

export const AIRLINES_BY_CODE = build();

/**
 * Look a carrier up by IATA code.
 * Unknown carriers get a usable record rather than null, so a feed returning a
 * regional operator we've never heard of still ranks - it just earns no
 * alliance benefits.
 */
export function airline(code, fallbackName) {
  const key = String(code ?? '').toUpperCase().trim();
  return (
    AIRLINES_BY_CODE[key] ?? {
      code: key || '??',
      name: fallbackName || key || 'Unknown carrier',
      alliance: null,
      region: null,
      shortHaulOnly: false,
      unknown: true,
    }
  );
}

/** Reverse lookup for feeds (like Google Flights) that give a name, not a code. */
const BY_NAME = new Map(
  Object.values(AIRLINES_BY_CODE).map((a) => [a.name.toLowerCase(), a])
);

export function airlineByName(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  if (BY_NAME.has(key)) return BY_NAME.get(key);
  // "American Airlines" -> "American", "Lufthansa German Airlines" -> "Lufthansa"
  for (const [known, record] of BY_NAME) {
    if (key.startsWith(known) || known.startsWith(key)) return record;
  }
  return null;
}

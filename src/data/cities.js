/**
 * Reference data: cities, their airports, and a starter set of places people
 * actually go. Users can add their own places (any name + coordinates) - this
 * catalogue only exists so the app is useful the first time you open it.
 *
 * `transitQuality` (0..1) feeds the travel-time model in core/geo.js.
 * `utcOffset` is a fixed hour offset - good enough to compute local arrival
 * times for comparison, and the one thing to replace with a real tz library
 * before anyone books off these numbers.
 */

export const CITIES = {
  TYO: {
    code: 'TYO',
    region: 'asia',
    name: 'Tokyo',
    country: 'Japan',
    center: { lat: 35.6812, lng: 139.7671 },
    transitQuality: 0.95,
    utcOffset: 9, // fixed offset; a real build would use an IANA zone
    currency: 'USD',
    airports: [
      { code: 'HND', name: 'Haneda', lat: 35.5494, lng: 139.7798, minutesToCenter: 30 },
      { code: 'NRT', name: 'Narita', lat: 35.772, lng: 140.3929, minutesToCenter: 75 },
    ],
    pois: [
      { name: 'Senso-ji Temple', kind: 'sight', lat: 35.7148, lng: 139.7967 },
      { name: 'Shibuya Crossing', kind: 'sight', lat: 35.6595, lng: 139.7005 },
      { name: 'teamLab Planets', kind: 'sight', lat: 35.6497, lng: 139.7906 },
      { name: 'Meiji Shrine', kind: 'sight', lat: 35.6764, lng: 139.6993 },
      { name: 'Ueno Park', kind: 'sight', lat: 35.7148, lng: 139.7737 },
      { name: 'Akihabara', kind: 'sight', lat: 35.6984, lng: 139.7731 },
      { name: 'Tsukiji Outer Market', kind: 'food', lat: 35.6654, lng: 139.7707 },
      { name: 'Toyosu Market sushi', kind: 'food', lat: 35.645, lng: 139.7867 },
      { name: 'Shinjuku Golden Gai', kind: 'food', lat: 35.6938, lng: 139.7036 },
      { name: 'Ichiran Shibuya', kind: 'food', lat: 35.6614, lng: 139.7007 },
    ],
  },
  LON: {
    code: 'LON',
    region: 'europe',
    name: 'London',
    country: 'United Kingdom',
    center: { lat: 51.5074, lng: -0.1278 },
    transitQuality: 0.88,
    utcOffset: 1, // fixed offset; a real build would use an IANA zone
    currency: 'USD',
    airports: [
      { code: 'LHR', name: 'Heathrow', lat: 51.47, lng: -0.4543, minutesToCenter: 50 },
      { code: 'LGW', name: 'Gatwick', lat: 51.1537, lng: -0.1821, minutesToCenter: 60 },
    ],
    pois: [
      { name: 'British Museum', kind: 'sight', lat: 51.5194, lng: -0.127 },
      { name: 'Tower of London', kind: 'sight', lat: 51.5081, lng: -0.0759 },
      { name: 'Westminster Abbey', kind: 'sight', lat: 51.4993, lng: -0.1273 },
      { name: 'Covent Garden', kind: 'sight', lat: 51.5117, lng: -0.124 },
      { name: 'Camden Market', kind: 'sight', lat: 51.5414, lng: -0.146 },
      { name: 'Hyde Park', kind: 'sight', lat: 51.5073, lng: -0.1657 },
      { name: 'Borough Market', kind: 'food', lat: 51.5055, lng: -0.091 },
      { name: 'Dishoom Shoreditch', kind: 'food', lat: 51.5245, lng: -0.0776 },
      { name: 'Brick Lane curry houses', kind: 'food', lat: 51.5216, lng: -0.0718 },
    ],
  },
  PAR: {
    code: 'PAR',
    region: 'europe',
    name: 'Paris',
    country: 'France',
    center: { lat: 48.8566, lng: 2.3522 },
    transitQuality: 0.9,
    utcOffset: 2, // fixed offset; a real build would use an IANA zone
    currency: 'USD',
    airports: [
      { code: 'CDG', name: 'Charles de Gaulle', lat: 49.0097, lng: 2.5479, minutesToCenter: 50 },
      { code: 'ORY', name: 'Orly', lat: 48.7233, lng: 2.3794, minutesToCenter: 40 },
    ],
    pois: [
      { name: 'Louvre', kind: 'sight', lat: 48.8606, lng: 2.3376 },
      { name: 'Eiffel Tower', kind: 'sight', lat: 48.8584, lng: 2.2945 },
      { name: "Musée d'Orsay", kind: 'sight', lat: 48.86, lng: 2.3266 },
      { name: 'Sacré-Cœur, Montmartre', kind: 'sight', lat: 48.8867, lng: 2.3431 },
      { name: 'Le Marais', kind: 'sight', lat: 48.857, lng: 2.36 },
      { name: 'Luxembourg Gardens', kind: 'sight', lat: 48.8462, lng: 2.3372 },
      { name: 'Septime', kind: 'food', lat: 48.8535, lng: 2.38 },
      { name: 'Rue Montorgueil', kind: 'food', lat: 48.8656, lng: 2.3475 },
    ],
  },
  NYC: {
    code: 'NYC',
    region: 'namerica',
    name: 'New York',
    country: 'United States',
    center: { lat: 40.758, lng: -73.9855 },
    transitQuality: 0.85,
    utcOffset: -4, // fixed offset; a real build would use an IANA zone
    currency: 'USD',
    airports: [
      { code: 'JFK', name: 'John F. Kennedy', lat: 40.6413, lng: -73.7781, minutesToCenter: 55 },
      { code: 'LGA', name: 'LaGuardia', lat: 40.7769, lng: -73.874, minutesToCenter: 35 },
      { code: 'EWR', name: 'Newark', lat: 40.6895, lng: -74.1745, minutesToCenter: 50 },
    ],
    pois: [
      { name: 'Metropolitan Museum of Art', kind: 'sight', lat: 40.7794, lng: -73.9632 },
      { name: 'Central Park', kind: 'sight', lat: 40.7829, lng: -73.9654 },
      { name: 'MoMA', kind: 'sight', lat: 40.7614, lng: -73.9776 },
      { name: 'Brooklyn Bridge', kind: 'sight', lat: 40.7061, lng: -73.9969 },
      { name: 'Statue of Liberty ferry', kind: 'sight', lat: 40.7033, lng: -74.017 },
      { name: "Katz's Delicatessen", kind: 'food', lat: 40.7223, lng: -73.9874 },
      { name: 'Chelsea Market', kind: 'food', lat: 40.7424, lng: -74.0061 },
    ],
  },
  BCN: {
    code: 'BCN',
    region: 'europe',
    name: 'Barcelona',
    country: 'Spain',
    center: { lat: 41.3874, lng: 2.1686 },
    transitQuality: 0.82,
    utcOffset: 2, // fixed offset; a real build would use an IANA zone
    currency: 'USD',
    airports: [
      { code: 'BCN', name: 'El Prat', lat: 41.2974, lng: 2.0833, minutesToCenter: 35 },
    ],
    pois: [
      { name: 'Sagrada Família', kind: 'sight', lat: 41.4036, lng: 2.1744 },
      { name: 'Park Güell', kind: 'sight', lat: 41.4145, lng: 2.1527 },
      { name: 'Gothic Quarter', kind: 'sight', lat: 41.3833, lng: 2.1777 },
      { name: 'Casa Batlló', kind: 'sight', lat: 41.3916, lng: 2.1649 },
      { name: 'Barceloneta Beach', kind: 'sight', lat: 41.3785, lng: 2.1925 },
      { name: 'La Boqueria', kind: 'food', lat: 41.3817, lng: 2.1717 },
      { name: 'El Xampanyet', kind: 'food', lat: 41.3846, lng: 2.1817 },
    ],
  },
  SFO: {
    code: 'SFO',
    region: 'namerica',
    name: 'San Francisco',
    country: 'United States',
    center: { lat: 37.7749, lng: -122.4194 },
    transitQuality: 0.6,
    utcOffset: -7, // fixed offset; a real build would use an IANA zone
    currency: 'USD',
    airports: [
      { code: 'SFO', name: 'San Francisco Intl', lat: 37.6213, lng: -122.379, minutesToCenter: 35 },
      { code: 'OAK', name: 'Oakland', lat: 37.7213, lng: -122.2207, minutesToCenter: 40 },
    ],
    pois: [
      { name: 'Golden Gate Bridge', kind: 'sight', lat: 37.8199, lng: -122.4783 },
      { name: 'Ferry Building', kind: 'food', lat: 37.7955, lng: -122.3937 },
      { name: 'Mission District taquerias', kind: 'food', lat: 37.7599, lng: -122.4148 },
      { name: 'SFMOMA', kind: 'sight', lat: 37.7857, lng: -122.4011 },
    ],
  },
};

/** Neighbourhoods used to place generated hotels somewhere plausible. */
export const NEIGHBOURHOODS = {
  TYO: [
    { name: 'Marunouchi', lat: 35.6812, lng: 139.7671, premium: 1.25 },
    { name: 'Shinjuku', lat: 35.6938, lng: 139.7034, premium: 1.05 },
    { name: 'Shibuya', lat: 35.6595, lng: 139.7005, premium: 1.1 },
    { name: 'Asakusa', lat: 35.7148, lng: 139.7967, premium: 0.75 },
    { name: 'Ginza', lat: 35.6717, lng: 139.765, premium: 1.3 },
    { name: 'Shinagawa', lat: 35.6285, lng: 139.7387, premium: 0.85 },
  ],
  LON: [
    { name: 'Mayfair', lat: 51.5096, lng: -0.1478, premium: 1.45 },
    { name: 'South Bank', lat: 51.5055, lng: -0.1165, premium: 1.05 },
    { name: 'Shoreditch', lat: 51.5265, lng: -0.0784, premium: 0.95 },
    { name: 'Kensington', lat: 51.4988, lng: -0.1749, premium: 1.1 },
    { name: "King's Cross", lat: 51.5308, lng: -0.1238, premium: 0.9 },
    { name: 'Southwark', lat: 51.5015, lng: -0.0921, premium: 0.85 },
  ],
  PAR: [
    { name: '1er - Louvre', lat: 48.8629, lng: 2.3364, premium: 1.35 },
    { name: 'Le Marais', lat: 48.857, lng: 2.36, premium: 1.15 },
    { name: 'Saint-Germain', lat: 48.8539, lng: 2.3336, premium: 1.25 },
    { name: 'Montmartre', lat: 48.8867, lng: 2.3431, premium: 0.85 },
    { name: 'Bastille', lat: 48.8531, lng: 2.3691, premium: 0.9 },
    { name: 'La Défense', lat: 48.8918, lng: 2.2379, premium: 0.7 },
  ],
  NYC: [
    { name: 'Midtown', lat: 40.7549, lng: -73.984, premium: 1.2 },
    { name: 'SoHo', lat: 40.7233, lng: -74.0021, premium: 1.3 },
    { name: 'Upper East Side', lat: 40.7736, lng: -73.9566, premium: 1.1 },
    { name: 'Financial District', lat: 40.7075, lng: -74.0113, premium: 0.9 },
    { name: 'Williamsburg', lat: 40.7141, lng: -73.9614, premium: 0.85 },
    { name: 'Chelsea', lat: 40.7465, lng: -74.0014, premium: 1.15 },
  ],
  BCN: [
    { name: 'Eixample', lat: 41.3915, lng: 2.1649, premium: 1.15 },
    { name: 'Gothic Quarter', lat: 41.3833, lng: 2.1777, premium: 1.05 },
    { name: 'Gràcia', lat: 41.4036, lng: 2.1561, premium: 0.85 },
    { name: 'Barceloneta', lat: 41.3785, lng: 2.1925, premium: 1.1 },
    { name: 'Sants', lat: 41.3757, lng: 2.1401, premium: 0.7 },
  ],
  SFO: [
    { name: 'Union Square', lat: 37.7879, lng: -122.4075, premium: 1.1 },
    { name: 'SoMa', lat: 37.7785, lng: -122.4056, premium: 1.0 },
    { name: 'Nob Hill', lat: 37.7929, lng: -122.4161, premium: 1.15 },
    { name: 'Mission', lat: 37.7599, lng: -122.4148, premium: 0.85 },
  ],
};

/** Resolve a user-typed city or airport string to a city record. */
export function findCity(query) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  for (const city of Object.values(CITIES)) {
    if (
      city.code.toLowerCase() === q ||
      city.name.toLowerCase() === q ||
      city.airports.some((a) => a.code.toLowerCase() === q || a.name.toLowerCase() === q)
    ) {
      return city;
    }
  }
  return Object.values(CITIES).find((c) => c.name.toLowerCase().startsWith(q)) ?? null;
}

/** Match a free-text place name against the city's catalogue. */
export function findPoi(city, name) {
  if (!city || !name) return null;
  const q = String(name).trim().toLowerCase();
  return (
    city.pois.find((p) => p.name.toLowerCase() === q) ??
    city.pois.find((p) => p.name.toLowerCase().includes(q)) ??
    city.pois.find((p) => q.includes(p.name.toLowerCase().split(',')[0])) ??
    null
  );
}

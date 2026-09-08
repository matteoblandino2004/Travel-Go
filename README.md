# Travel-Go

A trip search that ranks options against **your** priorities instead of a
default one. You rate each thing 1–5 (or N/A to drop it entirely), and flights
and hotels are scored, ordered, and explained against those weights.

```
npm start           # http://localhost:3000
npm test            # 93 tests, no network needed
```

No dependencies are required to run it. Node 20+. It runs on generated sample
data out of the box; see [Flight data](#flight-data) to connect a real supplier.

---

## What you rate

**Flights** — cost · departure time · arrival time · layovers · miles & points ·
lounge access · total trip time

**Hotels** — cost · hotel status · getting around · guest rating · points earned ·
flexibility

Plus a list of **places you want to be near**. Name the sights and restaurants
you're actually going for, rate each one 1–5, and hotels get scored on how long
it takes to reach them — so "cheap" stops meaning "cheap and forty minutes from
everything you came for".

Every rating is live: move one and the list re-orders instantly.

---

## How the scoring works

Four ideas, and they're worth knowing because they're what make the numbers
mean something.

**1. Importance is superlinear.** A rating of *n* becomes a weight of `n^1.6`,
normalised so all active criteria sum to 1. A "5" therefore pulls about 13× as
hard as a "1" — on a linear scale, three mid-rated criteria gang up and drown
out the one thing you said actually mattered. Only the *ratios* matter: rating
everything 5 ranks identically to rating everything 3.

**2. N/A means gone, not "low".** A criterion marked N/A gets weight 0, and is
excluded from the score, the explanations, and the breakdown table. It cannot
break a tie behind your back.

**3. Scores are relative to what's on screen.** "Cost: 5" means *cheapest of
these options*, not cheapest against some absolute idea of a fair fare. Each
criterion's 0–1 scale is built from the whole candidate set using Tukey fences
(`Q1 − 1.5·IQR`, `Q3 + 1.5·IQR`), so one $8,000 first-class fare can't compress
every real difference between the economy fares into the bottom 3% of the
scale. Criteria with fixed human meaning — layover count, walking minutes — use
absolute curves instead, because a connection costs you the same however good
the alternatives are.

**4. Nothing is a cliff edge.** Ask to depart between 08:00 and 12:00 and
anything in that window scores 1.0; outside it the score halves every 90
minutes rather than dropping to zero at 12:01. With no window given, times fall
back to a generic curve that dislikes 4am departures and 1am arrivals.

### Getting around

For each hotel, every place on your list gets a door-to-door estimate — walk,
transit, or taxi, whichever is quickest — from straight-line distance plus a
25% street-detour factor and the city's transit quality. Time becomes a score
on `exp(-(minutes/35)^1.5)`: five minutes is basically free, half an hour costs
you half, an hour costs nearly all of it.

The per-hotel total is **75% weighted average, 25% worst must-see**. That
second term matters: without it, a hotel sitting on top of four cafés you rated
2 outranks one that's a sensible ride from the museum you rated 5. Places you
can't be located are reported back to you rather than quietly dropped from the
maths.

---

## Describing the trip in plain English

Type something like:

> SFO to Tokyo in October for 5 nights, cheapest possible but nonstop, morning
> departure, I want a lounge, and I don't care about miles.

and it fills in the search, the ratings, the time window, and the places.

With `ANTHROPIC_API_KEY` set, Claude reads it (structured output against a fixed
schema, with server-side fallback enabled so a classifier decline doesn't cost
you the search). Without a key, a keyword parser handles it offline. Both return
the same shape, both are conservative — anything you didn't say stays at the
neutral 3 — and either way the sliders are yours to override afterwards. The
model sets the starting position; it doesn't get the final say.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm install          # pulls @anthropic-ai/sdk (optional dependency)
npm start
```

---

## Layout

```
src/core/      the scoring engine — no I/O, no dependencies, no idea where offers come from
  weights.js     importance 1–5 / N/A → normalised weights
  normalize.js   raw values → 0..1, outlier-resistant
  timepref.js    time-of-day windows and decay
  geo.js         distance and door-to-door travel estimates
  poi.js         hotel ⇄ your places
  rank.js        the generic weighted ranker + explanations
  flights.js     the seven flight criteria
  hotels.js      the six hotel criteria
src/data/      where offers come from
  providers/     flight suppliers: sample, google-flights (SerpApi), amadeus
  enrich.js      derives miles, elite credit and lounge access - no feed has them
  airlines.js    IATA codes -> alliance membership
  cities.js      cities, airports, neighbourhoods, places
  hotel-inventory.js
src/nl/        plain-English intake (Claude + offline fallback)
src/server/    zero-dependency HTTP API and static host
public/        the front end
test/          93 tests, including recorded supplier responses
```

The browser imports the **same** modules from `src/core` that the API uses, so
a slider move re-ranks locally with no round trip and no chance of the client
and server disagreeing about what a "4" means.

---

## Using it as a library

```js
import { planTrip } from './src/index.js';

const trip = await planTrip({
  from: 'SFO', to: 'Tokyo', date: '2026-10-12', nights: 5,
  flight: { cost: 5, departureTime: 4, arrivalTime: 3, layovers: 5,
            miles: 'na', lounge: 2, duration: 3 },
  hotel:  { cost: 4, status: 2, access: 5, guestRating: 3,
            points: 'na', cancellation: 1 },
  places: [
    { name: 'Senso-ji Temple', importance: 5 },
    { name: 'Tsukiji Outer Market', importance: 4 },
    { name: "a friend's flat", lat: 35.71, lng: 139.80, importance: 3 },
  ],
  departureWindow: { start: '08:00', end: '12:00' },
});

trip.flights.results[0].why;      // "Wins on cost, layovers; gives up arrival time."
trip.flights.results[0].breakdown // per-criterion weight, score, and points contributed
trip.hotels.results[0].access.legs // "Senso-ji Temple — 9 min by transit"
```

### HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/reference` | cities, criteria metadata, window presets |
| `POST /api/search` | candidates only — the browser ranks them itself |
| `POST /api/plan` | candidates **and** ranking, for non-browser clients |
| `POST /api/parse` | plain English → structured preferences |

`GET /api/reference` also reports which flight suppliers are configured and
which one is active.

---
## Flight data

### Google Flights has no API

Worth stating plainly, because it shapes every option below: **Google does not
offer a flights API.** QPX Express was retired in April 2018 and nothing public
replaced it. There is no key to sign up for and no partner tier for individual
developers. Anything advertising itself as a "Google Flights API" is a
third-party service scraping the page.

So there are two honest routes, and Travel-Go ships an adapter for each.

| | `google-flights` (SerpApi) | `amadeus` |
|---|---|---|
| **Data** | Exactly what Google Flights shows | Licensed GDS inventory |
| **Cost** | Paid, from ~$50/mo | Free self-service tier |
| **Coverage** | Everything Google aggregates, low-cost carriers included | GDS content; some low-cost carriers absent |
| **Bookable** | No — display only | Yes — offers can be priced and booked |
| **Standing** | Scrapes Google, against Google's ToS. Fine for a personal tool; a real risk to build a business on | Licensed, with terms and an SLA |

Set whichever you have and restart — the app detects it and the header switches
from **Sample data** to **Live**:

```bash
SERPAPI_API_KEY=...                                  # Google Flights
AMADEUS_CLIENT_ID=... AMADEUS_CLIENT_SECRET=...      # or Amadeus
TRAVELGO_FLIGHT_PROVIDER=amadeus                     # if both are set
```

See `.env.example`. With no key at all you get generated sample data:
realistic, deterministic, and clearly labelled as not bookable.

With a live supplier the app is no longer limited to the six catalogued cities
for flights — any airport or metro code works (`LAX`, `SIN`, `GRU`). City names
resolve to metro codes, so "Tokyo" searches Haneda *and* Narita, which is what
makes the result set match what you'd see on Google Flights.

### What no supplier gives you

Every feed returns roughly the same facts — price, times, stops, duration,
carrier, cabin. **None of them return miles earned, elite credit, or lounge
access**, because all three depend on who is flying, not on the fare. Three of
the seven things you can rank a flight on simply aren't in the data.

`src/data/enrich.js` derives them from the itinerary plus your loyalty profile:
revenue-based earning for the programmes that work that way (the US majors),
distance-based for the rest, both with elite bonuses; lounge access from cabin,
then alliance status, then any paid membership. Every derived value is tagged
and rendered with a dotted underline and an `est.` marker, so an estimate never
looks like a quoted number.

### Adding another supplier

`src/data/providers/` is the only place that knows where offers come from. An
adapter exports `id`, `label`, `credentials`, `isConfigured(env)` and
`searchFlights(query, opts)`, and routes its output through `toOffer()` in
`providers/normalize.js`. Register it in `providers/index.js` and everything
above — ranking, API, UI — is unchanged.

Two guards worth knowing about. `keepUsable()` throws a specific error when a
supplier returns offers but none are parseable, so a changed response shape
shows up as *"44 offers, none usable (missing: priceUsd)"* rather than an empty
page. And a live supplier that errors or times out falls back to sample data
with a visible note, so an outage degrades the page instead of breaking it.

Results are cached for 10 minutes per query, so dragging a rating slider
re-ranks locally instead of re-billing a paid API. The loyalty-derived fields
are recomputed after the cache, so changing your status updates immediately.

Adapters are covered by fixture tests (`test/fixtures/`) that need no keys and
no network — including one asserting that the same two itineraries parse to
identical numbers through both suppliers.

> **Both adapters are written against published documentation and tested
> against recorded responses; neither has been run against a live account.**
> Expect to correct a field name or two on first contact with a real key — the
> mapping tables sit at the top of each adapter for exactly that reason.

### Still generated

Hotels (`src/data/hotel-inventory.js`) are sample data behind the same kind of
seam. Two other things to replace before this is real: `estimateTravel` in
`src/core/geo.js` (swap the distance model for a directions API; everything
downstream only reads `{minutes, mode}`), and the fixed `utcOffset` per city in
`src/data/cities.js`, which should be a proper IANA time zone.

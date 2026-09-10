# Travel-Go

A trip search that ranks options against **your** priorities instead of a
default one. You rate each thing 1–5 (or N/A to drop it entirely), and flights
and hotels are scored, ordered, and explained against those weights.

## Running it

Needs **Node 20 or newer** and nothing else — there are no dependencies to
install.

```bash
git clone https://github.com/matteoblandino2004/Travel-Go.git
cd Travel-Go
git checkout claude/travel-booking-preference-ranking-vpm0x1

npm start                     # then open http://localhost:3000
```

That's it. It works immediately on generated sample data, for every city with
an airport — 7,916 of them, in 236 countries.

```bash
npm run doctor      # check what's configured and make one real call to each supplier
npm test            # 177 tests, no keys or network needed
npm run dev         # same as start, but restarts on file changes
PORT=8080 npm start # if 3000 is taken
```

For real fares with **no account and no key**: run your search on Google
Flights or Kayak, copy the result rows, and paste them into the box above the
flight results — see [Pasting flights in](#pasting-flights-in).

For a supplier that fetches them automatically, copy `.env.example` to `.env`
and fill in whatever keys you have — `npm start` loads it automatically. See
[Flight data](#flight-data) for what's available and what each option costs;
`npm run doctor` will tell you whether it worked.

---

## What you rate

**Flights** — cost · departure time · arrival time · layovers · miles & points ·
lounge access · total trip time

**Hotels** — cost · hotel status · getting around · guest rating · points earned ·
flexibility

Plus a list of **places you want to be near**. Name the sights and restaurants
you're actually going for — anywhere in the world, they get geocoded — rate
each one 1–5, and hotels get scored on how long it takes to reach them. So
"cheap" stops meaning "cheap and forty minutes from everything you came for".

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
  airports.json  7,916 airports: codes, names, coordinates, timezones
  airports.js    resolves "Tbilisi", "Haneda" or "KTM" to somewhere real
  providers/     flight sources: sample, google-flights (SerpApi), amadeus,
                 paste (parses flights copied off a search page)
  hotels/        hotel suppliers: sample (anywhere), amadeus
  geocode/       place names -> coordinates, for any city
  enrich.js      derives miles, elite credit and lounge access - no feed has them
  airlines.js    IATA codes -> alliance membership
  transit.js     how easy a city is to cross, per city
  cities.js      curated places for the cities we hand-checked
src/nl/        plain-English intake (Claude + offline fallback)
src/server/    zero-dependency HTTP API and static host
public/        the front end
scripts/       doctor (verify your setup), build-airports (refresh the dataset)
test/          177 tests, including recorded supplier responses
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
| `GET /api/places?q=` | autocomplete over all 7,916 airports and metros |
| `POST /api/geocode` | locate one named place near a destination |
| `POST /api/import/flights` | parse flights copied from a search page |

`GET /api/reference` also reports which suppliers and geocoder are configured,
which are active, and how many airports are covered.

---
## Flight data

### Three ways to get real fares in

| | Effort | Cost | Coverage |
|---|---|---|---|
| **Paste them in** | Copy the results you're looking at, each search | Free | Whatever site you copied from |
| **SerpApi** | Set one key, then automatic | ~$50/mo | Everything Google Flights shows |
| **Amadeus** | Set two keys, then automatic | Free tier | Licensed GDS content |

Pasting is the one that needs nothing — see [Pasting flights in](#pasting-flights-in).

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

### Pasting flights in

The route that needs no account, no key and no monthly bill: run the search
yourself on Google Flights, Kayak, Skyscanner or an airline's own site, select
the result rows — **including the prices** — copy, and paste into the box above
the flight results. They get ranked against your weights like anything else,
and your loyalty status still fills in miles and lounge access.

It reads what's on your clipboard rather than any one site's markup, so it
isn't tied to a layout that will change next month. It looks for the *shapes*
of the facts — a time range, a duration, an airport pair, a stop count, a
price — wherever they appear in a record:

```
10:15 AM – 2:30 PM+1        ->  ANA (NH), SFO-HND, 10:15-14:30 next day,
ANA                             11h15m nonstop, $1,247, 1,043 kg CO2
11 hr 15 min
SFO–HND
Nonstop
1,043 kg CO2e
$1,247
```

Handled: 12- and 24-hour clocks, `+1` day arrivals, layover airports
(`1 stop LHR`, `2 hr 5 min ORD`, `via AMS`), CO2 figures, and currency symbols
before or after the number. Sites differ on ordering — Google Flights puts the
price last, Kayak puts it first and the airline before the times — so the
record boundary is anchored on the price and the layout is worked out from the
paste itself rather than hard-coded per site.

Two things it will tell you rather than guess at. A row it can't read is named
back to you with what was missing, because a silently dropped flight is one
you think is in the ranking. And a paste mixing two currencies gets a warning,
since no conversion is applied — one consistent currency ranks fine whatever
it is, two do not.

A **CSV or JSON list** works too, with loosely-matched column names
(`price`/`fare`/`cost`, `carrier`/`airline`, `departure time`/`depart`), which
is the easier path if your data is already in a spreadsheet.

Pasting fares you are personally looking at into your own local tool is
ordinary personal use. Redistributing them is not, and neither is automating
the copying at volume — that's what the supplier APIs are for.

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

### Covering every city

Going from six cities to all of them meant solving four separate data problems.
Each has its own seam, and each degrades honestly when the layer below is
missing.

**1. Which city do you mean?** `src/data/airports.json` holds every airport
with an IATA code — 7,916 across 236 countries, with coordinates and IANA
timezones, built by `scripts/build-airports.mjs` from
[mwgg/Airports](https://github.com/mwgg/Airports) (MIT) and committed so there
is no build step and no network call.

Resolution is more than a lookup. A city name resolves to its **metropolitan
code** where one exists, so "Tokyo" searches Haneda *and* Narita and "New York"
covers Newark — the thing that makes results match a city search on Google
Flights. Airports serving one city collapse into one choice, while three
genuinely different Jacksonvilles stay three. Where the answer is
uncertain the app picks the likeliest and offers the rest as one-click
corrections, rather than refusing to search until you are more specific:

```
London  →  London (LON) — all airports (LCY, LGW, LHR, LTN, SEN, STN)
           Did you mean London (YXU) — Ontario · London (LOZ) — Kentucky
```

Two details that took a second pass. Ranking uses airport *names* as a
significance proxy, because the dataset has no passenger figures — "Jacksonville
International" is what people mean, "Jacksonville Municipal" and "RAF Northolt"
are not; without it, typing "tok" offered Tok, Alaska ahead of Tokyo. And a
short alias table covers the names people actually use (Haneda, Orly, Saigon,
Sheremetyevo), since the source calls HND "Tokyo International Airport".

**2. Where is the city centre?** Needed to place hotels and to bias place
lookups. Curated coordinates for catalogued cities, otherwise the geocoder,
otherwise the centroid of the airports serving it — which is 15 km out for
Tokyo, so that last case is flagged `approximate` and the UI says
so plainly rather than quietly ranking hotels around an airport.

**3. Where is the place I named?** `src/data/geocode/` resolves "Torre de
Belém" or "Chronicle of Georgia" against [Nominatim](https://nominatim.org/)
— free, keyless, and the default so the app works for everyone without a
signup. Its usage policy caps you at one request a second, which the seam
enforces with a serialised queue; results are cached for 30 days because
museums do not move. Set `NOMINATIM_URL` to self-host, or
`TRAVELGO_GEOCODER=none` to switch it off. Nearby matches beat globally famous
ones — searching "Victoria" while planning Hong Kong means the harbour.

**4. Hotels, and how hard is it to get around?** `src/data/hotels/` mirrors the
flight seam: Amadeus Hotel Search (same free credentials, global) or generated
inventory placed on rings around whatever centre it is given, priced against a
per-country cost index so Zurich does not cost what Hanoi costs.

Getting around needs one number the travel-time model can use.
`src/data/transit.js` supplies it — a curated value for metros where the answer
is well known, then a country default, then 0.5 — and the UI states which of
the three it used rather than presenting a guess as fact. But the city is only
half of it: someone walking everywhere and someone with a hire car experience
the same hotel completely differently, and no data about the city can tell you
which one is reading the page. So **how you'll get around is a control**, not
an assumption. Uncheck taxis and a hotel across town stops looking convenient.

### Still generated

Hotels default to generated inventory, and the flight sample market is
invented — both work for any city, neither is bookable. Timezone handling is
now real (IANA zones with DST), which is what makes local arrival times correct
on any route.

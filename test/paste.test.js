/**
 * The paste importer, against the shapes real search pages actually produce.
 * These are the formats that matter: whatever the sites emit is what the
 * traveller's clipboard contains.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlightText, importFlights } from '../src/data/providers/paste.js';
import { rankFlights } from '../src/core/flights.js';
import { enrichOffers } from '../src/data/enrich.js';

/** Google Flights: itinerary first, price last. */
const GOOGLE = `Best departing flights
10:15 AM – 2:30 PM+1
ANA
11 hr 15 min
SFO–HND
Nonstop
1,043 kg CO2e
+7% emissions
$1,247
round trip
7:20 AM – 3:45 PM+1
United
13 hr 25 min
SFO–NRT
1 stop
2 hr 5 min ORD
1,402 kg CO2e
$986
round trip`;

/** Kayak: price first, airline before the times. */
const KAYAK = `$812
British Airways
07:25 – 19:50
1 stop  LHR
11h 25m
LON–BCN
$643
Vueling
09:00 – 11:15
Nonstop
2h 15m
LON–BCN`;

/** A European site: 24-hour clock, euros, symbol after the number. */
const EUROPEAN = `06:30 – 09:45
Lufthansa
3 hr 15 min
Nonstop
289 €
14:05 – 17:40
Swiss
3 hr 35 min
Nonstop
341 €`;

test('Google Flights: itinerary-then-price parses completely', () => {
  const { offers, skipped, format } = parseFlightText(GOOGLE, { date: '2026-10-12' });
  assert.equal(format, 'text');
  assert.equal(offers.length, 2);
  assert.deepEqual(skipped, []);

  const [ana, united] = offers;
  assert.equal(ana.airline, 'ANA');
  assert.equal(ana.airlineCode, 'NH', 'matched against the carrier table');
  assert.equal(ana.alliance, 'star');
  assert.equal(ana.from, 'SFO');
  assert.equal(ana.to, 'HND');
  assert.equal(ana.departLocal, '10:15');
  assert.equal(ana.arriveLocal, '14:30', '2:30 PM in 24-hour time');
  assert.equal(ana.dayShift, 1);
  assert.equal(ana.durationMin, 675);
  assert.equal(ana.stops, 0);
  assert.equal(ana.priceUsd, 1247);
  assert.equal(ana.carbonKg, 1043);

  assert.equal(united.stops, 1);
  assert.deepEqual(united.layoverAirports, ['ORD']);
  assert.equal(united.priceUsd, 986);
});

test('a header line is not mistaken for a flight', () => {
  const { offers } = parseFlightText(GOOGLE, {});
  assert.ok(offers.every((o) => o.airline !== 'Best departing flights'));
});

test('price-first layouts attach the right price and airline to each flight', () => {
  // Splitting on time ranges alone gave flight one the second flight's fare
  // and flight two the wrong carrier.
  const { offers } = parseFlightText(KAYAK, { date: '2026-11-02' });
  assert.equal(offers.length, 2);

  assert.equal(offers[0].airline, 'British Airways');
  assert.equal(offers[0].priceUsd, 812);
  assert.equal(offers[0].stops, 1);
  assert.deepEqual(offers[0].layoverAirports, ['LHR']);

  assert.equal(offers[1].airline, 'Vueling');
  assert.equal(offers[1].priceUsd, 643);
  assert.equal(offers[1].stops, 0);
});

test('a currency symbol after the number is still a price', () => {
  const { offers } = parseFlightText(EUROPEAN, { from: 'LIS', to: 'ZRH' });
  assert.equal(offers.length, 2);
  assert.equal(offers[0].priceUsd, 289);
  assert.equal(offers[1].priceUsd, 341);
  assert.equal(offers[0].currencySymbol, '€');
  // The route came from the search boxes, since the paste didn't state it.
  assert.equal(offers[0].from, 'LIS');
  assert.equal(offers[0].to, 'ZRH');
});

test('mixed currencies are called out, because the comparison would be wrong', async () => {
  const mixed = `07:00 – 12:00\nDelta\n5 hr\nJFK–LAX\n$300\n09:00 – 14:00\nUnited\n5 hr\nJFK–LAX\n300 €`;
  const result = await importFlights(mixed, {});
  assert.match(result.notes.join(' '), /mix .* no conversion/i);
});

test('one consistent non-dollar currency is fine, and says so', async () => {
  const result = await importFlights(EUROPEAN, { from: 'LIS', to: 'ZRH' });
  assert.match(result.notes.join(' '), /compared as-is/);
});

test('12-hour and 24-hour clocks both work', () => {
  const twelve = parseFlightText('11:30 PM – 6:15 AM+1\nDelta\n6 hr 45 min\nJFK–LHR\nNonstop\n$540', {});
  assert.equal(twelve.offers[0].departLocal, '23:30');
  assert.equal(twelve.offers[0].arriveLocal, '06:15');
  assert.equal(twelve.offers[0].dayShift, 1);

  const noon = parseFlightText('12:05 PM – 12:40 AM+1\nUA\n12 hr 35 min\nSFO–FRA\nNonstop\n$700', {});
  assert.equal(noon.offers[0].departLocal, '12:05', 'noon is 12:05, not 00:05');
  assert.equal(noon.offers[0].arriveLocal, '00:40', 'midnight is 00:40, not 12:40');
});

test('a missing duration is computed from the clock, and flagged', () => {
  const { offers } = parseFlightText('07:00 AM – 11:15 AM\nDelta\nJFK–LAX\nNonstop\n$318', {});
  assert.equal(offers[0].durationMin, 255);
  assert.ok(offers[0].estimatedFields.includes('durationMin'));
});

test('an unknown carrier still imports, with no alliance benefits', () => {
  const { offers } = parseFlightText('08:00 – 10:00\nSome Regional Air\n2 hr\nABC–XYZ\nNonstop\n$120', {});
  assert.equal(offers[0].airline, 'Some Regional Air');
  assert.equal(offers[0].alliance, null);
  assert.equal(offers[0].priceUsd, 120);
});

test('a flight number identifies the carrier when the name is absent', () => {
  const { offers } = parseFlightText('08:00 – 16:00\nNH 7\n8 hr\nSFO–HND\nNonstop\n$900', {});
  assert.equal(offers[0].airlineCode, 'NH');
});

/* ---------------------------------------------------------------- *
 * Structured pastes
 * ---------------------------------------------------------------- */

test('CSV with recognised headers is used directly', () => {
  const csv = `airline,depart,arrive,duration,stops,price,from,to,cabin
ANA,10:15,14:30 +1,11h 15m,0,1247,SFO,HND,economy
Japan Airlines,13:15,17:05 +1,11h 50m,0,4180,SFO,HND,business`;
  const { offers, format } = parseFlightText(csv, {});
  assert.equal(format, 'csv');
  assert.equal(offers.length, 2);
  assert.equal(offers[0].priceUsd, 1247, 'a bare number in a price column is money');
  assert.equal(offers[0].dayShift, 1);
  assert.equal(offers[1].cabin, 'business');
  assert.equal(offers[1].airlineCode, 'JL');
});

test('column names are matched loosely', () => {
  const csv = `Carrier,Departure Time,Arrival Time,Fare,Origin,Destination,Connections
Delta,11:30 AM,3:20 PM,$742,JFK,CDG,1`;
  const { offers } = parseFlightText(csv, {});
  assert.equal(offers[0].airline, 'Delta');
  assert.equal(offers[0].priceUsd, 742);
  assert.equal(offers[0].stops, 1);
});

test('JSON is accepted as-is', () => {
  const json = JSON.stringify([
    { airline: 'Delta', depart: '11:30 AM', arrive: '3:20 PM', stops: 1, price: '$742', from: 'JFK', to: 'CDG', miles: 4200 },
  ]);
  const { offers, format } = parseFlightText(json, {});
  assert.equal(format, 'json');
  assert.equal(offers[0].milesEarned, 4200, 'a supplied figure is not overwritten');
});

test('a table of unrelated columns is not mistaken for flights', () => {
  const csv = 'name,email,company\nJane,jane@example.com,Acme';
  assert.equal(parseFlightText(csv, {}).offers.length, 0);
});

/* ---------------------------------------------------------------- *
 * Failure is reported, never silent
 * ---------------------------------------------------------------- */

test('unreadable input raises a message that says what to do', async () => {
  await assert.rejects(() => importFlights('hello there', {}), /Select the result rows/);
  await assert.rejects(() => importFlights('', {}), /Select the result rows/);
});

test('a row that cannot be read is reported, not dropped quietly', async () => {
  const partial = `10:15 AM – 2:30 PM\nANA\n11 hr 15 min\nSFO–HND\nNonstop\n$1,247
7:20 AM – 3:45 PM\nUnited\n13 hr 25 min\nSFO–NRT\n1 stop`;
  const result = await importFlights(partial, {});
  assert.equal(result.offers.length, 1);
  assert.match(result.notes.join(' '), /couldn't be read/);
  assert.ok(result.skipped[0].missing.includes('price'));
});

/* ---------------------------------------------------------------- *
 * End to end
 * ---------------------------------------------------------------- */

test('pasted flights rank against your weights like any others', async () => {
  const result = await importFlights(GOOGLE, { date: '2026-10-12' });
  const offers = enrichOffers(result.offers, { alliances: { star: 'gold' } });

  // Status the traveller holds applies to real fares just as it does to sample ones.
  assert.ok(offers.every((o) => o.loungeAccess === 'full'), 'Star gold opens lounges on ANA and United');
  assert.ok(offers.every((o) => o.milesEarned > 0));

  const onPrice = rankFlights(offers, { cost: 5, departureTime: 'na', arrivalTime: 'na', layovers: 'na', miles: 'na', lounge: 'na', duration: 'na' });
  assert.equal(onPrice.results[0].candidate.priceUsd, 986);

  const onStops = rankFlights(offers, { cost: 'na', departureTime: 'na', arrivalTime: 'na', layovers: 5, miles: 'na', lounge: 'na', duration: 'na' });
  assert.equal(onStops.results[0].candidate.stops, 0);

  for (const result of [...onPrice.results, ...onStops.results]) {
    for (const row of result.breakdown) {
      assert.ok(!String(row.display).includes('undefined'), `${row.key} rendered "${row.display}"`);
    }
  }
});

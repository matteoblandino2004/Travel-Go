/**
 * Front end.
 *
 * Note the imports: this page runs the *same* scoring modules as the API. The
 * server hands over candidates once per search; every slider move after that
 * re-ranks locally, instantly, with no chance of the client and server
 * disagreeing about what a "4" means.
 */

import { rankFlights, FLIGHT_CRITERIA } from '/src/core/flights.js';
import { rankHotels, HOTEL_CRITERIA } from '/src/core/hotels.js';
import { explain } from '/src/core/rank.js';
import { findPoi } from '/src/data/cities.js';

const $ = (id) => document.getElementById(id);

/** One colour per criterion, reused by the bar and the breakdown swatches. */
const PALETTE = ['#1f6feb', '#e0a13a', '#1a7f5a', '#8b5cf6', '#d9576c', '#2fa8b8', '#a3763b'];

const state = {
  reference: null,
  search: null, // { destination, offers, hotels, places }
  flight: {},
  hotel: {},
  places: [], // { name, kind, importance, lat, lng }
  departureWindow: null,
  arrivalWindow: null,
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

init().catch((err) => showSearchError(err.message));

async function init() {
  state.reference = await getJson('/api/reference');

  for (const c of FLIGHT_CRITERIA) state.flight[c.key] = 3;
  for (const c of HOTEL_CRITERIA) state.hotel[c.key] = 3;
  // Sensible opening position: most people are ranking on price and stops.
  state.flight.cost = 4;
  state.flight.layovers = 4;
  state.hotel.cost = 4;
  state.hotel.access = 4;

  renderCriteria($('flight-criteria'), FLIGHT_CRITERIA, state.flight, rerender);
  renderCriteria($('hotel-criteria'), HOTEL_CRITERIA, state.hotel, rerender);

  $('city-list').innerHTML = state.reference.cities
    .map((c) => `<option value="${esc(c.name)}"></option>`)
    .join('');

  $('f-date').value = defaultDate();
  wireEvents();
  await runSearch();
}

function defaultDate() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

function wireEvents() {
  $('btn-search').addEventListener('click', () => runSearch());
  $('btn-read').addEventListener('click', () => readIntake());
  $('btn-add-place').addEventListener('click', () => addPlaceFromInput());
  $('place-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPlaceFromInput(); }
  });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', String(active));
      }
      $('panel-flights').hidden = tab.dataset.panel !== 'flights';
      $('panel-hotels').hidden = tab.dataset.panel !== 'hotels';
    });
  }

  for (const id of ['dep-start', 'dep-end', 'dep-enabled', 'arr-start', 'arr-end', 'arr-enabled']) {
    $(id).addEventListener('change', () => { readWindows(); rerender(); });
  }
}

function readWindows() {
  state.departureWindow = $('dep-enabled').checked
    ? { start: $('dep-start').value, end: $('dep-end').value }
    : null;
  state.arrivalWindow = $('arr-enabled').checked
    ? { start: $('arr-start').value, end: $('arr-end').value }
    : null;
}

/* ------------------------------------------------------------------ *
 * Importance controls
 * ------------------------------------------------------------------ */

function renderCriteria(container, criteria, model, onChange) {
  container.innerHTML = '';
  for (const criterion of criteria) {
    const row = document.createElement('div');
    row.className = 'criterion';
    row.innerHTML = `
      <div class="criterion-head">
        <span class="criterion-name">${esc(criterion.label)}</span>
        <span class="criterion-weight" data-weight="${criterion.key}"></span>
      </div>
      <p class="criterion-hint">${esc(criterion.hint ?? '')}</p>
      <div class="rating" role="group" aria-label="${esc(criterion.label)} importance"></div>`;

    const rating = row.querySelector('.rating');
    for (const value of [1, 2, 3, 4, 5, 'na']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = value === 'na' ? 'N/A' : String(value);
      if (value === 'na') button.className = 'na';
      button.setAttribute('aria-pressed', String(model[criterion.key] === value));
      button.addEventListener('click', () => {
        model[criterion.key] = value;
        for (const sibling of rating.children) sibling.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        onChange();
      });
      rating.append(button);
    }
    container.append(row);
  }
}

/** Show each criterion's share of the total weight, so "5" has a visible meaning. */
function paintWeights(container, weights) {
  for (const el of container.querySelectorAll('[data-weight]')) {
    const w = weights[el.dataset.weight] ?? 0;
    el.textContent = w > 0 ? `${Math.round(w * 100)}% of score` : 'ignored';
  }
}

/* ------------------------------------------------------------------ *
 * Places
 * ------------------------------------------------------------------ */

function addPlaceFromInput() {
  const input = $('place-input');
  const name = input.value.trim();
  if (!name) return;
  addPlace({ name, importance: 4 });
  input.value = '';
  input.focus();
}

function addPlace(place) {
  const city = currentCity();
  const match = city ? findPoi(city, place.name) : null;
  const located = place.lat != null && place.lng != null;

  state.places.push({
    name: match ? match.name : place.name,
    kind: place.kind ?? match?.kind ?? 'other',
    importance: place.importance ?? 4,
    lat: located ? place.lat : match?.lat,
    lng: located ? place.lng : match?.lng,
    unlocated: !located && !match,
  });
  renderPlaces();
  rerender();
}

function renderPlaces() {
  const list = $('place-list');
  list.innerHTML = '';
  for (const [index, place] of state.places.entries()) {
    const li = document.createElement('li');
    li.className = 'place-item';
    li.innerHTML = `
      <span class="place-name" title="${esc(place.name)}">${esc(place.name)}
        <span class="place-kind">${place.unlocated ? '· not found' : `· ${esc(place.kind)}`}</span>
      </span>`;

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Importance of ${place.name}`);
    for (const value of [1, 2, 3, 4, 5, 'na']) {
      const option = new Option(value === 'na' ? 'N/A' : String(value), String(value));
      option.selected = String(place.importance) === String(value);
      select.append(option);
    }
    select.addEventListener('change', () => {
      place.importance = select.value === 'na' ? 'na' : Number(select.value);
      rerender();
    });

    const remove = document.createElement('button');
    remove.className = 'place-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${place.name}`);
    remove.addEventListener('click', () => {
      state.places.splice(index, 1);
      renderPlaces();
      rerender();
    });

    li.append(select, remove);
    list.append(li);
  }

  const missing = state.places.filter((p) => p.unlocated).map((p) => p.name);
  const warning = $('place-warning');
  warning.hidden = missing.length === 0;
  warning.textContent = missing.length
    ? `Couldn't place ${missing.join(', ')} on the map, so ${missing.length > 1 ? 'they are' : 'it is'} not affecting the ranking.`
    : '';
}

function currentCity() {
  const code = state.search?.destination?.code;
  if (!code) return null;
  const city = state.reference.cities.find((c) => c.code === code);
  return city ? { pois: city.pois } : null;
}

/* ------------------------------------------------------------------ *
 * Search + ranking
 * ------------------------------------------------------------------ */

async function runSearch() {
  const button = $('btn-search');
  button.disabled = true;
  showSearchError(null);
  try {
    state.search = await postJson('/api/search', {
      from: $('f-from').value,
      to: $('f-to').value,
      date: $('f-date').value,
      nights: Number($('f-nights').value) || 3,
      cabin: $('f-cabin').value,
      places: state.places,
    });

    $('poi-list').innerHTML = (state.search.destination.pois ?? [])
      .map((p) => `<option value="${esc(p.name)}"></option>`)
      .join('');

    // Re-locate any place the user added before the destination was known.
    for (const place of state.places) {
      if (place.lat != null) continue;
      const match = findPoi(currentCity(), place.name);
      if (match) Object.assign(place, { lat: match.lat, lng: match.lng, kind: match.kind, unlocated: false });
    }
    renderPlaces();
    rerender();
  } catch (error) {
    showSearchError(error.message);
  } finally {
    button.disabled = false;
  }
}

function rerender() {
  if (!state.search) return;
  readWindows();

  const flights = rankFlights(state.search.offers, state.flight, {
    departureWindow: state.departureWindow,
    arrivalWindow: state.arrivalWindow,
  });
  paintWeights($('flight-criteria'), flights.weights);
  renderResults($('flight-results'), flights, flightView);
  $('flights-count').textContent = summary(flights, state.search.offers.length);
  $('flights-heading').textContent = `Flights to ${state.search.destination.name}`;

  const hotels = rankHotels(state.search.hotels, state.hotel, {
    pois: state.places.filter((p) => p.lat != null),
    transitQuality: state.search.destination.transitQuality,
  });
  paintWeights($('hotel-criteria'), hotels.weights);
  renderResults($('hotel-results'), hotels, hotelView);
  $('hotels-count').textContent = summary(hotels, state.search.hotels.length);
  $('hotels-heading').textContent = `Hotels in ${state.search.destination.name}`;
}

function summary(ranked, total) {
  if (ranked.everythingIgnored) return 'Everything is marked N/A — nothing to rank on.';
  const counted = Object.values(ranked.weights).filter((w) => w > 0).length;
  return `${total} options · ranked on ${counted} criteri${counted === 1 ? 'on' : 'a'}`;
}

/* ------------------------------------------------------------------ *
 * Result rendering
 * ------------------------------------------------------------------ */

function flightView(result) {
  const f = result.candidate;
  return {
    title: `${f.airline} · ${f.from} → ${f.to}`,
    subtitle: `${f.departLocal} – ${f.arriveLocal}${f.arrivesNextDay ? ' (+1 day)' : ''} · ${hours(f.durationMin)}`,
    facts: [
      ['Fare', `$${f.priceUsd.toLocaleString('en-US')}`],
      ['Stops', f.stops === 0 ? 'Nonstop' : `${f.stops} via ${f.layoverAirports.join(', ')}`],
      ['Miles', f.milesEarned.toLocaleString('en-US')],
      ['Lounge', { none: 'None', paid: 'Paid', partner: 'Partner', full: 'Included' }[f.loungeAccess]],
      ['On time', `${f.onTimePct}%`],
    ],
  };
}

function hotelView(result) {
  const h = result.candidate;
  return {
    title: h.name,
    subtitle: `${h.stars}★ · ${h.neighbourhood} · ${h.guestRating}/10 from ${h.reviewCount.toLocaleString('en-US')} reviews`,
    facts: [
      ['Rate', `$${h.nightlyUsd.toLocaleString('en-US')}/night`],
      ['Total', `$${h.totalUsd.toLocaleString('en-US')} for ${h.nights}`],
      ['Status', h.eliteRecognition === 'none' ? 'No tier' : cap(h.eliteRecognition)],
      ['Points', h.pointsEarned.toLocaleString('en-US')],
      ['Cancel', { free: 'Free', partial: 'Partial', nonrefundable: 'None' }[h.cancellation]],
    ],
    legs: result.access?.legs ?? [],
  };
}

function renderResults(list, ranked, view) {
  list.innerHTML = '';
  if (ranked.everythingIgnored) {
    list.innerHTML = '<li class="empty">Rate at least one thing above 0 and the ranking appears here.</li>';
    return;
  }

  const colours = new Map(ranked.results[0]?.breakdown.map((b, i) => [b.key, PALETTE[i % PALETTE.length]]) ?? []);

  for (const result of ranked.results) {
    const v = view(result);
    const li = document.createElement('li');
    li.className = `result${result.rank === 1 ? ' is-top' : ''}`;

    const segments = result.breakdown
      .filter((b) => b.contribution > 0)
      .map((b) => `<span style="width:${(b.contribution / Math.max(0.0001, result.score / 100)) * 100}%;background:${colours.get(b.key)}" title="${esc(b.label)}: ${Math.round((b.contribution / (result.score / 100)) * 100)}% of this score"></span>`)
      .join('');

    li.innerHTML = `
      <div class="result-top">
        <span class="rank">${result.rank}</span>
        <div class="result-main">
          <p class="result-title">${esc(v.title)}</p>
          <p class="result-sub">${esc(v.subtitle)}</p>
        </div>
        <div class="score">
          <div class="score-value">${result.score.toFixed(1)}</div>
          <span class="score-label">match</span>
        </div>
      </div>
      <div class="bar-track"><div class="bar" style="width:${Math.max(2, result.score)}%">${segments}</div></div>
      <div class="facts">${v.facts.map(([k, val]) => `${esc(k)} <b>${esc(String(val))}</b>`).join('')}</div>
      <div class="chips">
        ${result.pros.map((p) => `<span class="chip pro">↑ ${esc(p.label)} · ${esc(p.display)}</span>`).join('')}
        ${result.cons.map((c) => `<span class="chip con">↓ ${esc(c.label)} · ${esc(c.display)}</span>`).join('')}
      </div>
      <details>
        <summary>${esc(explain(result))}</summary>
        ${breakdownTable(result, colours)}
        ${v.legs?.length ? legsList(v.legs) : ''}
      </details>`;
    list.append(li);
  }
}

function breakdownTable(result, colours) {
  const rows = result.breakdown
    .map((b) => {
      const ignored = b.weight === 0;
      return `<tr class="${ignored ? 'ignored' : ''}">
        <td><span class="swatch" style="background:${ignored ? 'transparent' : colours.get(b.key)}"></span>${esc(b.label)}</td>
        <td>${esc(b.display)}</td>
        <td class="num">${ignored ? 'N/A' : b.importance}</td>
        <td class="num">${ignored ? '—' : `${Math.round(b.weight * 100)}%`}</td>
        <td class="num">${ignored ? '—' : Math.round(b.score * 100)}</td>
        <td class="num">${ignored ? '—' : (b.contribution * 100).toFixed(1)}</td>
      </tr>`;
    })
    .join('');

  return `<table class="breakdown">
    <thead><tr>
      <th>Criterion</th><th>This option</th><th class="num">You rated</th>
      <th class="num">Weight</th><th class="num">Scored</th><th class="num">Points</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function legsList(legs) {
  return `<ul class="legs">${legs
    .map(
      (leg) =>
        `<li><span>${esc(leg.name)}${Number(leg.importance) >= 4 ? ' ★' : ''}</span>
         <span class="${leg.minutes > 45 ? 'far' : ''}">${esc(leg.summary)}</span></li>`
    )
    .join('')}</ul>`;
}

/* ------------------------------------------------------------------ *
 * Plain-English intake
 * ------------------------------------------------------------------ */

async function readIntake() {
  const text = $('intake-text').value.trim();
  if (!text) return;

  const button = $('btn-read');
  button.disabled = true;
  $('intake-status').textContent = 'Reading…';

  try {
    const parsed = await postJson('/api/parse', { text });

    if (parsed.origin) $('f-from').value = parsed.origin;
    if (parsed.destination) $('f-to').value = parsed.destination;
    if (parsed.departDate) $('f-date').value = parsed.departDate;
    if (parsed.nights) $('f-nights').value = parsed.nights;
    if (parsed.cabin) $('f-cabin').value = parsed.cabin;

    Object.assign(state.flight, parsed.flight);
    Object.assign(state.hotel, parsed.hotel);
    renderCriteria($('flight-criteria'), FLIGHT_CRITERIA, state.flight, rerender);
    renderCriteria($('hotel-criteria'), HOTEL_CRITERIA, state.hotel, rerender);

    applyWindow('dep', parsed.departureWindow);
    applyWindow('arr', parsed.arrivalWindow);

    state.places = [];
    for (const place of parsed.places ?? []) addPlace(place);
    renderPlaces();

    $('intake-status').textContent =
      parsed.source === 'claude' ? 'Read by Claude — adjust anything below.' : 'Read offline — adjust anything below.';
    showNotes([...(parsed.assumptions ?? []), ...(parsed.warnings ?? [])]);

    await runSearch();
  } catch (error) {
    $('intake-status').textContent = '';
    showNotes([`Couldn't read that: ${error.message}`]);
  } finally {
    button.disabled = false;
  }
}

function applyWindow(prefix, window) {
  $(`${prefix}-enabled`).checked = Boolean(window);
  if (window) {
    $(`${prefix}-start`).value = window.start;
    $(`${prefix}-end`).value = window.end;
  }
}

function showNotes(notes) {
  const list = $('intake-notes');
  list.innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
  list.hidden = notes.length === 0;
}

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

function showSearchError(message) {
  const el = $('search-error');
  el.hidden = !message;
  el.textContent = message ?? '';
}

const hours = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

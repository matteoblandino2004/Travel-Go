import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, estimateTravel, accessScoreForMinutes } from '../src/core/geo.js';
import { scoreHotelAccess } from '../src/core/poi.js';

const TOKYO_STATION = { lat: 35.6812, lng: 139.7671 };
const SENSOJI = { lat: 35.7148, lng: 139.7967 };
const SHIBUYA = { lat: 35.6595, lng: 139.7005 };

test('haversine matches known distances', () => {
  // Tokyo Station to Senso-ji is about 4.6 km as the crow flies.
  assert.ok(Math.abs(haversineKm(TOKYO_STATION, SENSOJI) - 4.6) < 0.4);
  assert.equal(haversineKm(TOKYO_STATION, TOKYO_STATION), 0);
});

test('short hops are walked, long ones are not', () => {
  const nearby = estimateTravel(TOKYO_STATION, { lat: 35.685, lng: 139.769 }, { transitQuality: 0.95 });
  assert.equal(nearby.mode, 'walk');
  const acrossTown = estimateTravel(TOKYO_STATION, SHIBUYA, { transitQuality: 0.95 });
  assert.notEqual(acrossTown.mode, 'walk');
  assert.ok(acrossTown.minutes > nearby.minutes);
});

test('better transit makes the same journey shorter', () => {
  const good = estimateTravel(TOKYO_STATION, SHIBUYA, { transitQuality: 0.95 });
  const poor = estimateTravel(TOKYO_STATION, SHIBUYA, { transitQuality: 0.2 });
  assert.ok(good.minutes < poor.minutes);
});

test('access score falls off with travel time', () => {
  const scores = [5, 15, 30, 60, 90].map(accessScoreForMinutes);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] < scores[i - 1]);
  assert.ok(scores[0] > 0.9, 'a five-minute walk is basically free');
  assert.ok(scores[3] < 0.2, 'an hour each way is a real cost');
});

test('a hotel nearer the same places scores higher', () => {
  const pois = [{ ...SENSOJI, name: 'Senso-ji', importance: 4 }];
  const near = scoreHotelAccess({ lat: 35.7128, lng: 139.7947 }, pois, { transitQuality: 0.95 });
  const far = scoreHotelAccess(SHIBUYA, pois, { transitQuality: 0.95 });
  assert.ok(near.score > far.score);
});

test('being far from the one must-see outweighs being near several nice-to-haves', () => {
  const pois = [
    { ...SENSOJI, name: 'Senso-ji', importance: 5 },
    { lat: 35.6585, lng: 139.7015, name: 'cafe A', importance: 2 },
    { lat: 35.6605, lng: 139.6995, name: 'cafe B', importance: 2 },
  ];
  // A hotel in Shibuya is on top of both cafes but a long way from Senso-ji.
  const shibuya = scoreHotelAccess({ lat: 35.6595, lng: 139.7005 }, pois, { transitQuality: 0.95 });
  // A hotel in the middle is a moderate ride from everything.
  const central = scoreHotelAccess({ lat: 35.6895, lng: 139.7495 }, pois, { transitQuality: 0.95 });
  assert.ok(
    central.score > shibuya.score,
    `middling-for-everything (${central.score.toFixed(3)}) should beat great-for-the-cheap-stuff (${shibuya.score.toFixed(3)})`
  );
  assert.equal(shibuya.worstMustSee.name, 'Senso-ji');
});

test('places marked n/a are excluded from the access score', () => {
  const withIgnored = scoreHotelAccess(SHIBUYA, [
    { ...SENSOJI, name: 'Senso-ji', importance: 'na' },
    { lat: 35.6598, lng: 139.7008, name: 'next door', importance: 4 },
  ], { transitQuality: 0.95 });
  const withoutIt = scoreHotelAccess(SHIBUYA, [
    { lat: 35.6598, lng: 139.7008, name: 'next door', importance: 4 },
  ], { transitQuality: 0.95 });
  assert.equal(withIgnored.score, withoutIt.score);
  assert.equal(withIgnored.legs.length, 1);
});

test('listing no places is neutral, not a penalty', () => {
  assert.equal(scoreHotelAccess(SHIBUYA, []).score, 0.5);
  assert.equal(scoreHotelAccess(SHIBUYA, undefined).score, 0.5);
});

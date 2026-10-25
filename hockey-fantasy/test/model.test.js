'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { joinStats, pruneCands } = require('../lib/model');

test('stats fallback matches initialed fantasy names by unique surname and club', () => {
  const pool = [{ id: '44', tagId: 'wrong-tag', name: 'Н. Нестеров', club: 'ЦСКА' }];
  const statsSnap = { byTag: {
    'stats-tag': { name: 'Никита Нестеров', team: 'ЦСКА', stats: { SCORERS: { MATCHES_PLAYED: 7, GOALS: 2 } } },
  } };
  const result = joinStats(pool, statsSnap);
  assert.equal(result.fallback, 1);
  assert.equal(result.map.get('44').gp, 7);
});

test('stats fallback refuses ambiguous same-surname matches within one club', () => {
  const pool = [{ id: '44', tagId: 'wrong-tag', name: 'Н. Нестеров', club: 'ЦСКА' }];
  const statsSnap = { byTag: {
    a: { name: 'Никита Нестеров', team: 'ЦСКА', stats: { SCORERS: { MATCHES_PLAYED: 7 } } },
    b: { name: 'Иван Нестеров', team: 'ЦСКА', stats: { SCORERS: { MATCHES_PLAYED: 5 } } },
  } };
  const result = joinStats(pool, statsSnap);
  assert.equal(result.fallback, 0);
  assert.equal(result.map.get('44'), null);
});

test('candidate pruning preserves club-diverse and low-cost alternatives', () => {
  const candidates = Array.from({ length: 100 }, (_, i) => ({
    id: String(i), pos: 3, score: 200 - i, price: 1000, club: 'Топ-клуб',
  }));
  candidates[98] = { id: 'rare-club', pos: 3, score: 1, price: 1000, club: 'Другой клуб' };
  candidates[99] = { id: 'cheap', pos: 3, score: 5, price: 500, club: 'Третий клуб' };
  const pruned = pruneCands(candidates);
  const ids = new Set(pruned.map((p) => p.id));
  assert.ok(ids.has('rare-club'), 'club-limit alternative should survive pruning');
  assert.ok(ids.has('cheap'), 'low-cost alternative should survive pruning');
  assert.ok(pruned.length < candidates.length, 'pruning should remain bounded');
});

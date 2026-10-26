'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { joinStats, pruneCands, analyze, exactOptimise } = require('../lib/model');
const { fixture, NOW } = require('./fixture');

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

test('exact small-pool optimiser chooses best feasible option and respects budget/club cap', () => {
  const squad = [{ id: 'out', pos: 3, club: 'A', price: 10, score: 5, locked: false }];
  const cands = [
    { id: 'best', pos: 3, club: 'B', price: 11, score: 12, canBuy: true },
    { id: 'too-expensive', pos: 3, club: 'C', price: 30, score: 100, canBuy: true },
  ];
  const levels = exactOptimise({ squad, cands, budget: 11, maxSwaps: 1, clubLimit: 1 });
  assert.equal(levels[1].ids[0], 'best');
  assert.equal(levels[1].value, 12);
});

test('single transfer recommendations include bounded uncertainty estimates', () => {
  const result = analyze(fixture(), { now: NOW, maxSwaps: 2, seasonWeeks: 0 });
  assert.ok(result.singles.length > 0);
  for (const swap of result.singles) {
    assert.ok(swap.probabilityBetter >= 0 && swap.probabilityBetter <= 1);
    assert.equal(swap.probabilityMethod, 'normal-approximation-independent-player-uncertainty');
  }
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

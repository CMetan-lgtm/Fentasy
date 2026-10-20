'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../lib/model');
const { validatePlan, transferLimit } = require('../lib/weekly-plan');
const { fixture, NOW } = require('./fixture');
const run = (snap = fixture(), opts = {}) => analyze(snap, { now: NOW, weeklyPlan: true, beamWidth: 30, ...opts });

test('five jointly feasible ordered transfers, consistent totals and no duplicates', () => {
  const a = run(), p = a.weeklyPlan;
  assert.equal(p.valid, true); assert.equal(p.transfers, 5); assert.equal(p.swaps.length, 5);
  assert.ok(p.gain > 0); assert.ok(Math.abs(p.expected - p.baseline - p.gain) < 0.02);
  assert.equal(new Set(p.swaps.map((s) => s.in.id)).size, 5);
  const byId = new Map(a.pool.map((p) => [p.id, p]));
  assert.ok(validatePlan({ squad: a.squad, swaps: p.swaps.map((s) => ({ out: byId.get(s.out.id), in: byId.get(s.in.id) })), budget: a.params.budget, clubLimit: 3, maxSwaps: 5 }).ok);
  for (const s of p.swaps) { assert.ok(s.budgetLeft >= 0); assert.equal(s.executeBefore, '2026-10-21T15:30:00.000Z'); }
});

test('weekly plan ignores global horizon, risk and requested transfer override', () => {
  const p = run().weeklyPlan;
  const other = run(fixture(), { horizon: 4, risk: -1, seasonWeeks: 5, maxSwaps: 1 }).weeklyPlan;
  assert.deepEqual(other, p);
});

test('respects actual remaining transfers including zero', () => {
  for (const remaining of [0, 1, 2]) {
    const snap = fixture(); snap.meta.transfersLeft = remaining;
    const p = run(snap, { maxSwaps: 5 }).weeklyPlan;
    assert.equal(p.maxSwaps, remaining); assert.equal(p.transfers, remaining);
  }
  for (const v of [NaN, Infinity, -4, 'bad', null]) assert.equal(transferLimit(v), 0);
  assert.equal(transferLimit(9), 5); assert.equal(transferLimit(2.8), 2);
});

test('does not force five transfers or mislabel actual transfers', () => {
  const snap = fixture(); for (const p of snap.pool) if (p.id > 18) p.lock = true;
  const a = run(snap);
  assert.equal(a.weeklyPlan.transfers, 1);
  assert.equal(a.options[5].transferLimit, 5); assert.equal(a.options[5].transfers, a.options[5].swaps.length);
  assert.equal(a.options[5].transfers, 1);
});

test('club limit applies to combined plan', () => {
  const snap = fixture();
  for (const p of snap.pool) if (p.id > 17) p.club = 'Общий клуб';
  snap.standings['Общий клуб'] = { games: 10, points: 15 };
  snap.schedule.push({ home: 'Общий клуб', away: 'X', start: Date.parse('2026-10-21T16:00:00Z') });
  assert.equal(run(snap).weeklyPlan.transfers, 3);
});

test('budget and locks exclude infeasible buys', () => {
  const snap = fixture();
  for (const p of snap.pool) if (p.id > 17) p.price = 10000;
  assert.equal(run(snap).weeklyPlan.transfers, 0);
  for (const p of snap.pool) if (p.id > 17) { p.price = 100; p.lock = true; }
  assert.equal(run(snap).weeklyPlan.transfers, 0);
});

test('missing roster and previous-week snapshots block recommendations', () => {
  const snap = fixture(); snap.generatedAt = '2026-10-18T10:00:00Z';
  assert.equal(run(snap).weeklyPlan.valid, false);
  snap.generatedAt = new Date(NOW).toISOString(); snap.roster[0].id = 999;
  assert.equal(run(snap).weeklyPlan.valid, false);
});

test('no remaining matches means no forced transfers', () => {
  const snap = fixture(); snap.schedule = [];
  const p = run(snap).weeklyPlan;
  assert.equal(p.transfers, 0); assert.equal(p.gain, 0);
});

test('validator checks positions, duplicate buys, locks and intermediate budget', () => {
  const a = run(), squad = a.squad;
  const mk = (id, price, pos = 3) => ({ ...squad[8], id, club: `Новый ${id}`, pos, price, locked: false });
  const cheap = { out: squad[8], in: mk(200, 50) }, costly = { out: squad[9], in: mk(201, 150) };
  const check = (swaps) => validatePlan({ squad, swaps, budget: 1700, clubLimit: 3, maxSwaps: 5 });
  assert.equal(check([cheap, costly]).ok, true);
  assert.equal(check([costly, cheap]).ok, false);
  assert.equal(check([cheap, { out: squad[9], in: cheap.in }]).ok, false);
  assert.equal(check([{ out: squad[8], in: mk(200, 50, 1) }]).ok, false);
  assert.equal(check([{ out: squad[8], in: { ...mk(200, 50), locked: true } }]).ok, false);
});

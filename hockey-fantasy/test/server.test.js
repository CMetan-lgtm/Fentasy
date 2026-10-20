'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixture');

test('analysis and recalc APIs expose independent weekly plans; season skips extra search', async () => {
  const snap = fixture(), calls = [];
  let handler;
  const refresh = { DATA_DIR: '/nonexistent-test-history', loadSnapshot: () => snap, refreshSnapshot: async () => snap, saveSnapshot() {}, writeExports() {} };
  const fakeFs = { existsSync: () => false, mkdirSync() {}, writeFileSync() {} };
  const model = { analyze: (s, opts) => {
    calls.push(opts);
    return { squad: [], league: null, weeklyPlan: opts.weeklyPlan ? { maxSwaps: 5 } : undefined };
  } };
  const context = { require: (id) => {
    if (id === 'http') return { createServer: (cb) => { handler = cb; return { listen() {} }; } };
    if (id === 'fs') return fakeFs;
    if (id === 'path') return path;
    if (id === './lib/refresh') return refresh;
    if (id === './lib/model') return model;
    throw new Error(id);
  }, process: { env: {} }, __dirname: path.join(__dirname, '..'), URL, Date, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), context);
  async function request(method, url) {
    return new Promise((resolve, reject) => {
      const res = { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) {
        try { resolve({ status: this.status, body: JSON.parse(body) }); } catch(e) { reject(e); }
      } };
      handler({ method, url }, res);
    });
  }
  const first = await request('GET', '/api/analysis?horizon=4&risk=-1&maxSwaps=1');
  assert.equal(first.status, 200); assert.equal(first.body.week.weeklyPlan.maxSwaps, 5);
  assert.equal(first.body.season.weeklyPlan, undefined);
  assert.equal(calls[0].weeklyPlan, true); assert.equal(calls[1].weeklyPlan, false);
  const second = await request('POST', '/api/recalc?horizon=2');
  assert.equal(second.status, 200); assert.equal(second.body.week.weeklyPlan.maxSwaps, 5);
});

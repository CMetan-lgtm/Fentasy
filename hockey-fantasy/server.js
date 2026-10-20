'use strict';
// Local web app: live refresh from sports.ru on every recalculation, analysis and exports.
const http = require('http');
const fs = require('fs');
const path = require('path');
const R = require('./lib/refresh');
const M = require('./lib/model');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUB = path.join(__dirname, 'public');
const SEASON_END = Date.UTC(2027, 4, 23, 21, 0);      // KHL 2026/27 end per sports.ru (23.05.2027)

let snapshot = R.loadSnapshot();
let queue = Promise.resolve();                         // serialises refreshes
let refreshing = false;
let lastRefresh = snapshot ? { at: snapshot.generatedAt, ok: true, error: null, warnings: snapshot.warnings || [] } : null;
const cache = new Map();

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
function sendFile(res, file, type, name) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  if (name) headers['Content-Disposition'] = `attachment; filename="${name}"`;
  res.writeHead(200, headers);
  res.end(fs.readFileSync(file));
}

function paramsFrom(q) {
  const n = (v, d) => (v === undefined || v === '' || v === null ? d : Number(v));
  return {
    weeklyPlan: true,
    horizon: n(q.horizon, 1),
    risk: n(q.risk, 0),
    maxSwaps: q.maxSwaps === undefined || q.maxSwaps === '' ? null : Number(q.maxSwaps),
    seasonWeeks: n(q.seasonWeeks, 0),
    discount: n(q.discount, 0.9),
    clubLimit: n(q.clubLimit, 3),
  };
}

// season-long view: exact calendar for 4 weeks, then average-rate weeks until the season end
function seasonParams(snap, q) {
  const weekMs = 7 * 24 * 3600 * 1000;
  const weeksToEnd = Math.max(1, Math.ceil((SEASON_END - Date.now()) / weekMs));
  return { ...paramsFrom(q), weeklyPlan: false, horizon: 4, discount: 1, seasonWeeks: Math.max(0, weeksToEnd - 4), maxSwaps: q.maxSwaps === undefined || q.maxSwaps === '' ? null : Number(q.maxSwaps) };
}

function analyzeCached(snap, params, key) {
  const k = key + '|' + JSON.stringify(params) + '|' + snap.generatedAt + '|' + Math.floor(Date.now() / 60000);
  if (cache.has(k)) return cache.get(k);
  const a = M.analyze(snap, params);
  cache.set(k, a);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return a;
}

function saveHistory(snap, a) {
  try {
    const dir = path.join(R.DATA_DIR, 'history');
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      generatedAt: snap.generatedAt,
      team: { cost: snap.meta.cost, balance: snap.meta.balance, value: snap.meta.cost + snap.meta.balance, transfersLeft: snap.meta.transfersLeft, week: snap.meta.week, globalPlace: snap.meta.globalPlace },
      league: a.league ? { leagueId: a.league.leagueId, ourPlace: a.league.ourPlace, ourValue: a.league.ourValue, leaderValue: a.league.leader && a.league.leader.value, top: a.league.top.map((r) => ({ place: r.place, teamId: r.teamId, value: r.value, tourPoints: r.tourPoints })) } : null,
      squad: a.squad.map((p) => ({ id: p.id, price: p.price, seasonPoints: p.seasonPoints, mu1: p.mu1 })),
    };
    fs.writeFileSync(path.join(dir, rec.generatedAt.replace(/[:.]/g, '-') + '.json'), JSON.stringify(rec));
  } catch (e) { /* history is optional */ }
}

function listHistory() {
  const dir = path.join(R.DATA_DIR, 'history');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { generatedAt: r.generatedAt, value: r.team.value, balance: r.team.balance, leaguePlace: r.league && r.league.ourPlace, leaderValue: r.league && r.league.leaderValue, globalPlace: r.team.globalPlace, transfersLeft: r.team.transfersLeft, week: r.team.week };
  });
}

function runRefresh(q) {
  const job = queue.then(async () => {
    refreshing = true;
    const t0 = Date.now();
    const snap = await R.refreshSnapshot({ withFanRosters: q.fan === '1' });
    R.saveSnapshot(snap);
    snapshot = snap;
    cache.clear();
    const week = M.analyze(snap, paramsFrom(q));
    R.writeExports(snap, week);
    saveHistory(snap, week);
    lastRefresh = { at: snap.generatedAt, ok: true, error: null, warnings: snap.warnings, ms: Date.now() - t0 };
    return snap;
  }).finally(() => { refreshing = false; });
  queue = job.catch(() => {});
  return job;
}

async function route(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(u.searchParams.entries());
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(PUB, 'index.html')));
  }
  if (req.method === 'GET' && p === '/api/status') {
    return sendJson(res, 200, { hasData: !!snapshot, snapshotAt: snapshot ? snapshot.generatedAt : null, sources: snapshot ? snapshot.sources : null, lastRefresh, busy: refreshing, team: snapshot ? snapshot.teamId : null });
  }
  if (req.method === 'POST' && p === '/api/refresh') {
    try {
      const snap = await runRefresh(q);
      return sendJson(res, 200, { ok: true, snapshotAt: snap.generatedAt, sources: snap.sources, warnings: snap.warnings });
    } catch (e) {
      lastRefresh = { at: lastRefresh && lastRefresh.at, ok: false, error: e.message };
      return sendJson(res, 502, { ok: false, error: e.message });
    }
  }
  if (req.method === 'POST' && p === '/api/recalc') {
    // every recalculation pulls fresh data from sports.ru first, then runs the model
    try {
      const snap = await runRefresh(q);
      const week = analyzeCached(snap, paramsFrom(q), 'week');
      const season = analyzeCached(snap, seasonParams(snap, q), 'season');
      return sendJson(res, 200, { ok: true, snapshotAt: snap.generatedAt, sources: snap.sources, warnings: snap.warnings, ms: lastRefresh.ms, week, season, history: listHistory() });
    } catch (e) {
      return sendJson(res, 502, { ok: false, error: e.message });
    }
  }
  if (req.method === 'GET' && p === '/api/analysis') {
    if (!snapshot) return sendJson(res, 409, { ok: false, error: 'Нет данных. Нажмите «Обновить с sports.ru».' });
    const week = analyzeCached(snapshot, paramsFrom(q), 'week');
    const season = q.season === '0' ? null : analyzeCached(snapshot, seasonParams(snapshot, q), 'season');
    return sendJson(res, 200, { ok: true, snapshotAt: snapshot.generatedAt, sources: snapshot.sources, warnings: snapshot.warnings, week, season, history: listHistory() });
  }
  if (req.method === 'GET' && p === '/api/history') {
    return sendJson(res, 200, listHistory());
  }
  if (req.method === 'GET' && p.startsWith('/api/export/')) {
    const name = p.replace('/api/export/', '');
    const files = {
      'squad.csv': ['squad_points.csv', 'text/csv; charset=utf-8'],
      'squad.json': ['squad_points.json', 'application/json; charset=utf-8'],
      'pool.csv': ['pool_players.csv', 'text/csv; charset=utf-8'],
      'snapshot.json': ['snapshot.json', 'application/json; charset=utf-8'],
    };
    if (!files[name]) return sendJson(res, 404, { error: 'unknown export' });
    const f = path.join(R.DATA_DIR, files[name][0]);
    if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'Сначала обновите данные.' });
    return sendFile(res, f, files[name][1], files[name][0]);
  }
  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    else res.end();
  });
});
server.listen(PORT, HOST, () => console.log(`Fantasy hockey calculator on http://${HOST}:${PORT}`));

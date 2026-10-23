'use strict';
// Collects a fresh snapshot from sports.ru, stores it in data/ and writes exports.
const fs = require('fs');
const path = require('path');
const S = require('./sportsru');
const M = require('./model');
const { fetchInjuries } = require('./injuries');

const TEAM_ID = String(process.env.TEAM_ID || '587717');
const DATA_DIR = path.join(__dirname, '..', 'data');
const FALLBACK_LEAGUES = { private: '27340', fan: '27304' };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function refreshSnapshot({ withFanRosters = false } = {}) {
  const warnings = [];
  const sources = {};
  const tryIt = async (name, fn) => {
    try { const v = await fn(); sources[name] = 'ok'; return v; } catch (e) { sources[name] = 'error: ' + e.message; warnings.push(`${name}: ${e.message}`); return null; }
  };

  const meta = await tryIt('teamPage', () => S.fetchTeamMeta(TEAM_ID));
  const roster = await tryIt('roster', () => S.fetchTeamRoster(TEAM_ID));
  const pool = await tryIt('pool', () => S.fetchPool());
  if (!meta || !roster || !pool) throw new Error('Не удалось получить состав, пул игроков или параметры команды: ' + warnings.join('; '));

  const privId = ((meta.leagues || []).find((l) => l.kind === 'private') || {}).id || FALLBACK_LEAGUES.private;
  const fanId = ((meta.leagues || []).find((l) => l.kind === 'fan') || {}).id || FALLBACK_LEAGUES.fan;

  const [schedule, standings, stats, privTable, fanTable] = await Promise.all([
    tryIt('schedule', () => S.fetchSchedule()),
    tryIt('standings', () => S.fetchStandings()),
    tryIt('stats', () => S.fetchPlayerStats()),
    tryIt('leaguePrivate', () => S.fetchLeagueTable(privId)),
    tryIt('leagueFan', () => S.fetchLeagueTable(fanId)),
  ]);

  let injuries;
  try {
    injuries = await fetchInjuries({ pool, stats: stats ? { byTag: Object.fromEntries(stats.byTag) } : {}, cacheFile: path.join(DATA_DIR, 'injuries-cache.json'), previousData: (loadSnapshot() || {}).injuries });
    sources.injuries = injuries.error ? 'error: ' + injuries.error : 'ok (новости, не полный реестр)';
    if (injuries.error) warnings.push('Травмы: ' + injuries.error);
  } catch (e) {
    sources.injuries = 'error: ' + e.message;
    warnings.push('Травмы: ' + e.message);
    // A storage/network failure must never erase known injured players.
    injuries = (loadSnapshot() || {}).injuries || null;
    if (injuries) injuries = { ...injuries, error: e.message };
  }

  const privRosters = {};
  if (privTable) {
    await mapLimit(privTable.rows.filter((r) => r.teamId !== TEAM_ID), 6, async (r) => {
      try { privRosters[r.teamId] = await S.fetchTeamRoster(r.teamId); } catch (e) { warnings.push(`roster ${r.teamId}: ${e.message}`); }
    });
    sources.privateRosters = `${Object.keys(privRosters).length}/${privTable.rows.length - 1}`;
  }
  const fanRosters = {};
  if (fanTable && withFanRosters) {
    await mapLimit(fanTable.rows.filter((r) => r.teamId !== TEAM_ID), 6, async (r) => {
      try { fanRosters[r.teamId] = await S.fetchTeamRoster(r.teamId); } catch (_) { /* ignore single failures */ }
    });
    sources.fanRosters = `${Object.keys(fanRosters).length}`;
  }
  privRosters[TEAM_ID] = roster;
  fanRosters[TEAM_ID] = roster;

  const snap = {
    generatedAt: new Date().toISOString(),
    teamId: TEAM_ID,
    sources,
    warnings,
    meta,
    roster,
    pool,
    injuries,
    schedule: schedule || [],
    standings: standings || {},
    stats: stats ? { byTag: Object.fromEntries(stats.byTag), players: stats.players } : { byTag: {}, players: 0 },
    leagues: {
      private: privTable ? { leagueId: privTable.leagueId, rows: privTable.rows, rosters: privRosters } : null,
      fan: fanTable ? { leagueId: fanTable.leagueId, rows: fanTable.rows, rosters: withFanRosters ? fanRosters : {} } : null,
    },
  };
  return snap;
}

function saveSnapshot(snap) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'snapshot.json'), JSON.stringify(snap));
}

function loadSnapshot() {
  const f = path.join(DATA_DIR, 'snapshot.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

const fmtMsk = (ms) => (ms == null ? '' : new Date(ms + 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16));

function writeExports(snap, analysis) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const squadRows = analysis.squad.map((p) => ({ ...p, nextMsk: fmtMsk(p.nextStart), lockTxt: p.locked ? 'да' : 'нет' }));
  const squadCols = [
    { h: 'Позиция', v: 'posShort' }, { h: 'Игрок', v: 'name' }, { h: 'Клуб', v: 'club' },
    { h: 'Цена', v: 'price' }, { h: 'Стартовая цена', v: 'startValue' }, { h: 'Очки сезона (фэнтези)', v: 'seasonPoints' },
    { h: 'Матчей сыграно', v: 'gp' }, { h: 'Очков за матч (оценка)', v: 'fppg' },
    { h: 'Игр клуба на неделе', v: 'weekGames' }, { h: 'Осталось игр на неделе', v: 'weekGamesLeft' },
    { h: 'Ожидаемые очки на неделю', v: 'mu1' }, { h: 'Ожидаемые очки за горизонт', v: 'muH' },
    { h: 'Статус травмы', v: 'injuryStatus' }, { h: 'Источник травмы', v: 'injurySource' }, { h: 'Дата сообщения', v: 'injuryUpdatedAt' },
    { h: 'Причины исключения из покупок', v: (p) => p.exclusionReasons.join(' | ') },
    { h: 'Блокировка сейчас', v: 'lockTxt' }, { h: 'Следующая игра клуба (МСК)', v: 'nextMsk' }, { h: 'ID игрока', v: 'id' },
  ];
  fs.writeFileSync(path.join(DATA_DIR, 'squad_points.csv'), M.toCsv(squadRows, squadCols));
  fs.writeFileSync(path.join(DATA_DIR, 'squad_points.json'), JSON.stringify({
    exportedAt: new Date().toISOString(), snapshotAt: snap.generatedAt,
    team: analysis.team, week: analysis.week,
    squad: analysis.squad.map((p) => ({ id: p.id, name: p.name, pos: p.posShort, club: p.club, price: p.price, startValue: p.startValue, seasonPoints: p.seasonPoints, gp: p.gp, fppgEstimate: p.fppg, weekGames: p.weekGames, weekGamesLeft: p.weekGamesLeft, expectedThisWeek: p.mu1, expectedHorizon: p.muH, locked: p.locked, injuryStatus: p.injuryStatus, injurySource: p.injurySource, injuryUpdatedAt: p.injuryUpdatedAt, rotationRisk: p.rotationRisk, canBuy: p.canBuy, exclusionReasons: p.exclusionReasons, nextStart: p.nextStart ? new Date(p.nextStart).toISOString() : null })),
  }, null, 2));
  const poolCols = [
    { h: 'ID', v: 'id' }, { h: 'Игрок', v: 'name' }, { h: 'Позиция', v: 'posShort' }, { h: 'Клуб', v: 'club' },
    { h: 'Цена', v: 'price' }, { h: 'Стартовая цена', v: 'startValue' }, { h: 'Очки сезона', v: 'seasonPoints' },
    { h: 'Матчей', v: 'gp' }, { h: 'Очков за матч (оценка)', v: 'fppg' }, { h: 'Доля игр клуба', v: 'availability' },
    { h: 'Игр на неделе', v: 'weekGames' }, { h: 'Осталось на неделе', v: 'weekGamesLeft' },
    { h: 'Ожидаемые очки на неделю', v: 'mu1' }, { h: 'Ожидаемые очки за горизонт', v: 'muH' }, { h: 'Разброс (сигма)', v: 'sigmaH' },
    { h: 'В моём составе', v: (p) => (analysis.squad.some((s) => s.id === p.id) ? 'да' : 'нет') },
    { h: 'Статус травмы', v: 'injuryStatus' }, { h: 'Источник травмы', v: 'injurySource' }, { h: 'Дата сообщения', v: 'injuryUpdatedAt' },
    { h: 'Можно покупать', v: (p) => p.canBuy ? 'да' : 'нет' }, { h: 'Причины исключения', v: (p) => p.exclusionReasons.join(' | ') },
    { h: 'Блокировка', v: (p) => (p.locked ? 'да' : 'нет') },
  ];
  fs.writeFileSync(path.join(DATA_DIR, 'pool_players.csv'), M.toCsv(analysis.pool, poolCols));
}

module.exports = { refreshSnapshot, saveSnapshot, loadSnapshot, writeExports, TEAM_ID, DATA_DIR };

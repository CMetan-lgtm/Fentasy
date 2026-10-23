'use strict';
const NOW = Date.parse('2026-10-20T04:33:00Z');
function fixture() {
  const pool = [], byTag = {}, standings = {}, schedule = [];
  for (let id = 1; id <= 23; id++) {
    const amplua = id <= 2 ? 1 : id <= 8 ? 2 : 3;
    const club = `Клуб ${id}`;
    pool.push({ id, tagId: String(id), name: `Игрок ${id}`, club, amplua, price: 100, startValue: 90, delta: id > 17 ? 100 : 10 });
    byTag[String(id)] = { name: `Игрок ${id}`, team: club, stats: { SCORERS: { MATCHES_PLAYED: 10, GOALS: 1, ASSISTS: 2 }, TIME_ON_ICE: { TIME_ON_ICE_PER_GAME: '15:00' }, SAVES: { MATCHES_PLAYED: 10, SAVES: 100, SHOTS_AGAINST: 110 } } };
    standings[club] = { games: 10, points: 15 };
    schedule.push({ home: club, away: `Соперник ${id}`, start: Date.parse('2026-10-21T16:00:00Z') });
    schedule.push({ home: club, away: `Соперник ${id}`, start: Date.parse('2026-10-28T16:00:00Z') });
  }
  return { generatedAt: new Date(NOW).toISOString(), pool, roster: pool.slice(0, 17).map((p) => ({ id: p.id })), stats: { byTag }, standings, schedule,
    injuries: { lastSuccessAt: new Date(NOW).toISOString(), checkedAt: new Date(NOW).toISOString(), byId: {} },
    meta: { teamId: '587717', teamName: 'Тестовая команда', cost: 1700, balance: 50, transfersLeft: 5, clubLimit: 3, week: 7, leagues: [] }, warnings: [] };
}
module.exports = { fixture, NOW };

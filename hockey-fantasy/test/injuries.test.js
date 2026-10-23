'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const I = require('../lib/injuries');
const { analyze } = require('../lib/model');
const { validatePlan } = require('../lib/weekly-plan');
const { fixture, NOW } = require('./fixture');
const url = 'https://www.sports.ru/hockey/1117410687-news.html';
const news = (title, body = title, publishedAt = '2026-10-20T03:00:00Z') => ({ url, title, body, publishedAt });
const pool = [
  { id: 'a', tagId: '11', name: 'Радулов', club: 'Локомотив' },
  { id: 'b', tagId: '12', name: 'Лимож', club: 'Динамо Минск' },
  { id: 'c', tagId: '13', name: 'Калинин', club: 'Динамо Минск' },
];
const run = (snap = fixture(), opts = {}) => analyze(snap, { now: NOW, weeklyPlan: true, beamWidth: 20, mcIters: 20, ...opts });
const setStatus = (snap, id, status = 'injured') => { snap.injuries.byId[String(id)] = { status, publishedAt: new Date(NOW - 3600000).toISOString(), sourceUrl: url, evidence: 'Тестовое сообщение' }; };
const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-injuries-')); t.after(() => fs.rmSync(dir, { force: true, recursive: true })); return path.join(dir, 'cache.json'); };
const html = (article) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: article.title, articleBody: article.body, datePublished: article.publishedAt })}</script>`;
const feed = `<a href="${url}">Локомотив внес Радулова в список травмированных</a>`;

test('public news links only: rejects blogs, comments and foreign hosts', () => {
  const links = I.articleLinks(feed + `<a href="${url}#comments">Комментарии</a><a href="https://evil.test/hockey/1117410687-x.html">Непроверенная новость</a><a href="/hockey/blogs/123.html">Статья блога</a>`);
  assert.equal(links.length, 1); assert.equal(links[0].url, url);
});
test('extracts NewsArticle only, ignores comments and unrelated structured data', () => {
  const a = I.parseArticle(html(news('Радулов травмирован')) + '<p>Калинин травмирован</p>', url);
  assert.equal(a.body, 'Радулов травмирован'); assert.throws(() => I.parseArticle('<h1>Радулов травмирован</h1>', url));
});
test('injury and explicit return events match inflected Russian surnames', () => {
  assert.equal(I.eventsFromArticle(news('Локомотив внес Радулова в список травмированных'), pool)[0].status, 'injured');
  assert.equal(I.eventsFromArticle(news('Динамо Минск вывело Лиможа из списка травмированных'), pool)[0].status, 'available');
});
test('different players in one news item do not share each other status', () => {
  const a = news('Лимож восстановился после травмы', 'Динамо Минск: Алекс Лимож восстановился после травмы. Алекс Лимож выведен из списка травмированных, а вот Сергей Калинин пополнил лазарет.');
  const e = I.eventsFromArticle(a, pool);
  assert.equal(e.find((x) => x.playerId === 'b').status, 'available');
  assert.equal(e.find((x) => x.playerId === 'c').status, 'injured');
});
test('ambiguous namesakes and multi-player clauses are not guessed', () => {
  const ps = pool.concat({ id: 'd', name: 'Радулов', club: 'Другой клуб' });
  assert.equal(I.eventsFromArticle(news('Радулов получил травму'), ps).length, 0);
  assert.equal(I.eventsFromArticle(news('Радулов и Калинин травмированы'), pool).length, 0);
});
test('future return or training is not proof of availability; negated recovery stays blocked', () => {
  assert.equal(I.statusOf('Радулов вернется через неделю'), null);
  assert.equal(I.statusOf('Радулов тренируется с командой'), null);
  assert.equal(I.statusOf('Радулов не восстановился после травмы'), 'injured');
  assert.equal(I.statusOf('Участие Радулова под вопросом'), 'doubtful');
});
test('older reports cannot override a later injury or return; injury never expires silently', () => {
  const injury = { playerId: 'a', status: 'injured', publishedAt: '2026-10-19T12:00:00Z' };
  const ret = { ...injury, status: 'available', publishedAt: '2026-10-20T01:00:00Z' };
  assert.equal(I.mergeEvents({}, [ret, injury]).a.status, 'available');
  assert.equal(I.mergeEvents({ a: injury }, []).a.status, 'injured');
});
test('live collector parses, persists and reuses short cache', async (t) => {
  const cacheFile = temp(t); let calls = 0;
  const fetchHtml = async (u) => { calls++; return u === url ? html(news('Локомотив внес Радулова в список травмированных')) : feed; };
  const first = await I.fetchInjuries({ pool, cacheFile, now: NOW, fetchHtml });
  assert.equal(first.error, null); assert.equal(first.byId.a.status, 'injured');
  assert.equal(first.articles[url].body, undefined);
  const n = calls;
  await I.fetchInjuries({ pool, cacheFile, now: NOW + 1000, fetchHtml }); assert.equal(calls, n);
});
test('network or changed layout preserves last known injuries and blocks recommendations', async (t) => {
  const cacheFile = temp(t);
  const prior = { checkedAt: new Date(NOW - I.TTL).toISOString(), lastSuccessAt: new Date(NOW - I.TTL).toISOString(), byId: { a: { status: 'injured' } } };
  fs.writeFileSync(cacheFile, JSON.stringify(prior));
  const failed = await I.fetchInjuries({ pool, cacheFile, now: NOW, fetchHtml: async () => { throw new Error('offline'); } });
  assert.equal(failed.byId.a.status, 'injured'); assert.equal(failed.lastSuccessAt, prior.lastSuccessAt);
  assert.equal(I.injurySummary(failed, NOW).blocked, true);
  const changed = await I.fetchInjuries({ pool, cacheFile, now: NOW, fetchHtml: async () => '<html>New layout</html>' });
  assert.ok(changed.error); assert.equal(changed.byId.a.status, 'injured');
});
test('snapshot backup preserves injuries if cache file was lost', async (t) => {
  const previousData = { byId: { a: { status: 'injured' } } };
  const data = await I.fetchInjuries({ pool, cacheFile: temp(t), previousData, now: NOW, fetchHtml: async () => { throw new Error('offline'); } });
  assert.equal(data.byId.a.status, 'injured');
});
test('future news dates cannot set current health status', async (t) => {
  const data = await I.fetchInjuries({ pool, cacheFile: temp(t), now: NOW, fetchHtml: async (u) => u === url ? html(news('Радулов травмирован', undefined, '2030-01-01T00:00:00Z')) : feed });
  assert.deepEqual(data.byId, {}); assert.ok(data.error);
});

test('all incoming recommendations exclude injuries, doubtful players and rotation', () => {
  const snap = fixture(); setStatus(snap, 18); setStatus(snap, 19, 'doubtful');
  for (const tab of Object.values(snap.stats.byTag['20'].stats)) if ('MATCHES_PLAYED' in tab) tab.MATCHES_PLAYED = 4;
  const a = run(snap), blocked = new Set([18,19,20]);
  const incoming = a.options.flatMap((x) => x.swaps).concat(a.singles, a.weeklyPlan.swaps).map((s) => s.in.id);
  assert.ok(incoming.length); assert.ok(incoming.every((id) => !blocked.has(id)));
  assert.ok(a.ideal.players.filter((p) => !a.squad.some((q) => q.id === p.id)).every((p) => !blocked.has(p.id)));
  assert.equal(a.pool.find((p) => p.id === 18).mu1, 0);
  assert.equal(a.pool.find((p) => p.id === 18).muH, 0);
  assert.equal(a.pool.find((p) => p.id === 20).rotationRisk, true);
});
test('injured current player can be sold, not bought back by ideal optimiser', () => {
  const snap = fixture(); setStatus(snap, 9);
  const a = run(snap);
  assert.ok(a.weeklyPlan.swaps.some((s) => s.out.id === 9));
  assert.ok(!a.ideal.ids.includes(9));
});
test('explicit return removes injury exclusion but does not bypass rotation', () => {
  const snap = fixture(); setStatus(snap, 18, 'available');
  assert.equal(run(snap).pool.find((p) => p.id === 18).canBuy, true);
  snap.stats.byTag['18'].stats.TIME_ON_ICE.TIME_ON_ICE_PER_GAME = '06:20';
  const p = run(snap).pool.find((p) => p.id === 18);
  assert.equal(p.lowIceTime, true); assert.equal(p.canBuy, false);
});
test('different goalie participation threshold and minimum sample apply', () => {
  const snap = fixture(); const p = snap.pool.find((p) => p.id === 18); p.amplua = 1;
  for (const tab of Object.values(snap.stats.byTag['18'].stats)) if ('MATCHES_PLAYED' in tab) tab.MATCHES_PLAYED = 6;
  snap.stats.byTag['18'].stats.TIME_ON_ICE.TIME_ON_ICE_PER_GAME = '55:00';
  let result = run(snap).pool.find((p) => p.id === 18);
  assert.equal(result.canBuy, true); assert.equal(result.rotationRisk, false);
  p.amplua = 3; assert.equal(run(snap).pool.find((p) => p.id === 18).canBuy, false);
  snap.standings[p.club].games = 4;
  assert.equal(run(snap).pool.find((p) => p.id === 18).rotationRisk, false);
});
test('missing and stale injury feed fails closed across every buying path', () => {
  for (const state of [undefined, { byId: {}, lastSuccessAt: '2020-01-01T00:00:00Z' }, { byId: {}, lastSuccessAt: new Date(NOW).toISOString(), error: 'offline' }]) {
    const snap = fixture(); snap.injuries = state; const a = run(snap);
    assert.equal(a.health.blocked, true); assert.equal(a.weeklyPlan.valid, false);
    assert.equal(a.singles.length, 0); assert.ok(a.options.every((o) => !o.swaps.length));
    if (a.ideal) assert.ok(a.ideal.ids.every((id) => a.squad.some((p) => p.id === id)));
  }
});
test('risk variants in league simulations use same buying filter', () => {
  const snap = fixture(); setStatus(snap, 18); setStatus(snap, 19);
  snap.leagues = { private: { leagueId: 'test', rows: [{ teamId:'587717',value:1750,place:1 },{teamId:'r',value:1750,place:2}], rosters: { r: snap.roster } } };
  const a = run(snap);
  assert.ok(a.league.candidates.flatMap((c) => c.swaps).every((s) => ![18,19].includes(s.in.id)));
});
test('final validator rejects an ineligible buy independently of optimiser', () => {
  const a = run(); const inn = { ...a.pool.find((p) => p.id === 18), canBuy: false };
  const v = validatePlan({ squad:a.squad, swaps:[{out:a.squad[8],in:inn}], budget:1750, clubLimit:3, maxSwaps:5 });
  assert.equal(v.ok, false); assert.ok(v.errors.some((e) => e.includes('Покупка исключена')));
});

test('initials and junior suffix do not hide injuries from discovery', () => {
  const ps = [{id:'r',name:'А. Радулов',club:'Локомотив'}, {id:'l',name:'Ларионов',club:'СКА'}];
  assert.equal(I.mentions('Локомотив внес Радулова в список травмированных', ps[0], ps, {}), true);
  assert.equal(I.eventsFromArticle(news('Ларионов-младший пропустит 2 месяца из-за травмы', 'Форвард СКА Игорь Ларионов-младший пропустит 2 месяца из-за травмы.'), ps)[0].playerId, 'l');
});
test('NHL namesake does not injure a KHL player; club resolves KHL namesakes', () => {
  const ps = [{id:'s',tagId:'s',name:'Свечников',club:'Ак Барс'}, {id:'a',name:'Иванов',club:'ЦСКА'}, {id:'b',name:'Иванов',club:'Амур'}];
  const stats = { byTag: { s: { name:'Евгений Свечников' } } };
  assert.equal(I.eventsFromArticle(news('Андрей Свечников получил травму', 'Форвард Каролины Андрей Свечников получил травму.'), ps, stats).length, 0);
  const e = I.eventsFromArticle(news('ЦСКА внес Иванова в список травмированных'), ps);
  assert.equal(e.length, 1); assert.equal(e[0].playerId, 'a');
});

test('negated injury is not treated as an injury or as a confirmed return', () => {
  assert.equal(I.statusOf('Радулов не получил травму'), null);
  assert.equal(I.statusOf('Радулов не травмирован'), null);
  assert.equal(I.statusOf('Радулов не внесен в список травмированных'), null);
});

'use strict';
// Public editorial HTML only. No private APIs, login or KHL scraping.
const fs = require('node:fs');
const path = require('node:path');
const { http, clean } = require('./sportsru');
const FEEDS = ['https://www.sports.ru/tags/1046555/', 'https://www.sports.ru/hockey/news/'];
const TTL = 15 * 60 * 1000;
const MAX_AGE = 24 * 60 * 60 * 1000;
const normal = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/-младш[а-я]*/g, '').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => normal(s).split(' ').filter(Boolean);
const stamp = (s) => Date.parse(s);
const isFresh = (data, now) => data && Number.isFinite(stamp(data.lastSuccessAt)) && now - stamp(data.lastSuccessAt) <= MAX_AGE && stamp(data.lastSuccessAt) <= now + 60000;

function articleLinks(html) {
  const found = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u;
    try { u = new URL(m[1], 'https://www.sports.ru'); } catch { continue; }
    if (u.hostname !== 'www.sports.ru' || !/^\/hockey\/\d{8,}-[^/]+\.html$/.test(u.pathname) || u.hash) continue;
    const title = clean(m[2]);
    if (title.length > 12) found.set(u.origin + u.pathname, title);
  }
  return [...found].map(([url, title]) => ({ url, title }));
}

function parseArticle(html, url) {
  const nodes = [];
  function walk(x) {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if ([].concat(x['@type'] || []).includes('NewsArticle')) nodes.push(x);
    if (x['@graph']) walk(x['@graph']);
  }
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1])); } catch { /* other structured blocks are not news */ }
  }
  const node = nodes.find((n) => n.articleBody && n.headline && Number.isFinite(stamp(n.datePublished)));
  if (!node) throw new Error('Не найдены текст и дата NewsArticle: ' + url);
  return { url, title: clean(node.headline), body: clean(node.articleBody), publishedAt: node.datePublished };
}

function playerNames(p, stats) {
  const full = stats && stats.byTag && stats.byTag[p.tagId];
  return [...new Set([p.name, full && full.name].filter(Boolean).map(normal))];
}
function surname(p) { return words(p.name).sort((a, b) => b.length - a.length)[0] || ''; }
function fullMention(text, p, stats) {
  const tokens = words(text);
  return playerNames(p, stats).some((name) => {
    const parts = words(name);
    return parts.length > 1 && parts.every((n) => n.length > 2 && tokens.some((w) => w === n || ['а', 'у', 'ом', 'е'].some((end) => w === n + end) || (/[йь]$/.test(n) && ['я','ю','ем'].some((end) => w === n.slice(0, -1) + end))));
  });
}
function clubMention(text, club) {
  const aliases = { 'Металлург Мг': ['металлург'], 'Салават Юлаев': ['салават'], 'Динамо Минск': ['минск'], 'Динамо Москва': ['динамо москва', 'динамо москов', 'московского динамо', 'московское динамо'], 'Шанхай Дрэгонс': ['шанхай'] };
  return [normal(club), ...(aliases[club] || [])].some((n) => normal(text).includes(n));
}
function mentions(text, p, pool, stats, context = null) {
  const t = normal(text);
  // Full names resolve namesakes; a surname alone must be unique in the KHL pool.
  if (fullMention(t, p, stats)) return true;
  const sur = surname(p);
  if (sur.length < 4 || !words(t).some((w) => w === sur || ['а', 'у', 'ом', 'е'].some((end) => w === sur + end))) return false;
  const namesakes = pool.filter((q) => surname(q) === sur);
  if (namesakes.length === 1) return true;
  return !!context && clubMention(context, p.club) && namesakes.filter((q) => clubMention(context, q.club)).length === 1;
}

function statusOf(text) {
  const t = normal(text);
  if (/не (?:восстановился|готов|сыграет)|не сможет (?:сыграть|помочь)|продолжает восстановление|все еще травмирован/.test(t)) return 'injured';
  if (/не получил.{0,15}травм|не травмирован|не (?:внесен|помещен).{0,35}список травмированных/.test(t)) return null;
  if (/(?:вывел|выведен|выведены|вывели).{0,55}из списка травмированных|восстановил(?:ся|ись).{0,35}(?:после|от) травм|вернул(?:ся|ись).{0,25}в (?:состав|строй).{0,25}после травм/.test(t)) return 'available';
  if (/(?:внес|внесен|внесены|поместил|помещен|пополнил|пополнили).{0,65}(?:список травмированных|лазарет)|получил.{0,25}(?:травм|поврежден)|(?:пропустит|выбыл).{0,65}(?:травм|недел|месяц|дней)|(?:травмирован|перелом|сотрясение|перенес операцию)/.test(t)) return 'injured';
  if (/под вопросом|может пропустить.{0,40}травм|не готов.{0,30}матч/.test(t)) return 'doubtful';
  return null;
}

function eventsFromArticle(article, pool, stats = {}) {
  const events = [];
  // Headline/lead only: historical paragraphs, comments and related stories never set status.
  const context = article.title + ' ' + article.body;
  const lead = article.body.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ');
  for (const p of pool) {
    if (!fullMention(context, p, stats) && !clubMention(context, p.club)) continue;
    const candidates = [article.title, ...lead.split(/(?<=[.!?;])\s+|[,—–]\s*(?:а вот|а|но)\s+/i)];
    for (const text of candidates) {
      if (!mentions(text, p, pool, stats, context)) continue;
      // Do not apply a clause about one player to other players in the same clause.
      const mentioned = pool.filter((q) => mentions(text, q, pool, stats, context));
      if (mentioned.length !== 1) continue;
      const status = statusOf(text);
      if (!status) continue;
      events.push({ playerId: String(p.id), name: p.name, club: p.club, status,
        publishedAt: article.publishedAt, sourceUrl: article.url, evidence: text.slice(0, 500) });
      break; // headline has precedence over older/background lead details
    }
  }
  return events;
}

function mergeEvents(previous, events) {
  const out = { ...(previous || {}) };
  for (const e of events) {
    const old = out[e.playerId];
    if (!old || stamp(e.publishedAt) > stamp(old.publishedAt) ||
      (stamp(e.publishedAt) === stamp(old.publishedAt) && e.status !== 'available')) out[e.playerId] = e;
  }
  // Injured records do not expire into "healthy". An explicit newer return is required.
  return out;
}

function loadCache(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.byId && typeof j.byId === 'object' ? j : null; }
  catch { return null; }
}
function saveCache(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

async function fetchInjuries({ pool, stats, cacheFile, now = Date.now(), fetchHtml = http, force = false, previousData = null }) {
  const previous = loadCache(cacheFile) || previousData;
  if (!force && previous && !previous.error && now - stamp(previous.checkedAt) >= 0 && now - stamp(previous.checkedAt) < TTL) return previous;
  const errors = [], links = new Map();
  let feedsOk = 0;
  for (const feed of FEEDS) {
    try {
      const html = await fetchHtml(feed, { timeoutMs: 15000, retries: 0 });
      const list = articleLinks(html);
      if (!list.length) throw new Error('Не найдены ссылки на новости (возможно, изменилась страница)');
      feedsOk++;
      for (const item of list) if (/(?:травм|восстанов|лазарет|выбыл|операци|перелом|сотряс|пропуст|вернул|вывел|вопросом)/i.test(item.title) && pool.some((p) => mentions(item.title, p, [p], stats))) links.set(item.url, item);
    } catch (e) { errors.push(feed + ': ' + e.message); }
  }
  const events = [], articles = { ...((previous && previous.articles) || {}) };
  let parsed = 0;
  // Bounded sequential requests; frequent recalculations reuse the 15-minute cache.
  const started = Date.now();
  const pending = [...links.values()];
  if (pending.length > 40) errors.push('Слишком много новых сообщений: проверка неполная');
  for (const item of pending.slice(0, 40)) {
    if (Date.now() - started > 60000) { errors.push('Проверка новостей превысила 60 секунд; повторите обновление'); break; }
    try {
      const cached = articles[item.url];
      const article = cached && cached.title === item.title ? cached : parseArticle(await fetchHtml(item.url, { timeoutMs: 12000, retries: 0 }), item.url);
      const date = stamp(article.publishedAt);
      if (!Number.isFinite(date) || date > now + 60000) throw new Error('Неверная дата новости');
      const extracted = article.events || eventsFromArticle(article, pool, stats);
      // Keep factual status/evidence, not copies of complete copyrighted articles.
      articles[item.url] = { title: item.title, publishedAt: article.publishedAt, events: extracted };
      parsed++;
      events.push(...extracted);
    } catch (e) { errors.push(item.url + ': ' + e.message); }
  }
  const ok = feedsOk === FEEDS.length && !errors.length;
  const data = {
    provider: 'Sports.ru: новости о травмах и возвращениях', coverage: 'news-not-complete-register',
    checkedAt: new Date(now).toISOString(), lastSuccessAt: ok ? new Date(now).toISOString() : previous && previous.lastSuccessAt || null,
    error: errors.length ? errors.join('; ') : null, feedsOk, articlesParsed: parsed,
    byId: mergeEvents(previous && previous.byId, events),
    articles: Object.fromEntries(Object.entries(articles).sort((a, b) => stamp(b[1].publishedAt) - stamp(a[1].publishedAt)).slice(0, 400)),
  };
  saveCache(cacheFile, data);
  return data;
}

function injurySummary(data, now) {
  const fresh = !!isFresh(data, now);
  return { fresh, checkedAt: data && data.checkedAt || null, lastSuccessAt: data && data.lastSuccessAt || null,
    provider: data && data.provider || 'Sports.ru', error: data && data.error || null,
    warning: 'Список собирается по новостям, а не по полному медицинскому реестру. Отсутствие сообщения не подтверждает здоровье игрока.',
    blocked: !fresh || !!(data && data.error), byId: data && data.byId || {} };
}
module.exports = { FEEDS, TTL, MAX_AGE, normal, articleLinks, parseArticle, mentions, statusOf, eventsFromArticle, mergeEvents, fetchInjuries, injurySummary };

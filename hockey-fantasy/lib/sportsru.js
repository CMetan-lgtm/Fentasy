'use strict';
// Live data fetchers for Sports.ru fantasy hockey (KHL, fantasy tournament 107).
// Every function talks to sports.ru directly; nothing is cached here.

const BASE = 'https://www.sports.ru';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TOURNAMENT_ID = '107';          // fantasy tournament "КХЛ"
const TAG_ID = '4084863';             // sports.ru tag of KHL (used by stats GraphQL)
const SEASON_SLUG = '2026-2027';
const STAT_TABS = ['SCORERS', 'PLUS_MINUS', 'PENALTIES', 'TIME_ON_ICE', 'SAVES', 'GOALTENDERS'];

async function http(url, opts = {}) {
  const { method = 'GET', body, headers = {}, timeoutMs = 45000, retries = 2 } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, 'Accept-Language': 'ru-RU,ru;q=0.9', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const getJson = async (url) => JSON.parse(await http(url, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } }));

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
const clean = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ---- Team roster (fantasy JSON; works without login) ----------------------
async function fetchTeamRoster(teamId) {
  const j = await getJson(`${BASE}/fantasy/hockey/team/json/${teamId}.json`);
  if (!Array.isArray(j.players)) throw new Error(`team ${teamId}: no players in JSON`);
  return j.players.map((p) => ({
    id: String(p.id),
    name: p.name,
    clubId: Number(p.club_id),
    club: p.club,
    amplua: Number(p.amplua),           // 1 = goalie, 2 = defence, 3 = forward
    price: Number(p.price),
    delta: Number(String(p.delta).replace('+', '')),  // season fantasy points = price - start value
    lock: Number(p.lock) === 1,
    img: p.img,
  }));
}

// ---- Player pool with prices (fantasy "create team" JSON, 699 players) ----
async function fetchPool() {
  const j = await getJson(`${BASE}/fantasy/hockey/team/create/${TOURNAMENT_ID}.json`);
  if (!Array.isArray(j.players)) throw new Error('pool: no players');
  return j.players.map((p) => ({
    id: String(p.id),
    tagId: String(p.tag_id),
    name: p.name,
    clubId: Number(p.club_id),
    club: p.club,
    amplua: Number(p.amplua),
    startValue: Number(p.start_value),
    price: Number(p.price),
    points: Number(p.points),          // season fantasy points (equals price - start value)
    delta: Number(String(p.delta).replace('+', '')),
    img: p.img,
  }));
}

// ---- Team page: budget, balance, transfers, week, deadline, places (SSR HTML)
async function fetchTeamMeta(teamId) {
  const html = await http(`${BASE}/fantasy/hockey/team/${teamId}.html`);
  const num = (re) => { const m = html.match(re); return m ? Number(m[1]) : null; };
  const txt = (re) => { const m = html.match(re); return m ? clean(m[1]) : null; };
  const title = txt(/<title>([^<]*)<\/title>/);
  const meta = {
    teamId: String(teamId),
    teamName: title ? title.split(':')[0].trim() : null,
    cost: num(/Стоимость команды<\/th>\s*<td[^>]*>\s*(\d+)/),
    balance: num(/Баланс<\/th>\s*<td[^>]*>\s*(-?\d+)/),
    transfersLeft: num(/Трансферы<\/th>\s*<td[^>]*>\s*(\d+)/),
    clubLimit: num(/Лимит игроков из одного клуба<\/th>\s*<td[^>]*>\s*(\d+)/),
    week: num(/Текущая неделя<\/th>\s*<td[^>]*>\s*неделя\s*(\d+)/),
    deadline: (() => { const m = html.match(/Дедлайн<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/); return m ? clean(m[1].replace(/<!--[\s\S]*?-->/g, '')) : null; })(),
    globalPlace: null, globalOf: null,
    leagues: [],
  };
  const g = html.match(/Место<\/th>\s*<td[^>]*>\s*(\d+)\s*из\s*(\d+)/);
  if (g) { meta.globalPlace = Number(g[1]); meta.globalOf = Number(g[2]); }
  // each league block: label cell, then league link, then "Место" cell "N из M"
  const blocks = [['fan', 'Лига болельщиков'], ['private', 'Лига<\\/th>']];
  for (const [kind, label] of blocks) {
    const re = new RegExp(label + '[\\s\\S]{0,700}?<a[^>]*href="/fantasy/hockey/league/(\\d+)\\.html"[^>]*>([^<]+)<\\/a>[\\s\\S]{0,500}?Место<\\/th>\\s*<td[^>]*>\\s*(\\d+)\\s*из\\s*(\\d+)');
    const m = html.match(re);
    if (m) meta.leagues.push({ kind, id: m[1], name: clean(m[2]), place: Number(m[3]), of: Number(m[4]) });
  }
  if (meta.cost == null || meta.balance == null) throw new Error('team page: could not parse cost/balance (layout changed?)');
  return meta;
}

// ---- League standings (fantasy league page, SSR). ОТ = tour points, ОС = team value (cost + balance)
async function fetchLeagueTable(leagueId, maxPages = 6) {
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${BASE}/fantasy/hockey/league/${leagueId}.html` : `${BASE}/fantasy/hockey/league/${leagueId}.html?p=${page}`;
    const html = await http(url);
    const re = /<tr[^>]*>\s*<td>(\d+)<\/td>\s*<td class="bordR"><\/td>\s*<td class="name-td alLeft"><a class="bold" href="\/fantasy\/hockey\/team\/(\d+)\.html">([\s\S]*?)<\/a><\/td>\s*<td class="name-td alLeft bordR small">([\s\S]*?)<\/td>\s*<td>(-?\d+)<\/td>\s*<td>(-?\d+)<\/td>/g;
    let m, added = 0;
    while ((m = re.exec(html))) {
      const teamId = m[2];
      if (seen.has(teamId)) continue;
      seen.add(teamId);
      rows.push({ place: Number(m[1]), teamId, teamName: clean(m[3]), manager: clean(m[4]), tourPoints: Number(m[5]), value: Number(m[6]) });
      added++;
    }
    if (added === 0) break;
  }
  rows.sort((a, b) => a.place - b.place);
  return { leagueId: String(leagueId), rows };
}

// ---- Player statistics (sports.ru GraphQL, same query the stats widget uses) ----
async function gql(query, variables) {
  const text = await http(`${BASE}/gql/graphql/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: BASE, Referer: `${BASE}/hockey/tournament/khl/stat/players/` },
    body: JSON.stringify({ query, variables }),
  });
  const j = JSON.parse(text);
  if (j.errors) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

async function fetchPlayerStats() {
  const out = new Map(); // sportsTag -> { name, position, team, stats: {TAB: {NAME: value}} }
  for (const tab of STAT_TABS) {
    const query = `query fantasyPlayerStats($tournamentTagId: ID!, $seasonSlug: String!) {
  statQueries { hockey { seasonBySlug(tournamentTagID: $tournamentTagId, slug: $seasonSlug) {
    playerStatRanking(input: { attributeTab: ${tab} attributeSort: POINTS stagePhase: REGULAR_SEASON limit: 1000 }) {
      statList { player { id name position ubersetzer { sportsTag } } team { name } stats { name value } }
    } } } } }`;
    const data = await gql(query, { tournamentTagId: TAG_ID, seasonSlug: SEASON_SLUG });
    const list = data.statQueries.hockey.seasonBySlug.playerStatRanking.statList || [];
    for (const row of list) {
      const tag = String(row.player.ubersetzer && row.player.ubersetzer.sportsTag);
      if (!out.has(tag)) out.set(tag, { name: row.player.name, position: row.player.position, team: row.team && row.team.name, stats: {} });
      const rec = out.get(tag);
      rec.stats[tab] = Object.fromEntries(row.stats.map((s) => [s.name, s.value]));
    }
  }
  return { byTag: out, fetchedTabs: STAT_TABS.length, players: out.size };
}

// ---- KHL schedule (SportsEvent JSON-LD on the tournament calendar page) ----
async function fetchSchedule() {
  const html = await http(`${BASE}/hockey/tournament/khl/calendar/`, { timeoutMs: 90000 });
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const matches = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === 'object') {
      if (x['@type'] === 'SportsEvent' && x.startDate && x.homeTeam && x.awayTeam) {
        matches.push({
          start: new Date(x.startDate).getTime(),
          home: x.homeTeam.name,
          away: x.awayTeam.name,
          url: x.url || null,
        });
      }
      Object.values(x).forEach(walk);
    }
  };
  for (const b of blocks) { try { walk(JSON.parse(b)); } catch (_) { /* skip non-JSON blocks */ } }
  const uniq = new Map();
  for (const m of matches) uniq.set(`${m.start}|${m.home}|${m.away}`, m);
  return [...uniq.values()].sort((a, b) => a.start - b.start);
}

// ---- Club strength: standings table from the KHL stat gadget (SSR) ----
async function fetchStandings() {
  const html = await http(`${BASE}/stat/gadget/107.html?sport_id=209&is_full=1`);
  const re = /<a class="name"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>\s*(\d+)\s*<\/td>/g;
  const clubs = {};
  let m;
  while ((m = re.exec(html))) clubs[decodeEntities(m[1])] = { games: Number(m[2]), points: Number(m[3]) };
  return clubs;
}

module.exports = {
  BASE, TOURNAMENT_ID, TAG_ID, SEASON_SLUG, STAT_TABS,
  http, getJson, clean,
  fetchTeamRoster, fetchPool, fetchTeamMeta, fetchLeagueTable,
  fetchPlayerStats, fetchSchedule, fetchStandings,
};

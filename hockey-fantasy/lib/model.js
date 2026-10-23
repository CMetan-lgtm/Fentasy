'use strict';
// Projection, transfer optimiser and league "finish first" estimator for the
// Sports.ru fantasy hockey team (KHL tournament 107).
//
// Verified facts the model relies on:
//  * player price = start value + season fantasy points (so "delta" = points gained)
//  * team league value ("ОС" in the league table) = squad price sum + balance
//  * fantasy week n starts Monday 04:00 Moscow time (week 1 = 7 Sep 2026)
//  * a transfer sells a player at his CURRENT price, so a swap is value-neutral;
//    what counts is the price growth (points) of the players you hold.

const { buildWeeklyPlan } = require('./weekly-plan');
const { injurySummary } = require('./injuries');

const WEEK_MS = 7 * 24 * 3600 * 1000;
const MIN_MS = 60 * 1000;
const WEEK_ANCHOR = Date.UTC(2026, 8, 7, 1, 0);       // Mon 7 Sep 2026 04:00 MSK (= 01:00 UTC)
const NEED = { 1: 2, 2: 6, 3: 9 };                    // goalies, defence, forwards
const POS_SHORT = { 1: 'G', 2: 'D', 3: 'F' };
const POS_NAME = { 1: 'Вратарь', 2: 'Защитник', 3: 'Нападающий' };

const DEFAULTS = {
  horizon: 1,          // weeks to project (1 = current week only, up to 4 = calendar limit)
  risk: 0,             // objective = mu - risk * sigma (negative = chase variance)
  maxSwaps: null,      // null = transfers left reported by the site
  clubLimit: 3,
  lockBefore: 30,      // minutes before a game the player is locked (from the rules)
  lockAfter: 150,      // ASSUMPTION: minutes after the start until unlock (rules say "some time after")
  priorK: 6,           // shrinkage strength in games towards the position average
  matchBeta: 0.4,      // sensitivity of points to the match win probability
  homeAdv: 0.03,       // home advantage added to win probability
  discount: 0.9,       // weekly discount for future weeks
  seasonWeeks: 0,      // extra APPROXIMATE weeks after the calendar (uses avg games per week)
  mcIters: 4000,
  seed: 20261008,
  beamWidth: 300,
  minParticipation: 0.75, // skaters: season appearances / club matches
  minGoalieParticipation: 0.60,
  minRotationSample: 5,
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (v) => { if (v == null || v === '') return 0; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const mmss = (v) => { const m = String(v || '').match(/^(\d+):(\d+)$/); return m ? Number(m[1]) + Number(m[2]) / 60 : num(v); };
const weekIndex = (ms) => Math.floor((ms - WEEK_ANCHOR) / WEEK_MS);       // 4 => fantasy week 5
const weekRange = (idx) => [WEEK_ANCHOR + idx * WEEK_MS, WEEK_ANCHOR + (idx + 1) * WEEK_MS];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- stats ----------------------------------------------------------------
function statsOf(rec) {
  if (!rec) return null;
  const S = rec.stats || {};
  const tabs = ['SCORERS', 'PLUS_MINUS', 'PENALTIES', 'TIME_ON_ICE', 'SAVES', 'GOALTENDERS'];
  return {
    gp: Math.max(...tabs.map((t) => num(S[t] && S[t].MATCHES_PLAYED))),
    goals: num(S.SCORERS && S.SCORERS.GOALS),
    assists: num(S.SCORERS && S.SCORERS.ASSISTS),
    plusMinus: num(S.PLUS_MINUS && S.PLUS_MINUS.PLUS_MINUS),
    pim: num(S.PENALTIES && S.PENALTIES.PENALTY_MINUTES),
    toiPg: mmss((S.TIME_ON_ICE && S.TIME_ON_ICE.TIME_ON_ICE_PER_GAME) || (S.GOALTENDERS && S.GOALTENDERS.TIME_ON_ICE_PER_GAME)),
    saves: num(S.SAVES && S.SAVES.SAVES),
    shotsAgainst: num(S.SAVES && S.SAVES.SHOTS_AGAINST),
    cleanSheets: num(S.GOALTENDERS && S.GOALTENDERS.CLEAN_SHEETS),
  };
}

function joinStats(pool, statsSnap) {
  const byTag = new Map(Object.entries((statsSnap && statsSnap.byTag) || {}));
  const bySurname = new Map();
  for (const rec of byTag.values()) {
    const key = String(rec.name || '').trim().split(/\s+/).pop().toLowerCase() + '|' + rec.team;
    bySurname.set(key, (bySurname.get(key) || []).concat([rec]));
  }
  const out = new Map();
  let fallback = 0;
  for (const p of pool) {
    let rec = byTag.get(p.tagId);
    if (!rec) {
      const c = bySurname.get(String(p.name).trim().toLowerCase() + '|' + p.club);
      if (c && c.length === 1) { rec = c[0]; fallback++; }
    }
    out.set(p.id, statsOf(rec));
  }
  return { map: out, fallback };
}

// ---- main analysis ---------------------------------------------------------
function analyze(snap, userOpts = {}) {
  const o = { ...DEFAULTS, ...userOpts };
  const now = Number(o.now || Date.now());
  const meta = snap.meta;
  const health = injurySummary(snap.injuries, now);
  const budget = meta.cost + meta.balance;                 // league value (ОС); swaps keep it constant
  const maxSwaps = o.maxSwaps != null ? Number(o.maxSwaps) : (meta.transfersLeft || 0);
  const H = clamp(Math.round(Number(o.horizon)), 1, 4);
  const currentWeek = weekIndex(now);
  const K = o.priorK;
  const clubSet = new Set();
  let calMatches = 0;
  for (const m of snap.schedule || []) { clubSet.add(m.home); clubSet.add(m.away); const w = weekIndex(m.start); if (w >= currentWeek && w < currentWeek + 4) calMatches++; }
  const gamesPerWeek = clubSet.size ? (2 * calMatches) / (clubSet.size * 4) : 2.4;
  const seasonExtra = clamp(Math.round(Number(o.seasonWeeks) || 0), 0, 60);

  // schedule per club
  const clubMatches = {};
  for (const m of snap.schedule || []) {
    (clubMatches[m.home] ||= []).push({ start: m.start, opp: m.away, home: true });
    (clubMatches[m.away] ||= []).push({ start: m.start, opp: m.home, home: false });
  }
  for (const k of Object.keys(clubMatches)) clubMatches[k].sort((a, b) => a.start - b.start);

  // club strength from standings (points share) and games played so far
  const standing = snap.standings || {};
  const winPct = (club) => { const s = standing[club]; if (!s || !s.games) return 0.5; return clamp(s.points / (3 * s.games), 0.1, 0.9); };
  const pWin = (club, opp, home) => {
    let a = winPct(club); const b = winPct(opp);
    a = home ? Math.min(0.95, a + o.homeAdv) : Math.max(0.05, a - o.homeAdv);
    return (a * (1 - b)) / (a * (1 - b) + b * (1 - a));
  };
  const matchFactor = (club, m) => 1 + o.matchBeta * (pWin(club, m.opp, m.home) - 0.5);
  const teamGames = (club) => (standing[club] ? standing[club].games : 0);
  const lockedClub = (club) => (clubMatches[club] || []).some((m) => now >= m.start - o.lockBefore * MIN_MS && now <= m.start + o.lockAfter * MIN_MS);
  const nextStart = (club) => { const n = (clubMatches[club] || []).find((m) => m.start >= now); return n ? n.start : null; };

  // stats join and position priors (pooled over players with >= 5 games)
  const pool = snap.pool;
  const { map: statMap, fallback } = joinStats(pool, snap.stats);
  const acc = { 1: { n: 0, pts: 0, sv: 0, ga: 0, cs: 0 }, 2: { n: 0, pts: 0, g: 0, a: 0, pim: 0 }, 3: { n: 0, pts: 0, g: 0, a: 0, pim: 0 } };
  for (const p of pool) {
    const st = statMap.get(p.id);
    if (!st || st.gp < 5) continue;
    const A = acc[p.amplua];
    if (!A) continue;
    A.n += st.gp; A.pts += p.delta;
    if (p.amplua === 1) { A.sv += st.saves; A.ga += st.shotsAgainst - st.saves; A.cs += st.cleanSheets; }
    else { A.g += st.goals; A.a += st.assists; A.pim += st.pim; }
  }
  const prior = {};
  for (const pos of [1, 2, 3]) {
    const A = acc[pos]; const n = Math.max(1, A.n);
    prior[pos] = pos === 1
      ? { fppg: A.pts / n, sv: A.sv / n, ga: A.ga / n, cs: A.cs / n }
      : { fppg: A.pts / n, g: A.g / n, a: A.a / n, pim: A.pim / n };
  }

  // per-player projections
  const players = pool.map((p) => {
    const st = statMap.get(p.id);
    const gp = st ? st.gp : 0;
    const tp = teamGames(p.club);
    const pr = prior[p.amplua];
    const fppg = (p.delta + K * pr.fppg) / (gp + K);               // fantasy points per game played
    const injury = health.byId[String(p.id)] || null;
    const unavailable = !!injury && ['injured', 'doubtful'].includes(injury.status);
    const participation = tp > 0 ? clamp(gp / tp, 0, 1) : null;
    const minShare = p.amplua === 1 ? o.minGoalieParticipation : o.minParticipation;
    const rotationRisk = tp >= o.minRotationSample && participation < minShare;
    const lowIceTime = !!st && st.toiPg > 0 && st.toiPg < (p.amplua === 1 ? 30 : 10);
    const exclusionReasons = [];
    if (health.blocked) exclusionReasons.push('Нет актуальной проверки новостей о травмах');
    if (unavailable) exclusionReasons.push(injury.status === 'injured' ? 'Сообщение о травме; возвращение не подтверждено' : 'Участие под вопросом');
    if (!st || !gp || tp <= 0) exclusionReasons.push('Недостаточно статистики участия');
    if (rotationRisk) exclusionReasons.push(`Риск ротации: участие в ${Math.round(participation * 100)}% матчей клуба`);
    if (lowIceTime) exclusionReasons.push('Мало среднего игрового времени');
    const canBuy = exclusionReasons.length === 0;
    const avail = unavailable ? 0 : clamp((gp + 1) / (tp + 1.5), 0.1, 1.0);           // share of club games he plays
    let sigma2Game;
    if (p.amplua === 1) {
      const sv = ((st ? st.saves : 0) + K * pr.sv) / (gp + K);
      const ga = ((st ? st.shotsAgainst - st.saves : 0) + K * pr.ga) / (gp + K);
      const pso = clamp(((st ? st.cleanSheets : 0) + K * 0.1) / (gp + K), 0.02, 0.4);
      sigma2Game = sv / 4 + 9 * ga + 2.2 + 400 * pso * (1 - pso);
    } else {
      const lg = ((st ? st.goals : 0) + K * pr.g) / (gp + K);
      const la = ((st ? st.assists : 0) + K * pr.a) / (gp + K);
      const lp = ((st ? st.pim : 0) + K * pr.pim) / (gp + K);
      const q = st && st.toiPg >= 10 ? 0.9 : 0.5;                   // chance of >10 min on ice
      sigma2Game = 100 * lg + 25 * la + 6 + lp + 2.2 + 4 * q * (1 - q);
    }
    const games = [];
    let mu = 0, v = 0, mu1 = 0, v1 = 0, weekTotal = 0, weekLeft = 0, nTot = 0;
    const sdRate = Math.sqrt(sigma2Game / (gp + K));          // uncertainty of the per-game rate itself
    for (let w = currentWeek; w < currentWeek + H; w++) {
      const [w0, w1] = weekRange(w);
      const inWeek = (clubMatches[p.club] || []).filter((m) => m.start >= w0 && m.start < w1);
      const left = w === currentWeek ? inWeek.filter((m) => m.start >= now) : inWeek;
      const nEff = left.reduce((acc, m) => acc + matchFactor(p.club, m), 0) * avail;
      const d = Math.pow(o.discount, w - currentWeek);
      const muW = fppg * nEff, varW = sigma2Game * nEff;
      mu += d * muW; v += d * d * varW; nTot += d * nEff;
      if (w === currentWeek) { mu1 = muW; v1 = varW; weekTotal = inWeek.length; weekLeft = left.length; }
      games.push({ week: w + 1, total: inWeek.length, left: left.length, expectedPlayed: +nEff.toFixed(2) });
    }
    if (seasonExtra > 0) {
      const nExt = avail * gamesPerWeek * seasonExtra;
      mu += fppg * nExt; v += sigma2Game * nExt; nTot += nExt;
    }
    // rate error is shared by all future games of the player (fully correlated over time)
    v += Math.pow(sdRate * nTot, 2);
    if (v1 === 0 && mu1 !== 0) v1 = 0;
    return {
      id: p.id, name: p.name, club: p.club, clubId: p.clubId, pos: p.amplua, posShort: POS_SHORT[p.amplua],
      price: p.price, startValue: p.startValue, seasonPoints: p.delta, gp, teamGames: tp,
      fppg: +fppg.toFixed(2), availability: +avail.toFixed(2),
      injuryStatus: injury ? injury.status : 'no-reported-injury', injurySource: injury ? injury.sourceUrl : null,
      injuryUpdatedAt: injury ? injury.publishedAt : null, injuryEvidence: injury ? injury.evidence : null,
      participation, rotationRisk, lowIceTime, canBuy, exclusionReasons,
      weekGames: weekTotal, weekGamesLeft: weekLeft, nextStart: nextStart(p.club),
      mu1: +mu1.toFixed(2), sigma1: +Math.sqrt(v1).toFixed(2),
      muH: +mu.toFixed(2), sigmaH: +Math.sqrt(v).toFixed(2),
      score: mu - o.risk * Math.sqrt(v),
      locked: lockedClub(p.club) || !!p.lock,
      games, img: p.img,
    };
  });
  const byId = new Map(players.map((p) => [p.id, p]));

  // squad
  const squadIds = snap.roster.map((r) => r.id);
  const squad = squadIds.map((id) => byId.get(id)).filter(Boolean);
  const squadMissing = squadIds.filter((id) => !byId.has(id));
  const squadSum = (arr, f) => arr.reduce((s, p) => s + f(p), 0);
  const currentScore = squadSum(squad, (p) => p.score);

  // candidates for buying: not locked, not in squad, priced
  const squadSet = new Set(squadIds);
  const cands = pruneCands(players.filter((p) => p.canBuy && !p.locked && !squadSet.has(p.id) && p.price > 0));

  // optimiser: best squad for each number of transfers (<= maxSwaps)
  const levels = beamOptimise({ squad, cands, budget, maxSwaps, clubLimit: o.clubLimit, width: o.beamWidth });
  const options = levels.map((lv, k) => ({
    transferLimit: k,
    transfers: lv.swaps.length,
    value: +lv.value.toFixed(2),
    gain: +(lv.value - currentScore).toFixed(2),
    gainThisWeek: +(squadSum(lv.ids.map((id) => byId.get(id)), (p) => p.mu1) - squadSum(squad, (p) => p.mu1)).toFixed(2),
    cost: lv.cost,
    budgetLeft: budget - lv.cost,
    swaps: lv.swaps.map((s) => ({ out: brief(byId.get(s.out)), in: brief(byId.get(s.in)) })),
    ids: lv.ids,
  }));

  // single swaps: "who to swap for whom"
  const singles = singleSwaps({ squad, cands, budget, clubLimit: o.clubLimit });

  // ideal squad with no transfer limit
  // Current players may be retained, including injured/locked players. They are not new buys.
  const idealPool = new Map(pruneCands(players.filter((p) => p.canBuy && !p.locked && p.price > 0)).concat(squad).map((p) => [p.id, p]));
  const ideal = idealSquad({ squad, players: [...idealPool.values()], budget, clubLimit: o.clubLimit, mustKeep: squad.filter((p) => p.locked).map((p) => p.id) });

  const league = leagueAnalysis({ snap, byId, players, squadIds, squad, options, ideal, o, budget, mulberry: mulberry32, maxSwaps });

  const wk = weekRange(currentWeek);
  return {
    generatedAt: snap.generatedAt,
    computedAt: new Date(now).toISOString(),
    health: { ...health, byId: undefined, excluded: players.filter((p) => !p.canBuy).length,
      injured: players.filter((p) => p.injuryStatus === 'injured').length,
      doubtful: players.filter((p) => p.injuryStatus === 'doubtful').length,
      rotation: players.filter((p) => p.rotationRisk || p.lowIceTime).length,
      minParticipation: o.minParticipation, minGoalieParticipation: o.minGoalieParticipation },
    params: { horizon: H, seasonWeeks: seasonExtra, gamesPerWeek: +gamesPerWeek.toFixed(2), risk: o.risk, maxSwaps, clubLimit: o.clubLimit, budget, lockBefore: o.lockBefore, lockAfter: o.lockAfter, priorK: K, matchBeta: o.matchBeta, discount: o.discount, beamWidth: o.beamWidth },
    week: { current: currentWeek + 1, start: new Date(wk[0]).toISOString(), end: new Date(wk[1]).toISOString(), deadline: meta.deadline, siteWeek: meta.week },
    team: {
      teamId: meta.teamId, name: meta.teamName, cost: meta.cost, balance: meta.balance, budget,
      transfersLeft: meta.transfersLeft, clubLimit: meta.clubLimit, globalPlace: meta.globalPlace, globalOf: meta.globalOf,
      leagues: meta.leagues,
      seasonPoints: squadSum(squad, (p) => p.seasonPoints),
      expectedThisWeek: +squadSum(squad, (p) => p.mu1).toFixed(1),
      expectedHorizon: +squadSum(squad, (p) => p.muH).toFixed(1),
      sumScore: +currentScore.toFixed(2),
    },
    squad: squad.map((p) => ({ ...p })),
    squadMissing,
    weeklyPlan: o.weeklyPlan ? buildWeeklyPlan({ players, squad, squadMissing, meta, budget, now,
      week: { current: currentWeek + 1, start: new Date(wk[0]).toISOString(), end: new Date(wk[1]).toISOString() },
      health, generatedAt: snap.generatedAt, optimise: beamOptimise, prune: pruneCands, width: o.beamWidth }) : undefined,
    options,
    singles,
    ideal: ideal ? { value: +ideal.value.toFixed(2), cost: ideal.cost, transfersNeeded: squadIds.filter((id) => !ideal.ids.includes(id)).length, ids: ideal.ids, players: ideal.ids.map((id) => brief(byId.get(id))) } : null,
    league,
    clubs: Object.keys(clubMatches).sort().map((c) => ({
      club: c, teamGames: teamGames(c), winPct: +winPct(c).toFixed(3), locked: lockedClub(c),
      thisWeek: (clubMatches[c] || []).filter((m) => weekIndex(m.start) === currentWeek).map((m) => ({ start: m.start, opp: m.opp, home: m.home, played: m.start < now })),
    })),
    pool: players,
    stats: { joined: players.filter((p) => p.gp > 0).length, fallbackJoins: fallback, total: players.length, priors: prior },
  };
}

function brief(p) {
  if (!p) return null;
  return { id: p.id, name: p.name, club: p.club, pos: p.posShort, price: p.price, seasonPoints: p.seasonPoints, gp: p.gp, fppg: p.fppg, mu1: p.mu1, muH: p.muH, sigmaH: p.sigmaH, weekGames: p.weekGames, weekGamesLeft: p.weekGamesLeft, locked: p.locked, canBuy: p.canBuy, injuryStatus: p.injuryStatus, injurySource: p.injurySource, injuryUpdatedAt: p.injuryUpdatedAt, participation: p.participation, rotationRisk: p.rotationRisk, exclusionReasons: p.exclusionReasons };
}

// Keep a small, useful candidate set per position: best by score and best by score per rouble.
function pruneCands(cands, keepTop = 60, keepRatio = 30) {
  const out = [];
  for (const pos of [1, 2, 3]) {
    const list = cands.filter((c) => c.pos === pos);
    const byScore = [...list].sort((a, b) => b.score - a.score).slice(0, keepTop);
    const byRatio = list.filter((c) => c.score > 0).sort((a, b) => (b.score / b.price) - (a.score / a.price)).slice(0, keepRatio);
    const m = new Map();
    for (const c of byScore.concat(byRatio)) m.set(c.id, c);
    out.push(...m.values());
  }
  return out;
}

// indices of the M largest values (binary min-heap, O(n log M))
function topIndices(vals, M) {
  const heap = new Int32Array(M);
  let hs = 0;
  const siftUp = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (vals[heap[p]] <= vals[heap[i]]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const siftDown = (i) => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hs && vals[heap[l]] < vals[heap[m]]) m = l; if (r < hs && vals[heap[r]] < vals[heap[m]]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
  for (let i = 0; i < vals.length; i++) {
    if (hs < M) { heap[hs] = i; siftUp(hs); hs++; }
    else if (vals[i] > vals[heap[0]]) { heap[0] = i; siftDown(0); }
  }
  return Array.from(heap.subarray(0, hs)).sort((a, b) => vals[b] - vals[a]);
}

// Beam search over swap sequences. A swap sells an ORIGINAL squad player and buys
// a non-squad player of the same position. Returns best squad for 0..maxSwaps swaps.
function beamOptimise({ squad, cands, budget, maxSwaps, clubLimit, width = 200 }) {
  const originals = new Map(squad.map((p) => [p.id, p]));
  const counts0 = {};
  for (const p of squad) counts0[p.club] = (counts0[p.club] || 0) + 1;
  const cost0 = squad.reduce((s, p) => s + p.price, 0);
  const val0 = squad.reduce((s, p) => s + p.score, 0);
  const byPos = { 1: [], 2: [], 3: [] };
  const candById = new Map();
  for (const c of cands) { if (originals.has(c.id) || c.canBuy === false) continue; byPos[c.pos].push(c); candById.set(c.id, c); }
  const root = { value: val0, cost: cost0, counts: counts0, sold: [], bought: [], ids: squad.map((p) => p.id), swaps: [] };
  const levels = [root];
  let beam = [root];
  const sellable = squad.filter((p) => !p.locked);
  for (let k = 1; k <= maxSwaps; k++) {
    // enumerate every feasible single move from every beam state
    const vals = [], meta = [];
    for (let si = 0; si < beam.length; si++) {
      const st = beam[si];
      for (const out of sellable) {
        if (st.sold.includes(out.id)) continue;
        for (const inn of byPos[out.pos]) {
          if (st.bought.includes(inn.id)) continue;
          const cost = st.cost - out.price + inn.price;
          if (cost > budget) continue;
          const cnt = (st.counts[inn.club] || 0) - (out.club === inn.club ? 1 : 0);
          if (cnt + 1 > clubLimit) continue;
          vals.push(st.value - out.score + inn.score);
          meta.push(si, out.id, inn.id, cost);
        }
      }
    }
    if (!vals.length) break;
    const order = topIndices(vals, width * 3);
    const next = [];
    const seen = new Set();
    for (const t of order) {
      const si = meta[t * 4], oid = meta[t * 4 + 1], iid = meta[t * 4 + 2], cost = meta[t * 4 + 3];
      const st = beam[si];
      const sold = [...st.sold, oid].sort();
      const bought = [...st.bought, iid].sort();
      const key = sold.join(',') + '|' + bought.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const out = originals.get(oid), inn = candById.get(iid);
      const counts = { ...st.counts };
      counts[out.club] -= 1; counts[inn.club] = (counts[inn.club] || 0) + 1;
      next.push({ value: vals[t], cost, counts, sold, bought, ids: st.ids.filter((x) => x !== oid).concat([iid]), swaps: st.swaps.concat([{ out: oid, in: iid }]) });
      if (next.length >= width) break;
    }
    if (!next.length) break;
    beam = next;
    levels.push(next[0]);
  }
  // "at most k transfers": prefix maxima
  const out = [];
  let best = levels[0];
  for (let k = 0; k <= maxSwaps; k++) {
    if (k < levels.length && levels[k].value > best.value) best = levels[k];
    out.push(best);
  }
  return out;
}

function singleSwaps({ squad, cands, budget, clubLimit }) {
  const squadSet = new Set(squad.map((p) => p.id));
  const cost0 = squad.reduce((s, p) => s + p.price, 0);
  const counts = {};
  for (const p of squad) counts[p.club] = (counts[p.club] || 0) + 1;
  const rows = [];
  for (const o of squad) {
    if (o.locked) continue;
    const list = [];
    for (const c of cands) {
      if (c.canBuy === false || c.pos !== o.pos || squadSet.has(c.id)) continue;
      if (cost0 - o.price + c.price > budget) continue;
      const cnt = (counts[c.club] || 0) - (o.club === c.club ? 1 : 0);
      if (cnt + 1 > clubLimit) continue;
      list.push({ o, c, d: c.score - o.score });
    }
    list.sort((a, b) => b.d - a.d);
    for (const x of list.slice(0, 3)) rows.push({ out: brief(x.o), in: brief(x.c), dScore: +x.d.toFixed(2), dPrice: x.c.price - x.o.price, dThisWeek: +(x.c.mu1 - x.o.mu1).toFixed(2), dHorizon: +(x.c.muH - x.o.muH).toFixed(2) });
  }
  rows.sort((a, b) => b.dScore - a.dScore);
  return rows.slice(0, 25);
}

// Best feasible 17 with no transfer limit: greedy seed + 1-swap local search + restarts.
function idealSquad({ squad, players, budget, clubLimit, mustKeep }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const byPos = { 1: [], 2: [], 3: [] };
  for (const p of players) if (p.canBuy && p.price > 0 && !p.locked) byPos[p.pos].push(p);
  const evalIds = (ids) => {
    const ps = ids.map((i) => byId.get(i));
    if (ps.some((p) => !p)) return null;
    const cnt = { 1: 0, 2: 0, 3: 0 }; const club = {}; let cost = 0;
    for (const p of ps) { cnt[p.pos]++; club[p.club] = (club[p.club] || 0) + 1; cost += p.price; }
    if (cnt[1] !== NEED[1] || cnt[2] !== NEED[2] || cnt[3] !== NEED[3]) return null;
    if (Object.values(club).some((c) => c > clubLimit) || cost > budget) return null;
    if (!mustKeep.every((m) => ids.includes(m))) return null;
    return { value: ps.reduce((s, p) => s + p.score, 0), cost };
  };
  const localSearch = (start) => {
    let ids = start.slice();
    for (let iter = 0; iter < 60; iter++) {
      const base = evalIds(ids);
      if (!base) return null;
      let best = null;
      for (let i = 0; i < ids.length; i++) {
        const pos = byId.get(ids[i]).pos;
        for (const c of byPos[pos]) {
          if (ids.includes(c.id)) continue;
          const trial = ids.slice(); trial[i] = c.id;
          const v = evalIds(trial);
          if (v && v.value > base.value + 1e-9 && (!best || v.value > best.v.value)) best = { v, ids: trial };
        }
      }
      if (!best) break;
      ids = best.ids;
    }
    const fin = evalIds(ids);
    return fin ? { ids, value: fin.value, cost: fin.cost } : null;
  };
  // greedy seed by score per price
  const order = [...players].sort((a, b) => (b.score / Math.max(1, b.price)) - (a.score / Math.max(1, a.price)));
  const cnt = { 1: 0, 2: 0, 3: 0 }; const club = {}; let cost = 0; const seed = [];
  for (const id of mustKeep) { const p = byId.get(id); if (p) { seed.push(id); cnt[p.pos]++; club[p.club] = (club[p.club] || 0) + 1; cost += p.price; } }
  for (const p of order) {
    if (!p.canBuy || p.locked || seed.includes(p.id) || cnt[p.pos] >= NEED[p.pos]) continue;
    if ((club[p.club] || 0) >= clubLimit || cost + p.price > budget) continue;
    seed.push(p.id); cnt[p.pos]++; club[p.club] = (club[p.club] || 0) + 1; cost += p.price;
  }
  let best = seed.length === 17 ? localSearch(seed) : null;
  const current = squad.map((p) => p.id);
  const alt = evalIds(current) ? localSearch(current) : null;
  if (alt && (!best || alt.value > best.value)) best = alt;
  // restarts: perturb best and re-climb
  const rnd = mulberry32(20261008);
  for (let r = 0; r < 25 && best; r++) {
    const ids = best.ids.slice();
    for (let t = 0; t < 3; t++) {
      const idx = Math.floor(rnd() * ids.length);
      const pos = byId.get(ids[idx]).pos;
      const pool = byPos[pos].filter((p) => !ids.includes(p.id)).slice(0, 80);
      if (pool.length) ids[idx] = pool[Math.floor(rnd() * pool.length)].id;
    }
    const cand = localSearch(ids);
    if (cand && cand.value > best.value + 1e-9) best = cand;
  }
  return best;
}

// Monte-Carlo: probability of finishing first in the league by ОС at the horizon.
function leagueAnalysis({ snap, byId, players, squadIds, squad, options, ideal, o, budget, mulberry, maxSwaps }) {
  const lg = snap.leagues && snap.leagues.private;
  if (!lg || !lg.rows || !lg.rows.length) return null;
  const ourRow = lg.rows.find((r) => r.teamId === String(snap.meta.teamId)) || null;
  const rivals = lg.rows.filter((r) => r.teamId !== String(snap.meta.teamId));
  const rosters = lg.rosters || {};
  const rivalData = rivals
    .map((r) => ({ teamId: r.teamId, name: r.teamName, manager: r.manager, value: r.value, place: r.place, ids: (rosters[r.teamId] || []).map((p) => p.id) }))
    .filter((r) => r.ids.length);

  // candidate rosters
  const cand = [];
  cand.push({ label: 'Текущий состав (без трансферов)', ids: squadIds, swaps: [] });
  for (let k = 1; k < options.length; k++) {
    const opt = options[k];
    if (opt.transfers !== k || !opt.swaps.length) continue;
    cand.push({ label: `Лучший состав: ${k} трансф.`, ids: opt.ids, swaps: opt.swaps });
  }
  if (ideal) cand.push({ label: 'Идеальный состав (без лимита трансферов)', ids: ideal.ids, swaps: [] });
  for (const r of [-1, -0.5, 0.5, 1]) {
    const scoreOf = (p) => p.muH - r * p.sigmaH;
    const sq = squad.map((p) => ({ ...p, score: scoreOf(p) }));
    const cc = pruneCands(players.filter((p) => p.canBuy && !p.locked && !squadIds.includes(p.id) && p.price > 0).map((p) => ({ ...p, score: scoreOf(p) })));
    const levels = beamOptimise({ squad: sq, cands: cc, budget, maxSwaps, clubLimit: o.clubLimit, width: Math.min(o.beamWidth, 150) });
    const last = levels[levels.length - 1];
    if (last && last.swaps.length) cand.push({ label: `Риск ${r > 0 ? '+' : ''}${r}: ${r < 0 ? 'агрессивно' : 'осторожно'}`, ids: last.ids, swaps: last.swaps.map((s) => ({ out: s.out, in: s.in })), risk: r });
  }
  const seen = new Set();
  const cands = cand.filter((c) => { const k = [...c.ids].sort().join(','); if (seen.has(k)) return false; seen.add(k); return true; });
  for (const c of cands) c.swapsBrief = c.swaps.map((s) => ({ out: brief(byId.get(typeof s.out === 'object' ? s.out.id : s.out)), in: brief(byId.get(typeof s.in === 'object' ? s.in.id : s.in)) }));

  // distribution index
  const index = new Map(); const mu = []; const sd = [];
  const idx = (id) => { if (index.has(id)) return index.get(id); const p = byId.get(id); index.set(id, mu.length); mu.push(p ? p.muH : 0); sd.push(p ? p.sigmaH : 0); return mu.length - 1; };
  const rivIdx = rivalData.map((r) => r.ids.map(idx));
  const candIdx = cands.map((c) => c.ids.map(idx));
  const ourBase = ourRow ? ourRow.value : budget;
  const rivBase = rivalData.map((r) => r.value);
  const N = o.mcIters;
  const rnd = mulberry(o.seed + 7);
  const wins = new Float64Array(cands.length);
  const sumVal = new Float64Array(cands.length);
  const rivalTop = new Float64Array(rivalData.length);
  const X = new Float64Array(mu.length);
  const tot = new Float64Array(rivalData.length);
  for (let it = 0; it < N; it++) {
    for (let i = 0; i < X.length; i++) {
      const u1 = Math.max(1e-12, rnd()), u2 = rnd();
      X[i] = mu[i] + sd[i] * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    let rMax = -Infinity, rArg = -1;
    for (let r = 0; r < rivalData.length; r++) {
      let t = rivBase[r];
      const ids = rivIdx[r];
      for (let j = 0; j < ids.length; j++) t += X[ids[j]];
      tot[r] = t;
      if (t > rMax) { rMax = t; rArg = r; }
    }
    if (rArg >= 0) rivalTop[rArg]++;
    for (let c = 0; c < cands.length; c++) {
      let t = ourBase;
      const ids = candIdx[c];
      for (let j = 0; j < ids.length; j++) t += X[ids[j]];
      sumVal[c] += t;
      if (t > rMax) wins[c]++;
    }
  }
  const expGain = (ids) => ids.reduce((s, id) => s + (byId.get(id) ? byId.get(id).muH : 0), 0);
  const ourBaseOut = ourBase;
  return {
    leagueId: lg.leagueId,
    leagueName: ((snap.meta.leagues || []).find((l) => l.kind === 'private') || {}).name || 'Лига',
    size: lg.rows.length,
    ourPlace: ourRow ? ourRow.place : null,
    ourValue: ourBaseOut,
    leader: lg.rows[0] ? { teamId: lg.rows[0].teamId, name: lg.rows[0].teamName, manager: lg.rows[0].manager, value: lg.rows[0].value } : null,
    gapToLeader: lg.rows[0] && ourRow ? lg.rows[0].value - ourRow.value : null,
    top: lg.rows.slice(0, 10),
    rostersLoaded: rivalData.length,
    iterations: N,
    horizon: Math.round(Number(o.horizon)),
    seasonWeeks: o.seasonWeeks || 0,
    candidates: cands.map((c, i) => ({
      label: c.label,
      pFirst: +(wins[i] / N).toFixed(4),
      expectedValue: +(sumVal[i] / N).toFixed(1),
      expectedGain: +expGain(c.ids).toFixed(1),
      swaps: c.swapsBrief,
      ids: c.ids,
    })).sort((a, b) => b.pFirst - a.pFirst),
    rivals: rivalData.map((r, i) => ({ teamId: r.teamId, name: r.name, manager: r.manager, value: r.value, place: r.place, expectedGain: +rivIdx[i].reduce((s, j) => s + mu[j], 0).toFixed(1), pTopValue: +(rivalTop[i] / N).toFixed(4) })).sort((a, b) => b.value - a.value),
    note: 'Монте-Карло: игроки независимы, составы соперников фиксированы; трансферы не меняют ОС (продажа по текущей цене).',
  };
}

function toCsv(rows, columns) {
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = columns.map((c) => c.h).join(';');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.v === 'function' ? c.v(r) : r[c.v])).join(';'));
  return '\uFEFF' + [head, ...body].join('\r\n') + '\r\n';
}

module.exports = { analyze, toCsv, DEFAULTS, POS_NAME, POS_SHORT, NEED, weekIndex, WEEK_ANCHOR };

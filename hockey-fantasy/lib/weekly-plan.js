'use strict';

const NEED = { 1: 2, 2: 6, 3: 9 };
const round = (n) => +n.toFixed(2);
const transferLimit = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(5, Math.floor(Number(value)))) : 0;

// Validate the complete squad and EVERY intermediate state, not just the final cost.
function validatePlan({ squad, swaps, budget, clubLimit, maxSwaps }) {
  const current = new Map(squad.map((p) => [p.id, p]));
  const original = new Set(current.keys());
  const sold = new Set(), bought = new Set();
  const errors = [];
  function check() {
    const counts = { 1: 0, 2: 0, 3: 0 }, clubs = {};
    let cost = 0;
    for (const p of current.values()) {
      counts[p.pos] = (counts[p.pos] || 0) + 1;
      clubs[p.club] = (clubs[p.club] || 0) + 1;
      cost += p.price;
    }
    if (current.size !== 17 || Object.entries(NEED).some(([pos, n]) => counts[pos] !== n)) errors.push('Неполный состав или неверные позиции.');
    if (!Number.isFinite(cost) || !Number.isFinite(budget) || cost > budget + 1e-6) errors.push('Превышен бюджет или нет данных о ценах.');
    if (!Number.isFinite(clubLimit) || clubLimit < 1 || Object.values(clubs).some((n) => n > clubLimit)) errors.push('Превышен лимит игроков клуба.');
    return cost;
  }
  let cost = check();
  if (current.size !== squad.length) errors.push('Повтор игрока в составе.');
  if (swaps.length > maxSwaps) errors.push('Недостаточно трансферов.');
  const balances = [];
  for (const s of swaps) {
    const out = current.get(s.out.id), inn = s.in;
    if (!out || sold.has(s.out.id) || bought.has(inn.id) || original.has(inn.id) || current.has(inn.id)) { errors.push('Повтор или недоступный игрок в плане.'); break; }
    if (out.locked || inn.locked) errors.push('Игрок заблокирован.');
    if (inn.canBuy === false) errors.push('Покупка исключена: травма, риск ротации или неполные данные.');
    if (out.pos !== inn.pos) errors.push('Позиции замены не совпадают.');
    if (!Number.isFinite(inn.price) || inn.price <= 0) errors.push('Неизвестная цена покупки.');
    current.delete(out.id); current.set(inn.id, inn);
    sold.add(out.id); bought.add(inn.id);
    cost = check(); balances.push(round(budget - cost));
  }
  return { ok: !errors.length, errors: [...new Set(errors)], cost, balances, ids: [...current.keys()] };
}

function buildWeeklyPlan({ players, squad, squadMissing, meta, budget, now, week, generatedAt, health, optimise, prune, width = 300 }) {
  const maxSwaps = transferLimit(meta.transfersLeft);
  const clubLimit = Number(meta.clubLimit) > 0 ? Math.min(3, Math.floor(Number(meta.clubLimit))) : 3;
  const baseline = round(squad.reduce((sum, p) => sum + p.mu1, 0));
  const snapshotMs = Date.parse(generatedAt);
  const base = { week, generatedAt, computedAt: new Date(now).toISOString(), maxSwaps, clubLimit,
    transfers: 0, baseline, expected: baseline, gain: 0, budgetLeft: meta.balance, swaps: [],
    valid: true, reason: '', method: 'Лучший найденный план по модели (beam search)',
    health, assumptions: 'Известные травмы и сомнительные участия исключены; ротация оценивается по доле матчей сезона и среднему времени на льду. Новости не являются полным медицинским реестром. Подтверждённые старты неизвестны. Блокировка после начала матча оценена в 150 минут.' };
  const initial = validatePlan({ squad, swaps: [], budget, clubLimit, maxSwaps });
  if (squadMissing.length || !initial.ok || !Number.isFinite(snapshotMs) || snapshotMs < Date.parse(week.start) || snapshotMs > now + 60000) {
    return { ...base, valid: false, reason: 'Неполные или устаревшие данные. Обновите состав, цены и расписание с sports.ru.' };
  }
  if (!health || health.blocked) return { ...base, valid: false, reason: 'Нет актуальной проверки травм. Обновите рекомендации; старые статусы травм сохранены.' };
  if (!maxSwaps) return { ...base, reason: 'На текущую неделю трансферов не осталось.' };
  // mu1 does not depend on the global horizon, season extension or risk setting.
  const sq = squad.map((p) => ({ ...p, score: p.mu1 }));
  const owned = new Set(sq.map((p) => p.id));
  const cands = prune(players.filter((p) => p.canBuy && !owned.has(p.id) && !p.locked && p.price > 0 && Number.isFinite(p.mu1)).map((p) => ({ ...p, score: p.mu1 })));
  const levels = optimise({ squad: sq, cands, budget, maxSwaps, clubLimit, width });
  const best = levels[levels.length - 1];
  const byId = new Map(players.map((p) => [p.id, p]));
  const swaps = best.swaps.map((s) => ({ out: byId.get(s.out), in: byId.get(s.in) }));
  const checked = validatePlan({ squad, swaps, budget, clubLimit, maxSwaps });
  if (!checked.ok) return { ...base, valid: false, reason: 'План не прошёл проверку ограничений. Обновите данные.', errors: checked.errors };
  if (!swaps.length || best.value <= baseline + 0.005) return { ...base, reason: 'Полезных доступных замен не найдено. Сохраните трансферы.' };
  const compact = (p) => ({ id: p.id, name: p.name, club: p.club, pos: p.posShort, price: p.price,
    mu1: p.mu1, fppg: p.fppg, availability: p.availability, weekGamesLeft: p.weekGamesLeft,
    injuryStatus: p.injuryStatus, injurySource: p.injurySource, injuryUpdatedAt: p.injuryUpdatedAt,
    participation: p.participation, rotationRisk: p.rotationRisk, canBuy: p.canBuy, exclusionReasons: p.exclusionReasons });
  const rows = swaps.map((s, i) => {
    const starts = [s.out.nextStart, s.in.nextStart].filter((t) => Number.isFinite(t));
    const executeBefore = Math.min(Date.parse(week.end), ...starts.map((t) => t - 30 * 60000));
    const reasons = ['Нет известного запрета по новостям; порог участия и игрового времени пройден'];
    if (['injured', 'doubtful'].includes(s.out.injuryStatus)) reasons.push('У продаваемого игрока есть сообщение о травме или сомнительном участии');
    if (s.out.rotationRisk || s.out.lowIceTime) reasons.push('У продаваемого игрока повышенный риск ротации');
    if (s.in.weekGamesLeft > s.out.weekGamesLeft) reasons.push('Больше оставшихся матчей');
    if (s.in.fppg > s.out.fppg) reasons.push('Выше прогноз очков за матч');
    if (s.in.availability > s.out.availability) reasons.push('Выше расчётная доля участия');
    if (s.in.mu1 < s.out.mu1) reasons.push('Освобождает бюджет или место в клубе для общего плана');
    if (!reasons.length) reasons.push('Улучшает общий план с учётом календаря и ограничений');
    return { order: i + 1, out: compact(s.out), in: compact(s.in), gain: round(s.in.mu1 - s.out.mu1),
      dPrice: s.in.price - s.out.price, budgetLeft: checked.balances[i], executeBefore: new Date(executeBefore).toISOString(), reasons };
  });
  const expected = round(checked.ids.reduce((sum, id) => sum + byId.get(id).mu1, 0));
  return { ...base, transfers: rows.length, expected, gain: round(expected - baseline), budgetLeft: round(budget - checked.cost), swaps: rows,
    reason: rows.length < maxSwaps ? 'Дополнительные замены не улучшают найденный план.' : 'Выполняйте замены строго в указанном порядке.' };
}

module.exports = { buildWeeklyPlan, validatePlan, transferLimit };

'use strict';
// Rolling-origin calibration report. Requires weekly history records created
// after this version, with forecasts captured before the target week ends.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'data', 'history');
const records = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt))
  : [];
const observations = [];
for (const origin of records) {
  if (!origin.forecast || !origin.poolForecast || !origin.forecast.targetAt) continue;
  const target = Date.parse(origin.forecast.targetAt);
  if (!Number.isFinite(target)) continue;
  const outcome = records.find((r) => Date.parse(r.generatedAt) >= target && r.generatedAt !== origin.generatedAt && Array.isArray(r.poolForecast));
  if (!outcome) continue;
  const actualById = new Map(outcome.poolForecast.map((p) => [String(p.id), Number(p.seasonPoints)]));
  for (const p of origin.poolForecast) {
    const actualFinal = actualById.get(String(p.id));
    if (!Number.isFinite(actualFinal) || !Number.isFinite(Number(p.seasonPoints))) continue;
    const actual = actualFinal - Number(p.seasonPoints);
    const predicted = Number(p.mu1);
    if (!Number.isFinite(predicted)) continue;
    observations.push({ actual, predicted, sigma: Math.max(0, Number(p.sigma1) || 0), position: p.pos });
  }
}
function metrics(rows) {
  if (!rows.length) return { n: 0 };
  const errors = rows.map((x) => x.predicted - x.actual);
  return {
    n: rows.length,
    mae: +(errors.reduce((s, e) => s + Math.abs(e), 0) / rows.length).toFixed(3),
    rmse: +Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / rows.length).toFixed(3),
    bias: +(errors.reduce((s, e) => s + e, 0) / rows.length).toFixed(3),
    intervalCoverage1Sigma: +(rows.filter((x, i) => Math.abs(errors[i]) <= x.sigma).length / rows.length).toFixed(3),
  };
}
const byPosition = {};
for (const position of ['G', 'D', 'F']) byPosition[position] = metrics(observations.filter((x) => x.position === position));
const report = { generatedAt: new Date().toISOString(), forecastHorizon: 'one fantasy week', observations: observations.length, overall: metrics(observations), byPosition };
console.log(JSON.stringify(report, null, 2));
if (!observations.length) console.error('Нет завершённых пар прогноз/факт. Обновляйте данные раз в неделю; для backtest нужны будущие снимки после targetAt.');

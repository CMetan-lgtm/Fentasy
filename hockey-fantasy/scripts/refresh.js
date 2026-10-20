'use strict';
// CLI: fetch everything from sports.ru, save data/snapshot.json and export CSV/JSON files.
const path = require('path');
const R = require(path.join(__dirname, '..', 'lib', 'refresh.js'));
const M = require(path.join(__dirname, '..', 'lib', 'model.js'));

(async () => {
  const t0 = Date.now();
  const withFan = process.argv.includes('--fan-rosters');
  const snap = await R.refreshSnapshot({ withFanRosters: withFan });
  R.saveSnapshot(snap);
  const analysis = M.analyze(snap, { ...M.DEFAULTS });
  R.writeExports(snap, analysis);
  console.log(JSON.stringify({ ms: Date.now() - t0, sources: snap.sources, warnings: snap.warnings.slice(0, 10) }, null, 2));
  console.log('team', JSON.stringify(analysis.team));
  console.log('week', JSON.stringify(analysis.week));
})().catch((e) => { console.error('REFRESH FAILED:', e.message); process.exit(1); });

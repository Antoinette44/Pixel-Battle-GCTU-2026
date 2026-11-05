/* Copies the live battle log into samples/ with a time stamp, so the REAL battle is kept in Git.
   Usage:  npm run backup-log                      (copies data/actions.ndjson, run on the server machine)
           URL=https://your-app.onrender.com npm run backup-log     (downloads it from the running public server) */
const fs = require('fs'), path = require('path');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const out = path.join(__dirname, '..', 'samples', `battle-${stamp}.ndjson`);
fs.mkdirSync(path.dirname(out), { recursive: true });
(async () => {
  if (process.env.URL) {
    const j = await (await fetch(process.env.URL.replace(/\/$/, '') + '/api/log')).json();
    fs.writeFileSync(out, j.log.map(e => JSON.stringify(e)).join('\n') + '\n');
    console.log(`Downloaded ${j.log.length} actions -> ${out}`);
  } else {
    const src = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'actions.ndjson');
    if (!fs.existsSync(src)) { console.error('No log found at ' + src); process.exit(1); }
    fs.copyFileSync(src, out); console.log(`Copied ${src} -> ${out}`);
  }
  console.log('Now:  git add samples && git commit -m "Add real battle log"');
})();

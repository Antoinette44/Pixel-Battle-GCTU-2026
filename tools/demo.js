/* Starts the server with a saved battle already loaded, so the replay can be shown any time.
   Usage: npm run demo                         (uses samples/demo-battle.ndjson)
          npm run demo -- samples/battle-X.ndjson                                                */
const fs = require('fs'), path = require('path');
const src = path.resolve(process.argv[2] || path.join(__dirname, '..', 'samples', 'demo-battle.ndjson'));
if (!fs.existsSync(src)) { console.error('Not found: ' + src + '   (run: node tools/make-demo-log.js)'); process.exit(1); }
const dir = path.join(__dirname, '..', 'data-demo');
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
fs.copyFileSync(src, path.join(dir, 'actions.ndjson'));
process.env.DATA_DIR = dir;
console.log('DEMO MODE: replaying ' + src + ' (your real data/ folder is not touched)');
require('../server.js');

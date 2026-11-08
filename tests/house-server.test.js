/* Server-owned House Challenge integration tests. Run: node tests/house-server.test.js */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const Board = require('../public/board.js');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ok = message => console.log('  ok  ' + message);

async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

async function launch(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-house-server-'));
  if (options.log) fs.writeFileSync(path.join(dataDir, 'actions.ndjson'), options.log);
  const port = await unusedPort();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      CANVAS_SIZE: '128',
      COOLDOWN_MS: '0',
      CHALLENGE_SECS: '5',
      ADMIN_KEY: 'house-test-secret',
      ZONES: options.zones === false ? '0' : '1',
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}`);
    try {
      const health = await request(port, '/health');
      if (health.status === 200) return { dataDir, port, server };
    } catch (_) { /* Retry while the server starts. */ }
    await sleep(25);
  }
  server.kill();
  throw new Error('server did not become healthy');
}

async function stop(instance) {
  if (!instance) return;
  if (instance.server.exitCode === null) instance.server.kill();
  await new Promise(resolve => {
    if (instance.server.exitCode !== null) return resolve();
    instance.server.once('exit', resolve);
    setTimeout(resolve, 1000);
  });
  fs.rmSync(instance.dataDir, { recursive: true, force: true });
  if (instance.backupDataDir) fs.rmSync(instance.backupDataDir, { recursive: true, force: true });
}

function connect(port, name, team, id, query = '') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${query}`);
    const client = { ws, messages: [], seq: 0 };
    ws.on('message', data => {
      const message = JSON.parse(data);
      client.messages.push(message);
      if (message.t === 'init' && !client.init) {
        client.init = message;
        resolve(client);
      }
    });
    ws.once('error', reject);
    ws.once('open', () => {
      if (name) ws.send(JSON.stringify({ t: 'hello', id, name, team }));
      else resolve(client);
    });
    client.next = (predicate, from = 0, timeout = 8000) => new Promise((done, fail) => {
      const deadline = Date.now() + timeout;
      const check = () => {
        for (let i = from; i < client.messages.length; i++) {
          if (predicate(client.messages[i])) return done(client.messages[i]);
        }
        if (Date.now() >= deadline) return fail(new Error('timed out waiting for WebSocket message'));
        setTimeout(check, 10);
      };
      check();
    });
    client.send = message => ws.send(JSON.stringify(message));
    client.act = action => client.send({ t: 'act', seq: ++client.seq, ...action });
    client.admin = (cmd, extra = {}) => client.send({ t: 'admin', cmd, key: 'house-test-secret', ...extra });
  });
}

async function adminResult(client, from) {
  return client.next(message => message.t === 'adm', from);
}

async function testHouseFlow() {
  const instance = await launch();
  let red, blue, late, watcher;
  try {
    red = await connect(instance.port, 'Red player', 0, 'house-red-player');
    blue = await connect(instance.port, 'Blue player', 1, 'house-blue-player');
    watcher = await connect(instance.port, null, null, null, '?host');

    assert.strictEqual(watcher.messages.some(message => message.t === 'houseWatch'), false);

    const battleStartAt = red.messages.length;
    red.admin('start', { secs: 30, mode: 'battle' });
    assert.strictEqual((await adminResult(red, battleStartAt)).ok, true);
    await red.next(message => message.t === 'ch' && message.state === 'running' && message.mode === 'battle', battleStartAt);
    red.act({ tool: 'dda', pts: [[5, 5], [16, 16]], c: 4, f: 0 });
    assert.match((await red.next(message => message.t === 'rej' && message.seq === 1)).reason, /House Challenge/);
    ok('DDA is rejected during Normal Battle');

    const resetAt = red.messages.length;
    red.admin('reset');
    assert.strictEqual((await adminResult(red, resetAt)).ok, true);
    red.act({ tool: 'dda', pts: [[5, 5], [16, 16]], c: 4, f: 0 });
    assert.match((await red.next(message => message.t === 'rej' && message.seq === 2)).reason, /House Challenge/);
    ok('DDA is rejected outside a running challenge');

    const houseStartAt = red.messages.length;
    red.admin('start', { secs: 5, mode: 'house' });
    assert.strictEqual((await adminResult(red, houseStartAt)).ok, true);
    await red.next(message => message.t === 'ch' && message.state === 'running' && message.mode === 'house', houseStartAt);
    const blueStart = await blue.next(message => message.t === 'ch' && message.state === 'running' && message.mode === 'house');
    assert.strictEqual(blueStart.mode, 'house');
    assert.strictEqual(watcher.messages.some(message => message.t === 'houseWatch'), false,
      'the host query parameter alone does not authorize score disclosure');
    ok('House Challenge starts with a server-owned five-second timer; ?host alone does not authorize');

    const liveWatchAt = watcher.messages.length;
    watcher.send({ t: 'watch', key: 'house-test-secret' });
    assert.strictEqual((await watcher.next(message => message.t === 'watch', liveWatchAt)).ok, true);
    await watcher.next(message => message.t === 'houseWatch' && message.state === 'running', liveWatchAt);
    const failedWatchAt = watcher.messages.length;
    watcher.send({ t: 'watch', key: 'wrong-secret' });
    assert.strictEqual((await watcher.next(message => message.t === 'watch', failedWatchAt)).ok, false);

    red.act({ tool: 'dda', pts: [[60, 5], [70, 15]], c: 4, f: 0 });
    assert.match((await red.next(message => message.t === 'rej' && message.seq === 3)).reason, /own team zone/);
    const revokedAt = watcher.messages.length;
    const redScoreAt = red.messages.length;
    red.act({ tool: 'dda', pts: [[5, 5], [16, 16]], c: 4, f: 0 });
    await red.next(message => message.t === 'ok' && message.seq === 4);
    const redScore = await red.next(message => message.t === 'house' && message.marks === 10, redScoreAt);
    assert.strictEqual(redScore.team, 0);
    assert(Array.isArray(redScore.items), 'player receives a checklist for their own team');
    const blueScore = await blue.next(message => message.t === 'house' && message.team === 1);
    assert.strictEqual(blueScore.marks, 0);
    assert.strictEqual(red.messages.some(message => message.t === 'houseWatch'), false);
    assert.strictEqual(blue.messages.some(message => message.t === 'houseWatch'), false);
    const lastPx = red.messages.filter(message => message.t === 'px').at(-1);
    assert(lastPx && !Object.hasOwn(lastPx, 'sc'), 'House live pixel messages do not reveal all team scores');
    await sleep(150);
    assert.strictEqual(watcher.messages.slice(revokedAt).some(message => message.t === 'houseWatch'), false,
      'a failed watch attempt revokes the socket authorization');
    ok('team-zone enforcement and per-player score/checklist visibility work without live score leakage');

    const validAt = watcher.messages.length;
    watcher.send({ t: 'watch', key: 'house-test-secret' });
    assert.strictEqual((await watcher.next(message => message.t === 'watch', validAt)).ok, true);
    await watcher.next(message => message.t === 'houseWatch' && message.teams[0].marks === 10, validAt);
    const missingAt = watcher.messages.length;
    watcher.send({ t: 'watch' });
    assert.strictEqual((await watcher.next(message => message.t === 'watch', missingAt)).ok, false);
    const reauthAt = watcher.messages.length;
    watcher.send({ t: 'watch', key: 'house-test-secret' });
    assert.strictEqual((await watcher.next(message => message.t === 'watch', reauthAt)).ok, true);
    await watcher.next(message => message.t === 'houseWatch' && message.teams[0].marks === 10, reauthAt);
    ok('watch authorization is socket-scoped; valid watch reveals all marks and failed or missing keys revoke it');

    late = await connect(instance.port, 'Late joiner', 2, 'house-late-player');
    assert.strictEqual(late.init.ch.mode, 'house');
    assert.strictEqual(Object.hasOwn(late.init, 'scores'), false);
    const lateOwn = await late.next(message => message.t === 'house' && message.team === 2);
    assert.strictEqual(lateOwn.marks, 0);
    ok('late joiner receives current board, timer, and only their team checklist');

    const undoAt = red.messages.length;
    red.send({ t: 'undo', seq: ++red.seq });
    await red.next(message => message.t === 'undone', undoAt);
    const undoScore = await red.next(message => message.t === 'house' && message.marks === 0, undoAt);
    assert.strictEqual(undoScore.team, 0);
    const watcherUndo = await watcher.next(message => message.t === 'houseWatch' && message.teams[0].marks === 0);
    assert.strictEqual(watcherUndo.teams.length, 4);
    await sleep(520);
    const redoAt = red.messages.length;
    red.send({ t: 'redo', seq: ++red.seq });
    await red.next(message => message.t === 'redone', redoAt);
    await red.next(message => message.t === 'house' && message.marks === 10, redoAt);
    await watcher.next(message => message.t === 'houseWatch' && message.teams[0].marks === 10);
    ok('accepted drawing, Undo, and Redo recalculate and synchronize marks');

    const final = await red.next(message => message.t === 'ch' && message.state === 'ended' && message.mode === 'house');
    assert.deepStrictEqual(final.final, [10, 0, 0, 0]);
    assert.deepStrictEqual(final.winners, [0]);
    assert.strictEqual(final.resultSaved, true);
    const finalBreakdown = await late.next(message => message.t === 'houseFinal');
    assert.strictEqual(finalBreakdown.teams.length, 4);
    assert.deepStrictEqual(finalBreakdown.winners, [0]);
    await watcher.next(message => message.t === 'houseWatch' && message.state === 'ended');
    let resultFiles = fs.readdirSync(instance.dataDir)
      .filter(name => /^challenge-result-\d+\.json$/.test(name));
    assert.strictEqual(resultFiles.length, 1);
    let savedResult = JSON.parse(fs.readFileSync(path.join(instance.dataDir, resultFiles[0]), 'utf8'));
    assert.match(resultFiles[0], /^challenge-result-\d+\.json$/);
    assert(Number.isFinite(Date.parse(savedResult.endedAt)));
    assert.strictEqual(savedResult.durationMs, 5000);
    assert.deepStrictEqual(savedResult.scores, [10, 0, 0, 0]);
    assert.deepStrictEqual(savedResult.winners, [0]);
    assert.strictEqual(savedResult.teams.length, 4);
    assert.strictEqual(savedResult.teams[0].marks, 10);
    ok('timer completion announces the winner and reveals every final breakdown; host watch remains authorized');

    const tieStartAt = red.messages.length;
    red.admin('start', { secs: 5, mode: 'house' });
    assert.strictEqual((await adminResult(red, tieStartAt)).ok, true);
    await red.next(message => message.t === 'ch' && message.state === 'running' && message.mode === 'house', tieStartAt);
    await watcher.next(message => message.t === 'houseWatch' && message.state === 'running');
    const tie = await red.next(message => message.t === 'ch' && message.state === 'ended' && message.mode === 'house', tieStartAt);
    assert.deepStrictEqual(tie.final, [0, 0, 0, 0]);
    assert.deepStrictEqual(tie.winners, [0, 1, 2, 3]);
    resultFiles = fs.readdirSync(instance.dataDir)
      .filter(name => /^challenge-result-\d+\.json$/.test(name));
    assert.strictEqual(resultFiles.length, 2);
    savedResult = JSON.parse(fs.readFileSync(path.join(instance.dataDir, resultFiles[1]), 'utf8'));
    assert.deepStrictEqual(savedResult.scores, [0, 0, 0, 0]);
    assert.deepStrictEqual(savedResult.winners, [0, 1, 2, 3]);
    assert(savedResult.teams.every(team => team.items.length > 0));
    ok('host-watch authorization survives the next challenge reset; ties and result-file writing are correct');
  } finally {
    for (const client of [red, blue, late, watcher]) {
      if (client && client.ws.readyState < WebSocket.CLOSING) client.ws.close();
    }
    await stop(instance);
  }
}

async function testZonesDisabled() {
  const instance = await launch({ zones: false });
  let host;
  try {
    host = await connect(instance.port, 'Host', 0, 'house-no-zones');
    const from = host.messages.length;
    host.admin('start', { secs: 5, mode: 'house' });
    const result = await adminResult(host, from);
    assert.strictEqual(result.ok, false);
    assert.match(result.msg, /requires team zones/);
    ok('House Challenge start is refused when ZONES=0');
  } finally {
    if (host && host.ws.readyState < WebSocket.CLOSING) host.ws.close();
    await stop(instance);
  }
}

async function testResultWriteFailure() {
  const instance = await launch();
  let host;
  try {
    host = await connect(instance.port, 'Host', 0, 'house-results-failure');
    const from = host.messages.length;
    host.admin('start', { secs: 5, mode: 'house' });
    await host.next(message => message.t === 'adm' && message.ok, from);
    instance.backupDataDir = `${instance.dataDir}-backup`;
    fs.renameSync(instance.dataDir, instance.backupDataDir);
    fs.writeFileSync(instance.dataDir, 'blocking the result directory');
    const final = await host.next(message => message.t === 'ch' && message.state === 'ended' && message.mode === 'house');
    assert.strictEqual(final.resultSaved, false);
    const breakdown = await host.next(message => message.t === 'houseFinal');
    assert.deepStrictEqual(breakdown.scores, [0, 0, 0, 0]);
    assert.deepStrictEqual(breakdown.winners, [0, 1, 2, 3]);
    assert.strictEqual(fs.readdirSync(instance.backupDataDir)
      .some(name => /^challenge-result-\d+\.json$/.test(name)), false);
    ok('result-file write failure is reported without blocking challenge finalization or score disclosure');
  } finally {
    if (host && host.ws.readyState < WebSocket.CLOSING) host.ws.close();
    await stop(instance);
  }
}

async function testDdaReplayInBattleMode() {
  const entry = {
    n: 0, ts: 1, p: 'Earlier house player', u: 'houseplayer01',
    tm: 0, tool: 'dda', pts: [[5, 5], [16, 16]], c: 4, f: 0,
  };
  const instance = await launch({ log: JSON.stringify(entry) + '\n' });
  let player;
  try {
    player = await connect(instance.port, 'Replay viewer', 0, 'house-replay-viewer');
    assert.strictEqual(player.init.ch.state, 'idle');
    assert.strictEqual(Object.hasOwn(player.init.ch, 'mode'), false);
    const api = await request(instance.port, '/api/log');
    assert.strictEqual(api.status, 200);
    const archivedHouseLog = JSON.parse(api.body).log;
    assert.strictEqual(archivedHouseLog[0].tool, 'dda');
    const replay = Board.create(128, 128, 0);
    for (let i = 0; i < archivedHouseLog.length; i++) {
      const applied = Board.apply(replay, archivedHouseLog[i], i);
      assert(!applied.error, applied.error);
    }
    assert.strictEqual(Array.from(replay.fb.data).filter(colour => colour === 4).length, 12);
    assert.strictEqual(player.init.grid, Array.from(replay.fb.data, value => value.toString(36)).join(''));
    assert.deepStrictEqual(player.init.scores, [12, 0, 0, 0]);
    ok('a previously accepted House DDA log replays through the shared Board in battle mode');
  } finally {
    if (player && player.ws.readyState < WebSocket.CLOSING) player.ws.close();
    await stop(instance);
  }
}

(async () => {
  await testHouseFlow();
  await testZonesDisabled();
  await testResultWriteFailure();
  await testDdaReplayInBattleMode();
  console.log('\nhouse server tests passed');
})().catch(error => {
  console.error('FAIL', error);
  process.exitCode = 1;
});

/* End-to-end eraser tests using real WebSocket clients. Run: node tests/eraser-server.test.js */
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
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
}

function requestBody(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

async function launch() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-eraser-'));
  const port = await unusedPort();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, COOLDOWN_MS: '0',
      CHALLENGE_SECS: '60', ADMIN_KEY: 'eraser-test-secret', ZONES: '1' },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with code ${server.exitCode}`);
    try { if (await request(port, '/health') === 200) return { dataDir, port, server }; }
    catch (_) { /* Retry while the server starts. */ }
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
}

function connect(port, name, team, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = { ws, messages: [], seq: 0 };
    ws.on('message', data => {
      const message = JSON.parse(data);
      client.messages.push(message);
      if (message.t === 'init' && !client.init) { client.init = message; resolve(client); }
    });
    ws.once('error', reject);
    ws.once('open', () => ws.send(JSON.stringify({ t: 'hello', id, name, team })));
    client.next = (predicate, from = 0, timeout = 5000) => new Promise((done, fail) => {
      const deadline = Date.now() + timeout;
      const check = () => {
        for (let i = from; i < client.messages.length; i++) if (predicate(client.messages[i])) return done(client.messages[i]);
        if (Date.now() >= deadline) return fail(new Error('timed out waiting for WebSocket message'));
        setTimeout(check, 10);
      };
      check();
    });
    client.send = message => ws.send(JSON.stringify(message));
    client.act = action => client.send({ t: 'act', seq: ++client.seq, ...action });
    client.admin = (cmd, extra = {}) => client.send({ t: 'admin', cmd, key: 'eraser-test-secret', ...extra });
  });
}

async function act(client, action) {
  const from = client.messages.length;
  const seq = client.seq + 1;
  client.act(action);
  const ack = await client.next(message => message.t === 'ok' && message.seq === seq, from);
  return { ack, from };
}

function replayClient(client) {
  const colours = Array.from(client.init.grid, value => parseInt(value, 36));
  const teams = Array.from(client.init.teams, value => parseInt(value, 36) - 1);
  for (const message of client.messages) {
    if (message.t !== 'px') continue;
    for (let k = 0; k < message.idx.length; k++) {
      const i = message.idx[k];
      colours[i] = message.cols ? message.cols[k] : message.c;
      teams[i] = message.teams[k];
    }
  }
  return { colours, teams };
}

async function main() {
  const instance = await launch();
  let red, blue;
  try {
    red = await connect(instance.port, 'Eraser Red', 0, 'eraser-red-player');
    blue = await connect(instance.port, 'Blue observer', 1, 'eraser-blue-player');
    const actions = [
      { tool: 'circle', pts: [[20, 10], [25, 10]], c: 4, f: 1 },
      { tool: 'polygon', pts: [[10, 35], [38, 35], [24, 24]], c: 5, f: 1 },
      { tool: 'polygon', pts: [[12, 36], [36, 36], [36, 56], [12, 56]], c: 6, f: 1 },
    ];
    for (const action of actions) {
      const updateAt = blue.messages.length;
      const { ack } = await act(red, action);
      assert(ack.pixels > 0);
      await blue.next(message => message.t === 'px' && message.tool === action.tool, updateAt);
    }
    const before = replayClient(blue);
    const sunPixels = before.colours.map((colour, i) => colour === 4 ? i : -1).filter(i => i >= 0);
    assert(sunPixels.length > 0);
    const houseSamples = [35 * 128 + 20, 30 * 128 + 24, 45 * 128 + 12];
    const houseBefore = houseSamples.map(i => [before.colours[i], before.teams[i]]);

    const eraser = { tool: 'eraser', pts: [[15, 6], [25, 6], [25, 10], [15, 10], [15, 14], [25, 14]], c: 0, f: 0 };
    const eraseAt = blue.messages.length;
    const { ack: eraseAck } = await act(red, eraser);
    const eraseUpdate = await blue.next(message => message.t === 'px' && message.tool === 'eraser', eraseAt);
    assert.strictEqual(eraseUpdate.c, 0, 'the server canonicalizes erase colour to the board background');
    assert(eraseUpdate.idx.length > 0);
    const afterErase = replayClient(blue);
    for (const i of sunPixels) {
      assert.strictEqual(afterErase.colours[i], 0, 'sun pixel remains visible at ' + i);
      assert.strictEqual(afterErase.teams[i], -1, 'erased pixel retains team ownership at ' + i);
    }
    assert.deepStrictEqual(houseSamples.map(i => [afterErase.colours[i], afterErase.teams[i]]), houseBefore);
    assert.strictEqual(eraseUpdate.sc[0], before.teams.filter(team => team === 0).length - sunPixels.length);
    assert.deepStrictEqual(eraseUpdate.sc, afterErase.teams.reduce((scores, team) => {
      if (team >= 0) scores[team]++;
      return scores;
    }, [0, 0, 0, 0]));
    assert(eraseAck.undo > 0);
    console.log('  ok  multiplayer eraser clears the sun only, removes pixel ownership, and updates the scoreboard');

    const undoAt = blue.messages.length;
    const undoAckAt = red.messages.length;
    red.send({ t: 'undo', seq: ++red.seq });
    await red.next(message => message.t === 'undone', undoAckAt);
    await blue.next(message => message.t === 'px' && message.tool === 'undo', undoAt);
    const afterUndo = replayClient(blue);
    for (const i of sunPixels) {
      assert.strictEqual(afterUndo.colours[i], 4);
      assert.strictEqual(afterUndo.teams[i], 0);
    }
    await sleep(520);
    const redoAt = blue.messages.length;
    const redoAckAt = red.messages.length;
    red.send({ t: 'redo', seq: ++red.seq });
    await red.next(message => message.t === 'redone', redoAckAt);
    await blue.next(message => message.t === 'px' && message.tool === 'redo', redoAt);
    const afterRedo = replayClient(blue);
    for (const i of sunPixels) {
      assert.strictEqual(afterRedo.colours[i], 0);
      assert.strictEqual(afterRedo.teams[i], -1);
    }
    const apiLog = await requestBody(instance.port, '/api/log');
    assert.strictEqual(apiLog.status, 200);
    const replay = Board.create(128, 128, 0), entries = JSON.parse(apiLog.body).log;
    entries.forEach((entry, n) => assert(!Board.apply(replay, entry, n).error, `replay failed at ${n}`));
    assert.deepStrictEqual(Array.from(replay.fb.data), afterRedo.colours);
    assert.deepStrictEqual(Array.from(replay.teams), afterRedo.teams);
    console.log('  ok  eraser Undo and Redo synchronize for both players and replay from the action log');

    const startAt = red.messages.length;
    red.admin('start', { secs: 60, mode: 'house' });
    assert.strictEqual((await red.next(message => message.t === 'adm', startAt)).ok, true);
    await red.next(message => message.t === 'ch' && message.state === 'running' && message.mode === 'house', startAt);
    const ddaAt = red.messages.length;
    const { ack: ddaAck } = await act(red, { tool: 'dda', pts: [[5, 5], [16, 16]], c: 4, f: 0 });
    const ddaScore = await red.next(message => message.t === 'house' && message.marks === 10, ddaAt);
    assert.strictEqual(ddaScore.team, 0);
    const challengeEraseAt = red.messages.length;
    const { ack: challengeEraseAck } = await act(red, { tool: 'eraser', pts: [[10, 10]], c: 4, f: 0 });
    assert(challengeEraseAck.pixels > 0);
    const erasedScore = await red.next(message => message.t === 'house' && message.marks === 0, challengeEraseAt);
    assert.strictEqual(erasedScore.team, 0);
    console.log('  ok  erasing challenge pixels re-evaluates house marks without awarding eraser credit');

    const boundaryAt = red.messages.length;
    red.act({ tool: 'eraser', pts: [[62, 20], [64, 20]], c: 0, f: 0 });
    const rejected = await red.next(message => message.t === 'rej' && message.seq === red.seq, boundaryAt);
    assert.match(rejected.reason, /own team zone/);
    console.log('  ok  eraser brush footprints obey team-zone enforcement');
  } finally {
    for (const client of [red, blue]) if (client && client.ws.readyState < WebSocket.CLOSING) client.ws.close();
    await stop(instance);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

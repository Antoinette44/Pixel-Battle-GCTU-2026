/* Golden WebSocket transcript for one deterministic Normal Battle session. */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const expected = require('./fixtures/normal-battle.golden.json');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-golden-'));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

function waitForHealth(port, child) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (child.exitCode !== null) return reject(new Error(`server exited with code ${child.exitCode}`));
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, res => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error('server did not become healthy'));
      setTimeout(check, 25);
    };
    check();
  });
}

function waitForCount(messages, target, onMessage) {
  if (messages.length >= target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onMessage.removeListener('message', received);
      reject(new Error(`timed out waiting for ${target} WebSocket messages`));
    }, 3000);
    function received() {
      if (messages.length < target) return;
      clearTimeout(timer);
      onMessage.removeListener('message', received);
      resolve();
    }
    onMessage.on('message', received);
  });
}

function normalize(messages) {
  return messages.map(message => {
    if (message.t === 'init') {
      assert.strictEqual(message.grid, '0'.repeat(128 * 128));
      assert.strictEqual(message.teams, '0'.repeat(128 * 128));
      return { ...message, grid: '<blank-grid>', teams: '<unowned-teams>' };
    }
    if (message.t === 'px') {
      assert(Number.isSafeInteger(message.ts), 'drawing broadcast must include a numeric timestamp');
      return { ...message, ts: '<timestamp>' };
    }
    return message;
  });
}

async function run() {
  const port = await unusedPort();
  const server = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      CANVAS_SIZE: '128',
      COOLDOWN_MS: '0',
      CHALLENGE_SECS: '300',
      ZONES: '1',
    },
    stdio: 'ignore',
  });
  let socket;
  try {
    await waitForHealth(port, server);
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    socket.on('message', data => messages.push(JSON.parse(data)));
    await new Promise((resolve, reject) => {
      socket.once('open', () => socket.send(JSON.stringify({
        t: 'hello',
        id: 'golden-player-001',
        name: 'Baseline',
        team: 0,
      })));
      socket.once('error', reject);
      socket.once('message', () => resolve());
    });
    await waitForCount(messages, 2, socket);
    socket.send(JSON.stringify({
      t: 'act',
      seq: 1,
      tool: 'line',
      pts: [[10, 10], [12, 10]],
      c: 4,
      f: 0,
    }));
    await waitForCount(messages, 4, socket);

    assert.deepStrictEqual(normalize(messages), expected.messages);
    assert.strictEqual(messages.filter(message => message.t === 'ch').length, 0);
    assert.strictEqual(messages[0].ch.state, 'idle');
    console.log('Normal Battle golden transcript passed (4 server-to-client messages).');
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    if (server.exitCode === null) server.kill();
    await new Promise(resolve => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', resolve);
      setTimeout(resolve, 1000);
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

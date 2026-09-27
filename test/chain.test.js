'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PKG = path.resolve(__dirname, '..');
const NODE = process.execPath;
const CHAIN = path.join(PKG, 'src', 'supervisor', 'ctw-chain.js');
const MOCK = path.join(__dirname, 'mock-agent.js');

function runChain(env, cwd, extra) {
  return env === undefined
    ? null
    : execFileSync(NODE, [CHAIN, '--task', 'Finish the CleanTheWindow spike.', '--cwd', cwd, ...extra], {
        cwd,
        env: { ...process.env, ...env },
        timeout: 60000,
      }).toString();
}

test('chain mode: protocol handoff -> window 2 receives it -> CTW_COMPLETE', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-chain-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-mock-'));
  const env = {
    CTW_CHAIN_AGENT_CMD: '"' + NODE + '" "' + MOCK + '"',
    CTW_MOCK_STATE: path.join(stateDir, 'state'),
  };
  const out = runChain(env, tmp, ['--agent-cmd', '"' + NODE + '" "' + MOCK + '"']);
  assert.ok(out.includes('CTW_COMPLETE at window #2'));

  const prompt2 = fs.readFileSync(path.join(tmp, '.ctw', 'window-2-prompt.md'), 'utf8');
  assert.ok(prompt2.includes('HANDOFF FROM WINDOW #1'));
  assert.ok(prompt2.includes('NEXT_MARKER_WRITE_CHAIN_TESTS'), 'handoff content must reach window 2');
  const log = fs.readFileSync(path.join(tmp, '.ctw', 'chain-log.md'), 'utf8');
  assert.ok(log.includes('windows used: 2'));
  assert.ok(fs.existsSync(path.join(tmp, '.ctw', 'window-1-handoff.md')));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('chain mode: agent forgets the protocol, token safety net forces a rollover', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-chain-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-mock-'));
  const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-tr-'));
  const agentCmd = '"' + NODE + '" "' + MOCK + '"';
  const env = {
    CTW_CHAIN_AGENT_CMD: agentCmd,
    CTW_MOCK_STATE: path.join(stateDir, 'state'),
    CTW_MOCK_FORGET: '1',
    CTW_CHAIN_TRANSCRIPT_DIR: transcriptDir,
  };
  const out = execFileSync(
    NODE,
    [CHAIN, '--task', 'x', '--cwd', tmp, '--agent-cmd', agentCmd],
    { cwd: tmp, env: { ...process.env, ...env }, timeout: 60000 }
  ).toString();
  assert.ok(out.includes('forced rollover'), 'safety net must fire on protocol miss + high usage');
  assert.ok(out.includes('CTW_COMPLETE at window #2'));

  const log = fs.readFileSync(path.join(tmp, '.ctw', 'chain-log.md'), 'utf8');
  assert.ok(log.includes('transcript tokens=180000'));
  const prompt2 = fs.readFileSync(path.join(tmp, '.ctw', 'window-2-prompt.md'), 'utf8');
  assert.ok(prompt2.includes('forced rollover'));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(transcriptDir, { recursive: true, force: true });
});

test('chain mode: max windows cap stops an endless handoff loop', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-chain-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-mock-'));
  // agent always hands off (calls counter grows, but branch 1 only when calls===1)
  // -> use CTW_MOCK_FORGET on every call? simpler: mock hands off only on call 1,
  // so force max-windows=1 to test the cap on the first handoff.
  const agentCmd = '"' + NODE + '" "' + MOCK + '"';
  let code = 0;
  let out = '';
  try {
    execFileSync(NODE, [CHAIN, '--task', 'x', '--cwd', tmp, '--max-windows', '1', '--agent-cmd', agentCmd], {
      cwd: tmp,
      env: { ...process.env, CTW_MOCK_STATE: path.join(stateDir, 'state') },
      timeout: 60000,
    });
  } catch (e) {
    code = e.status;
    out = String(e.stdout || '');
  }
  assert.equal(code, 3, 'must exit 3 when the window cap is hit');
  assert.ok(out.includes('max windows'));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
});

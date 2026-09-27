'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PKG = path.resolve(__dirname, '..');
const { tokensFromTranscriptText, usageToTokens, parseJsonl } = require(path.join(PKG, 'src', 'core', 'tokens.js'));
const { loadConfig, evaluate } = require(path.join(PKG, 'src', 'core', 'config.js'));
const { extractDraft, writeDraft, findRestorable, fillTemplate } = require(path.join(PKG, 'src', 'core', 'handoff.js'));
const { mergeSettings, buildHooksConfig } = require(path.join(PKG, 'src', 'adapters', 'shared.js'));

const j = (o) => JSON.stringify(o);

const usage = (i, cc, cr, o) => ({ input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o });

test('token counting matches the verified real-transcript shape', () => {
  // shape confirmed against a real Claude Code transcript on 2026-09-27:
  // last assistant usage: input 0, cache_creation 29167, cache_read 18626
  const text = [
    j({ type: 'user', message: { role: 'user', content: 'hi' } }),
    j({ type: 'assistant', message: { role: 'assistant', usage: usage(100, 50, 200, 25) } }),
    j({ type: 'assistant', message: { role: 'assistant', usage: usage(0, 29167, 18626, 129) } }),
    j({ type: 'system', content: 'noise' }),
  ].join('\n');
  // occupancy = 0 + 29167 + 18626 + 129 = 47922 (last assistant only)
  assert.equal(tokensFromTranscriptText(text), 47922);
  assert.equal(usageToTokens(usage(100, 50, 200, 25)), 375);
  assert.equal(tokensFromTranscriptText('not json\n\n{"broken": '), 0);
  assert.equal(parseJsonl('{"a":1}\ngarbage\n{"b":2}').length, 2);
});

test('evaluate applies percent threshold with absolute floor', () => {
  const cfg = loadConfig(fs, { pkgRoot: PKG, cwd: os.tmpdir() }); // defaults
  // defaults: window 200000, rollover 75%, floor 30000
  assert.equal(evaluate(cfg, 140000).rolloverHit, false); // 70% -> no
  assert.equal(evaluate(cfg, 160000).rolloverHit, true);  // 80% -> yes
  assert.equal(evaluate(cfg, 10000).rolloverHit, false);  // below floor
  assert.equal(evaluate(cfg, 120000).warnHit, true);      // 60% warn
  // floor protects small sessions from early rollover
  const tiny = evaluate({ threshold: { rolloverPercent: 75, absoluteFloorTokens: 30000, contextWindowTokens: 200000 } }, 31000);
  assert.equal(tiny.rolloverHit, false); // 15.5% >= floor but way below 75%
});

test('extractDraft pulls user messages, file paths and commands', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'fix the login bug in src/auth.js' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Reading the file first.' },
      { type: 'tool_use', input: { file_path: '/proj/src/auth.js' } },
      { type: 'tool_use', input: { command: 'npm test' } },
    ] } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Found the bug: missing null check.' },
    ] } },
  ];
  const d = extractDraft(lines, {});
  assert.ok(d.userMsgs.some((m) => m.includes('login bug')));
  assert.ok(d.files.includes('/proj/src/auth.js'));
  assert.ok(d.cmds.includes('npm test'));
  assert.equal(d.lastAssistantText, 'Found the bug: missing null check.');
  assert.equal(fillTemplate(d, { sessionId: 's1', cwd: '/proj', tokens: 100, pct: 50 }).includes('# CTW Handoff'), true);
});

test('writeDraft then findRestorable: happy path, freshness and cwd guards', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctw-test-'));
  const cfg = { handoff: { dir: '.ctw', maxAgeSeconds: 900, requireSameCwd: true } };
  const { file } = writeDraft(fs, tmp, cfg, { userMsgs: ['do X'], files: ['/x'], cmds: [], lastAssistantText: 'y' }, { sessionId: 's1', cwd: tmp, tokens: 1, pct: 1 });
  assert.ok(fs.existsSync(file));

  const ok = findRestorable(fs, tmp, cfg, {});
  assert.ok(ok && ok.body.includes('do X'));

  // stale -> null
  const stale = JSON.parse(fs.readFileSync(path.join(tmp, '.ctw', 'latest.json'), 'utf8'));
  stale.ts = Date.now() - 901 * 1000;
  fs.writeFileSync(path.join(tmp, '.ctw', 'latest.json'), JSON.stringify(stale));
  assert.equal(findRestorable(fs, tmp, cfg, {}), null);

  // restore freshness, wrong cwd -> null
  const fresh = JSON.parse(fs.readFileSync(path.join(tmp, '.ctw', 'latest.json'), 'utf8'));
  fresh.ts = Date.now();
  fs.writeFileSync(path.join(tmp, '.ctw', 'latest.json'), JSON.stringify(fresh));
  assert.equal(findRestorable(fs, tmp + '-other', cfg, {}), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('mergeSettings never clobbers existing hooks and stays idempotent', () => {
  const ours = buildHooksConfig(PKG, 'claude-code');
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } };
  const m1 = mergeSettings(existing, ours);
  assert.equal(m1.hooks.Stop.length, 2); // existing kept + ours added
  const m2 = mergeSettings(m1, ours);
  assert.equal(m2.hooks.Stop.length, 2); // second run does not duplicate
  assert.equal(m1.hooks.SessionStart[0].matcher, 'clear');
  assert.ok(m1.hooks.SessionStart[0].hooks[0].command.includes('ctw-restore-handoff'));
});

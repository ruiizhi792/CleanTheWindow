#!/usr/bin/env node
'use strict';

/**
 * CleanTheWindow — chain supervisor (automatic window rollover).
 *
 * Runs a task across multiple FRESH context windows:
 *
 *   window 1: claude -p "<task + protocol>"
 *     agent hits context pressure -> ends with CTW_HANDOFF + handoff
 *   window 2: claude -p "<continuation prompt with handoff + protocol>"
 *     ... repeats until the agent ends with CTW_COMPLETE
 *
 * Deterministic safety net: after every run, the real transcript token usage
 * is checked; if the threshold is crossed and the agent forgot the protocol,
 * we draft a handoff from the transcript and roll over anyway.
 *
 * Works with any Claude Code-family CLI that supports `-p <prompt>`
 * (Claude Code, WorkBuddy/CodeBuddy CLI). Override the command via
 * --agent-cmd or CTW_CHAIN_AGENT_CMD (used by tests and mocks).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const { loadConfig, evaluate } = require(path.join(PKG_ROOT, 'src', 'core', 'config.js'));
const { parseJsonl, lastAssistantUsage, usageToTokens } = require(path.join(PKG_ROOT, 'src', 'core', 'tokens.js'));
const { extractDraft, fillTemplate } = require(path.join(PKG_ROOT, 'src', 'core', 'handoff.js'));

const MARK_COMPLETE = 'CTW_COMPLETE';
const MARK_HANDOFF = 'CTW_HANDOFF';

function transcriptDirFor(cwd) {
  if (process.env.CTW_CHAIN_TRANSCRIPT_DIR) return process.env.CTW_CHAIN_TRANSCRIPT_DIR;
  const home = process.env.USERPROFILE || process.env.HOME;
  const munged = String(cwd).replace(/[:\\/]+/g, '-');
  return path.join(home, '.claude', 'projects', munged);
}

/** Newest transcript file in dir newer than `since` (ms), or null. */
function newestTranscript(dir, since) {
  let best = null;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= since && (!best || st.mtimeMs > best.mtime)) best = { p, mtime: st.mtimeMs };
    } catch { /* skip */ }
  }
  return best ? best.p : null;
}

function tokensOfTranscript(file) {
  const lines = parseJsonl(fs.readFileSync(file, 'utf8'));
  return usageToTokens(lastAssistantUsage(lines));
}

function buildProtocol(windowNo) {
  return [
    '=== CTW chain protocol (window #' + windowNo + ') ===',
    'You are one window in a chain managed by CleanTheWindow. Each window gets a fresh context.',
    '1. Work autonomously until the task is fully done. Do not stop to ask questions.',
    '2. When the whole task is done, end your final message with a line containing exactly: ' + MARK_COMPLETE,
    '3. If you cannot finish in this window (context filling up, or a natural checkpoint),',
    '   end your final message with a line containing exactly: ' + MARK_HANDOFF,
    '   followed by a handoff in exactly this markdown structure, nothing after it:',
    '',
    '   ## Goal',
    '   ## Current state',
    '   ## Next step',
    '   ## Key decisions',
    '   ## Files touched',
    '   ## Pitfalls / notes',
    '   ## How to verify',
    '',
  ].join('\n');
}

function continuationPrompt(handoff, windowNo) {
  return [
    'You are window #' + windowNo + ' of a task chain. The previous window ran out of context and wrote the handoff below.',
    'Read it, verify the current state it describes (files, tests), and continue from "Next step".',
    'Do NOT redo work the handoff marks as done. Do not re-ask the user anything — work autonomously.',
    '',
    '--- HANDOFF FROM WINDOW #' + (windowNo - 1) + ' ---',
    handoff,
    '--- END HANDOFF ---',
    '',
    buildProtocol(windowNo),
  ].join('\n');
}

function extractHandoff(output) {
  const idx = output.lastIndexOf(MARK_HANDOFF);
  if (idx === -1) return null;
  const body = output.slice(idx + MARK_HANDOFF.length).trim();
  return body.length > 40 ? body : null; // a real handoff is never tiny
}

/** Run the agent CLI once. Resolves { code, output }. */
function runAgent(cmd, args, cwd, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timeoutMs = (opts.runTimeoutSec || 0) * 1000;
    let killed = false;
    const timer = timeoutMs ? setTimeout(() => { killed = true; child.kill(); }, timeoutMs) : null;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, output: '', error: String(e && e.message || e) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: killed ? 124 : code, output: out, error: err });
    });
  });
}

function parseArgs(argv) {
  const o = { cwd: process.cwd(), agentCmd: process.env.CTW_CHAIN_AGENT_CMD || 'claude', maxWindows: 10, extraArgs: [], task: null, taskFile: null, runTimeoutSec: 0, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') o.task = argv[++i];
    else if (a === '--task-file') o.taskFile = argv[++i];
    else if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--agent-cmd') o.agentCmd = argv[++i];
    else if (a === '--max-windows') o.maxWindows = Number(argv[++i]);
    else if (a === '--extra-args') o.extraArgs = String(argv[++i]).split(/\s+/).filter(Boolean);
    else if (a === '--run-timeout') o.runTimeoutSec = Number(argv[++i]);
    else if (a === '--dry-run') o.dryRun = true;
    else { console.error('Unknown arg: ' + a); process.exit(2); }
  }
  if (o.taskFile) o.task = fs.readFileSync(path.resolve(o.taskFile), 'utf8');
  if (!o.task) { console.error('Provide --task "..." or --task-file <file>'); process.exit(2); }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const config = loadConfig(fs, { pkgRoot: PKG_ROOT, cwd: o.cwd });
  const ctwDir = path.join(o.cwd, (config.handoff && config.handoff.dir) || '.ctw');
  fs.mkdirSync(ctwDir, { recursive: true });
  const logFile = path.join(ctwDir, 'chain-log.md');
  const log = (s) => { fs.appendFileSync(logFile, s + '\n', 'utf8'); process.stdout.write(s + '\n'); };

  log('# CleanTheWindow chain started ' + new Date().toISOString());
  log('# task: ' + String(o.task).slice(0, 200).replace(/\n/g, ' '));

  let handoff = null;
  for (let windowNo = 1; windowNo <= o.maxWindows; windowNo++) {
    const prompt = windowNo === 1
      ? String(o.task).trim() + '\n\n' + buildProtocol(1)
      : continuationPrompt(handoff, windowNo);

    // persist the exact prompt so every window is auditable
    fs.writeFileSync(path.join(ctwDir, 'window-' + windowNo + '-prompt.md'), prompt, 'utf8');

    if (o.dryRun) { log('[dry-run] window #' + windowNo + ' prompt saved, not spawning.'); return; }

    const since = Date.now();
    log('## window #' + windowNo + ' starting (' + new Date().toISOString() + ')');
    const parts = String(o.agentCmd).match(/"([^"]*)"|\S+/g) || [];
    const [cmd, ...cmdRest] = parts.map((p) => p.replace(/^"|"$/g, ''));
    const res = await runAgent(cmd, [...cmdRest, '-p', prompt, ...o.extraArgs], o.cwd, o);

    if (res.code === -1) {
      log('FATAL: could not launch agent command "' + o.agentCmd + '": ' + res.error);
      log('Set --agent-cmd / CTW_CHAIN_AGENT_CMD, or make sure the CLI is on PATH.');
      process.exit(1);
    }
    fs.writeFileSync(path.join(ctwDir, 'window-' + windowNo + '-output.txt'), res.output || '', 'utf8');
    log('window #' + windowNo + ' exited code=' + res.code + ', output ' + (res.output || '').length + ' chars');

    if (res.output.includes(MARK_COMPLETE)) {
      log('## ' + MARK_COMPLETE + ' at window #' + windowNo + ' — chain finished.');
      log('# windows used: ' + windowNo + '; handoffs: ' + (windowNo - 1));
      process.exit(0);
    }

    const agentHandoff = extractHandoff(res.output);
    let usedHandoff = agentHandoff;

    if (!usedHandoff) {
      // protocol miss: deterministic safety net — check real token usage
      const tFile = newestTranscript(transcriptDirFor(o.cwd), since);
      const tokens = tFile ? tokensOfTranscript(tFile) : 0;
      const ev = evaluate(config, tokens);
      log('no protocol marker; transcript tokens=' + tokens + ' (' + ev.pct.toFixed(1) + '%)');
      if (ev.rolloverHit && tFile) {
        const draft = fillTemplate(extractDraft(parseJsonl(fs.readFileSync(tFile, 'utf8')), (config.handoff && config.handoff.draft) || {}), {
          sessionId: 'window-' + windowNo, cwd: o.cwd, tokens, pct: ev.pct,
        });
        usedHandoff = draft + '\n(forced rollover: threshold crossed without ' + MARK_HANDOFF + ' marker)';
        log('threshold crossed -> forced rollover with draft handoff');
      } else {
        log('no marker and below threshold -> treating run as complete (ambiguous end).');
        log('# windows used: ' + windowNo + '; handoffs: ' + (windowNo - 1));
        process.exit(0);
      }
    }

    fs.writeFileSync(path.join(ctwDir, 'window-' + windowNo + '-handoff.md'), usedHandoff, 'utf8');
    log('handoff saved (' + usedHandoff.length + ' chars) -> rolling to window #' + (windowNo + 1));
    handoff = usedHandoff;
  }

  log('## max windows (' + o.maxWindows + ') reached without ' + MARK_COMPLETE + ' — stopping. Last handoff: window-' + o.maxWindows + '-handoff.md');
  process.exit(3);
}

main();

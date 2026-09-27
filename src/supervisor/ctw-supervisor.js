#!/usr/bin/env node
'use strict';

/**
 * CleanTheWindow — supervisor (spike version).
 *
 * Monitors the newest transcript for the given project directory, evaluates
 * occupancy against thresholds, and:
 *   - WARN:   prints a notice once per crossing
 *   - ROLLOVER: writes a handoff draft (same logic as the write hook) and
 *               instructs the user to run /clear.
 *
 * Full automatic rollover (PTY wrapper that triggers /clear itself) is the
 * v0.1 target; this spike ships the deterministic half that hooks can verify
 * end to end. Everything the automatic mode needs flows through
 * onRolloverReady() below.
 *
 * Usage:
 *   node ctw-supervisor.js <projectDir> [--once]
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const { parseJsonl, lastAssistantUsage, usageToTokens } = require(path.join(PKG_ROOT, 'src', 'core', 'tokens.js'));
const { loadConfig, evaluate } = require(path.join(PKG_ROOT, 'src', 'core', 'config.js'));
const { extractDraft, writeDraft } = require(path.join(PKG_ROOT, 'src', 'core', 'handoff.js'));

/** Where Claude Code family CLIs keep per-project transcripts. */
function transcriptRoot(home, mungedCwd) {
  return path.join(home, '.claude', 'projects', mungedCwd);
}

function mungeCwd(dir) {
  return String(dir).replace(/[:\\/]/g, '-');
}

function newestTranscript(fs, home, cwd) {
  const dir = transcriptRoot(home, mungeCwd(cwd));
  let best = null;
  let bestMtime = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.mtimeMs > bestMtime) { bestMtime = st.mtimeMs; best = p; }
    }
  } catch {
    return null;
  }
  return best;
}

function readTokens(fs, file) {
  const text = fs.readFileSync(file, 'utf8');
  const usage = lastAssistantUsage(parseJsonl(text));
  return { tokens: usageToTokens(usage), lines: parseJsonl(text) };
}

/** Hook for the future automatic mode: swap this for the PTY trigger. */
function onRolloverReady(fs, cwd, config, lines, ev, transcriptFile) {
  const extracted = extractDraft(lines, (config.handoff && config.handoff.draft) || {});
  const { file } = writeDraft(fs, cwd, config, extracted, {
    sessionId: path.basename(transcriptFile, '.jsonl'),
    cwd,
    tokens: ev.tokens,
    pct: ev.pct,
  });
  console.log('');
  console.log('[CleanTheWindow] ROLLOVER THRESHOLD HIT (' + Math.round(ev.pct) + '%, ~' + ev.tokens + ' tokens)');
  console.log('[CleanTheWindow] Handoff written: ' + file);
  console.log('[CleanTheWindow] Run /clear in the agent now — the handoff will be restored into the new window.');
}

function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const projectDir = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  const config = loadConfig(fs, { pkgRoot: PKG_ROOT, cwd: projectDir });

  let lastState = 'below';

  const tick = () => {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const t = newestTranscript(fs, home, projectDir);
    if (!t) return; // no transcripts yet — nothing to monitor
    let r;
    try {
      r = readTokens(fs, t);
    } catch {
      return;
    }
    if (!r.tokens) return;

    const ev = evaluate(config, r.tokens);
    const state = ev.rolloverHit ? 'rollover' : ev.warnHit ? 'warn' : 'below';

    if (state === 'rollover' && lastState !== 'rollover') {
      onRolloverReady(fs, projectDir, config, r.lines, ev, t);
    } else if (state === 'warn' && lastState === 'below') {
      console.log('[CleanTheWindow] WARN: occupancy ' + Math.round(ev.pct) + '% (~' + ev.tokens + ' tokens). Handoff will be written at ' + config.threshold.rolloverPercent + '%.');
    }
    lastState = state;
  };

  if (once) { tick(); return; }
  const pollSec = (config.supervisor && config.supervisor.pollSeconds) || 30;
  console.log('[CleanTheWindow] supervising ' + projectDir + ' (poll ' + pollSec + 's, rollover ' + config.threshold.rolloverPercent + '%)');
  tick();
  setInterval(tick, pollSec * 1000);
}

main();

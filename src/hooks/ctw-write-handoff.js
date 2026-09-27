#!/usr/bin/env node
'use strict';

/**
 * CleanTheWindow — write-handoff hook.
 *
 * Register on: Stop (primary) and PreCompact (catch-all).
 * Reads the hook JSON from stdin, checks current occupancy against the
 * configured threshold, and writes a structured handoff draft to <cwd>/.ctw/.
 *
 * Output: JSON with systemMessage when a handoff was written (visible hint),
 * silent no-op in every other case — never breaks the hook pipeline.
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const { tokensFromTranscriptText, parseJsonl } = require(path.join(PKG_ROOT, 'src', 'core', 'tokens.js'));
const { loadConfig, evaluate } = require(path.join(PKG_ROOT, 'src', 'core', 'config.js'));
const { extractDraft, writeDraft } = require(path.join(PKG_ROOT, 'src', 'core', 'handoff.js'));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0); // no stdin — nothing to do
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const config = loadConfig(fs, { pkgRoot: PKG_ROOT, cwd });
  const event = input.hook_event_name || '';
  const force = event === 'PreCompact'; // PreCompact always writes (last-resort safety net)

  // occupancy
  let tokens = 0;
  let lines = [];
  if (input.transcript_path) {
    try {
      const text = fs.readFileSync(input.transcript_path, 'utf8');
      tokens = tokensFromTranscriptText(text);
      lines = parseJsonl(text);
    } catch {
      process.exit(0); // unreadable transcript — degrade silently
    }
  }
  const ev = evaluate(config, tokens);

  if (!force && !ev.warnHit) process.exit(0);

  // write the draft
  try {
    const extracted = extractDraft(lines, (config.handoff && config.handoff.draft) || {});
    const { file } = writeDraft(fs, cwd, config, extracted, {
      sessionId: input.session_id,
      cwd,
      tokens: ev.tokens,
      pct: ev.pct,
    });
    const why = force ? 'pre-compact safety net' : Math.round(ev.pct) + '% occupancy';
    emit({
      systemMessage: '[CleanTheWindow] Handoff written (' + why + ') -> ' + path.basename(file) +
        '. Run /clear when ready; the handoff will be restored automatically.',
    });
  } catch {
    process.exit(0); // any failure: silent no-op
  }
}

main();

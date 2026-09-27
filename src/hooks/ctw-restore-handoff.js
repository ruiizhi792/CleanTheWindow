#!/usr/bin/env node
'use strict';

/**
 * CleanTheWindow — restore-handoff hook.
 *
 * Register on: SessionStart with matcher "clear" (a fresh window after rollover).
 * Guards: handoff must be recent (maxAgeSeconds) and match the cwd.
 * Injects the handoff body via hookSpecificOutput.additionalContext so the new
 * window starts with goal / state / next step / files / pitfalls / verification.
 */

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const { loadConfig } = require(path.join(PKG_ROOT, 'src', 'core', 'config.js'));
const { findRestorable } = require(path.join(PKG_ROOT, 'src', 'core', 'handoff.js'));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cwd = input.cwd || process.cwd();
  const config = loadConfig(fs, { pkgRoot: PKG_ROOT, cwd });

  let restored;
  try {
    restored = findRestorable(fs, cwd, config, input);
  } catch {
    process.exit(0);
  }
  if (!restored) process.exit(0);

  const banner = [
    '=== CleanTheWindow handoff restored (' + new Date().toISOString() + ') ===',
    'You are in a FRESH context window. A previous window was rolled over when its',
    'context filled up. Below is the handoff document from that window. Read it,',
    'verify the state it describes (files, tests), and continue the task from',
    '"Next step". Do not re-ask the user for information that is already here.',
    '',
    restored.body,
  ].join('\n');

  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: banner,
    },
  });
}

main();

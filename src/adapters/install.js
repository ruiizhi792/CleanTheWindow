#!/usr/bin/env node
'use strict';

/**
 * CleanTheWindow installer / uninstaller for Claude Code and WorkBuddy (CodeBuddy CLI).
 *
 * Usage:
 *   node install.js claude-code [--uninstall]
 *   node install.js workbuddy   [--uninstall]
 *
 * - Merges hook entries into ~/.claude/settings.json or ~/.codebuddy/settings.json
 * - Never clobbers existing hooks; backs up settings first; idempotent.
 * - WorkBuddy note: edited settings require review in the CLI /hooks panel.
 */

const fs = require('fs');
const path = require('path');

const { install, mergeSettings, buildHooksConfig } = require('./shared.js');

const HOME = process.env.USERPROFILE || process.env.HOME;
const PKG_ROOT = path.resolve(__dirname, '..', '..');

const TOOLS = {
  'claude-code': {
    settingsPath: path.join(HOME, '.claude', 'settings.json'),
    postInstallHint: 'Restart Claude Code. Hooks take effect on the next session.',
  },
  workbuddy: {
    settingsPath: path.join(HOME, '.codebuddy', 'settings.json'),
    postInstallHint: 'Open the WorkBuddy CLI and run /hooks to review and apply the new hooks (edited settings need one manual trust step).',
  },
};

function uninstall(tool) {
  const settingsPath = TOOLS[tool].settingsPath;
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    console.log('Nothing to uninstall (no settings file).');
    return;
  }
  const out = JSON.parse(JSON.stringify(existing));
  let removed = 0;
  out.hooks = out.hooks || {};
  for (const event of Object.keys(out.hooks)) {
    const kept = [];
    for (const grp of out.hooks[event]) {
      const isCtw = Array.isArray(grp && grp.hooks) &&
        grp.hooks.some((h) => h && /ctw-(write|restore)-handoff/.test(h.command || ''));
      if (isCtw) removed++; else kept.push(grp);
    }
    out.hooks[event] = kept;
  }
  fs.writeFileSync(settingsPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Removed ' + removed + ' CleanTheWindow hook group(s) from ' + settingsPath);
}

function main() {
  const [tool, flag] = process.argv.slice(2);
  if (!TOOLS[tool]) {
    console.log('Usage: node install.js <claude-code|workbuddy> [--uninstall]');
    process.exit(1);
  }
  if (flag === '--uninstall') { uninstall(tool); return; }

  const res = install(fs, {
    pkgRoot: PKG_ROOT,
    settingsPath: TOOLS[tool].settingsPath,
    tool,
    postInstallHint: TOOLS[tool].postInstallHint,
  });
  console.log('CleanTheWindow installed for ' + tool + ':');
  console.log('  settings : ' + res.settingsPath);
  if (res.backup) console.log('  backup   : ' + res.backup);
  console.log('');
  console.log('  ' + res.postInstallHint);
}

main();

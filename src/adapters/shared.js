'use strict';

/**
 * Shared installer logic for Claude Code-family tools.
 * Both adapters use this; only paths and the trust hint differ.
 */

const path = require('path');

function hookEntry(hookFile, matcher) {
  const entry = { type: 'command', command: 'node "' + hookFile + '"' };
  const out = { hooks: [entry] };
  if (matcher) out.matcher = matcher;
  return out;
}

function buildHooksConfig(pkgRoot, tool) {
  const write = path.join(pkgRoot, 'src', 'hooks', 'ctw-write-handoff.js');
  const restore = path.join(pkgRoot, 'src', 'hooks', 'ctw-restore-handoff.js');
  return {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node "' + write + '"' }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: 'node "' + write + '"' }] }],
      SessionStart: [
        {
          matcher: 'clear',
          hooks: [{ type: 'command', command: 'node "' + restore + '"' }],
        },
      ],
    },
  };
}

/** Merge our hook entries into an existing settings object without clobbering. */
function mergeSettings(existing, ours) {
  const out = JSON.parse(JSON.stringify(existing || {}));
  out.hooks = out.hooks || {};
  for (const event of Object.keys(ours.hooks)) {
    out.hooks[event] = Array.isArray(out.hooks[event]) ? out.hooks[event].slice() : [];
    for (const grp of ours.hooks[event]) {
      const dup = out.hooks[event].some((g) =>
        Array.isArray(g && g.hooks) && g.hooks.some((h) => h && /ctw-(write|restore)-handoff/.test(h.command || ''))
      );
      if (!dup) out.hooks[event].push(grp);
    }
  }
  return out;
}

function install(fs, opts) {
  const { pkgRoot, settingsPath, tool, postInstallHint } = opts;
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  let existing = {};
  let backup = null;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    backup = settingsPath + '.ctw-backup-' + Date.now();
    fs.copyFileSync(settingsPath, backup);
  } catch {
    /* no existing settings — fresh install */
  }
  const merged = mergeSettings(existing, buildHooksConfig(pkgRoot, tool));
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return { settingsPath, backup, postInstallHint };
}

module.exports = { install, buildHooksConfig, mergeSettings };

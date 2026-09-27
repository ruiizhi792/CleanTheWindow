'use strict';

/**
 * Handoff document write / read / restore guards.
 *
 * Draft mode is deterministic (no LLM): extract recent user messages, files
 * touched (from tool_use inputs), recent commands and last assistant text from
 * the transcript, then fill the seven-field template.
 * The agent-facing "polished mode" prompt lives in templates/handoff-template.md.
 */

const path = require('path');

function handoffDir(cwd, config) {
  return path.join(cwd, (config.handoff && config.handoff.dir) || '.ctw');
}

/** Extract material for the draft from parsed transcript lines. */
function extractDraft(lines, opts) {
  const o = opts || {};
  const maxUser = o.maxUserMessages || 8;
  const maxAsstChars = o.maxAssistantChars || 1200;
  const maxFiles = o.maxFileEntries || 15;
  const maxCmds = o.maxCommandEntries || 10;

  const userMsgs = [];
  const files = [];
  const cmds = [];
  let lastAssistantText = '';

  for (let i = lines.length - 1; i >= 0; i--) {
    const d = lines[i];
    if (!d || !d.message) continue;

    if (d.type === 'user' && userMsgs.length < maxUser) {
      const c = d.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c)
        ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join(' ')
        : '';
      const t = String(text).trim();
      if (t && !t.startsWith('<') && !/^\[(Request interrupted|API Error)/.test(t) && userMsgs.indexOf(t) === -1) {
        userMsgs.push(t.slice(0, 300));
      }
    }

    if (d.type === 'assistant') {
      const c = d.message.content;
      if (Array.isArray(c)) {
        for (const blk of c) {
          if (blk && blk.type === 'tool_use') {
            const inp = blk.input || {};
            const fp = inp.file_path || inp.path || inp.notebook_path;
            if (fp && files.length < maxFiles && files.indexOf(fp) === -1) files.push(fp);
            if (inp.command && cmds.length < maxCmds) cmds.push(String(inp.command).slice(0, 200));
          }
        }
      }
    }
  }

  // last assistant text: scan from the end for the nearest text block
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = lines[i];
    if (d && d.type === 'assistant' && Array.isArray(d.message && d.message.content)) {
      const txt = d.message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ').trim();
      if (txt) { lastAssistantText = txt.slice(0, maxAsstChars); break; }
    }
  }

  return { userMsgs: userMsgs.reverse(), files: files.reverse(), cmds: cmds.reverse(), lastAssistantText };
}

function fillTemplate(extracted, meta) {
  const { userMsgs, files, cmds, lastAssistantText } = extracted;
  const list = (arr, empty) => (arr.length ? arr.map((x) => '- ' + x).join('\n') : '- (' + empty + ')');
  const ts = new Date().toISOString();

  return [
    '# CTW Handoff',
    '',
    '- Generated: ' + ts,
    '- Session: ' + (meta.sessionId || 'unknown'),
    '- CWD: `' + (meta.cwd || 'unknown') + '`',
    '- Occupancy: ' + String(meta.tokens || '?') + ' tokens (' + String(Math.round(meta.pct || 0)) + '%)',
    '- Mode: draft (script-generated; ask the agent to polish via the handoff prompt for best results)',
    '',
    '## Goal',
    '(DRAFT: most recent user instruction below — agent should restate the task goal precisely.)',
    list(userMsgs, 'no user messages captured'),
    '',
    '## Current state',
    '(DRAFT: last assistant output below.)',
    lastAssistantText ? lastAssistantText : '- (no assistant text captured)',
    '',
    '## Next step',
    '(DRAFT — agent fills in.)',
    '',
    '## Key decisions',
    '(DRAFT — agent fills in from conversation.)',
    '',
    '## Files touched',
    list(files, 'no file paths captured'),
    '',
    '## Pitfalls / notes',
    list(cmds.slice(0, 5), 'no commands captured'),
    '',
    '## How to verify',
    '(DRAFT — agent fills in: commands to run, expected outcomes.)',
    '',
  ].join('\n');
}

/** Write a draft handoff + latest.json pointer. Returns { file } or throws. */
function writeDraft(fs, cwd, config, extracted, meta) {
  const dir = handoffDir(cwd, config);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, 'handoff-' + stamp + '.md');
  const body = fillTemplate(extracted, meta);
  fs.writeFileSync(file, body, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'latest.json'),
    JSON.stringify({ file: path.basename(file), ts: Date.now(), cwd, sessionId: meta.sessionId || null, tokens: meta.tokens || null }),
    'utf8'
  );
  return { file, body };
}

/**
 * Find the restorable handoff for a session start (guard: cwd match + freshness).
 * Returns { body, file } or null (nothing to restore is a normal outcome).
 */
function findRestorable(fs, cwd, config, hookInput) {
  const dir = handoffDir(cwd, config);
  const latestPath = path.join(dir, 'latest.json');
  let latest;
  try {
    latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  } catch {
    return null;
  }
  const maxAge = (config.handoff && config.handoff.maxAgeSeconds) || 900;
  if (!latest.ts || Date.now() - latest.ts > maxAge * 1000) return null;
  if ((config.handoff && config.handoff.requireSameCwd) !== false) {
    const latestCwd = latest.cwd || '';
    if (cwd && latestCwd && path.resolve(latestCwd) !== path.resolve(cwd)) return null;
  }
  const file = path.join(dir, latest.file);
  try {
    const body = fs.readFileSync(file, 'utf8');
    return { body, file };
  } catch {
    return null;
  }
}

module.exports = { extractDraft, writeDraft, findRestorable, handoffDir, fillTemplate };

'use strict';

/**
 * Mock agent for chain tests. Emulates `claude -p <prompt>`:
 *  - window 1: ends with CTW_HANDOFF + a seven-field handoff
 *  - window 2+: ends with CTW_COMPLETE
 *  - CTW_MOCK_FORGET=1: window 1 emits no marker, writes a fake transcript
 *    with high token usage (exercises the forced-rollover safety net)
 */

const fs = require('fs');

const stateFile = process.env.CTW_MOCK_STATE;
const transcriptDir = process.env.CTW_CHAIN_TRANSCRIPT_DIR;
const prompt = process.argv[process.argv.indexOf('-p') + 1];

let calls = 0;
try { calls = Number(fs.readFileSync(stateFile, 'utf8')) || 0; } catch { calls = 0; }
calls += 1;
fs.mkdirSync(require('path').dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, String(calls));

function fakeTranscript(tokens) {
  const line = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
  });
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(require('path').join(transcriptDir, 'mock-session.jsonl'), line + '\n');
}

if (process.env.CTW_MOCK_FORGET === '1' && calls === 1) {
  fakeTranscript(180000); // 90% of a 200k window, well past the 75% rollover threshold
  process.stdout.write('I refactored three files and think I am mostly done for now.');
  process.exit(0);
}

if (calls === 1) {
  process.stdout.write(
    [
      'Window one work: built the token counter core.',
      'CTW_HANDOFF',
      '## Goal',
      'Ship the CleanTheWindow spike with tests passing.',
      '## Current state',
      'Token counter and handoff core exist; five unit tests pass.',
      '## Next step',
      'NEXT_MARKER_WRITE_CHAIN_TESTS',
      '## Key decisions',
      '- Zero npm dependencies; Node built-ins only.',
      '## Files touched',
      '- src/core/tokens.js',
      '## Pitfalls / notes',
      '- POSIX paths from Git Bash resolve against the current drive on Windows.',
      '## How to verify',
      'node --test test/core.test.js',
    ].join('\n')
  );
  process.exit(0);
}

process.stdout.write('Chain tests finished, everything green. CTW_COMPLETE');

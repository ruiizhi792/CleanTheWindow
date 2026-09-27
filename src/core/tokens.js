'use strict';

/**
 * Token counting from agent transcript JSONL files.
 *
 * Works with the Claude Code family of transcripts (Claude Code, WorkBuddy /
 * CodeBuddy CLI), where each `assistant` line carries a `message.usage` object:
 *   input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
 *
 * The context occupancy after a completed turn is estimated as:
 *   input + cache_creation + cache_read + output
 * (output of the last call becomes part of the next call's input).
 */

/** Pick the last assistant entry that has a usable usage object. */
function lastAssistantUsage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = lines[i];
    if (d && d.type === 'assistant' && d.message && typeof d.message.usage === 'object') {
      return d.message.usage;
    }
  }
  return null;
}

/** Occupancy estimate in tokens for the *next* request, from a usage object. */
function usageToTokens(usage) {
  if (!usage) return 0;
  const u = usage;
  return (
    (u.input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.output_tokens || 0)
  );
}

/** Parse JSONL text into an array of parsed objects (bad lines skipped). */
function parseJsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* tolerate malformed lines */
    }
  }
  return out;
}

/** Compute context occupancy from raw transcript file content. */
function tokensFromTranscriptText(text) {
  const lines = parseJsonl(text);
  return usageToTokens(lastAssistantUsage(lines));
}

/** Read a transcript file and compute occupancy. Returns { tokens, usage, lineCount }. */
function readTranscriptTokens(fs, filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = parseJsonl(text);
  const usage = lastAssistantUsage(lines);
  return { tokens: usageToTokens(usage), usage, lineCount: lines.length };
}

module.exports = {
  lastAssistantUsage,
  usageToTokens,
  parseJsonl,
  tokensFromTranscriptText,
  readTranscriptTokens,
};

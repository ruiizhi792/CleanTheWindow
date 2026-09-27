'use strict';

/**
 * Config loader: defaults <- user config (<cwd>/.ctw/config.json) <- env overrides.
 * Zero-dependency: plain Node fs/path.
 */

const path = require('path');

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!extra || typeof extra !== 'object') return out;
  for (const k of Object.keys(extra)) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig(fs, opts) {
  const o = opts || {};
  const pkgRoot = o.pkgRoot || path.resolve(__dirname, '..', '..');
  const cwd = o.cwd || process.cwd();

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'config.default.json'), 'utf8'));
  } catch {
    config = {};
  }

  // user config in the project being supervised
  try {
    const user = JSON.parse(fs.readFileSync(path.join(cwd, '.ctw', 'config.json'), 'utf8'));
    config = deepMerge(config, user);
  } catch {
    /* optional */
  }

  // env overrides (CI-friendly)
  if (process.env.CTW_WINDOW_TOKENS) config.threshold = config.threshold || {};
  if (process.env.CTW_WINDOW_TOKENS) config.threshold.contextWindowTokens = Number(process.env.CTW_WINDOW_TOKENS);
  if (process.env.CTW_ROLLOVER_PERCENT) config.threshold = config.threshold || {};
  if (process.env.CTW_ROLLOVER_PERCENT) config.threshold.rolloverPercent = Number(process.env.CTW_ROLLOVER_PERCENT);
  if (process.env.CTW_ABSOLUTE_FLOOR_TOKENS) config.threshold = config.threshold || {};
  if (process.env.CTW_ABSOLUTE_FLOOR_TOKENS) config.threshold.absoluteFloorTokens = Number(process.env.CTW_ABSOLUTE_FLOOR_TOKENS);

  return config;
}

/** Decide whether tokens cross the warn / rollover thresholds (percent with absolute floor). */
function evaluate(config, tokens) {
  const th = (config && config.threshold) || {};
  const window = th.contextWindowTokens || 200000;
  const floor = th.absoluteFloorTokens || 0;
  const pct = window > 0 ? (tokens / window) * 100 : 0;
  const rolloverHit = tokens >= floor && pct >= (th.rolloverPercent || 75);
  const warnHit = tokens >= floor && pct >= (th.warnPercent || 60);
  return { pct, tokens, window, warnHit, rolloverHit };
}

module.exports = { loadConfig, evaluate, deepMerge };

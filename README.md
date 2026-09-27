# CleanTheWindow

**English** | [简体中文](README.zh-CN.md)

Threshold-triggered context window rollover for the Claude Code family of CLIs (Claude Code, WorkBuddy / CodeBuddy CLI).

When a context window fills past a threshold, the agent writes a structured handoff document, and the next window starts clean — with the handoff injected — instead of resuming a compacted pile of summaries.

**Why not just compact?** Compaction keeps the same window and re-feeds it a lossy summary. Rollover gives the model a fresh window plus a handoff written *for the next window*. Compaction and rollover are not enemies: rollover just happens *before* compaction matters.

Zero npm dependencies. Node >= 18. Works on Windows (Git Bash), macOS and Linux.

## Two modes

### Chain mode — fully automatic rollover

The supervisor runs your task across a series of fresh windows and you never touch `/clear`:

```bash
node src/supervisor/ctw-chain.js --task "Refactor the auth module and make all tests pass" --cwd /path/to/project
# or from a file:
node src/supervisor/ctw-chain.js --task-file task.md --cwd /path/to/project
```

Each window is a `claude -p` (print mode) run, so every window is a genuinely fresh context. The chain protocol tells the agent:

- task fully done → end with `CTW_COMPLETE`
- cannot finish in this window → end with `CTW_HANDOFF` + a seven-field handoff

The supervisor extracts the handoff, saves it, and launches the next window with the handoff embedded in the prompt. Loop until `CTW_COMPLETE`.

A deterministic safety net covers protocol misses: after every run, the real transcript token usage is checked (`input + cache_creation + cache_read + output`); if the rollover threshold is crossed and the agent forgot the marker, the supervisor drafts a handoff from the transcript and rolls over anyway. A `--max-windows` cap (default 10) stops runaway chains.

Every window's prompt, output and handoff is persisted under `.ctw/` (`window-N-prompt.md`, `window-N-output.txt`, `window-N-handoff.md`, `chain-log.md`) so you can audit exactly what each window saw.

Useful flags:

| Flag | Meaning |
|---|---|
| `--task` / `--task-file` | the task (string or markdown file) |
| `--cwd` | project directory the agent works in |
| `--agent-cmd` | agent command, default `claude` (e.g. `codebuddy` for WorkBuddy CLI) |
| `--extra-args` | pass-through CLI flags, e.g. `"--model sonnet --permission-mode acceptEdits"` |
| `--max-windows` | safety cap on chain length (default 10) |
| `--run-timeout` | per-window timeout in seconds (default: none) |
| `--dry-run` | write the window-1 prompt and exit, no agent spawned |

> Chain mode runs the agent non-interactively; you need your CLI's autonomous permission mode (e.g. `--permission-mode acceptEdits` via `--extra-args`) for tasks that touch files.

### Assist mode — keep your interactive session, get told when to roll over

For interactive use, install the hooks and keep the supervisor running in the background:

```bash
# Claude Code
node src/adapters/install.js claude-code
# WorkBuddy / CodeBuddy CLI (afterwards run /hooks inside the CLI to review + apply)
node src/adapters/install.js workbuddy

# uninstall (removes only our hooks, keeps yours)
node src/adapters/install.js claude-code --uninstall
```

Then in another terminal:

```bash
node src/supervisor/ctw-supervisor.js /path/to/project
```

When the threshold hits, the supervisor writes `.ctw/handoff-<ts>.md` and tells you to `/clear`. The new window restores the handoff automatically via the SessionStart hook. The write hooks also fire on Stop / PreCompact as a safety net, so a handoff exists even if the session compacts before you react.

Both installers merge into existing settings without clobbering other hooks and write a timestamped backup first.

## The handoff format

Seven fields, same in both modes: **Goal / Current state / Next step / Key decisions / Files touched / Pitfalls / How to verify**. In chain mode the agent writes it itself (protocol); in assist mode the draft is script-generated from the transcript and the agent can polish it with `templates/handoff-template.md`.

## Configuration

Defaults in `config.default.json`; override per project in `<project>/.ctw/config.json`:

```json
{
  "threshold": { "warnPercent": 60, "rolloverPercent": 75, "absoluteFloorTokens": 30000, "contextWindowTokens": 200000 },
  "handoff":   { "dir": ".ctw", "maxAgeSeconds": 900, "requireSameCwd": true }
}
```

Both a percentage **and** an absolute token floor must be crossed — small sessions never roll over early. Env overrides for tests and CI: `CTW_WINDOW_TOKENS`, `CTW_ROLLOVER_PERCENT`, `CTW_ABSOLUTE_FLOOR_TOKENS`.

## What is actually verified

Every claim below is reproducible from this repo:

- Token counting was validated against a real Claude Code transcript: parser output exactly matched `input + cache_creation + cache_read + output` computed by hand from the same file (47,922 tokens, exact match).
- Chain mode is covered by end-to-end tests with a mock agent: protocol handoff chaining, the forced-rollover safety net (no marker + 180k tokens → rollover anyway), and the max-windows cap (`test/chain.test.js`).
- Hook guards are unit-tested: freshness window, cwd match, idempotent installer merge (`test/core.test.js`).
- 8/8 tests pass. Run: `npm test`.

Not yet verified: a full multi-window chain against a live `claude` session on a real long task, and the accuracy of the occupancy percentage against `/context` on a live session. Both are top of the roadmap.

## Roadmap

- Real-task validation run: a 10+ file refactor through 3+ rollovers, results published in the README.
- Interactive auto-rollover: supervisor types `/clear` into your live TUI session (PTY wrapper; needs a platform story on Windows).
- Codex CLI adapter (its hooks are experimental; Windows support unverified).
- Dynamic thresholds by task size; handoff chains across many windows.

## Known limitations

- Chain mode relies on the agent following the `CTW_HANDOFF` / `CTW_COMPLETE` protocol; the token safety net catches threshold-crossing misses, but a chatty agent below threshold that fails to emit either marker ends the chain as "complete".
- Occupancy estimate is the last API call's usage including output tokens — close to, but not identical with, what `/context` reports. Calibrate before trusting the percentage blindly.
- Windows + Git Bash: POSIX-style paths passed to Node resolve against the current drive (`/tmp/...` landed in `D:\tmp\...` during testing). Real CLIs pass native paths; test harnesses on Git Bash must use Windows paths.
- The assist-mode supervisor polls the newest transcript in the project dir; it does not pin a session id yet.

## License

[MIT](LICENSE)

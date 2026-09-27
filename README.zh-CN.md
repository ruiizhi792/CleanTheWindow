# CleanTheWindow

[English](README.md) | **简体中文**

面向 Claude Code 系 CLI（Claude Code、WorkBuddy / CodeBuddy CLI）的 context 窗口阈值自动交接工具。

当 context 占用超过阈值时，agent 写一份结构化交接文档，下一个窗口干净启动——交接文档自动注入，而不是带着一堆压缩摘要继续干活。

**为什么不只是压缩（compact）？** 压缩留在同一个窗口里，把有损摘要塞回去继续用。换窗给模型一个全新窗口，外加一份**为下一个窗口写的**交接文档。两者不冲突：换窗只是抢在压缩变得要命之前发生。

零 npm 依赖。Node >= 18。Windows（Git Bash）、macOS、Linux 均可运行。

## 两种模式

### 链式模式——全自动换窗

supervisor 把你的任务跑在一系列全新窗口上，全程不用碰 `/clear`：

```bash
node src/supervisor/ctw-chain.js --task "重构 auth 模块并让全部测试通过" --cwd /path/to/project
# 或从文件读任务：
node src/supervisor/ctw-chain.js --task-file task.md --cwd /path/to/project
```

每个窗口是一次 `claude -p`（非交互模式）运行，所以每个窗口都是真正的全新 context。链式协议告诉 agent：

- 任务全部完成 → 结尾输出 `CTW_COMPLETE`
- 这个窗口干不完 → 结尾输出 `CTW_HANDOFF` + 七字段交接文档

supervisor 提取交接文档、落盘，然后带着它启动下一个窗口。循环直到 `CTW_COMPLETE`。

有一道确定性安全网兜住协议失误：每次运行结束后检查真实 transcript 的 token 占用（`input + cache_creation + cache_read + output`）；如果超过阈值而 agent 忘了打标记，supervisor 从 transcript 生成草稿交接文档照样换窗。`--max-windows`（默认 10）防止链无限跑下去。

每个窗口的 prompt、输出、交接文档都落在 `.ctw/` 下（`window-N-prompt.md`、`window-N-output.txt`、`window-N-handoff.md`、`chain-log.md`），每个窗口看到了什么完全可审计。

常用参数：

| 参数 | 含义 |
|---|---|
| `--task` / `--task-file` | 任务内容（字符串或 markdown 文件） |
| `--cwd` | agent 工作的项目目录 |
| `--agent-cmd` | agent 命令，默认 `claude`（WorkBuddy CLI 用 `codebuddy`） |
| `--extra-args` | 透传给 CLI 的参数，如 `"--model sonnet --permission-mode acceptEdits"` |
| `--max-windows` | 链长上限（默认 10） |
| `--run-timeout` | 单窗口超时秒数（默认不限） |
| `--dry-run` | 只写出第一个窗口的 prompt 就退出，不启动 agent |

> 链式模式是非交互运行；要动文件的任务需要 CLI 的自主权限模式（通过 `--extra-args` 传，如 `--permission-mode acceptEdits`）。

### 辅助模式——保留交互式会话，到点提醒你换窗

交互场景下，装上 hooks，后台开着 supervisor：

```bash
# Claude Code
node src/adapters/install.js claude-code
# WorkBuddy / CodeBuddy CLI（装完后在 CLI 里跑 /hooks 审查并生效）
node src/adapters/install.js workbuddy

# 卸载（只删自己的 hooks，保留你的其他 hooks）
node src/adapters/install.js claude-code --uninstall
```

另开一个终端：

```bash
node src/supervisor/ctw-supervisor.js /path/to/project
```

超过阈值时，supervisor 写出 `.ctw/handoff-<ts>.md` 并提示你 `/clear`。新窗口通过 SessionStart hook 自动恢复交接文档。写 hooks 也在 Stop / PreCompact 上触发作为保险——就算你还没反应过来会话就被压缩了，交接文档也已经在了。

两个 installer 都不覆盖已有 hooks，改动前先写带时间戳的备份。

## 交接文档格式

两种模式同一套七字段：**目标 / 当前状态 / 下一步 / 关键决策 / 动过的文件 / 坑 / 如何验证**。链式模式由 agent 按协议自己写；辅助模式由脚本从 transcript 生成草稿，agent 可参照 `templates/handoff-template.md` 润色。

## 配置

默认值在 `config.default.json`；按项目覆盖写在 `<project>/.ctw/config.json`：

```json
{
  "threshold": { "warnPercent": 60, "rolloverPercent": 75, "absoluteFloorTokens": 30000, "contextWindowTokens": 200000 },
  "handoff":   { "dir": ".ctw", "maxAgeSeconds": 900, "requireSameCwd": true }
}
```

百分比和绝对 token 下限必须同时超过——小会话永远不会被提前换窗。测试和 CI 可用环境变量覆盖：`CTW_WINDOW_TOKENS`、`CTW_ROLLOVER_PERCENT`、`CTW_ABSOLUTE_FLOOR_TOKENS`。

## 实际验证过什么

以下每一条都能在本仓库复现：

- token 计数用一份真实 Claude Code transcript 验证过：解析器输出与从同一文件手算的 `input + cache_creation + cache_read + output` 完全一致（47,922 tokens，精确相等）。
- 链式模式有 mock agent 端到端测试覆盖：协议交接链、强制换窗安全网（无标记 + 180k tokens → 照样换窗）、窗口上限熔断（`test/chain.test.js`）。
- hook 守卫有单元测试：新鲜度窗口、cwd 匹配、installer 幂等合并（`test/core.test.js`）。
- 8/8 测试通过。运行方式：`npm test`。

尚未验证：对真实 `claude` 会话跑完整的多窗口链式长任务；占用百分比与 `/context` 在活会话上的偏差。两项都在 roadmap 最前面。

## Roadmap

- 真实长任务验证：一个 10+ 文件的重构穿过 3+ 次换窗，结果写回 README。
- 交互式自动换窗：supervisor 往你的 TUI 会话里打 `/clear`（PTY 包装，Windows 上需要单独的方案）。
- Codex CLI 适配器（其 hooks 还是实验性，Windows 支持未核实）。
- 按任务大小动态调阈值；跨多窗口的交接链。

## 已知限制

- 链式模式依赖 agent 遵守 `CTW_HANDOFF` / `CTW_COMPLETE` 协议；token 安全网兜得住超阈值的失误，但阈值以下、两个标记都没打的啰嗦 agent 会被当作「已完成」收尾。
- 占用估算取最后一次 API 调用的 usage（含输出 token）——与 `/context` 的显示接近但不完全相同，百分比请先校准再用。
- Windows + Git Bash：传给 Node 的 POSIX 风格路径会按当前盘符解析（测试时 `/tmp/...` 落到了 `D:\tmp\...`）。真实 CLI 传原生路径，不受影响；Git Bash 下的测试脚本要用 Windows 路径。
- 辅助模式的 supervisor 轮询项目目录里最新的 transcript，暂未绑定 session id。

## 许可证

[MIT](LICENSE)

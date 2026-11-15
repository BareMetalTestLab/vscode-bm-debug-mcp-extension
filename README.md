# Debug MCP Bridge

[![CI](https://github.com/BareMetalTestLab/vscode-bm-debug-mcp-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/BareMetalTestLab/vscode-bm-debug-mcp-extension/actions/workflows/ci.yml)

Give your AI agent a real debugger.

A VS Code extension that exposes the built-in debugger — any DAP adapter:
cortex-debug, cppdbg, node, python — as [MCP](https://modelcontextprotocol.io)
tools over HTTP. Agents such as Claude Code can launch debug sessions, set
breakpoints, inspect variables, step through code and read live
[SEGGER RTT](https://www.segger.com/products/debug-trace-probes/rtt/)
output — while everything stays visible in the VS Code UI: sessions in the
debug toolbar, breakpoints in the editor gutter, values in the VARIABLES
pane.

Built with embedded development in mind: launch.json is resolved without any
interactive prompts, long flashing sessions never block the agent, and RTT
logs/target-CLI input are first-class tools.

Zero dependencies — plain Node.js, no npm install.

## Features

- **16 MCP tools**: start/stop sessions, breakpoints (editor-visible, with
  conditions and logpoints), stack, variables, expression evaluation,
  set-variable, pause/continue/step
- **launch.json resolution without popups**: JSONC support, variable
  substitution (`${workspaceFolder}`, `${config:*}`, `${env:*}`,
  `${input:*}` with defaults) — no interactive pickers an agent cannot
  answer
- **Non-blocking launches**: embedded flashing routinely outlasts MCP
  client timeouts; the launch runs in the background, errors surface in
  `debug_status`
- **SEGGER RTT monitoring**: auto-connects to the J-Link GDB Server RTT
  telnet port, buffers per channel, strips ANSI colors, and can send input
  to a target-side CLI
- **Per-project ports**: stable, collision-free port per workspace folder,
  auto-registered for Claude Code — two project windows never fight over
  one server
- **Self-healing**: port binding retries across window reloads; agent
  configs are kept in sync automatically

## Installation

Install the VSIX from the [releases](https://github.com/BareMetalTestLab/vscode-bm-debug-mcp-extension/releases)
(download the artifact, then Extensions → `…` → *Install from VSIX…*),
from the Marketplace, or manually:

```bash
mkdir -p ~/.vscode/extensions/baremetaltestlab.vscode-bm-debug-mcp
cp -R package.json extension.js README.md media \
      ~/.vscode/extensions/baremetaltestlab.vscode-bm-debug-mcp/
```

Reload VS Code — the status bar shows the bridge URL
(`Debug MCP Bridge: 127.0.0.1:<port>/mcp`).

## Quick start

**Claude Code inside VS Code** — nothing to configure: the extension
registers itself through VS Code's native MCP discovery, and Claude Code
picks the tools up automatically.

**Claude Code CLI (or any MCP client)** — the extension maintains
`.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "debug-bridge": { "type": "http", "url": "http://127.0.0.1:7819/mcp" }
  }
}
```

The file is created automatically for projects that use `cortex-debug`
configs (its presence counts as consent); **deleting it opts the project
out permanently**. To register any project explicitly, run
**Debug MCP Bridge: Register in Claude Code (project .mcp.json)** from the
Command Palette.

## Tools

| Tool | What it does |
|---|---|
| `debug_start` | Start a launch.json configuration (`configName`) or an inline config (`config`) |
| `debug_stop` | Stop a session |
| `debug_status` | List sessions and their state (running/stopped + reason, RTT buffers) |
| `debug_pause` | Pause (break into) the target |
| `debug_continue` | Continue execution |
| `debug_step` | Step: `over` / `into` / `out` |
| `debug_stack` | Call stack, returns frame ids |
| `debug_variables` | Frame variables (by `frameId`), nested values via `{ref:N}` |
| `debug_evaluate` | Evaluate an expression in the frame's context |
| `debug_set_variable` | Change a variable's value |
| `debug_set_breakpoints` | Set breakpoints by file/lines, options: condition, hitCondition, logMessage |
| `debug_clear_breakpoints` | Remove breakpoints (in one file or all) |
| `debug_list_breakpoints` | List all breakpoints |
| `debug_rtt_connect` | Connect RTT sockets manually (non-jlink servers) |
| `debug_rtt_read` | Read captured RTT output (draining by default; `peek`, `raw` options) |
| `debug_rtt_write` | Send text to the RTT down-buffer (target input) |

## Example workflow

```
debug_start {configName: "Launch (SEGGER JLink)", folder: "/path/to/proj"}
  → session runs to main, RTT capture starts automatically
debug_set_breakpoints {file: ".../src/main.c", lines: [120]}
debug_continue
  → breakpoint hit, line highlighted in VS Code
debug_stack                  → frameId of the top frame
debug_variables {frameId: 1}
debug_evaluate {expression: "SystemCoreClock", frameId: 1}
debug_rtt_read               → boot logs
debug_rtt_write {text: "?\n"} → target CLI answers over RTT
debug_continue
debug_stop
```

## Configuration

**Port.** Each project gets one stable port (range 7800–7899, derived from
the folder path). Resolution order:

1. an explicit `debugMcpBridge.port` setting (user or workspace) — used as is;
2. the port stored in the project's `.mcp.json`;
3. first launch in a project — a free port from the range above is chosen
   and written to `.mcp.json`.

The only file the extension ever creates in your projects is `.mcp.json`.

**RTT.** For `servertype: jlink` sessions RTT capture connects automatically
to port 19021 (channel N on 19021+N); override with the `rttPort` field of
the launch config. The RTT telnet port accepts a single client — if another
RTT terminal occupies it, restart the session. For other servers use
`debug_rtt_connect {port}`.

## Behavior notes

- `debug_start` never blocks on the full launch (GDB server + flashing +
  run-to-entry can exceed MCP timeouts); poll `debug_status` for progress
  and errors.
- Breakpoints go through the VS Code breakpoint model, so they are visible
  in the gutter, the BREAKPOINTS pane, and survive session restarts.
- VS Code launched from the Dock has a minimal PATH; the extension merges
  the login shell's PATH so toolchains referenced by bare name
  (`"gdbPath": "arm-none-eabi-gdb"`) resolve.
- The server binds 127.0.0.1 only and has no authentication — it is a
  local development tool; do not expose it.

## CI & publishing

- **CI** runs on every push to `main` and on PRs: syntax check + VSIX
  packaging, the VSIX is uploaded as an artifact.
- **Publish** is triggered by a version tag and ships to the VS Code
  Marketplace via the GitHub Actions OIDC flow (the workflow is registered
  on the publisher page under *Release workflow* — no PAT needed):

  ```bash
  git tag v0.3.5 && git push origin v0.3.5
  ```

  Open VSX publishing is optional and uses the `OVSX_PAT` repo secret.

## License

[MIT](LICENSE.md)

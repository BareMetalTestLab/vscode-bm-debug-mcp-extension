# Debug MCP Bridge (vscode-debug-mcp)

A VS Code extension that exposes the VS Code debugger (any DAP adapter:
cortex-debug, cppdbg, node, python — anything) as MCP tools over HTTP.
It lets an AI assistant (Claude Code and the like) drive debugging while
**everything stays visible in the VS Code UI**: sessions in the toolbar,
breakpoints in the editor gutter, variable values in the VARIABLES pane.

Zero dependencies — plain JS, nothing to install through npm.

## Installation

```bash
mkdir -p ~/.vscode/extensions/paul.vscode-debug-mcp-0.1.0
cp -R /path/to/vscode-debug-mcp/{package.json,extension.js,README.md} \
      ~/.vscode/extensions/paul.vscode-debug-mcp-0.1.0/
```

Restart VS Code. The extension activates on startup and starts an HTTP
server on `127.0.0.1:<project port>`.

**One port per project**, and exactly **one file** per project:
`.mcp.json` in the root. It serves both as the agent registration (Claude
Code reads it natively) and as our port storage
(`mcpServers."debug-bridge".url`).

1. Port set explicitly in settings (`debugMcpBridge.port`, user or
   workspace) → used as is, `.mcp.json` is kept in sync.
2. Otherwise the port is taken from `.mcp.json` (our entry) → stable
   across window reloads.
3. First time a project is opened → a stable port derived from the folder
   path hash (7800–7899, first free one) is written into `.mcp.json`.

**`.mcp.json` is NOT created in every project**, only where the bridge is
actually wanted:
- the file already exists → our entry is kept in sync (its presence =
  consent);
- no file, but `.vscode/launch.json` has `cortex-debug` configs → created
  **once**, the project is remembered;
- **deleting the file = opting out**: after that, `.mcp.json` is never
  re-created in this project (the folder is marked in globalState);
- to bring it back: Command Palette → **Debug MCP Bridge: Register in
  Claude Code (project .mcp.json)**.

Other files are deliberately never touched: project scripts may regenerate
`settings.json`, and `.codex/config.toml` belongs to other extensions
(e.g. SiLabs) — two writers into one file would conflict.

Check that the server is alive (use your project's port; 7777 is the
legacy default for folder-less windows):

```bash
curl -s -X POST http://127.0.0.1:7777/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## Connecting Claude Code

**Nothing to configure.** The extension registers itself through the
native VS Code MCP API (`mcpServerDefinitionProviders` — the same
mechanism the Silicon Labs extension uses): VS Code discovers the server
on its own, and Claude Code running inside VS Code picks up its tools
automatically.

For CLI clients **outside** VS Code, registration is only needed when the
automatic project `.mcp.json` is not enough (e.g. a global, port-fixed
setup):

```bash
claude mcp add --transport http debug-bridge http://127.0.0.1:7819/mcp --scope user
```

(or, per project, just run it in the project directory with `--scope
project` — or use Command Palette → **Debug MCP Bridge: Register in
Claude Code (project .mcp.json)**)

## Tools

| Tool | What it does |
|---|---|
| `debug_start` | Starts a launch.json configuration (`configName`) or an inline config (`config`) |
| `debug_stop` | Stops a session |
| `debug_status` | Lists sessions and their state (running/stopped + reason) |
| `debug_pause` | Pause (break into) |
| `debug_continue` | Continue execution |
| `debug_step` | Step: `over` / `into` / `out` |
| `debug_stack` | Call stack, returns frame ids |
| `debug_variables` | Frame variables (by `frameId`), nested values via `{ref:N}` |
| `debug_evaluate` | Evaluate an expression in the frame's context |
| `debug_set_variable` | Change a variable's value |
| `debug_set_breakpoints` | Set breakpoints by file/lines (visible in the editor!), options: condition, hitCondition, logMessage |
| `debug_clear_breakpoints` | Remove breakpoints (in one file or all) |
| `debug_list_breakpoints` | List all breakpoints |
| `debug_rtt_connect` | Connect RTT sockets to the J-Link GDB Server (port 19021, channel N = port+N; for jlink sessions `debug_start` connects automatically) |
| `debug_rtt_read` | Read captured RTT output (draining by default; `peek` keeps the buffer, `raw` keeps ANSI codes) |
| `debug_rtt_write` | Send text to the RTT down-buffer (target input, e.g. a CLI on `SEGGER_RTT_GetKey`) |

## Example workflow (STM32 + cortex-debug, RPLC project)

```
debug_start {configName: "Launch (SEGGER JLink)"}
debug_set_breakpoints {file: ".../src/main.c", lines: [120]}
debug_continue
  → breakpoint hit, the line is highlighted in VS Code
debug_stack            → frameId of the top frame
debug_variables {frameId: 1}
debug_evaluate {expression: "HAL_GetTick()", frameId: 1}
debug_continue
debug_stop
```

## Notes

- **`configName` is resolved by the extension itself**: it reads the
  folder's `.vscode/launch.json` (JSONC: comments and trailing commas are
  supported), finds the configuration by name and substitutes the
  `${workspaceFolder}`, `${config:*}`, `${env:*}` and `${input:*}`
  variables (`promptString` inputs fall back to their `default`; without a
  default you get a clear error — use an inline `config` instead). Applied
  input defaults are listed in the `debug_start` response. The fully
  typed config is passed to `startDebugging`, so the interactive
  **"Select debugger" picker never pops up** (with a bare `{name}` VS Code
  shows exactly that picker on a failed resolve and hangs).
- `debug_start` does not wait for the launch to complete (GDB server +
  flashing + runToEntryPoint can easily outlast an MCP client timeout):
  the launch goes to the background, the response arrives as soon as the
  session is up (or has failed), afterwards poll `debug_status` (which
  also surfaces launch errors).
- **PATH from the login shell**: VS Code launched from the Dock gets a
  minimal PATH (no homebrew), so `"gdbPath": "arm-none-eabi-gdb"` in a
  shared launch.json does not resolve. On activation the extension merges
  the missing entries from `$SHELL -lc` into `process.env.PATH` — child
  processes spawned by any extension (gdb, JLinkGDBServer, ...) inherit
  them.
- Breakpoints go through the VS Code breakpoint model
  (`vscode.debug.addBreakpoints`), so they are visible in the gutter and
  the BREAKPOINTS pane, and VS Code syncs them with the adapter itself
  (they are also restored on session restarts).
- `debug_set_breakpoints` replaces all breakpoints in the given file
  (pass `lines: []` to clear the file).
- **RTT monitoring**: JLinkGDBServer serves SEGGER RTT over a telnet-style
  TCP socket (channel N on port `19021+N`). For jlink sessions
  `debug_start` connects to these sockets automatically (the port can be
  overridden with the `rttPort` field of the launch config); data lands in
  a per-channel ring buffer (256 KB) with ANSI colors stripped. The port
  is **single-client**: if cortex-debug's own RTT terminal has taken the
  slot, restart the session or close that terminal. For non-jlink servers
  (BMP/openocd) connect manually via `debug_rtt_connect {port}`.
- The server listens on 127.0.0.1 only — not reachable from outside.
- stopped/running state is tracked via DebugAdapterTracker (the session
  entry is created lazily so the `stopped` event from runToEntryPoint is
  not lost during launch), so `debug_status` shows the real target state;
  stack/step operations use the thread that actually stopped.
- After editing extension.js, copy it into
  `~/.vscode/extensions/paul.vscode-debug-mcp-0.1.0/` and run
  **Developer: Reload Window** (killing the extension host does not
  re-activate `onStartupFinished` extensions).

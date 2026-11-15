// Debug MCP Bridge — VS Code debugging as MCP tools over HTTP.
// Zero dependencies: plain Node http server (MCP Streamable HTTP) +
// vscode.debug API + raw DAP requests via DebugSession.customRequest().
'use strict';

const vscode = require('vscode');
const http = require('http');
const net = require('net');
const { exec } = require('child_process');

const SERVER_INFO = { name: 'vscode-debug-mcp', version: '0.3.5' };

/** @type {http.Server|null} */
let server = null;
let sessionId = 0;
let bridgePort = 7777;
// Set in activate; the .mcp.json opt-out memory lives in its globalState.
let extensionContext = null;

/** id -> {session, name, stopped, stopReason, threadId, rtt} */
const sessions = new Map();

/** Recent debug_start launches (newest last): {name, state: pending|ok|failed, error, at}.
 *  'ok' just ends the "launching..." display — nothing reads it directly. */
const launches = [];

// ---------------------------------------------------------------------------
// VS Code debug session tracking
// ---------------------------------------------------------------------------

function onSessionStart(session) {
  // The DAP tracker may have created the entry already (see below) — mutate
  // it in place; replacing it would orphan the RTT sockets and flags
  // registered on the old object.
  let info = sessions.get(session.id);
  if (!info) {
    info = { stopped: false, stopReason: null };
    sessions.set(session.id, info);
  }
  info.session = session;
  info.name = session.name;
  for (const l of launches) {
    if (l.state === 'pending' && l.name === session.name) {
      l.state = 'ok';
    }
  }
}

function onSessionEnd(session) {
  rttCleanup(session.id);
  sessions.delete(session.id);
}

function getSession(nameOrId) {
  if (sessions.size === 0) {
    throw new Error('No active debug session. Start one with debug_start first.');
  }
  if (nameOrId) {
    const s = String(nameOrId);
    for (const [id, info] of sessions) {
      if (id === s || info.name === s) {
        return info;
      }
    }
    throw new Error(`Debug session not found: ${nameOrId}`);
  }
  // Default: the active session, else the first known one.
  const active = vscode.debug.activeDebugSession;
  if (active && sessions.has(active.id)) {
    return sessions.get(active.id);
  }
  return sessions.values().next().value;
}

function dap(info, command, args) {
  return info.session.customRequest(command, args || {});
}

async function threadId(info, { forPause = false } = {}) {
  // Prefer the thread that reported the last stop: with RTOS support the
  // thread list is long and threads[0] is not necessarily the stopped one.
  // info.threadId is kept across 'continued' (stale but still a valid id),
  // so pause/continue also work while the target is running.
  if (info.threadId !== undefined) {
    return info.threadId;
  }
  const res = await dap(info, 'threads');
  const threads = (res && res.threads) || [];
  if (threads.length === 0) {
    // While the target is running some adapters report no threads at all;
    // cortex-debug's pause just interrupts gdb and ignores the id.
    if (forPause) {
      return 1;
    }
    throw new Error('No threads in the debug session (is it still starting?)');
  }
  return threads[0].id;
}

// ---------------------------------------------------------------------------
// launch.json resolution
// ---------------------------------------------------------------------------

/** Strip line and block comments (string-aware). */
function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n !== undefined ? n : '';
        i += 2;
        continue;
      }
      if (c === '"') {
        inStr = false;
      }
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Drop trailing commas before } or ] (string-aware) — JSONC allows them. */
function stripTrailingCommas(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) {
        j++;
      }
      if (text[j] === '}' || text[j] === ']') {
        continue; // drop the comma
      }
    }
    out += c;
  }
  return out;
}

/** Substitutes ${workspaceFolder}, ${workspaceRoot}, ${config:*}, ${env:*}, ${input:*}. */
function substituteVars(value, folderPath, launchInputs, note) {
  if (typeof value === 'string') {
    return value
      .replace(/\$\{workspaceFolder\}|\$\{workspaceRoot\}/g, folderPath)
      .replace(/\$\{env:([^}]+)\}/g, (_, k) => process.env[k] || '')
      .replace(/\$\{config:([^}]+)\}/g, (_, k) => {
        const v = vscode.workspace.getConfiguration().get(k);
        return v === undefined ? '' : String(v);
      })
      .replace(/\$\{input:([^}]+)\}/g, (_, id) => {
        const inp = (launchInputs || []).find((x) => x && x.id === id);
        if (inp && inp.default !== undefined) {
          note.inputsUsed.push(`${id}=${inp.default}`);
          return String(inp.default);
        }
        throw new Error(
          `Config needs \${input:${id}} which is interactive and has no default — pass an inline config instead`
        );
      });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteVars(v, folderPath, launchInputs, note));
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) {
      value[k] = substituteVars(value[k], folderPath, launchInputs, note);
    }
    return value;
  }
  return value;
}

/** Resolves a named configuration with variables substituted.
 *  @returns {{cfg: object, inputsUsed: string[]}} */
async function resolveNamedConfig(folder, configName) {
  const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
  let raw;
  try {
    raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch (e) {
    throw new Error(`launch.json not readable in ${folder.uri.fsPath} (${e.message})`);
  }
  let doc;
  try {
    doc = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
  } catch (e) {
    throw new Error(`launch.json is not valid JSONC: ${e.message}`);
  }
  const cfg = (doc.configurations || []).find((c) => c && c.name === configName);
  if (!cfg) {
    throw new Error(`Configuration "${configName}" not found in ${uri.fsPath}`);
  }
  const note = { inputsUsed: [] };
  const resolved = substituteVars(JSON.parse(JSON.stringify(cfg)), folder.uri.fsPath, doc.inputs || [], note);
  return { cfg: resolved, inputsUsed: note.inputsUsed };
}

// ---------------------------------------------------------------------------
// RTT monitoring (SEGGER RTT via the J-Link GDB Server RTT telnet socket)
// ---------------------------------------------------------------------------

// JLinkGDBServer serves SEGGER RTT over a telnet-style TCP socket: channel N
// on port 19021+N by default (override via the launch config's rttPort).
// The port is single-client — cortex-debug's own RTT terminal competes for
// the same slot.
const RTT_DEFAULT_PORT = 19021;
const RTT_BUF_CAP = 256 * 1024; // per channel

function rttCleanup(sessionId) {
  const info = sessions.get(sessionId);
  if (info && info.rtt) {
    for (const st of info.rtt.chans.values()) {
      try {
        st.sock.destroy();
      } catch (_) {
        /* already closed */
      }
    }
    info.rtt = null;
  }
}

function rttConnect(info, port, channel) {
  return new Promise((resolve, reject) => {
    // One live connection per channel: the J-Link RTT telnet server accepts
    // a single client, so a second connect would just get dropped.
    const existing = info.rtt && info.rtt.chans.get(channel);
    if (existing && existing.sock && !existing.sock.destroyed) {
      return resolve(`RTT channel ${channel} already connected (127.0.0.1:${info.rtt.port})`);
    }
    let settled = false;
    const st = { sock: null, buf: '' };
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      if (settled) {
        return;
      }
      settled = true;
      st.sock = sock;
      if (!info.rtt) {
        info.rtt = { port, chans: new Map() };
      }
      info.rtt.chans.set(channel, st);
      resolve(`RTT channel ${channel} ← 127.0.0.1:${port}`);
    });
    sock.on('data', (d) => {
      st.buf += d.toString('utf8');
      if (st.buf.length > RTT_BUF_CAP) {
        st.buf = st.buf.slice(-RTT_BUF_CAP);
      }
    });
    sock.on('error', (e) => {
      try {
        sock.destroy();
      } catch (_) {
        /* noop */
      }
      if (!settled) {
        settled = true;
        reject(new Error(`RTT connect channel ${channel} → 127.0.0.1:${port}: ${e.message}`));
      }
    });
    sock.on('close', () => {
      // Deregister only if THIS socket is the registered one — concurrent
      // connect attempts (auto-retry + manual) must not delete each other.
      if (info.rtt && info.rtt.chans.get(channel) === st) {
        info.rtt.chans.delete(channel);
      }
    });
  });
}

/** Auto-connect with retries: the GDB server may come up seconds after the session. */
function rttAutoConnect(info, port, channel) {
  let tries = 0;
  const attempt = () => {
    rttConnect(info, port, channel).catch(() => {
      if (++tries < 30) {
        setTimeout(attempt, 1000);
      }
    });
  };
  attempt();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'debug_start',
    description: 'Start a VS Code debug session. Either pass configName (a launch.json configuration name) or a full inline config (type, request, executable, ...). Everything happens inside VS Code, so the user sees the debug UI.',
    inputSchema: {
      type: 'object',
      properties: {
        configName: { type: 'string', description: 'Name of a configuration from launch.json' },
        folder: { type: 'string', description: 'Optional workspace folder path to resolve configName in' },
        config: { type: 'object', description: 'Inline DebugConfiguration (used as-is, e.g. cortex-debug settings)' },
      },
    },
    async run(args) {
      let folder;
      if (args.folder) {
        const f = vscode.workspace.workspaceFolders.find((w) => w.uri.fsPath === args.folder);
        if (!f) {
          throw new Error(`Workspace folder not found: ${args.folder}`);
        }
        folder = f;
      } else if (vscode.workspace.workspaceFolders) {
        folder = vscode.workspace.workspaceFolders[0];
      }
      let cfg;
      let inputNote = '';
      if (args.configName) {
        if (!folder) {
          throw new Error('configName needs a workspace folder — pass folder');
        }
        // Resolve the config from launch.json ourselves and pass it in full.
        // A bare {name} that fails to resolve makes VS Code pop the
        // interactive "select debugger" picker instead of erroring out —
        // unusable from an MCP client.
        const r = await resolveNamedConfig(folder, args.configName);
        cfg = r.cfg;
        if (r.inputsUsed.length) {
          inputNote = ` (input defaults: ${r.inputsUsed.join(', ')})`;
        }
      } else if (args.config) {
        cfg = args.config;
        if (!cfg.name) {
          cfg.name = 'mcp-inline';
        }
      } else {
        throw new Error('Pass either configName or config');
      }
      // Do NOT await the full launch: embedded launches (JLink GDB server,
      // flashing, runToEntryPoint) routinely take longer than MCP client
      // timeouts. Fire it, then report as soon as the session shows up (or
      // fails); after the grace window the caller polls debug_status.
      const launch = { name: cfg.name, state: 'pending', error: null, at: Date.now() };
      launches.push(launch);
      if (launches.length > 5) {
        launches.shift();
      }
      vscode.debug
        .startDebugging(folder, cfg)
        .then(
          (ok) => {
            if (!ok) {
              launch.state = 'failed';
              launch.error =
                'startDebugging returned false (bad configuration or an error dialog in VS Code)';
            }
          },
          (e) => {
            launch.state = 'failed';
            launch.error = (e && e.message) || String(e);
          }
        );
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (launch.state === 'failed') {
          throw new Error(`Debug launch failed: ${launch.error}`);
        }
        const info = [...sessions.values()].find((s) => s.name === cfg.name);
        if (info) {
          // Hook RTT before the target starts running so boot logs are captured.
          if (String(cfg.servertype || '') === 'jlink') {
            const port = Number(cfg.rttPort) || RTT_DEFAULT_PORT;
            const chans = [
              ...new Set(
                ((cfg.rttConfig && cfg.rttConfig.decoders) || [{ port: 0 }]).map((d) =>
                  d.port !== undefined ? d.port : 0
                )
              ),
            ];
            for (const c of chans) {
              rttAutoConnect(info, port, c);
            }
          }
          return `Debug session "${cfg.name}" started${info.stopped ? ` — stopped (${info.stopReason})` : ''}.${inputNote}`;
        }
      }
      return `Debug launch "${cfg.name}" still in progress (server + flashing can take a while). Poll debug_status.${inputNote}`;
    },
  },

  {
    name: 'debug_stop',
    description: 'Stop a debug session (default: active one).',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Session name or id (optional)' } },
    },
    async run(args) {
      const info = getSession(args.session);
      await vscode.debug.stopDebugging(info.session);
      return 'Stop requested.';
    },
  },

  {
    name: 'debug_status',
    description: 'List debug sessions and their state (running/stopped, stop reason).',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const lines = [];
      for (const l of launches.slice(-3)) {
        if (l.state === 'pending') {
          lines.push(`launching "${l.name}"... (${Math.round((Date.now() - l.at) / 1000)}s)`);
        } else if (l.state === 'failed') {
          lines.push(`launch "${l.name}" FAILED: ${l.error}`);
        }
      }
      for (const [id, info] of sessions) {
        let line = `[${id}] "${info.name}" — ${info.stopped ? `STOPPED (${info.stopReason || 'unknown'})` : 'running'}`;
        if (info.rtt && info.rtt.chans.size) {
          line +=
            ' | rtt ' +
            [...info.rtt.chans.entries()].map(([c, st]) => `ch${c}[${st.buf.length}B]`).join(' ');
        }
        lines.push(line);
      }
      if (lines.length === 0) {
        return 'No debug sessions.';
      }
      return lines.join('\n');
    },
  },

  {
    name: 'debug_pause',
    description: 'Pause (break into) the target.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' } },
    },
    async run(args) {
      const info = getSession(args.session);
      await dap(info, 'pause', { threadId: await threadId(info, { forPause: true }) });
      return 'Pause requested.';
    },
  },

  {
    name: 'debug_continue',
    description: 'Continue execution of a paused target.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' } },
    },
    async run(args) {
      const info = getSession(args.session);
      await dap(info, 'continue', { threadId: await threadId(info) });
      return 'Continued.';
    },
  },

  {
    name: 'debug_step',
    description: 'Step: kind = over | into | out.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['over', 'into', 'out'] },
        session: { type: 'string' },
      },
      required: ['kind'],
    },
    async run(args) {
      const info = getSession(args.session);
      const tid = await threadId(info);
      const cmd = { over: 'next', into: 'stepIn', out: 'stepOut' }[args.kind];
      if (!cmd) {
        throw new Error(`Bad step kind: ${args.kind}`);
      }
      await dap(info, cmd, { threadId: tid });
      return `Step ${args.kind} requested.`;
    },
  },

  {
    name: 'debug_stack',
    description: 'Get the call stack of the stopped thread. Returns frames with ids for debug_variables / debug_evaluate.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        levels: { type: 'number', description: 'Max frames (default 20)' },
      },
    },
    async run(args) {
      const info = getSession(args.session);
      const tid = await threadId(info);
      const res = await dap(info, 'stackTrace', {
        threadId: tid,
        startFrame: 0,
        levels: args.levels || 20,
      });
      const frames = (res && res.stackFrames) || [];
      if (frames.length === 0) {
        return 'Call stack is empty (target not stopped?).';
      }
      return frames
        .map((f) => {
          const file = f.source && f.source.path ? f.source.path : '<no source>';
          return `#${f.id} ${f.name}  ${file}:${f.line}`;
        })
        .join('\n');
    },
  },

  {
    name: 'debug_variables',
    description: 'List variables of a stack frame (scopes with their variables). frameId comes from debug_stack. Drill deeper with the returned variablesReference values.',
    inputSchema: {
      type: 'object',
      properties: {
        frameId: { type: 'number', description: 'Frame id from debug_stack' },
        session: { type: 'string' },
      },
      required: ['frameId'],
    },
    async run(args) {
      const info = getSession(args.session);
      const scopesRes = await dap(info, 'scopes', { frameId: args.frameId });
      const scopes = (scopesRes && scopesRes.scopes) || [];
      const out = [];
      for (const sc of scopes) {
        const varsRes = await dap(info, 'variables', { variablesReference: sc.variablesReference });
        const vars = (varsRes && varsRes.variables) || [];
        out.push(
          `── ${sc.name} ──\n` +
            vars
              .map((v) => {
                const ref = v.variablesReference ? ` {ref:${v.variablesReference}}` : '';
                return `${v.name} = ${v.value}${ref}`;
              })
              .join('\n')
        );
      }
      return out.join('\n\n') || 'No variables.';
    },
  },

  {
    name: 'debug_evaluate',
    description: 'Evaluate a C/C++ expression in the context of a frame (or globally if the target is running and the adapter allows it). frameId comes from debug_stack.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        frameId: { type: 'number' },
        session: { type: 'string' },
      },
      required: ['expression'],
    },
    async run(args) {
      const info = getSession(args.session);
      // With a frame, evaluate as a watch expression ('repl' in cortex-debug
      // feeds the string to the gdb console, where plain identifiers fail
      // with "Undefined command"). Without a frame (target running) fall
      // back to 'repl' so gdb commands still work.
      const res = await dap(info, 'evaluate', {
        expression: args.expression,
        frameId: args.frameId,
        context: args.frameId !== undefined ? 'watch' : 'repl',
      });
      if (!res) {
        throw new Error('evaluate returned nothing');
      }
      let out = String(res.result);
      if (res.variablesReference) {
        out += ` {ref:${res.variablesReference}}`;
      }
      return out;
    },
  },

  {
    name: 'debug_set_variable',
    description: 'Change a variable value on the target. variablesReference comes from debug_variables / debug_evaluate output.',
    inputSchema: {
      type: 'object',
      properties: {
        variablesReference: { type: 'number' },
        name: { type: 'string' },
        value: { type: 'string' },
        session: { type: 'string' },
      },
      required: ['variablesReference', 'name', 'value'],
    },
    async run(args) {
      const info = getSession(args.session);
      const res = await dap(info, 'setVariable', {
        variablesReference: args.variablesReference,
        name: args.name,
        value: args.value,
      });
      return `Set. New value: ${res && res.value}`;
    },
  },

  {
    name: 'debug_set_breakpoints',
    description: 'Set breakpoints on lines of a file (replaces previous breakpoints set by this tool in that file). Breakpoints are visible in the VS Code editor gutter.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute file path' },
        lines: { type: 'array', items: { type: 'number' }, description: '1-based line numbers' },
        condition: { type: 'string', description: 'Optional condition expression (applied to all lines)' },
        hitCondition: { type: 'string', description: 'Optional hit count, e.g. "5" or ">10" (applied to all lines)' },
        logMessage: { type: 'string', description: 'Optional logpoint message (applied to all lines)' },
      },
      required: ['file', 'lines'],
    },
    async run(args) {
      const uri = vscode.Uri.file(args.file);
      // The VS Code breakpoint model is global — replace per file.
      const existing = vscode.debug.breakpoints.filter(
        (b) => b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === uri.toString()
      );
      if (existing.length) {
        vscode.debug.removeBreakpoints(existing);
      }
      if (!args.lines || args.lines.length === 0) {
        return 'Cleared breakpoints in file.';
      }
      const bps = args.lines.map((line) => {
        const location = new vscode.Location(uri, new vscode.Position(line - 1, 0));
        return new vscode.SourceBreakpoint(
          location,
          true,
          args.condition || undefined,
          args.hitCondition || undefined,
          args.logMessage || undefined
        );
      });
      vscode.debug.addBreakpoints(bps);
      const desc = args.condition
        ? ` (condition: ${args.condition})`
        : args.hitCondition
          ? ` (hit: ${args.hitCondition})`
          : '';
      return `Breakpoints set at ${args.file}:${args.lines.join(',')}${desc}`;
    },
  },

  {
    name: 'debug_clear_breakpoints',
    description: 'Clear breakpoints: in one file or all (file omitted).',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Absolute file path; omit to clear ALL breakpoints' } },
    },
    async run(args) {
      let toRemove = vscode.debug.breakpoints;
      if (args.file) {
        const uri = vscode.Uri.file(args.file);
        toRemove = toRemove.filter(
          (b) => b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === uri.toString()
        );
      }
      vscode.debug.removeBreakpoints(toRemove);
      return `Removed ${toRemove.length} breakpoint(s).`;
    },
  },

  {
    name: 'debug_list_breakpoints',
    description: 'List all breakpoints known to VS Code.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const bps = vscode.debug.breakpoints;
      if (bps.length === 0) {
        return 'No breakpoints.';
      }
      return bps
        .map((b) => {
          if (b instanceof vscode.SourceBreakpoint) {
            const p = b.location.range.start;
            const extra = [
              b.condition ? `cond:${b.condition}` : '',
              b.hitCondition ? `hit:${b.hitCondition}` : '',
              b.enabled ? '' : 'disabled',
            ]
              .filter(Boolean)
              .join(' ');
            return `${b.location.uri.fsPath}:${p.line + 1}${extra ? '  ' + extra : ''}`;
          }
          return `${b.label}(function)`;
        })
        .join('\n');
    },
  },

  {
    name: 'debug_rtt_connect',
    description:
      'Connect RTT monitoring sockets to the J-Link GDB Server RTT telnet port (default 19021; channel N listens on port+N). Auto-connected for jlink sessions started via debug_start. For other servers (BMP/openocd) pass the port your setup exposes.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'TCP port of RTT channel 0 (default 19021)' },
        channels: { type: 'array', items: { type: 'number' }, description: 'RTT channels to connect (default [0])' },
        session: { type: 'string' },
      },
    },
    async run(args) {
      const info = getSession(args.session);
      const port = args.port || RTT_DEFAULT_PORT;
      const chans = args.channels && args.channels.length ? args.channels : [0];
      const res = [];
      for (const c of chans) {
        res.push(await rttConnect(info, port, c));
      }
      return res.join('\n');
    },
  },

  {
    name: 'debug_rtt_read',
    description:
      'Read captured SEGGER RTT output. Draining by default (returns text since the last read); pass peek: true to keep the buffer. CRLF is normalized to LF.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'number', description: 'RTT channel (default 0)' },
        peek: { type: 'boolean', description: 'Do not consume the buffer' },
        raw: { type: 'boolean', description: 'Keep ANSI escape codes' },
        session: { type: 'string' },
      },
    },
    async run(args) {
      const info = getSession(args.session);
      const channel = args.channel !== undefined ? args.channel : 0;
      const st = info.rtt && info.rtt.chans.get(channel);
      if (!st) {
        throw new Error(
          `RTT channel ${channel} is not connected — call debug_rtt_connect (jlink default port ${RTT_DEFAULT_PORT})`
        );
      }
      if (!st.buf.length) {
        return '(no new RTT data)';
      }
      let text = st.buf;
      if (!args.peek) {
        st.buf = '';
      }
      if (text.length > 32000) {
        text = `[... truncated ${text.length - 32000} chars]\n` + text.slice(-32000);
      }
      if (!args.raw) {
        text = text.replace(/\x1b\[[0-9;]*m/g, ''); // ANSI color codes
      }
      return text.replace(/\r\n/g, '\n');
    },
  },

  {
    name: 'debug_rtt_write',
    description:
      'Send text to the RTT down-buffer (target input, e.g. a CLI listening on SEGGER_RTT read). Channel 0 by default.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        channel: { type: 'number' },
        session: { type: 'string' },
      },
      required: ['text'],
    },
    async run(args) {
      const info = getSession(args.session);
      const channel = args.channel !== undefined ? args.channel : 0;
      const st = info.rtt && info.rtt.chans.get(channel);
      if (!st || !st.sock) {
        throw new Error(`RTT channel ${channel} is not connected`);
      }
      st.sock.write(args.text);
      return `Sent ${args.text.length} chars → RTT down-buffer ${channel}.`;
    },
  },
];

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP (JSON responses, no external deps)
// ---------------------------------------------------------------------------

function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function dispatch(msg) {
  const { method, params, id } = msg;

  if (method === 'initialize') {
    return {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'Tools control VS Code debugging sessions (any DAP adapter). Start with debug_start (configName from launch.json), then debug_set_breakpoints, debug_continue/pause/step, debug_stack + debug_variables + debug_evaluate.',
    };
  }

  if (method === 'ping') {
    return {};
  }

  if (method === 'tools/list') {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    let text;
    try {
      text = await tool.run(args);
    } catch (e) {
      return {
        content: [{ type: 'text', text: `ERROR: ${e && e.message ? e.message : String(e)}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: String(text) }] };
  }

  if (method === 'resources/list' || method === 'prompts/list') {
    return { resources: [], prompts: [] };
  }

  throw new Error(`Method not supported: ${method}`);
}

async function handleRequest(req, res) {
  try {
    const isMcp = req.url === '/mcp' || req.url === '/mcp/';

    if (!isMcp) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Debug MCP Bridge. POST MCP messages to /mcp');
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // Streamable HTTP: no server-initiated SSE stream, no stateful session.
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    const raw = await readBody(req);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    // Notifications (no id) — nothing to answer.
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }

    try {
      const result = await dispatch(msg);
      const headers = {};
      if (msg.method === 'initialize') {
        // Give the client a session id to keep strict clients happy.
        headers['Mcp-Session-Id'] = `dbg-${++sessionId}`;
      }
      json(res, 200, { jsonrpc: '2.0', id: msg.id, result }, headers);
    } catch (e) {
      json(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: e && e.message ? e.message : String(e) },
      });
    }
  } catch (e) {
    try {
      res.writeHead(500);
      res.end(String(e));
    } catch (_) {
      /* socket gone */
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry points
// ---------------------------------------------------------------------------

/**
 * VS Code launched from the Dock gets a minimal PATH (no homebrew etc.), so
 * toolchain executables referenced by bare name in launch.json ("gdbPath":
 * "arm-none-eabi-gdb") are not found. Merge missing entries from the user's
 * login shell PATH into this process — child processes spawned by any
 * extension (gdb, JLinkGDBServer, ...) inherit it.
 */
function enrichPathFromLoginShell() {
  const shell = process.env.SHELL || '/bin/zsh';
  exec(`${shell} -lc 'printf %s "$PATH"'`, { timeout: 3000 }, (err, stdout) => {
    if (err || !stdout) {
      return;
    }
    const cur = (process.env.PATH || '').split(':').filter(Boolean);
    let added = 0;
    for (const p of stdout.toString().split(':')) {
      if (p && !cur.includes(p)) {
        cur.push(p);
        added++;
      }
    }
    if (added) {
      process.env.PATH = cur.join(':');
      console.log(`[debugMcpBridge] PATH: +${added} entries from login shell`);
    }
  });
}

// ---------------------------------------------------------------------------
// Port resolution and .mcp.json registration
// ---------------------------------------------------------------------------

function isFreePort(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: '127.0.0.1', port }, () => {
      probe.destroy();
      resolve(false);
    });
    probe.on('error', () => resolve(true));
    setTimeout(() => {
      try {
        probe.destroy();
      } catch (_) {
        /* noop */
      }
      resolve(true);
    }, 500);
  });
}

// .mcp.json at the project root is the ONLY file we write in the user's
// project: Claude Code reads it natively, and our port persists in it
// (mcpServers."debug-bridge".url). settings.json and other tools' config
// files are never touched.

/**
 * Registration policy: .mcp.json is auto-created only for projects that look
 * like bridge users, and never re-created after the user deletes it
 * (the opt-out is remembered in globalState):
 *   - exists                                  → keep in sync
 *   - absent + folder in opt-out list         → do nothing
 *   - absent + launch.json has cortex-debug   → create once
 *   - absent otherwise                        → do nothing
 */
const REGISTERED_KEY = 'mcpJsonRegisteredProjects';

async function hasCortexDebugLaunch(folder) {
  try {
    const text = Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json'))
    ).toString('utf8');
    return /cortex-debug/.test(text);
  } catch (_) {
    return false;
  }
}

async function markRegistered(folder) {
  if (!extensionContext) {
    return;
  }
  const list = new Set(extensionContext.globalState.get(REGISTERED_KEY, []));
  list.add(folder.uri.fsPath);
  await extensionContext.globalState.update(REGISTERED_KEY, [...list]);
}

async function isMarkedRegistered(folder) {
  if (!extensionContext) {
    return false;
  }
  const list = extensionContext.globalState.get(REGISTERED_KEY, []);
  return list.includes(folder.uri.fsPath);
}

/** Applies the registration policy above. */
async function syncRegistration(folder, port) {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, '.mcp.json'));
    await syncAgentConfigs(folder, port);
    await markRegistered(folder); // marks the opt-out point: deletion after this sticks
    return;
  } catch (_) {
    /* no .mcp.json */
  }
  if (await isMarkedRegistered(folder)) {
    return;
  }
  if (await hasCortexDebugLaunch(folder)) {
    await syncAgentConfigs(folder, port);
    await markRegistered(folder);
  }
}

async function readBridgePortFromMcpJson(folder) {
  try {
    const text = Buffer.from(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, '.mcp.json'))
    ).toString('utf8');
    const doc = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
    const url =
      doc && doc.mcpServers && doc.mcpServers['debug-bridge'] && doc.mcpServers['debug-bridge'].url;
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/mcp\/?$/.exec(String(url || ''));
    return m ? Number(m[1]) : null;
  } catch (_) {
    return null;
  }
}

/** Rewrites .mcp.json only when our URL actually changed; preserves other servers. */
async function syncAgentConfigs(folder, port) {
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const uri = vscode.Uri.joinPath(folder.uri, '.mcp.json');
    let text = '';
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch (_) {
      /* no .mcp.json yet — create */
    }
    let doc = {};
    if (text.trim()) {
      try {
        doc = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
      } catch (e) {
        console.log(`[debugMcpBridge] .mcp.json unreadable, not touching it: ${e.message}`);
        return;
      }
    }
    doc.mcpServers = doc.mcpServers || {};
    const cur = doc.mcpServers['debug-bridge'];
    if (!cur || cur.url !== url) {
      doc.mcpServers['debug-bridge'] = { type: 'http', url };
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(doc, null, 4) + '\n'));
      console.log(`[debugMcpBridge] .mcp.json → ${url}`);
    }
  } catch (e) {
    console.log(`[debugMcpBridge] .mcp.json update failed: ${e.message}`);
  }
}

/** Stable port derived from the folder path: hash → 7800..7899. */
function hashedPort(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) >>> 0;
  }
  return 7800 + (h % 100);
}

/**
 * 1. explicit `debugMcpBridge.port` setting → use as is;
 * 2. port from our .mcp.json entry → reuse (stable across reloads);
 * 3. otherwise hashedPort(folder), first free one, registered in .mcp.json
 *    (per the policy). One stable port per project — no cross-window fights
 *    over a shared default.
 */
async function resolvePort() {
  const cfg = vscode.workspace.getConfiguration('debugMcpBridge');
  const insp = cfg.inspect('port');
  const explicit =
    insp &&
    (insp.workspaceValue !== undefined ||
      insp.workspaceFolderValue !== undefined ||
      insp.globalValue !== undefined);
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (explicit) {
    const port = cfg.get('port');
    if (folder) {
      await syncRegistration(folder, port);
    }
    return port;
  }
  if (!folder) {
    return 7777; // folder-less window: legacy default
  }
  const fromMcp = await readBridgePortFromMcpJson(folder);
  if (fromMcp) {
    return fromMcp;
  }
  let port = hashedPort(folder.uri.fsPath);
  for (let i = 0; i < 20 && !(await isFreePort(port)); i++) {
    port++;
  }
  await syncRegistration(folder, port);
  return port;
}

function activate(context) {
  extensionContext = context;
  enrichPathFromLoginShell();
  resolvePort().then((port) => {
    bridgePort = port;

    // Native MCP discovery: VS Code (and MCP-aware clients inside it, e.g.
    // Claude Code) finds the server automatically — nothing to configure.
    if (vscode.lm && vscode.lm.registerMcpServerDefinitionProvider) {
      const provider = {
        provideMcpServerDefinitions: () => [
          new vscode.McpHttpServerDefinition('Debug MCP Bridge', vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`)),
        ],
      };
      context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider('debugMcpBridgeProvider', provider)
      );
    }

    startServer(port);
  });

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage: (m) => {
            if (m.type !== 'event') {
              return;
            }
            // DAP events arrive before onDidStartDebugSession (the
            // runToEntryPoint stop happens mid-launch) — create the entry
            // lazily or the stopped state is lost.
            let info = sessions.get(session.id);
            if (!info) {
              info = { session, name: session.name, stopped: false, stopReason: null };
              sessions.set(session.id, info);
            }
            if (m.event === 'stopped') {
              info.stopped = true;
              info.stopReason = (m.body && m.body.reason) || 'unknown';
              if (m.body && m.body.threadId !== undefined) {
                info.threadId = m.body.threadId;
              }
            } else if (m.event === 'continued') {
              info.stopped = false;
              // keep threadId: adapters answer 'threads' with [] while the
              // target runs, but pause/continue still need an id.
            }
          },
        };
      },
    })
  );

  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(onSessionStart),
    vscode.debug.onDidTerminateDebugSession(onSessionEnd),
    vscode.commands.registerCommand('debugMcpBridge.showStatus', () => {
      const list = [...sessions.values()]
        .map((s) => `${s.name}: ${s.stopped ? 'stopped' : 'running'}`)
        .join('\n');
      vscode.window.showInformationMessage(
        `Debug MCP Bridge: http://127.0.0.1:${bridgePort}/mcp\n${list || 'No debug sessions.'}`
      );
    }),
    vscode.commands.registerCommand('debugMcpBridge.registerClaude', async () => {
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      if (!folder) {
        vscode.window.showErrorMessage('Debug MCP Bridge: open a folder first');
        return;
      }
      try {
        await syncAgentConfigs(folder, bridgePort);
        await markRegistered(folder);
        vscode.window.showInformationMessage(
          `Debug MCP Bridge registered in ${folder.name}/.mcp.json → http://127.0.0.1:${bridgePort}/mcp`
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Debug MCP Bridge: registration failed: ${e.message}`);
      }
    })
  );

  context.subscriptions.push({ dispose: () => server && server.close() });
}

function startServer(port) {
  // On EADDRINUSE another window owns the port (e.g. an explicit duplicate
  // config); keep retrying so this window takes over when it goes away.
  const tryListen = () => {
    const s = http.createServer(handleRequest);
    s.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        vscode.window.setStatusBarMessage(
          `Debug MCP Bridge: port ${port} served by another window, will retry`, 10000
        );
        setTimeout(tryListen, 10000);
        return;
      }
      vscode.window.showErrorMessage(`Debug MCP Bridge failed to listen on port ${port}: ${e.message}`);
    });
    s.listen(port, '127.0.0.1', () => {
      server = s;
      vscode.window.setStatusBarMessage(`Debug MCP Bridge: 127.0.0.1:${port}/mcp`, 15000);
    });
  };
  tryListen();
}

function deactivate() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = { activate, deactivate };

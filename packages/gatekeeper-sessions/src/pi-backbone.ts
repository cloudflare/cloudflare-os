import type { CodingSessionPiCommand } from "@gadgets/workshop-shared/api";
import { harnessRpcCommand } from "./runtime.js";

export const PI_BRIDGE_PORT = 4097;
export const PI_BRIDGE_PATH = "/workspace/.odie-pi/owner-bridge-v1.mjs";
export const PI_BRIDGE_COMMAND: [string, ...string[]] = ["node", PI_BRIDGE_PATH];

/** Reject unknown fields as well as unknown commands before crossing the sandbox boundary. */
export function validatePiCommand(command: CodingSessionPiCommand): CodingSessionPiCommand {
  if (!command || typeof command !== "object") throw new Error("Invalid Pi command.");
  let keys: string[] = ["type"];
  switch (command.type) {
    case "get_state": case "get_messages": case "get_entries": case "get_tree": case "abort": case "export_html": break;
    case "prompt": case "steer": case "follow_up":
      keys.push("message");
      if (typeof command.message !== "string" || !command.message.trim() || new TextEncoder().encode(command.message).length > 32768) throw new Error("Invalid Pi input.");
      break;
    case "events":
      keys.push("after");
      if (!Number.isSafeInteger(command.after) || command.after < 0) throw new Error("Invalid event cursor.");
      break;
    case "extension_ui_response":
      keys.push("id", "value", "confirmed", "cancelled");
      if (typeof command.id !== "string" || command.id.length > 256 || !command.id ||
          command.value !== undefined && (typeof command.value !== "string" || command.value.length > 8192) ||
          command.confirmed !== undefined && typeof command.confirmed !== "boolean" ||
          command.cancelled !== undefined && command.cancelled !== true ||
          [command.value, command.confirmed, command.cancelled].filter(value => value !== undefined).length !== 1) throw new Error("Invalid dialog reply.");
      break;
    default: throw new Error("Unsupported Pi command.");
  }
  if (Object.keys(command).some(key => !keys.includes(key))) throw new Error("Unexpected Pi command field.");
  return command;
}

/** The bridge is materialized by the Worker; its child uses pipes, never a PTY. */
export function piBridgeSource(): string {
  const argv = harnessRpcCommand("pi");
  argv.push("--session", "/workspace/.odie-pi/owner-session.jsonl");
  return `const argv = ${JSON.stringify(argv)};\n` + String.raw`
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { constants, openSync, closeSync, readFileSync } from 'node:fs';
const LIMIT = 2 * 1024 * 1024;
// JSON can escape each decoded input byte as six ASCII bytes, plus envelope/id overhead.
const REQUEST_LIMIT = 6 * 32768 + 4096;
const DIALOG_TIMEOUT = 30000;
const DRAIN_TIMEOUT = 5000;
if (JSON.parse(readFileSync('/opt/odie-pi/node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8')).version !== '0.84.2') throw new Error('Unsupported Pi version; expected 0.84.2.');
// A crashed bridge must not silently spawn another brain against the same history.
// The lock is intentionally retained until explicit sandbox destruction/restart.
closeSync(openSync('/workspace/.odie-pi/owner-bridge.lock', 'wx', 0o600));
const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
let pending = new Map(), dialogs = new Map(), dialogTimers = new Map(), events = [], bytes = 0, seq = 0, dead = false;
const buffer = Buffer.alloc(LIMIT);
let used = 0, draining = false;
let drainTimer;
function event(data) {
  const size = Buffer.byteLength(JSON.stringify(data));
  events.push({cursor: ++seq, data, size}); bytes += size;
  while (events.length > 256 || bytes > LIMIT / 2) bytes -= events.shift().size;
}
function rejectPending(message) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
}
function removeDialog(id) {
  clearTimeout(dialogTimers.get(id)); dialogTimers.delete(id); dialogs.delete(id);
}
function fail() {
  if (dead) return; dead = true;
  clearTimeout(drainTimer); drainTimer = undefined;
  used = 0; draining = false;
  rejectPending('Pi process unavailable; explicit restart required.');
  for (const id of dialogs.keys()) removeDialog(id);
  event({type:'bridge_exit'});
}
child.on('error', fail); child.on('exit', fail);
function failTransport() {
  if (dead) return;
  fail(); child.kill('SIGKILL');
}
// Even an otherwise-live process is unusable after losing its response channel.
// This also closes incomplete ordinary frames and oversized frames still draining.
child.stdout.on('end', failTransport);
child.stdout.on('close', failTransport);
child.stdout.on('error', failTransport);
child.stderr.on('data', () => {}); // Never mix stderr into protocol or expose credentials from it.
function receive(line) {
    let data; try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(line)); } catch { fail(); child.kill('SIGKILL'); return; }
    if (!data || typeof data !== 'object') { fail(); child.kill('SIGKILL'); return; }
    if (data.type === 'response') {
      const p = pending.get(data.id);
      if (p && p.type === data.command) {
        pending.delete(data.id); clearTimeout(p.timer);
        data.success === true ? p.resolve(data.data ?? null) : p.reject(new Error('Pi command failed.'));
      }
    } else {
      if (data.type === 'extension_ui_request' && typeof data.id === 'string') {
        if (dialogs.size >= 64 || Buffer.byteLength(JSON.stringify(data)) > 8192) { fail(); child.kill('SIGKILL'); return; }
        if (['confirm','select','input','editor'].includes(data.method)) {
          if (dialogs.has(data.id)) { fail(); child.kill('SIGKILL'); return; }
          dialogs.set(data.id, data);
          dialogTimers.set(data.id, setTimeout(() => {
            if (dialogs.get(data.id) !== data) return;
            try {
              // Pi may have no native deadline (notably editor). Release its waiter too.
              send({type:'extension_ui_response', id:data.id, cancelled:true});
              removeDialog(data.id);
            } catch {
              // Never leave a live peer silently waiting when cancellation cannot be sent.
              fail(); child.kill('SIGKILL');
            }
          }, Number.isSafeInteger(data.timeout) && data.timeout > 0 ? Math.min(data.timeout, DIALOG_TIMEOUT) : DIALOG_TIMEOUT).unref());
        }
      }
      event(data);
    }
}
child.stdout.on('data', chunk => {
  let start = 0;
  while (start < chunk.length && !dead) {
    const lf = chunk.indexOf(10, start);
    const end = lf < 0 ? chunk.length : lf;
    const length = end - start;
    if (!draining && used + length > LIMIT) {
      // Correlation is unavailable without parsing the oversized frame. Reject all
      // outstanding requests explicitly, then discard through LF without retaining it.
      draining = true; used = 0;
      // Absolute deadline from first overflow; more bytes must not prolong it.
      drainTimer = setTimeout(failTransport, DRAIN_TIMEOUT).unref();
      rejectPending('Pi response frame too large; pending results unavailable and write outcomes unknown. Do not retry writes automatically.');
      event({type:'bridge_frame_omitted', reason:'frame_too_large'});
    }
    if (!draining) { chunk.copy(buffer, used, start, end); used += length; }
    if (lf >= 0) {
      clearTimeout(drainTimer); drainTimer = undefined;
      if (!draining) receive(buffer.subarray(0, used));
      used = 0; draining = false;
    }
    start = end + 1;
  }
});
function send(command) {
  const frame = JSON.stringify(command) + '\n';
  const size = Buffer.byteLength(frame);
  if (size > REQUEST_LIMIT) throw new Error('Pi command too large.');
  if (dead || !child.stdin.writable || child.stdin.writableLength + size > 2 * REQUEST_LIMIT) throw new Error('Pi unavailable or busy.');
  child.stdin.write(frame);
}
child.stdin.on('error', fail);
function rpc(command) {
  if (draining) return Promise.reject(new Error('Pi is draining an oversized frame; command was not sent.'));
  if (pending.size >= 16) return Promise.reject(new Error('Pi is busy.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Pi command timed out; outcome unknown. Do not retry writes automatically.')); }, 25000);
    pending.set(id, {resolve, reject, timer, type:command.type});
    try { send({...command,id}); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
  });
}
async function execute(command) {
  if (command.type === 'events') return {cursor:seq, truncated:command.after < (events[0]?.cursor ?? seq + 1) - 1,
    events:events.filter(e => e.cursor > command.after).map(({cursor,data}) => ({cursor,data})), dialogs:[...dialogs.values()], dead};
  if (command.type === 'extension_ui_response') {
    const dialog = dialogs.get(command.id);
    if (!dialog) throw new Error('Dialog expired or unknown.');
    if (!command.cancelled && (dialog.method === 'confirm' ? typeof command.confirmed !== 'boolean' : typeof command.value !== 'string')) throw new Error('Invalid dialog response.');
    if (dialog.method === 'select' && !command.cancelled && !dialog.options?.includes(command.value)) throw new Error('Invalid selection.');
    send(command); removeDialog(command.id); return {accepted:true};
  }
  if (command.type === 'export_html') {
    const dir = await mkdtemp('/tmp/odie-pi-export-'); const path = dir + '/session.html';
    try {
      await rpc({type:'export_html', outputPath:path});
      if (await realpath(path) !== await realpath(dir) + '/session.html') throw new Error('Invalid artifact.');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Artifact too large.');
        const data = Buffer.alloc(1024 * 1024 + 1); const {bytesRead} = await file.read(data, 0, data.length, 0);
        if (bytesRead > 1024 * 1024) throw new Error('Artifact too large.');
        return {filename:'pi-session.html', mediaType:'text/html', base64:data.subarray(0,bytesRead).toString('base64')};
      } finally { await file.close(); }
    } finally { await rm(dir, {recursive:true,force:true}); }
  }
  if (!['get_state','get_messages','get_entries','get_tree','prompt','steer','follow_up','abort'].includes(command.type)) throw new Error('Unsupported operation.');
  return rpc(command);
}
const server = createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST' || req.url !== '/') { res.writeHead(404).end(); return; }
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > REQUEST_LIMIT) throw new Error('Request too large.'); chunks.push(chunk); }
    const result = JSON.stringify(await execute(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    if (Buffer.byteLength(result) > LIMIT) throw new Error('Result too large; use terminal history.');
    res.end(result);
  } catch (error) { res.writeHead(409).end(JSON.stringify({error:error.message})); }
});
server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxConnections = 32;
server.on('error', () => { child.kill('SIGKILL'); process.exitCode = 1; });
server.listen(4097, '0.0.0.0', () => process.stdout.write('Pi owner bridge ready\n'));
function shutdown() { fail(); server.close(); child.kill('SIGTERM'); setTimeout(() => {child.kill('SIGKILL'); process.exit(0);}, 1000).unref(); }
for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, shutdown);
process.stdin.resume(); // Terminal input never becomes agent input.
`;
}

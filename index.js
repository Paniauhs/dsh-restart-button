/**
 * dsh-restart-button — Host half.
 *
 * Owns the restart itself and exposes it to the caption-row button:
 *
 *  - `GET  /dsh-restart/status`     mode, serving port, and whether a restart
 *                                  POST from the caller's page would pass the
 *                                  local fence.
 *  - `POST /dsh-restart/restart`    hand the restart to a detached helper and
 *                                  then exit this Host, so the helper can
 *                                  replace it (or, under the desktop app, kill
 *                                  the app and start it again).
 *  - `POST /dsh-restart/diagnostic` append one JSON line to a temp log. The
 *                                  caption-row button reports the geometry it
 *                                  measured there; no session data is sent.
 *
 * The helper is `helper.cjs`, copied into a fresh temp directory at handoff
 * time and run detached: it has to act after this process is gone, and it has
 * to keep working while the profile's own plugin tree is the thing being
 * restarted.
 *
 * Restart safety: only a direct same-origin loopback POST can schedule one
 * (no forwarding headers, a loopback `Host`, and an `Origin` equal to `Host`),
 * which keeps a rebound DNS name or a foreign page from stopping the app; the
 * helper re-checks the process it is about to kill before it kills it; and
 * `?dryRun=1` performs every measurement and writes the plan without killing
 * anything.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the caption button reads state and asks for the restart. */
const STATUS_PATH = '/dsh-restart/status';
const RESTART_PATH = '/dsh-restart/restart';
const DIAGNOSTIC_PATH = '/dsh-restart/diagnostic';

/** The desktop app's own host, which this plugin restarts from inside. */
const HOST_SERVICE = 'webServer';

/** Longest diagnostic body accepted, in bytes. */
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

/** Native Windows caption button width in DIPs (three of them sit right of us). */
const CAPTION_BUTTON_WIDTH = 46;

/** Environment keys a relaunched GUI app must not inherit. */
const APP_ENV_EXCLUSIONS = ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ATTACH_CONSOLE'];

export const inject = [HOST_SERVICE];

/**
 * Declare the three routes on the Harness Web server.
 * @param ctx - Host context carrying the Web server service.
 */
export function apply(ctx) {
  let restarting = false;

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (request, response) => {
      const reachable = directLoopbackRequest(request);
      sendJson(response, 200, {
        ok: true,
        plugin: 'dsh-restart-button',
        mode: restartMode(),
        pid: process.pid,
        port: servingPort(request),
        captionButtonWidth: CAPTION_BUTTON_WIDTH,
        restarting,
        // Read off THIS request: the POST arrives from the same page over the
        // same path, so a proxy peer or a foreign Host fails both the same way.
        restartReachable: reachable.ok,
        restartBlockedBy: reachable.ok ? null : reachable.reason,
      });
    },
  }), 'dsh-restart-button: status route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RESTART_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'the restart button restarts with POST' }, { allow: 'POST' });
        return;
      }
      const fence = trustedRestartRequest(request);
      if (!fence.ok) {
        sendJson(response, 403, { error: fence.reason });
        return;
      }
      const mode = restartMode();
      if (mode === null) {
        sendJson(response, 503, { error: 'this host cannot be restarted from its own process' });
        return;
      }
      if (restarting) {
        sendJson(response, 409, { error: 'a restart is already scheduled' });
        return;
      }
      restarting = true;
      const dryRun = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
        .searchParams.get('dryRun') === '1';
      let plan;
      try {
        plan = scheduleRestart({ port: servingPort(request), mode, dryRun, ctx });
      } catch (error) {
        restarting = false;
        sendJson(response, 500, { error: `could not schedule the restart: ${message(error)}` });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        mode,
        dryRun,
        directory: plan.directory,
        helperPid: plan.helperPid,
      });
      if (dryRun) restarting = false;
      else exitAfterFlush(response);
    },
  }), 'dsh-restart-button: restart route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DIAGNOSTIC_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'diagnostics are posted' }, { allow: 'POST' });
        return;
      }
      if (!directLoopbackRequest(request).ok) {
        sendJson(response, 403, { error: 'diagnostics are limited to loopback callers' });
        return;
      }
      let body = '';
      try {
        body = await readBody(request, MAX_DIAGNOSTIC_BYTES);
      } catch (error) {
        sendJson(response, 413, { error: message(error) });
        return;
      }
      const line = `${new Date().toISOString()} ${body.replace(/\s+/gu, ' ').slice(0, MAX_DIAGNOSTIC_BYTES)}\n`;
      try {
        appendFileSync(diagnosticLogPath(), line);
        sendJson(response, 200, { ok: true, log: diagnosticLogPath() });
      } catch (error) {
        sendJson(response, 500, { error: message(error) });
      }
    },
  }), 'dsh-restart-button: diagnostic route');
}

/**
 * Which restart this process supports: the whole desktop app when the Host is
 * Electron running in Node mode as a child of its own main process, and the
 * Host process alone when it is an ordinary `dsh` / `dsh web` process.
 * @returns the mode, or null when neither plan can be built.
 */
function restartMode() {
  const app = appPlan();
  if (app !== null) return 'app';
  return hostPlan() === null ? null : 'host';
}

/**
 * The desktop application around this process, when there is one.
 *
 * The Host is spawned by the Electron main process with `ELECTRON_RUN_AS_NODE`
 * set, so the executable path is the app itself and the parent is its main
 * process — the process whose termination closes DSH and whose relaunch is a
 * complete restart.
 * @returns the app plan, or null when this is not the desktop Host.
 */
function appPlan() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return null;
  if (process.platform !== 'win32') return null;
  if (!/\.exe$/iu.test(process.execPath)) return null;
  if (!Number.isSafeInteger(process.ppid) || process.ppid <= 0) return null;
  return {
    pid: process.ppid,
    exe: process.execPath,
    dir: dirname(process.execPath),
    args: [],
    env: filteredEnv(APP_ENV_EXCLUSIONS),
  };
}

/**
 * The exact invocation that booted this Host, for the standalone case.
 * `process.argv[1]` is the entry the shell ran (`bin.js`, the desktop Host
 * entry, a source launch); `process.execArgv` carries the flags Node needs to
 * run it again. Inspector flags are dropped: the replacement would fail to bind
 * the same debug port.
 * @returns the host plan, or null when this process has no replayable entry.
 */
function hostPlan() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return null;
  return {
    exe: process.execPath,
    args: [...replayableExecArgv(), ...process.argv.slice(1)],
    cwd: process.cwd(),
    env: { ...process.env },
  };
}

/** @returns `process.execArgv` without debugger flags. */
function replayableExecArgv() {
  return process.execArgv.filter((arg) => !/^--(?:inspect|inspect-brk|inspect-port|inspect-wait|debug|debug-brk)(?:=|$)/u.test(arg));
}

/**
 * @param exclusions - Environment keys to drop.
 * @returns a copy of this process's environment without those keys.
 */
function filteredEnv(exclusions) {
  const env = { ...process.env };
  for (const key of exclusions) delete env[key];
  return env;
}

/**
 * Write the helper and its plan into a fresh temp directory and start the
 * helper detached.
 * @param options - Serving port, restart mode, dry-run flag, and Host context.
 * @returns the plan directory and the helper's pid.
 */
function scheduleRestart({ port, mode, dryRun, ctx }) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  const directory = join(tmpdir(), `dsh-restart-${stamp}`);
  mkdirSync(directory, { recursive: true });
  const helperPath = join(directory, 'helper.cjs');
  const planPath = join(directory, 'plan.json');
  writeFileSync(helperPath, readFileSync(fileURLToPath(new URL('./helper.cjs', import.meta.url))));
  const plan = {
    version: 1,
    createdAt: new Date().toISOString(),
    dryRun,
    mode,
    port: port ?? servicePort(ctx),
    profile: process.env.DSH_PROFILE ?? null,
    helperPath,
    planPath,
    lockPath: join(directory, 'helper.lock'),
    logPath: join(directory, 'helper.log'),
    resultPath: join(directory, 'result.json'),
    app: appPlan(),
    host: hostPlan(),
  };
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const helper = spawn(process.execPath, [helperPath, planPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
    cwd: process.cwd(),
  });
  helper.unref();
  return { directory, helperPid: helper.pid };
}

/**
 * @param ctx - Host context.
 * @returns the Web server's own port, when the service publishes one.
 */
function servicePort(ctx) {
  const value = ctx.webServer?.port;
  return typeof value === 'number' ? value : null;
}

/**
 * Exit once the response is on its way, so the helper can take the port over.
 * @param response - The response being finished.
 */
function exitAfterFlush(response) {
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.exit(0);
  };
  response.on('finish', () => setTimeout(exit, 200));
  response.on('close', () => setTimeout(exit, 200));
  // Backstop: never leave a scheduled restart waiting on a socket event.
  setTimeout(exit, 3000).unref?.();
}

/**
 * The port the replacement has to serve, read off the request that asked.
 * The Host header is what the page actually reached; parsing the launch argv
 * would be wrong for every host that binds from config.
 * @param request - Incoming request.
 * @returns the port, or null when the header carries none.
 */
function servingPort(request) {
  const host = request.headers.host;
  if (typeof host !== 'string') return null;
  const match = /:(\d{1,5})$/u.exec(host);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * @param host - A `Host` header value.
 * @returns whether it names a loopback authority (so a rebound name fails).
 */
function loopbackAuthority(host) {
  if (typeof host !== 'string' || host === '') return false;
  const value = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return value === '127.0.0.1' || value === 'localhost' || value === '::1';
}

/**
 * The part of the fence that does not depend on `Origin`, so the status route
 * can predict it for a plain same-origin GET.
 * @param request - Incoming request.
 * @returns whether the caller is a direct loopback request.
 */
function directLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    return { ok: false, reason: 'restart is limited to loopback callers' };
  }
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) {
    return { ok: false, reason: 'restart is limited to direct requests (a proxy peer was detected)' };
  }
  if (!loopbackAuthority(request.headers.host)) {
    return { ok: false, reason: 'restart is limited to requests addressed to a loopback host' };
  }
  return { ok: true, reason: null };
}

/**
 * The full fence a process-control request has to pass.
 *
 * An `Origin` that is present must be loopback and identical to `Host`: that is
 * the browser case, and it is what stops another page — including one reached
 * through a rebound name — from restarting DSH. An ABSENT `Origin` passes,
 * because no browser omits it on a POST while a same-origin fetch that arrived
 * through the desktop shell's custom-protocol forward has it stripped by design
 * (`forwardWebRequest` removes `origin`, `cookie`, and `sec-fetch-site` and
 * re-attaches the host cookie). The loopback peer, the absence of forwarding
 * headers, and the loopback `Host` above still have to hold, so only a local
 * caller can reach this route at all.
 * @param request - Incoming request.
 * @returns `{ ok, reason }` — `reason` explains a refusal to the caller.
 */
function trustedRestartRequest(request) {
  const direct = directLoopbackRequest(request);
  if (!direct.ok) return direct;
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined) return { ok: true, reason: null };
  if (typeof origin !== 'string' || typeof host !== 'string') {
    return { ok: false, reason: 'restart requires an Origin that matches this page' };
  }
  try {
    const parsed = new URL(origin);
    if (!loopbackAuthority(parsed.host)) {
      return { ok: false, reason: 'restart requires a loopback page origin' };
    }
    if (parsed.host !== host) {
      return { ok: false, reason: 'restart requires a same-origin page' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'restart requires an http(s) page origin' };
    }
  } catch {
    return { ok: false, reason: 'restart requires an Origin that matches this page' };
  }
  return { ok: true, reason: null };
}

/**
 * Read a bounded request body.
 * @param request - Incoming request.
 * @param limit - Largest accepted body in bytes.
 * @returns the body text.
 */
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error(`the body exceeds ${String(limit)} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @returns the temp log the caption button's diagnostics are appended to. */
function diagnosticLogPath() {
  return join(tmpdir(), 'dsh-restart-diagnostic.log');
}

/**
 * Answer one request with JSON.
 * @param response - Server response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 * @param headers - Extra response headers.
 */
function sendJson(response, status, body, headers = {}) {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

/**
 * @param error - Anything thrown.
 * @returns a readable message.
 */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

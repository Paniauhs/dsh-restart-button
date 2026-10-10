/**
 * dsh-restart-button — detached restart helper.
 *
 * Started by the Host's restart route with `node helper.cjs plan.json`, then
 * left to finish the job after that Host exits:
 *
 *  app mode   verify the parent process is the desktop app's main process, kill
 *             it, wait for the port to be released, start the app again.
 *  host mode  wait for the port to be released, start the same Host invocation
 *             again with the environment it had.
 *
 * Why a helper at all: the process that knows the launch invocation is the one
 * being replaced, so the replacement cannot be started by it directly.
 *
 * Why it re-creates itself through WMI in app mode: the app kill may take the
 * whole process tree down, and this helper is inside that tree. The copy WMI
 * creates is parented to the WMI provider host instead, so it survives; the
 * first copy only delegates and exits. A lock file keeps exactly one of them
 * acting, and when WMI is unavailable the first copy does the work itself —
 * which it can do invisibly, because it was started with CREATE_NO_WINDOW.
 * The re-created copy is launched through `conhost --headless` so that this
 * escape costs the user no window; `createGuardian` records what the other
 * launchers were measured to do.
 *
 * Nothing here trusts the plan blindly: the process about to be killed is
 * re-read from the OS and must look like the app's main process, not a renderer
 * or a browser.
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { dirname, join } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const guardian = process.argv.includes('--guardian');
const POWERSHELL = process.env.SystemRoot === undefined
  ? 'powershell.exe'
  : `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/** Appends one line to the plan's log; logging never fails the restart. */
function log(line) {
  try {
    fs.appendFileSync(plan.logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* the restart matters more than its log */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @returns whether something accepts a connection on the loopback port. */
function portOpen(port) {
  return new Promise((resolve) => {
    if (typeof port !== 'number') {
      resolve(false);
      return;
    }
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    setTimeout(() => done(false), 500);
  });
}

/** @returns whether the port reached the wanted state before the timeout. */
async function waitPort(port, open, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portOpen(port) === open) return true;
    if (Date.now() >= deadline) return false;
    await sleep(300);
  }
}

/** @returns whether a file exists before the timeout. */
async function waitFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(path)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

/** Quotes one PowerShell single-quoted literal. */
function psQuote(text) {
  return `'${String(text).replace(/'/gu, "''")}'`;
}

/** Runs one PowerShell command line. */
function powershell(script, timeoutMs) {
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/**
 * Re-create this helper outside the app's process tree through the WMI
 * provider, without ever showing a window.
 *
 * WMI creates a process with no window-style control and runs it in this
 * session, so the launcher decides what the user sees. Measured on this
 * machine, with each candidate's visible top-level windows enumerated around
 * the launch:
 *
 *   - `cmd.exe /c …`                  wrapper runs, one console window appears
 *                                    and lives as long as the helper, so it had
 *                                    to be closed by hand;
 *   - `wscript.exe` + `Run(…, 0, …)`  no window, but the script never runs
 *                                    from this context at all;
 *   - `powershell -WindowStyle Hidden` no wrapper run, and a window still
 *                                    flashes;
 *   - `conhost.exe --headless`        wrapper runs, zero windows.
 *
 * So the wrapper is a .cmd that starts this helper again with --guardian and
 * returns immediately (`start /b`, so whoever owns the console is not kept
 * alive by the restart), and conhost runs that wrapper headless. Where the
 * headless switch does not exist the guardian simply never claims the lock and
 * this copy carries on, which is also how the whole escape degrades.
 * @returns whether WMI reported a created process.
 */
function createGuardian() {
  const wrapper = join(dirname(plan.planPath), 'guardian.cmd');
  try {
    fs.writeFileSync(wrapper, [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `start "" /b "${plan.app.exe}" "${plan.helperPath}" "${plan.planPath}" --guardian`,
      '',
    ].join('\r\n'));
  } catch (error) {
    log(`could not write the guardian wrapper: ${String(error)}`);
    return false;
  }
  const conhost = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\conhost.exe`;
  const command = `"${conhost}" --headless cmd.exe /c "${wrapper}"`;
  const script = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psQuote(command)}}; if ($r.ReturnValue -eq 0) { "created " + $r.ProcessId } else { "failed " + $r.ReturnValue }`;
  const result = powershell(script, 25000);
  log(`guardian attempt: status=${String(result.status)} out=${result.stdout} err=${result.stderr}`);
  return result.status === 0 && result.stdout.startsWith('created');
}

/** @returns `{ ProcessId, Name, CommandLine }` for a pid, or null when it is gone. */
function processInfo(pid) {
  const script = `Get-CimInstance Win32_Process -Filter ${psQuote(`ProcessId=${pid}`)} | Select-Object -Property ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
  const result = powershell(script, 20000);
  if (result.status !== 0 || result.stdout === '') return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    log(`process identity was not JSON: ${String(error)} raw=${result.stdout.slice(0, 200)}`);
    return null;
  }
}

/** Terminates exactly one process — never its tree, which contains this helper. */
function killProcess(pid) {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  log(`taskkill ${String(pid)}: status=${String(result.status)} out=${output}`);
  return result.status === 0;
}

/** Takes the helper lock so exactly one copy acts. */
function takeLock() {
  try {
    const handle = fs.openSync(plan.lockPath, 'wx');
    fs.writeSync(handle, String(process.pid));
    fs.closeSync(handle);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the process the plan names really is the desktop app's main process:
 * same executable, command line without a Chromium child-type switch.
 * @returns 'kill' when it is safe to terminate, 'gone' when it already exited,
 *   or a refusal reason.
 */
async function appKillDecision(app) {
  const info = processInfo(app.pid);
  if (info === null) return { decision: 'gone', detail: 'the app process is already gone' };
  const name = String(info.Name ?? '');
  const commandLine = String(info.CommandLine ?? '');
  const expected = app.exe.split(/[\\/]/u).pop();
  if (name.toLowerCase() !== String(expected).toLowerCase()) {
    return { decision: 'refuse', detail: `parent process is ${name}, not ${expected}` };
  }
  if (/--type=/u.test(commandLine)) {
    return { decision: 'refuse', detail: 'parent process is a Chromium child process, not the app main process' };
  }
  return { decision: 'kill', detail: commandLine };
}

/** Waits until the pid disappears, with the port as the real signal. */
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (processInfo(pid) === null) return true;
    if (Date.now() >= deadline) return false;
    await sleep(400);
  }
}

/** Starts the app or the Host, detached, logging its output beside the helper. */
function startReplacement(target, args, cwd, env, options) {
  const out = fs.openSync(`${plan.logPath}.out`, 'a');
  const err = fs.openSync(`${plan.logPath}.err`, 'a');
  const child = spawn(target, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: options.windowsHide !== false,
  });
  child.on('error', (error) => log(`could not start the replacement: ${error.message}`));
  child.unref();
  return child.pid;
}

/** Writes the machine-readable outcome beside the plan. */
function writeResult(result) {
  try {
    fs.writeFileSync(plan.resultPath, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    log(`could not write the result: ${String(error)}`);
  }
}

/** Reports the process facts a dry run is judged on. */
async function dryRun() {
  const report = {
    dryRun: true,
    mode: plan.mode,
    port: plan.port,
    portOpenNow: await portOpen(plan.port),
    host: plan.host === null
      ? null
      : { exe: plan.host.exe, args: plan.host.args, cwd: plan.host.cwd },
    app: plan.app === null
      ? null
      : { pid: plan.app.pid, exe: plan.app.exe, dir: plan.app.dir, envKeys: Object.keys(plan.app.env).length },
  };
  if (plan.app !== null) report.appDecision = await appKillDecision(plan.app);
  log(`dry run: ${JSON.stringify(report)}`);
  writeResult(report);
}

/** Performs the restart this plan describes. */
async function restart() {
  const report = { dryRun: false, mode: plan.mode, startedAt: new Date().toISOString(), steps: [] };
  const step = (text) => {
    report.steps.push(text);
    log(text);
  };
  let mode = plan.mode;
  let app = plan.app;

  if (mode === 'app' && app !== null) {
    const decision = await appKillDecision(app);
    step(`app check: ${decision.decision} (${decision.detail.slice(0, 200)})`);
    if (decision.decision === 'refuse') {
      // Never kill a process we cannot identify; the Host restart still reloads
      // every plugin, which is what the button is for.
      mode = plan.host === null ? 'none' : 'host';
      step(`falling back to ${mode} mode`);
      app = null;
    }
  }

  if (mode === 'app' && app !== null) {
    killProcess(app.pid);
    const gone = await waitGone(app.pid, 25000);
    step(`app process gone: ${String(gone)}`);
    const released = await waitPort(plan.port, false, 30000);
    step(`port ${String(plan.port)} released: ${String(released)}`);
    await sleep(1200);
    const pid = startReplacement(app.exe, app.args, app.dir, app.env, { windowsHide: false });
    step(`started the app again (pid ${String(pid)})`);
  } else if (mode === 'host' && plan.host !== null) {
    const released = await waitPort(plan.port, false, 30000);
    step(`port ${String(plan.port)} released: ${String(released)}`);
    const pid = startReplacement(plan.host.exe, plan.host.args, plan.host.cwd, plan.host.env, { windowsHide: true });
    step(`started the Host again (pid ${String(pid)})`);
  } else {
    step('no usable restart plan');
    writeResult({ ...report, ok: false });
    return;
  }

  if (typeof plan.port !== 'number') {
    writeResult({ ...report, ok: true, note: 'the serving port is unknown, so the replacement was not verified' });
    return;
  }

  // Success is not one answer: a boot that fails still binds the port briefly.
  // It has to answer continuously for SETTLE_MS.
  const settleMs = 6000;
  const deadline = Date.now() + 120000;
  let steadySince = null;
  let ok = false;
  while (Date.now() < deadline) {
    if (await portOpen(plan.port)) {
      if (steadySince === null) steadySince = Date.now();
      else if (Date.now() - steadySince >= settleMs) {
        ok = true;
        break;
      }
    } else {
      steadySince = null;
    }
    await sleep(500);
  }
  step(`replacement answering on port ${String(plan.port)}: ${String(ok)}`);
  writeResult({ ...report, ok });
}

async function main() {
  log(`helper up pid=${String(process.pid)} ppid=${String(process.ppid)} mode=${String(plan.mode)} dryRun=${String(plan.dryRun)} guardian=${String(guardian)}`);

  if (plan.dryRun) {
    // A dry run measures one side of the handoff only; no lock, no kills.
    await dryRun();
    process.exit(0);
  }

  if (plan.mode === 'app' && !guardian) {
    if (createGuardian()) {
      if (await waitFile(plan.lockPath, 5000)) {
        log('the guardian owns the restart; this copy exits');
        process.exit(0);
      }
      log('the guardian did not claim the restart in time; this copy continues');
    }
  }
  if (!takeLock()) {
    log('another helper owns the restart; exiting');
    process.exit(0);
  }
  await restart();
  process.exit(0);
}

main().catch((error) => {
  log(`helper failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});

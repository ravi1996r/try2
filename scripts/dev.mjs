/**
 * `npm run dev` -- supervises web + gateway + AI service + fake providers.
 *
 * WHY a supervisor rather than four background shells: with four separate processes, a failure in
 * one leaves three orphans holding ports that the next `npm run dev` then refuses to start on. The
 * refusal is correct behaviour, but it would look like a bug. One parent that owns all four means
 * one Ctrl+C, or one crash, tears down everything.
 *
 * WHY ports are checked BEFORE spawning: AGENTS.md requires a clear failure rather than a hang. The
 * most confusing version of this bug is a Vite "Port 5173 is in use, trying 5174 instead", which
 * silently moves the site to a port the rest of the project does not know about.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPorts, formatBusyPortReport, REQUIRED_PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Resolves the repo Python interpreter, preferring the venv AGENTS.md documents. */
function pythonBin() {
  const venv = process.platform === 'win32'
    ? join(ROOT, '.venv', 'Scripts', 'python.exe')
    : join(ROOT, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3');
}

/**
 * Resolves how to spawn an npm workspace command as a [binary, argv[]] pair.
 *
 * WHY this exists: Node throws EINVAL *synchronously* when a child_process spawns a `.cmd` shim with
 * shell:false, which is how npm is reached on Windows. `npm run dev` failed with a bare "spawn
 * EINVAL" and named no service. When npm invoked this script it exported `npm_execpath`, the real JS
 * entry point; running that with the current node binary works identically on every platform.
 */
function npmWorkspace(args) {
  const entry = process.env.npm_execpath;
  if (entry && existsSync(entry)) return [process.execPath, [entry, ...args]];
  return [process.platform === 'win32' ? 'npm.cmd' : 'npm', args];
}

/**
 * The processes to supervise.
 *
 * WHY `FAKE_PROVIDERS=true` here: the fake providers exist so the whole stack runs with zero
 * credentials, which is the project's first requirement. The production startup guard already
 * refuses local backends in production, so this cannot leak into a real deployment.
 */
function services(env) {
  const [webBin, webArgs] = npmWorkspace(['run', 'dev', '--workspace', '@portfolio/web']);
  return [
    {
      name: 'ai',
      cmd: pythonBin(),
      args: ['-m', 'services.ai.app.main'],
      cwd: ROOT,
      // WHY -u: uvicorn's own log_level is "warning", so without unbuffered output the startup
      // banner would sit in a buffer and the process would look hung during the port wait.
      env: { ...env, PYTHONUNBUFFERED: '1' },
    },
    {
      name: 'gateway',
      cmd: process.execPath,
      args: [join(ROOT, 'services/gateway/src/server.js')],
      cwd: ROOT,
      env,
    },
    {
      name: 'fake-providers',
      cmd: process.execPath,
      args: [join(ROOT, 'ops/fake-providers/server.js')],
      cwd: join(ROOT, 'ops/fake-providers'),
      env: { ...env, FAKE_PROVIDERS: 'true' },
    },
    { name: 'web', cmd: webBin, args: webArgs, cwd: ROOT, env },
  ];
}

/** Prefixes every line so interleaved output stays attributable to a service. */
function pipeTagged(child, name) {
  const tag = `[${name}]`;
  const write = (stream, chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.trim() === '') continue;
      stream.write(`${tag} ${line}\n`);
    }
  };
  child.stdout.on('data', (c) => write(process.stdout, c));
  child.stderr.on('data', (c) => write(process.stderr, c));
}

async function main() {
  const results = await checkPorts(REQUIRED_PORTS);
  const busy = results.filter((r) => !r.free);
  if (busy.length > 0) {
    console.error(formatBusyPortReport(busy));
    process.exit(1);
  }

  const env = { ...process.env };
  const children = [];
  let shuttingDown = false;

  // WHY this promise exists: `dev` is a long-running task, and the runner decides PASSED/FAILED from
  // this process's EXIT CODE. An earlier version returned from main() immediately after spawning,
  // so the runner printed "PASSED: dev" while the web service was crashing -- a gate reporting
  // success on a broken stack, which is the exact failure mode AGENTS.md forbids. main() must stay
  // pending until shutdown, and the exit code must reflect WHY we stopped.
  let settleExit;
  const finished = new Promise((resolve) => { settleExit = resolve; });

  /** Kills every child and resolves the task with the exit code the runner should see. */
  const shutdown = (code, reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[dev] ${reason}`);
    for (const c of children) {
      // WHY SIGTERM, not SIGKILL: uvicorn and Vite need a moment to close sockets and flush, and
      // killing them outright is what leaves ports bound after a shutdown.
      try {
        if (c.spawned.pid) c.spawned.kill('SIGTERM');
      } catch { /* already gone */ }
    }
    // WHY a timeout rather than waiting forever: a wedged child must not block shutdown forever.
    // It also guarantees the process actually exits even if a child ignores SIGTERM.
    setTimeout(() => settleExit(code), 1500).unref();
  };

  process.on('SIGINT', () => shutdown(0, 'Ctrl+C: stopping every service.'));
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM: stopping every service.'));

  for (const svc of services(env)) {
    // WHY shell:false everywhere: a shell would interleave and swallow the exit codes this
    // supervisor depends on to decide whether to shut the stack down.
    const child = spawn(svc.cmd, svc.args, {
      cwd: svc.cwd,
      env: svc.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', (err) => {
      console.error(`[dev] ${svc.name} failed to launch: ${err.message}`);
      shutdown(1, `Launch failure in "${svc.name}".`);
    });
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      shutdown(1, `${svc.name} exited unexpectedly (code=${code}, signal=${signal}). `
        + 'Stopping the rest so no ports are left bound.');
    });
    pipeTagged(child, svc.name);
    children.push({ ...svc, spawned: child });
  }

  console.log('[dev] all four services launched. Ctrl+C to stop them all.');
  return finished;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[dev] FAILED: ${err.message}`);
    process.exit(1);
  });
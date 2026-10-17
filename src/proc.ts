import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  /**
   * The **complete** environment for the child. The caller filters it (see src/env.ts);
   * omitted = inherit process.env unchanged (only tests and smoke paths should do that).
   */
  env?: Record<string, string | undefined>;
  maxWallMs: number;
  onLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
  /** 每读一行检查一次;返回 true 即中断(用于 token 预算超限或协议已收工)。 */
  shouldAbort?: () => boolean;
  /** 为 true 时把 stdin 接成管道,并通过 onStdin 交出写入器(会话型协议需要)。 */
  needsStdin?: boolean;
  onStdin?: (write: (line: string) => void) => void;
  /**
   * Written to stdin and then closed. Prompts go here instead of argv: argv is capped by the
   * OS (≈32K chars on Windows, 128 KiB per argument on Linux, 1 MiB total on macOS) and a
   * prompt starting with "-" (a pasted diff, a bullet list) is parsed as an option.
   */
  stdinData?: string;
  /** Aborting it terminates the whole process tree; the outcome is marked cancelled. */
  signal?: AbortSignal;
  /** POSIX: delay between SIGTERM and SIGKILL to the process group. */
  killGraceMs?: number;
}

export interface RunOutcome {
  exitCode: number | null;
  exitSignal?: string | null;
  timedOut: boolean;
  aborted: boolean;
  cancelled: boolean;
  /** The process never started (E2BIG, ENOENT, EACCES, …). Nothing ran. */
  spawnError?: string;
  /**
   * The worker exited but something it started still held stdout open; the bridge killed the
   * worker's process group and stopped reading. Before this existed the task hung until the
   * leftover process exited on its own.
   */
  pipeLeftOpen?: boolean;
  stderrTail: string;
  /** Lines whose onLine callback threw. They are skipped; a parser bug must not kill the bridge. */
  callbackErrors: number;
}

/** A single stdout "line" larger than this is flushed in pieces instead of growing without bound. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** After the worker exits, how long to wait for stdout to close before assuming a leftover holds it. */
const DRAIN_MS = 300;
/** After the final kill, how long to wait before giving up on the pipes. */
const FORCE_CLOSE_MS = 500;

/**
 * 跑一个 harness 子进程,按行回调 stdout。
 *
 * Process tree: on POSIX the worker is started as the leader of its own process group
 * (`detached`), so timeout/abort/cancel signal the whole group — the agent CLI and everything it
 * spawned. On Windows `taskkill /T /F` does the same. Processes that deliberately leave the group
 * (setsid/daemonize) are out of reach; that is documented, not hidden.
 *
 * The promise always resolves (never rejects): spawn failures become `spawnError`.
 */
export function runStreaming(o: RunOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const posix = process.platform !== 'win32';
    const wantsStdin = o.needsStdin === true || o.stdinData !== undefined;

    let stderrTail = '';
    let buffer = '';
    let timedOut = false;
    let aborted = false;
    let cancelled = false;
    let settled = false;
    let callbackErrors = 0;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let exited = false;
    let killing = false;
    let pipeLeftOpen = false;
    const timers: NodeJS.Timeout[] = [];

    let child: ChildProcess;
    try {
      child = spawn(o.command, o.args, {
        cwd: o.cwd,
        env: (o.env ?? process.env) as NodeJS.ProcessEnv,
        stdio: [wantsStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: posix,
      });
    } catch (err) {
      // Node throws synchronously for errors such as E2BIG/ENAMETOOLONG/EINVAL. Inside a promise
      // executor that used to become an unhandled rejection and take the whole bridge down.
      resolve({
        exitCode: null,
        timedOut: false,
        aborted: false,
        cancelled: false,
        spawnError: (err as Error).message,
        stderrTail: '',
        callbackErrors: 0,
      });
      return;
    }

    const finish = (): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbortSignal);
      if (buffer.length > 0) deliver(buffer);
      buffer = '';
      resolve({
        exitCode,
        exitSignal,
        timedOut,
        aborted,
        cancelled,
        pipeLeftOpen: pipeLeftOpen || undefined,
        stderrTail,
        callbackErrors,
      });
    };

    const signalTree = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (!posix) {
        try {
          const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          k.on('error', () => {});
        } catch {
          /* taskkill missing: fall through to the direct kill */
        }
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        return;
      }
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const forceClose = (): void => {
      pipeLeftOpen = pipeLeftOpen || !child.stdout?.closed;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      finish();
    };

    /** Terminate everything the task started, escalating to SIGKILL, and never wait forever. */
    const terminate = (): void => {
      if (killing || settled) return;
      killing = true;
      signalTree('SIGTERM');
      timers.push(
        setTimeout(() => {
          signalTree('SIGKILL');
          timers.push(setTimeout(forceClose, FORCE_CLOSE_MS));
        }, posix ? (o.killGraceMs ?? 2_000) : 0),
      );
    };

    function onAbortSignal(): void {
      cancelled = true;
      terminate();
    }

    const deliver = (line: string): void => {
      try {
        o.onLine(line);
      } catch {
        callbackErrors++;
      }
    };

    if (o.signal?.aborted) {
      cancelled = true;
      terminate();
    } else {
      o.signal?.addEventListener('abort', onAbortSignal, { once: true });
    }

    timers.push(
      setTimeout(() => {
        timedOut = true;
        terminate();
      }, o.maxWallMs),
    );

    if (wantsStdin && child.stdin) {
      const stdin = child.stdin;
      stdin.setDefaultEncoding('utf8');
      // EPIPE when the worker exits before reading everything; without a listener it would be an
      // uncaught 'error' event.
      stdin.on('error', (err) => {
        stderrTail = (stderrTail + `\nstdin error: ${err.message}`).slice(-4000);
      });
      if (o.stdinData !== undefined) {
        stdin.end(o.stdinData);
      } else {
        o.onStdin?.((line: string) => {
          if (stdin.destroyed || stdin.writableEnded) return;
          stdin.write(line + '\n');
        });
      }
    }

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) deliver(line);
      }
      while (buffer.length > MAX_LINE_CHARS) {
        deliver(buffer.slice(0, MAX_LINE_CHARS));
        buffer = buffer.slice(MAX_LINE_CHARS);
      }
      if (!aborted && o.shouldAbort?.() === true) {
        aborted = true;
        terminate();
      }
    });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      try {
        o.onStderr?.(chunk);
      } catch {
        /* observer bug, ignore */
      }
    });

    child.on('error', (err) => {
      stderrTail = (stderrTail + `\nspawn error: ${err.message}`).slice(-4000);
      if (child.pid === undefined) {
        // ENOENT/EACCES are reported asynchronously and mean nothing started.
        finish();
      }
    });

    child.on('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      // 'close' can come first; a timer armed after settling would keep this closure (and the
      // caller's parser with everything it accumulated) alive for no reason.
      if (settled) return;
      // Normal case: 'close' follows within milliseconds. If a leftover process still holds
      // stdout, stop waiting for it — and stop it: it belongs to this task.
      timers.push(
        setTimeout(() => {
          if (settled) return;
          // 'close' did not follow 'exit': something the worker started still holds stdout.
          pipeLeftOpen = true;
          if (posix) signalTree('SIGKILL');
          else signalTree('SIGTERM');
          timers.push(setTimeout(forceClose, FORCE_CLOSE_MS));
        }, DRAIN_MS),
      );
    });

    child.on('close', (code, sig) => {
      if (!exited) {
        exitCode = code;
        exitSignal = sig;
      }
      finish();
    });
  });
}

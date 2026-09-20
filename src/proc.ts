import { spawn } from 'node:child_process';

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  maxWallMs: number;
  onLine: (line: string) => void;
  onStderr?: (chunk: string) => void;
  /** 每读一行检查一次;返回 true 即中断(用于 token 预算超限或协议已收工)。 */
  shouldAbort?: () => boolean;
  /** 为 true 时把 stdin 接成管道,并通过 onStdin 交出写入器(会话型协议需要)。 */
  needsStdin?: boolean;
  onStdin?: (write: (line: string) => void) => void;
}

export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
}

/**
 * 跑一个 harness 子进程,按行回调 stdout。
 *
 * Windows 上必须连子进程树一起杀:这些 CLI 都会再拉一层 node/语言服务器,
 * 只 kill 顶层进程会留下孤儿继续写盘。
 */
export async function runStreaming(o: RunOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: { ...process.env, ...(o.env ?? {}) },
      stdio: [o.needsStdin === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (o.needsStdin === true && child.stdin) {
      const stdin = child.stdin;
      stdin.setDefaultEncoding('utf8');
      o.onStdin?.((line: string) => {
        if (stdin.destroyed || stdin.writableEnded) return;
        stdin.write(line + '\n');
      });
    }

    let stderrTail = '';
    let buffer = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killTree = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, o.maxWallMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer.length > 0) o.onLine(buffer);
      resolve({ exitCode, timedOut, aborted, stderrTail });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) o.onLine(line);
      }
      if (o.shouldAbort?.() === true && !aborted) {
        aborted = true;
        killTree();
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      o.onStderr?.(chunk);
    });

    child.on('error', (err) => {
      stderrTail = (stderrTail + `\nspawn error: ${err.message}`).slice(-4000);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
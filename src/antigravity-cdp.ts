import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Antigravity 的 CDP 入口(层级④,未公开接口)。
 *
 * 端口由 Electron 在启动时分配,只能从宿主的登记文件读 —— 硬编码的端口下次启动就失效
 * (AGENTS.md §3 同名约束)。这里不保存任何 token:CDP 走回环,不需要凭证。
 */

export interface CdpPage {
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export function devToolsPortFile(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Antigravity', 'DevToolsActivePort');
}

/** DevToolsActivePort 的第一行是端口,第二行是 browser 的 ws 路径。 */
export function parseDevToolsPort(text: string): number | null {
  const first = (text.split(/\r?\n/)[0] ?? '').trim();
  const port = Number(first);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function readCdpPort(): number | null {
  try {
    return parseDevToolsPort(readFileSync(devToolsPortFile(), 'utf8'));
  } catch {
    return null;
  }
}

export async function fetchVersion(port: number): Promise<{ Browser?: string } | null> {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { Browser?: string };
  } catch {
    return null;
  }
}

export async function findPage(port: number): Promise<CdpPage | null> {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as CdpPage[];
    return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
  } catch {
    return null;
  }
}

export class CdpClient {
  #ws: WebSocket;
  #seq = 0;
  #pending = new Map<number, (message: { result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }) => void>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const resolve = this.#pending.get(message.id);
      if (resolve) {
        this.#pending.delete(message.id);
        resolve(message);
      }
    });
  }

  static async connect(url: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return new CdpClient(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }> {
    const id = ++this.#seq;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const out = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (out.result?.exceptionDetails) {
      throw new Error(`页面内执行失败:${JSON.stringify(out.result.exceptionDetails).slice(0, 300)}`);
    }
    return out.result?.result?.value as T;
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      /* 已经断了就无所谓 */
    }
  }
}

import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

/**
 * 取 `%LOCALAPPDATA%`,**没有就按已知位置推**。
 *
 * 为什么不能直接读那个环境变量:GUI 宿主(实测 Qoder)拉起的子进程**不保证继承它**。
 */
export function localAppData(): string | null {
  const fromEnv = process.env.LOCALAPPDATA;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const guess = join(homedir(), 'AppData', 'Local');
    return existsSync(guess) ? guess : null;
  } catch {
    return null;
  }
}

/**
 * Directories searched after PATH on POSIX. GUI hosts (Claude Desktop, IDEs) often start MCP
 * servers with a minimal PATH, and the common user-level installers put CLIs here.
 */
function fallbackDirs(): string[] {
  if (process.platform === 'win32') return [];
  const h = homedir();
  return [
    join(h, '.local', 'bin'),
    join(h, '.npm-global', 'bin'),
    join(h, '.bun', 'bin'),
    join(h, '.volta', 'bin'),
    join(h, '.cargo', 'bin'),
    join(h, '.opencode', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
}

function isExecutableFile(p: string): boolean {
  try {
    if (!realpathSync(p)) return false;
    accessSync(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 从 PATH(再加常见安装目录)找一个可执行文件;找不到返回 null。 */
export async function which(name: string): Promise<string | null> {
  // Windows 上 npm 装的 CLI 会同时有 `claude`(无扩展名,是 bash 脚本)、`claude.cmd`、`claude.ps1`。
  // 无扩展名的那个 spawn 不起来,所以按可执行扩展名优先挑。
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...fallbackDirs()];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (dir.length === 0 || seen.has(dir)) continue;
    seen.add(dir);
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      const st = await stat(candidate).catch(() => null);
      if (st?.isFile() && isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export interface ResolvedCli {
  command: string;
  /** 需要前置到用户参数之前的固定参数(如 node 的入口 js)。 */
  prefixArgs: string[];
  detail: string;
}

function bridgeHome(): string {
  return process.env.LLMS_BRIDGE_HOME ?? join(homedir(), '.llms-bridge');
}

/**
 * Explicit per-harness CLI path: env `LLMS_BRIDGE_<ID>_CLI` (e.g. LLMS_BRIDGE_CLAUDE_CLI) or
 * `<LLMS_BRIDGE_HOME>/config.json` → `{ "cli": { "<id>": "/path" } }`.
 * Returns null when not configured; throws when the config file exists but cannot be parsed
 * (a broken override must not silently fall back to some other binary).
 */
export function cliOverride(id: string, env: Record<string, string | undefined> = process.env): { path: string; whence: string } | null {
  const key = `LLMS_BRIDGE_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLI`;
  const fromEnv = env[key]?.trim();
  if (fromEnv) return { path: fromEnv, whence: `env ${key}` };
  const cfgPath = join(env.LLMS_BRIDGE_HOME ?? bridgeHome(), 'config.json');
  if (!existsSync(cfgPath)) return null;
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    throw new Error(`${cfgPath} 解析失败: ${(err as Error).message}`);
  }
  const v = (cfg as { cli?: Record<string, unknown> } | null)?.cli?.[id];
  return typeof v === 'string' && v.trim() ? { path: v.trim(), whence: `${cfgPath} 的 cli.${id}` } : null;
}

/** How to start a CLI that lives at `p`: JS entry points run under the current node, others directly. */
export function invocationFor(p: string, detail: string): ResolvedCli {
  if (/\.(m|c)?js$/i.test(p)) return { command: process.execPath, prefixArgs: [p], detail: `${detail} → node ${p}` };
  return { command: p, prefixArgs: [], detail };
}

/**
 * 定位一个 CLI。
 *
 * Windows: 按 package.json 的 `bin` 字段解析真实入口 —— Node 不允许直接 spawn `.cmd`,而且绕 shim
 * 也避免了把用户 prompt 交给 shell 解释(注入面)。
 *
 * POSIX (2026-10-16): the PATH entry itself is spawned (a symlink into `<prefix>/lib/node_modules`,
 * a native binary, or a script with a shebang all work). The first version looked for
 * `<bin dir>/node_modules`, which is the Windows npm layout only, so on macOS/Linux every npm CLI
 * and every native installer (e.g. Claude Code's ~/.local/bin/claude) was reported as missing.
 */
export async function resolveGlobalCli(binName: string, pkgName: string, id: string = binName): Promise<ResolvedCli | null> {
  const override = cliOverride(id);
  if (override) {
    if (!existsSync(override.path)) throw new Error(`${override.whence} 指向的文件不存在: ${override.path}`);
    return invocationFor(override.path, `${override.whence} @ ${override.path}`);
  }

  const shim = await which(binName);
  if (!shim) return null;

  if (process.platform !== 'win32') {
    let real = shim;
    try {
      real = realpathSync(shim);
    } catch {
      /* keep the PATH spelling */
    }
    return { command: shim, prefixArgs: [], detail: real === shim ? shim : `${shim} → ${real}` };
  }

  const globalRoot = join(dirname(shim), 'node_modules');
  const pkgDir = join(globalRoot, ...pkgName.split('/'));
  const raw = await readFile(join(pkgDir, 'package.json'), 'utf8').catch(() => null);
  if (raw === null) {
    // Native Windows installers (an .exe on PATH) have no package.json next to them.
    return shim.toLowerCase().endsWith('.exe') ? { command: shim, prefixArgs: [], detail: shim } : null;
  }

  let binField: unknown;
  try {
    binField = (JSON.parse(raw) as { bin?: unknown }).bin;
  } catch {
    return null;
  }
  const rel =
    typeof binField === 'string' ? binField : ((binField as Record<string, string> | undefined)?.[binName] ?? null);
  if (typeof rel !== 'string' || rel.length === 0) return null;

  const entry = resolve(pkgDir, rel);
  const st = await stat(entry).catch(() => null);
  if (!st?.isFile()) return null;

  if (entry.toLowerCase().endsWith('.exe')) {
    return { command: entry, prefixArgs: [], detail: `${pkgName} → ${entry}` };
  }
  return { command: process.execPath, prefixArgs: [entry], detail: `${pkgName} → node ${entry}` };
}

/**
 * 定位 Codex CLI。
 * Windows: %LOCALAPPDATA%\OpenAI\Codex\bin\<内容哈希>\codex.exe(按目录的最新修改时间挑)。
 * Elsewhere / fallback: explicit override, then PATH and the common install directories.
 */
export async function resolveCodex(): Promise<string | null> {
  const override = cliOverride('codex');
  if (override) {
    if (!existsSync(override.path)) throw new Error(`${override.whence} 指向的文件不存在: ${override.path}`);
    return override.path;
  }
  const lAD = process.platform === 'win32' ? localAppData() : null;
  const root = lAD ? join(lAD, 'OpenAI', 'Codex', 'bin') : null;
  if (root) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const found: { path: string; mtimeMs: number }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, 'codex.exe');
      const st = await stat(candidate).catch(() => null);
      if (st?.isFile()) found.push({ path: candidate, mtimeMs: st.mtimeMs });
    }
    if (found.length > 0) {
      found.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return found[0]!.path;
    }
  }
  return which('codex');
}

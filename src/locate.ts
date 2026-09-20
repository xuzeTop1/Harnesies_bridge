import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * 取 `%LOCALAPPDATA%`,**没有就按已知位置推**。
 *
 * 为什么不能直接读那个环境变量:GUI 宿主(实测 Qoder)拉起的子进程**不保证继承它** ——
 * 而同一个最小环境里 `USERPROFILE` 与 `os.homedir()` 仍然正确。少了它时
 * `resolveCodex()` 会整段跳过、codebuddy 的 `bundledCliPath()` 会返回 null 并退回
 * PATH 上那份无扩展名的 npm shim(→ `spawn EINVAL`),于是**两个 harness 同时"变不可用"**,
 * 而 `harness_list` 是主脑唯一的依据 —— 这张表报错比没有表更糟。
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

/** 从 PATH 找一个可执行文件;找不到返回 null。 */
export async function which(name: string): Promise<string | null> {
  // Windows 上 npm 装的 CLI 会同时有 `claude`(无扩展名,是 bash 脚本)、`claude.cmd`、`claude.ps1`。
  // 无扩展名的那个 spawn 不起来,所以按可执行扩展名优先挑。
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      const st = await stat(candidate).catch(() => null);
      if (st?.isFile()) return candidate;
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

/**
 * 定位 npm 全局安装的 CLI,按 package.json 的 `bin` 字段解析真实入口。
 *
 * 不走 `claude.cmd` 这类 shim:Node 出于安全不允许直接 spawn `.cmd`,而且绕 shim
 * 也避免了把用户 prompt 交给 shell 解释(注入面)。解析出的入口若是 .exe 就直接跑,
 * 否则用当前 node 跑那个 js。
 */
export async function resolveGlobalCli(binName: string, pkgName: string): Promise<ResolvedCli | null> {
  const shim = await which(binName);
  if (!shim) return null;
  const globalRoot = join(dirname(shim), 'node_modules');
  const pkgDir = join(globalRoot, ...pkgName.split('/'));
  const raw = await readFile(join(pkgDir, 'package.json'), 'utf8').catch(() => null);
  if (raw === null) return null;

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
 * 它装在 %LOCALAPPDATA%\OpenAI\Codex\bin\<内容哈希>\codex.exe —— 哈希随版本更新而变,
 * 所以按目录的最新修改时间挑,不硬编码哈希(见 AGENTS.md:禁止硬编码会漂移的标识)。
 */
export async function resolveCodex(): Promise<string | null> {
  const lAD = localAppData();
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
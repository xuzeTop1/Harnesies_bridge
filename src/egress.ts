/**
 * 派发前的"出口自报":这一次派发,数据会从这台机器发往**哪个主机**。
 *
 * 为什么需要(2026-09-22):同一个 harness id 背后可能是两个完全不同的数据去向 ——
 * 例如用户可以把 Claude Code 的端点一键切到国内中转,也可以切回原生 Anthropic。
 *
 * 这个模块**只报主机名与代理线索**;凭证字段一律不读、不打印,连长度都不印。
 *
 * 2026-10-16, Claude Code precedence measured with the real CLI (2.1.302) against local mock
 * servers: settings-file `env` beats the process environment, project `.claude/settings.json`
 * beats the user file, and `.claude/settings.local.json` beats both. The first version assumed
 * "process env first" and ignored project files, so a project file pointing at a relay produced
 * a report (and a local-only policy decision) about a host the request never went to.
 * Managed settings are documented as highest priority; that layer is read but was not measured.
 * Bedrock/Vertex switches are honoured. When the project directory is ambiguous (cwd below the
 * repository root) every candidate host is reported in `alternateHosts`, and policy checks require
 * all of them to be local.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EgressReport } from './types.ts';
import { git, realpathOr } from './worktree.ts';

const execFileAsync = promisify(execFile);

/** Anthropic 自己的域名 —— 只有这些算"原生"。判定用后缀匹配,不硬编码完整 URL。 */
const ANTHROPIC_HOSTS = ['anthropic.com', 'claude.ai', 'claudeusercontent.com'];
/** 端点没配置时 Claude Code 的默认去向。 */
const DEFAULT_NATIVE_HOST = 'api.anthropic.com';

export interface EgressProbeOptions {
  /** 测试注入:指向一份 fixture 的**用户级** settings.json */
  settingsPath?: string;
  /** Task cwd: project-level `.claude/settings*.json` are looked up from here. */
  cwd?: string;
  /** 测试注入:替代 process.env */
  env?: Record<string, string | undefined>;
  /** 测试注入:跳过注册表探测(单套件不该依赖 Windows 状态) */
  readProxyClues?: boolean;
  /** 测试注入:managed-settings.json 的位置(默认按平台)。 */
  managedPath?: string;
}

/** 从 URL 里只取主机,取不到就把原串截断——绝不返回带路径/查询串的东西(里面可能藏 key)。 */
function hostOnly(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw.slice(0, 60);
  }
}

function isNative(host: string): boolean {
  const h = host.toLowerCase();
  return ANTHROPIC_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * 只从进程环境里提代理线索。**导出给用例直接测**。
 */
export function proxyCluesFromEnv(env: Record<string, string | undefined>): string[] {
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => {
    const v = env[k];
    return v ? `${k}=${hostOnly(v)}` : `${k} 未设置`;
  });
}

/** Windows 系统代理线索(只在 Windows 上查注册表)。输出里代理地址去掉可能的 user:pass。 */
async function systemProxyClues(env: Record<string, string | undefined>): Promise<string[]> {
  const clues = proxyCluesFromEnv(env);
  if (process.platform !== 'win32') return clues;
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 5_000 },
    );
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(ProxyEnable|ProxyServer)\s+REG_\w+\s+(.*)$/i);
      if (!m) continue;
      const raw = m[2]!.trim();
      clues.push(`注册表 ${m[1]}=${m[1]!.toLowerCase() === 'proxyenable' ? raw : hostOfProxyServer(raw)}`);
    }
  } catch {
    clues.push('注册表代理设置:未读到');
  }
  return clues;
}

function hostOfProxyServer(raw: string): string {
  const one = raw.split(';')[0]!.trim();
  const noAuth = one.includes('@') ? one.slice(one.lastIndexOf('@') + 1) : one;
  return noAuth || '(空)';
}

/** Only the `env` block of a settings file, and only the non-credential routing keys. */
const ROUTING_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_REGION',
  'CLOUD_ML_REGION',
];

async function routingEnvFrom(path: string): Promise<Record<string, string> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  const env = (parsed as { env?: Record<string, unknown> } | null)?.env;
  if (!env || typeof env !== 'object') return null;
  const out: Record<string, string> = {};
  for (const k of ROUTING_KEYS) {
    const v = env[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function managedSettingsPath(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes)$/i.test(v.trim());

/** Effective host from merged routing variables. */
function hostFromRouting(env: Record<string, string | undefined>): { host: string; why: string } {
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) {
    if (env.ANTHROPIC_BEDROCK_BASE_URL) return { host: hostOnly(env.ANTHROPIC_BEDROCK_BASE_URL), why: 'Bedrock (custom base URL)' };
    return { host: `bedrock-runtime.${env.AWS_REGION ?? 'us-east-1'}.amazonaws.com`, why: 'Bedrock' };
  }
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) {
    if (env.ANTHROPIC_VERTEX_BASE_URL) return { host: hostOnly(env.ANTHROPIC_VERTEX_BASE_URL), why: 'Vertex (custom base URL)' };
    const region = env.CLOUD_ML_REGION ?? 'global';
    return { host: region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`, why: 'Vertex' };
  }
  if (truthy(env.CLAUDE_CODE_USE_FOUNDRY) && env.ANTHROPIC_FOUNDRY_BASE_URL) {
    return { host: hostOnly(env.ANTHROPIC_FOUNDRY_BASE_URL), why: 'Foundry' };
  }
  if (env.ANTHROPIC_BASE_URL) return { host: hostOnly(env.ANTHROPIC_BASE_URL), why: 'ANTHROPIC_BASE_URL' };
  return { host: DEFAULT_NATIVE_HOST, why: 'default' };
}

/**
 * Claude Code 的数据去向。Layers, lowest to highest priority:
 * process env < user settings < project settings < project local settings < managed settings.
 */
export async function claudeEgress(opts: EgressProbeOptions = {}): Promise<EgressReport> {
  const env = opts.env ?? process.env;
  const configDir = env.CLAUDE_CONFIG_DIR ? env.CLAUDE_CONFIG_DIR : join(homedir(), '.claude');
  const userPath = opts.settingsPath ?? join(configDir, 'settings.json');

  // Claude Code's project directory is normally the cwd; when the cwd is below the repository
  // root the root's files are a second candidate. Both are evaluated; disagreement is reported.
  const projectDirs: string[] = [];
  if (opts.cwd) {
    projectDirs.push(realpathOr(opts.cwd));
    const top = await git(opts.cwd, ['rev-parse', '--show-toplevel']);
    if (top.ok) {
      const t = realpathOr(top.stdout.trim());
      if (!projectDirs.includes(t)) projectDirs.push(t);
    }
  }

  const base: Record<string, string | undefined> = {};
  for (const k of ROUTING_KEYS) if (env[k]) base[k] = env[k];
  const user = await routingEnvFrom(userPath);
  const managed = await routingEnvFrom(opts.managedPath ?? managedSettingsPath());

  const evaluate = async (projectDir: string | undefined, withLocal = true) => {
    const layers: Array<[string, Record<string, string> | null]> = [['process env', base as Record<string, string>], [userPath, user]];
    if (projectDir) {
      const shared = join(projectDir, '.claude', 'settings.json');
      const local = join(projectDir, '.claude', 'settings.local.json');
      layers.push([shared, await routingEnvFrom(shared)]);
      if (withLocal) layers.push([local, await routingEnvFrom(local)]);
    }
    layers.push([opts.managedPath ?? managedSettingsPath(), managed]);
    const merged: Record<string, string | undefined> = {};
    for (const [, layer] of layers) if (layer) Object.assign(merged, layer);
    const r = hostFromRouting(merged);
    if (r.why === 'default') return { host: r.host, source: '未配置端点 → Claude Code 默认值' };
    // Name the highest-priority layer that set the variable which decided the host.
    const decisive =
      r.why.startsWith('Bedrock') ? (merged.ANTHROPIC_BEDROCK_BASE_URL ? 'ANTHROPIC_BEDROCK_BASE_URL' : 'CLAUDE_CODE_USE_BEDROCK')
      : r.why.startsWith('Vertex') ? (merged.ANTHROPIC_VERTEX_BASE_URL ? 'ANTHROPIC_VERTEX_BASE_URL' : 'CLAUDE_CODE_USE_VERTEX')
      : r.why === 'Foundry' ? 'ANTHROPIC_FOUNDRY_BASE_URL'
      : 'ANTHROPIC_BASE_URL';
    const from = [...layers].reverse().find(([, layer]) => layer?.[decisive] !== undefined)?.[0] ?? 'process env';
    return { host: r.host, source: `${from} 的 ${decisive}` };
  };

  // Also evaluate each project dir without its settings.local.json: that file is usually untracked,
  // so a worker running in a fresh worktree does not see it. Every resulting host is a candidate.
  const results =
    projectDirs.length > 0
      ? await Promise.all([...projectDirs.map((d) => evaluate(d)), ...projectDirs.map((d) => evaluate(d, false))])
      : [await evaluate(undefined)];
  const primary = results[0]!;
  const alternates = [...new Set(results.slice(1).map((r) => r.host))].filter((h) => h !== primary.host);

  const native = isNative(primary.host);
  const proxyClues = opts.readProxyClues === false ? ['(本次未探测代理)'] : await systemProxyClues(env);
  const notice = native
    ? `原生 Anthropic 端点(${primary.host}):数据将离开本机前往官方服务。"有没有出口"和"该 CLI 是否真的用那个出口"桥都**无法验证**。`
    : `第三方端点(${primary.host}):数据发往该主机,不经过 Anthropic 官方。桥不读、也不打印任何凭证,但请把"这一轮题目正文会到达该主机"当成已知事实。`;

  return {
    endpointHost: primary.host,
    nativeAnthropic: native,
    vendor: 'anthropic',
    source: primary.source,
    proxyClues,
    notice: alternates.length > 0 ? `${notice} 另有候选端点:${alternates.join(', ')}(子目录与仓库根的项目设置不一致)。` : notice,
    ...(alternates.length > 0 ? { alternateHosts: alternates } : {}),
  };
}

/* ---------------- Codex ---------------- */

export interface CodexConfigView {
  /** Effective provider id (default "openai"). */
  provider: string;
  /** base_url of a configured provider table, if any. */
  baseUrl?: string;
  /** env_key names of all configured providers (names only). */
  envKeys: string[];
  /** Set when the file uses something this minimal reader does not model (profiles…). */
  unsupported?: string;
}

/**
 * A deliberately small reader for the parts of `config.toml` that decide where Codex sends data.
 * Anything it does not understand makes the result `unsupported`, and the caller then reports the
 * endpoint as unknown (which a local-only policy treats as remote).
 */
export function readCodexConfigText(text: string): CodexConfigView {
  let table = '';
  const top: Record<string, string> = {};
  const providers: Record<string, Record<string, string>> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (header) {
      table = header[1]!.replace(/"/g, '');
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"\s*$/);
    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    if (table === '') top[key] = value;
    else if (table.startsWith('model_providers.')) {
      const id = table.slice('model_providers.'.length);
      (providers[id] ??= {})[key] = value;
    }
  }
  const envKeys = Object.values(providers)
    .map((p) => p.env_key)
    .filter((k): k is string => typeof k === 'string' && k.length > 0);
  if (top.profile) return { provider: top.model_provider ?? 'openai', envKeys, unsupported: `profile "${top.profile}"` };
  const provider = top.model_provider ?? 'openai';
  return { provider, baseUrl: providers[provider]?.base_url, envKeys };
}

export async function readCodexConfig(env: Record<string, string | undefined> = process.env): Promise<CodexConfigView | null> {
  const home = env.CODEX_HOME ? env.CODEX_HOME : join(homedir(), '.codex');
  try {
    return readCodexConfigText(await readFile(join(home, 'config.toml'), 'utf8'));
  } catch {
    return { provider: 'openai', envKeys: [] };
  }
}

/** Where `codex exec` sends data, from config.toml only (no credential files are read). */
export async function codexEgress(env: Record<string, string | undefined> = process.env): Promise<EgressReport | undefined> {
  const cfg = await readCodexConfig(env);
  if (!cfg || cfg.unsupported) return undefined;
  const proxyClues = proxyCluesFromEnv(env);
  if (cfg.baseUrl) {
    const host = hostOnly(cfg.baseUrl);
    return {
      endpointHost: host,
      nativeAnthropic: false,
      vendor: cfg.provider,
      source: `config.toml model_providers.${cfg.provider}.base_url`,
      proxyClues,
      notice: `Codex provider "${cfg.provider}" → ${host}。桥不读凭证文件。`,
    };
  }
  const builtin: Record<string, string> = { oss: 'localhost:11434', ollama: 'localhost:11434', lmstudio: 'localhost:1234' };
  if (builtin[cfg.provider]) {
    return {
      endpointHost: builtin[cfg.provider]!,
      nativeAnthropic: false,
      vendor: cfg.provider,
      source: `built-in provider "${cfg.provider}"`,
      proxyClues,
      notice: `Codex 内置本地 provider "${cfg.provider}"(默认端口)。`,
    };
  }
  if (cfg.provider === 'openai') {
    // ChatGPT login goes to chatgpt.com, API-key login to api.openai.com; which one is used is in
    // the credential file, which the bridge does not read. Report both.
    return {
      endpointHost: 'api.openai.com',
      alternateHosts: ['chatgpt.com'],
      nativeAnthropic: false,
      vendor: 'openai',
      source: 'default provider "openai"',
      proxyClues,
      notice: 'OpenAI 端点(api.openai.com 或 chatgpt.com,取决于登录方式):数据将离开本机。',
    };
  }
  return undefined;
}

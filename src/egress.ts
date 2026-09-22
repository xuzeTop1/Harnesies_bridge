/**
 * 派发前的"出口自报":这一次派发,数据会从这台机器发往**哪个主机**。
 *
 * 为什么需要(2026-09-22):同一个 harness id 背后可能是两个完全不同的数据去向 ——
 * 例如用户可以把 Claude Code 的端点一键切到国内中转,也可以切回原生 Anthropic。
 * 前者直连即可、账号是中转方的;后者要走可用出口、且账号风险面完全不同
 * (Anthropic 有"不受支持地区"的政策)。桥以前只报"可用 + 版本",于是派发一次
 * 就等于在用户不知情时换了一次数据去向。
 *
 * 这个模块**只报主机名与代理线索**:
 *  - 端点按字段白名单读(env 的 ANTHROPIC_BASE_URL,或 settings.json 的 env.ANTHROPIC_BASE_URL);
 *  - 凭证字段(ANTHROPIC_AUTH_TOKEN / API_KEY)一律不读、不打印,连长度都不印。
 * 铁律 1 在这里的边界就是"我知道它去哪,但我不知道也不需要知道它是用什么身份去的"。
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EgressReport } from './types.ts';

const execFileAsync = promisify(execFile);

/** Anthropic 自己的域名 —— 只有这些算"原生"。判定用后缀匹配,不硬编码完整 URL。 */
const ANTHROPIC_HOSTS = ['anthropic.com', 'claude.ai', 'claudeusercontent.com'];
/** 端点没配置时 Claude Code 的默认去向。 */
const DEFAULT_NATIVE_HOST = 'api.anthropic.com';

export interface EgressProbeOptions {
  /** 测试注入:指向一份 fixture settings.json */
  settingsPath?: string;
  /** 测试注入:替代 process.env */
  env?: Record<string, string | undefined>;
  /** 测试注入:跳过注册表探测(单套件不该依赖 Windows 状态) */
  readProxyClues?: boolean;
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
 * 只从进程环境里提代理线索。**导出给用例直接测** —— 走 claudeEgress 的话要么碰注册表,
 * 要么被 readProxyClues:false 整个跳过,两种都测不到这段剥账号密码的逻辑。
 */
export function proxyCluesFromEnv(env: Record<string, string | undefined>): string[] {
  return ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => {
    const v = env[k];
    return v ? `${k}=${hostOnly(v)}` : `${k} 未设置`;
  });
}

/**
 * Windows 系统代理线索。
 *
 * 注意这不是"请求一定走了代理"的结论:Chromium/Node 系工具**不一定**读 WinINET 设置,
 * 所以这里只报"本机有这些线索",把判断留给用户。输出里代理地址去掉可能的 user:pass。
 */
async function systemProxyClues(env: Record<string, string | undefined>): Promise<string[]> {
  const clues = proxyCluesFromEnv(env);
  try {
    const { stdout } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { windowsHide: true, timeout: 5_000 },
    );
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(ProxyEnable|ProxyServer)\s+REG_\w+\s+(.*)$/i);
      if (!m) continue; // 同一份输出里还有别的值,不扫进来
      const raw = m[2].trim();
      clues.push(`注册表 ${m[1]}=${m[1].toLowerCase() === 'proxyenable' ? raw : hostOfProxyServer(raw)}`);
    }
  } catch {
    clues.push('注册表代理设置:未读到');
  }
  return clues;
}

/** ProxyServer 形如 `http://127.0.0.1:7897` 或 `host:port`;若有人塞了 user:pass@ 就剥掉。 */
function hostOfProxyServer(raw: string): string {
  const one = raw.split(';')[0].trim();
  const noAuth = one.includes('@') ? one.slice(one.lastIndexOf('@') + 1) : one;
  return noAuth || '(空)';
}

/**
 * Claude Code 的数据去向。
 *
 * 优先级照 Claude Code 自己的:进程 env > settings.json 的 env 段 > 内置默认。
 */
export async function claudeEgress(opts: EgressProbeOptions = {}): Promise<EgressReport> {
  const env = opts.env ?? process.env;
  const settingsPath = opts.settingsPath ?? join(homedir(), '.claude', 'settings.json');

  let host: string;
  let source: string;
  if (env.ANTHROPIC_BASE_URL) {
    host = hostOnly(env.ANTHROPIC_BASE_URL);
    source = '进程 env ANTHROPIC_BASE_URL';
  } else {
    let fromSettings: string | undefined;
    try {
      const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
      const v = parsed?.env?.ANTHROPIC_BASE_URL;
      if (typeof v === 'string' && v) fromSettings = v;
    } catch {
      // 文件不存在/不是 JSON:Claude Code 自己会按默认端点跑,所以不算错,但要说清来源。
    }
    if (fromSettings) {
      host = hostOnly(fromSettings);
      source = `${settingsPath} 的 env.ANTHROPIC_BASE_URL`;
    } else {
      host = DEFAULT_NATIVE_HOST;
      source = '未配置端点 → Claude Code 默认值';
    }
  }

  const native = isNative(host);
  const proxyClues =
    opts.readProxyClues === false ? ['(本次未探测代理)'] : await systemProxyClues(env);

  const notice = native
    ? `原生 Anthropic 端点(${host}):数据将离开本机前往官方服务。国内网络需要可用出口才连得通,` +
      `而"有没有出口"和"该 CLI 是否真的用那个出口"桥都**无法验证**;另注意官方对不受支持地区的访问有政策风险,这个决定由你承担。`
    : `第三方端点(${host}):数据发往该主机,不经过 Anthropic 官方。桥不读、也不打印任何凭证,` +
      `但请把"这一轮题目正文会到达该主机"当成已知事实。`;

  return { endpointHost: host, nativeAnthropic: native, source, proxyClues, notice };
}

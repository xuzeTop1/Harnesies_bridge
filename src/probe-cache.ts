import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AcpInitResult } from './adapters/acp.ts';

/**
 * ACP 握手结果的**跨进程**共享缓存(带互斥)。
 *
 * 为什么必须有它(2026-10-30 实测):宿主每开一个会话就新建一个 MCP server 实例 —— ChatGPT
 * 桌面版在 25 秒内起了 16 个 `node mcp-server.ts`。每个实例启动都跑一遍全量预热,而层级① 的
 * 探测是**真起 CLI 进程走完 initialize + session/new**(不通的那次还要 8s + 25s 各探一次),
 * 每家 100–400 MB。进程内的 `#detectPromise` 互相看不见对方,于是同一家被并发握手 N 遍,
 * 整机瞬时 4–5 GB。
 *
 * 缓存的粒度是"**这一家 CLI 的握手结果**",不是整份 harness 报告:审批档位是静态的,
 * 而出口(egress)会被人用 cc-switch 在两次派发之间整体换掉,那一层仍由调度器现算。
 *
 * 三个刻意的设计:
 * 1. **未判定(probe=null)只缓存很短时间**。detect() 的注释解释了为什么"一次超时"不能当
 *    "不可用"用;把"未判定"钉 15 分钟会让重跑 harness_list 失去意义,那比重复探测更糟。
 * 2. **拿不到锁的进程等对方的结果,而不是各探各的** —— 这才是风暴真正的原因。
 *    但等不到就得自己探:宁可重复一次握手,也不能让调用方挂在别人的锁上。
 * 3. **锁主死了要能抢**:超过 CLAIM_STALE_MS 没动静的锁视为遗弃(unlink 后重试一次),
 *    否则一个被强杀的进程会让这个键在后续所有实例里都走"等超时再自探"的慢路径。
 */

/** 正结果的新鲜期:一次 MCP 会话的生命周期内不必反复握手。 */
const TTL_OK = () => Number(process.env.LLMS_BRIDGE_PROBE_TTL_MS ?? 900_000);
/** 未判定(两次握手都没响应)的新鲜期:短到"再问一次"仍然有意义,长到能挡住房主的并发爆发。 */
const TTL_MISS = () => Number(process.env.LLMS_BRIDGE_PROBE_MISS_TTL_MS ?? 60_000);
/** 别人正在探这一家时,我最等多这么久;超了就自己探(调用方在等,不能挂在别人的锁上)。 */
const WAIT_MS = () => Number(process.env.LLMS_BRIDGE_PROBE_WAIT_MS ?? 45_000);
/** 锁文件的年龄超过它就该被抢走。必须大于单次探测最坏耗时(8s + 25s + 起进程)。 */
const CLAIM_STALE_MS = () => Number(process.env.LLMS_BRIDGE_PROBE_CLAIM_STALE_MS ?? 120_000);

const POLL_MS = 400;

export interface ProbeOutcome {
  /** 握手结果;null = 未判定(两次都没响应)或 CLI 起不来。 */
  probe: AcpInitResult | null;
  /** 握手**实际发生**的时刻。取自缓存时它早于现在,调用方必须据此说明"这不是这次探的"。 */
  checkedAt: number;
  fromCache: boolean;
}

/** 落点跟着 LLMS_BRIDGE_HOME 走(与账本同源):测试把它指到临时目录就不碰用户真实家目录。 */
function cacheDir(): string {
  const home = process.env.LLMS_BRIDGE_HOME ?? join(homedir(), '.llms-bridge');
  return join(home, 'acp-probes');
}

const entryPath = (key: string) => join(cacheDir(), `${key}.json`);
const claimPath = (key: string) => join(cacheDir(), `${key}.claim`);

/**
 * 键里带上解析出的入口,这样"用户换了 CLI / 升级了 node"会自然落到另一个键上,
 * 而不是让缓存替我们假装 CLI 路径没变。
 */
export function probeKey(adapterId: string, command: string, args: string[]): string {
  const digest = createHash('sha1')
    .update([process.execPath, command, args.join(' ')].join('\n'))
    .digest('hex')
    .slice(0, 12);
  return `${adapterId}-${digest}`;
}

interface Claim {
  pid: number;
  at: number;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readClaim(key: string): Claim | null {
  const raw = readJson(claimPath(key)) as Claim | null;
  return raw && typeof raw.at === 'number' && typeof raw.pid === 'number' ? raw : null;
}

function claimAbandoned(claim: Claim | null): boolean {
  // null = 文件不存在或读不出名堂。读不出来的那部分交给 tryClaim 兜(它会 unlink 后重试)。
  return claim === null || Date.now() - claim.at > CLAIM_STALE_MS();
}

/** 原子占有:同一时刻只有一个桥进程在探这一家。抢不到就返回 false,由调用方去等结果。 */
function tryClaim(key: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(cacheDir(), { recursive: true });
      writeFileSync(claimPath(key), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return false; // 目录不可写等:没有锁可用,照常探测比卡死强
      if (!claimAbandoned(readClaim(key))) return false;
      try {
        unlinkSync(claimPath(key));
      } catch {
        /* 别人抢先清了,下一轮重试 */
      }
    }
  }
  return false;
}

function releaseClaim(key: string): void {
  try {
    unlinkSync(claimPath(key));
  } catch {
    /* 已被抢走或本就没有 */
  }
}

/** 只认"结构上还能当作一次握手结果"的缓存条目;坏文件按缺失处理,绝不把它读成 available。 */
function isProbeShape(v: unknown): v is AcpInitResult {
  return typeof v === 'object' && v !== null && 'protocolVersion' in v;
}

function readFresh(key: string, minAt: number): ProbeOutcome | null {
  const raw = readJson(entryPath(key)) as { probe?: unknown; at?: number } | null;
  if (!raw || typeof raw.at !== 'number' || raw.at < minAt) return null;
  if (!('probe' in raw)) return null;
  if (raw.probe !== null && !isProbeShape(raw.probe)) return null;
  const probe = (raw.probe ?? null) as AcpInitResult | null;
  return Date.now() - raw.at <= (probe === null ? TTL_MISS() : TTL_OK())
    ? { probe, checkedAt: raw.at, fromCache: true }
    : null;
}

function writeEntry(key: string, probe: AcpInitResult | null, at: number): void {
  const path = entryPath(key);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ probe, at }), 'utf8');
    // 先写临时文件再改名:另一个实例可能正读到半截 JSON,那会被当成"没有缓存"而不是崩掉。
    renameSync(tmp, path);
  } catch {
    /* 缓存写不出去不影响本次探测结论 */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 取这一家的握手结果:先读缓存;没有就尽量由**当前持有锁的那个进程**去探,其余进程等它的结果。
 * force = 忽略缓存重新握手(harness_models 的 force 一路传到这里)。
 */
export async function probeShared(
  key: string,
  run: () => Promise<AcpInitResult | null>,
  force = false,
): Promise<ProbeOutcome> {
  const askedAt = Date.now();
  // force 时仍然接受"别人在这次要求之后刚探出来的结果":那样两个进程共享一次握手,
  // 又不违背"给我重新问一次"的原意。
  const minAt = force ? askedAt : 0;

  const cached = readFresh(key, minAt);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<ProbeOutcome> => {
    let claimed = tryClaim(key);
    if (!claimed) {
      const peer = await waitForPeer(key, minAt);
      if (peer) return peer;
      claimed = tryClaim(key); // 对方僵死/已经收手:把锁接过来自己探
    }
    const at = Date.now();
    try {
      const probe = await run();
      // 先写结果、后放锁:反过来会留一个"锁没了但结果还没落盘"的窗口,
      // 等待方在那一刻只能自己再起一次进程 —— 而重复起进程正是这次要修的东西。
      if (claimed) writeEntry(key, probe, at);
      return { probe, checkedAt: at, fromCache: false };
    } finally {
      if (claimed) releaseClaim(key);
    }
  })();

  const tracked = task.finally(() => inFlight.delete(key));
  inFlight.set(key, tracked);
  return tracked;
}

/** 同一进程内的并发去重(也防止自己占的锁把自己等死)。 */
const inFlight = new Map<string, Promise<ProbeOutcome>>();

async function waitForPeer(key: string, minAt: number): Promise<ProbeOutcome | null> {
  const deadline = Date.now() + WAIT_MS();
  for (;;) {
    const hit = readFresh(key, minAt);
    if (hit) return hit;
    if (claimAbandoned(readClaim(key))) return null; // 锁主死了或已释放:去抢,别干等
    if (Date.now() >= deadline) return null; // 等太久:自己探一次,不能把调用方拖没
    await sleep(POLL_MS);
  }
}

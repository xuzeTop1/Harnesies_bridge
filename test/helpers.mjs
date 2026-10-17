/**
 * Shared fixtures for the 2026-10 regression tests: throwaway git repositories and stub/fake
 * workers. Nothing here starts a real agent CLI or talks to a model.
 *
 * 本文件是 .mjs(纯 JS),不能出现 TS 语法。
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });

/** Canonical temp dir (macOS reaches tmp through /var -> /private/var). */
export async function tempDir(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** A git repo with one commit containing `files` ({ path: content }). */
export async function makeRepo(files = { 'README.md': 'base\n' }, prefix = 'llms-bridge-rg-') {
  const dir = await tempDir(prefix);
  git(dir, ['init', '-q']);
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return dir;
}

/** Write an executable Node script and return its path. */
export async function nodeScript(dir, name, source) {
  const p = join(dir, name);
  await writeFile(p, `#!/usr/bin/env node\n${source}\n`, 'utf8');
  await chmod(p, 0o755);
  return p;
}

/**
 * Minimal adapter whose worker is `plan(spec)` and whose parser turns each stdout line into a
 * message event (JSON lines with a `usage` field carry it through, cumulative).
 */
export function stubAdapter(opts) {
  return {
    id: opts.id ?? 'stub',
    tier: 3,
    displayName: 'stub',
    supportedApprovals: opts.approvals ?? ['read-only', 'workspace-write'],
    usageReporting: opts.usageReporting,
    credentialEnv: opts.credentialEnv,
    egress: opts.egress,
    detect: async () => ({ available: true, version: 'stub' }),
    plan: opts.plan,
    createRun: (spec, taskId) => {
      let seq = 0;
      let last;
      return {
        parseLine(line) {
          if (opts.throwOn && line.includes(opts.throwOn)) throw new Error('boom in parser');
          let obj = null;
          try {
            obj = JSON.parse(line);
          } catch {
            /* plain text */
          }
          const ev = { taskId, seq: seq++, harness: opts.id ?? 'stub', tier: 3, type: 'message', at: Date.now(), text: line };
          if (obj && typeof obj === 'object' && obj.usage) {
            ev.usage = obj.usage;
            last = obj.usage;
          }
          return [ev];
        },
        finalize: (code) => ({ text: opts.text ?? 'done', usage: last, errorText: code === 0 ? undefined : `exit ${code}` }),
      };
    },
  };
}

export const spec = (cwd, taskId, extra = {}) => ({
  taskId,
  harness: 'stub',
  prompt: 'p',
  cwd,
  approval: 'read-only',
  budget: { maxWallMs: 30_000 },
  session: { mode: 'fresh' },
  ...extra,
});

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

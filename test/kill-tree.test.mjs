/**
 * killTree 必须带走整棵进程树。
 *
 * 这条是 2026-10-30 那次进程风暴的泄漏点:acpProbe 收尾用 `child.kill()`,在 Windows 上
 * 只终止 `openclaw acp` 那个 61 MB 的外壳,外壳自己 re-exec 出来的 200–400 MB 主进程
 * 会变成 ParentProcessId 指向僵尸 PID 的孤儿继续常驻。
 * 只在 Windows 上跑:POSIX 分支就是给直系子进程发 SIGKILL,没有这条实测路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { killTree } = await import(pathToFileURL(join(PROJECT, 'src', 'proc.ts')).href);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Windows 上 EPERM 也算"还在"(存在但没权限打开),ESRCH 才是没了
    return err.code === 'EPERM';
  }
};

const skip = process.platform !== 'win32' ? '只在 Windows 上验证进程树孤儿问题' : false;

test('killTree 连同 re-exec 出来的孙进程一起杀掉', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'llms-bridge-killtree-'));
  const grandPidFile = join(dir, 'grand.pid');

  // 孙:写下自己的 PID,然后活着不动 —— 它就是那种"外壳死了还占几百 MB"的残留
  writeFileSync(
    join(dir, 'grand.mjs'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(grandPidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  // 父:探测到的那个 CLI 壳,它会再拉起一层 node
  writeFileSync(
    join(dir, 'parent.mjs'),
    `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [${JSON.stringify(join(dir, 'grand.mjs'))}], { stdio: 'ignore', windowsHide: true });
if (!child.pid) process.exit(1);
setInterval(() => {}, 1000);
`,
  );

  const shell = spawn(process.execPath, [join(dir, 'parent.mjs')], { stdio: 'ignore', windowsHide: true });
  try {
    const deadline = Date.now() + 20_000;
    while (!existsOnce(grandPidFile) && Date.now() < deadline) await new Promise((s) => setTimeout(s, 100));
    assert.ok(existsOnce(grandPidFile), '没能把父子两代起起来,用例前提不成立');
    const grandPid = Number(readFileSync(grandPidFile, 'utf8'));
    assert.ok(alive(grandPid), '刚起好的孙进程应该是活的');
    assert.ok(alive(shell.pid), '刚起好的壳进程应该是活的');

    killTree(shell);

    const killDeadline = Date.now() + 8000;
    while (alive(grandPid) && Date.now() < killDeadline) await new Promise((s) => setTimeout(s, 100));

    assert.equal(alive(shell.pid), false, '外壳该被杀掉');
    assert.equal(alive(grandPid), false, 're-exec 出来的孙进程不能变成孤儿 —— 这就是那次留下 15 个 node 的原因');
  } finally {
    // 万一断言失败,别把测试自己造的进程留在用户机器上
    try {
      killTree(shell);
    } catch {
      /* 已经没了 */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function existsOnce(path) {
  try {
    return readFileSync(path, 'utf8').length > 0;
  } catch {
    return false;
  }
}

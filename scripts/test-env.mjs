// Cross-platform `NAME=value node --test …` (npm scripts run under cmd.exe on Windows).
// Usage: node scripts/test-env.mjs NAME=value [NAME=value…] -- <test files or globs…>
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const assignments = sep < 0 ? args : args.slice(0, sep);
const files = sep < 0 ? [] : args.slice(sep + 1);
const env = { ...process.env };
for (const a of assignments) {
  const i = a.indexOf('=');
  if (i > 0) env[a.slice(0, i)] = a.slice(i + 1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
process.exit(r.status ?? 1);

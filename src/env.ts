/**
 * Worker environment filtering (铁律一: the bridge must not forward vendor credentials).
 *
 * The bridge used to hand its whole environment to every worker (`{...process.env}`). Any key
 * the host process happened to carry — ANTHROPIC_API_KEY, OPENAI_API_KEY, a host session token
 * such as CLAUDE_CODE_MESSAGING_TOKEN — therefore reached every other vendor's CLI, and CLIs
 * that pick provider keys up from the environment would silently use them.
 *
 * Now each adapter declares the credential variables it legitimately uses (its own vendor's);
 * every other credential-looking variable is withheld. Non-secret variables (PATH, HOME,
 * proxies, locale, tool homes…) pass through unchanged. Users can widen the list explicitly
 * with `LLMS_BRIDGE_PASS_ENV=NAME,PREFIX_*`.
 */

/** Words that make a variable name a credential wherever they appear. */
const STRONG = /(PASSWORD|PASSWD|SECRET|PRIVATE_?KEY|CREDENTIAL)/i;
/** Words that make a name a credential only as a whole `_`-delimited part (TOKENIZERS_* stays). */
const WEAK = /(^|_)(API_?KEY|ACCESS_?KEY|TOKEN|AUTH|COOKIE|BEARER|SESSION_?KEY)(_|$)/i;
/** Sockets, not secrets; git over ssh needs them. */
const NEVER_CREDENTIAL = new Set(['SSH_AUTH_SOCK', 'GPG_AGENT_INFO']);

export function isCredentialName(name: string): boolean {
  if (NEVER_CREDENTIAL.has(name.toUpperCase())) return false;
  return STRONG.test(name) || WEAK.test(name);
}

/** `NAME` or `PREFIX_*`; case-insensitive because Windows environment names are. */
export function nameMatches(name: string, patterns: readonly string[]): boolean {
  const n = name.toUpperCase();
  return patterns.some((p) => {
    const q = p.trim().toUpperCase();
    if (q.length === 0) return false;
    return q.endsWith('*') ? n.startsWith(q.slice(0, -1)) : n === q;
  });
}

export interface WorkerEnv {
  env: Record<string, string>;
  /** Names (never values) of the variables that were withheld from the worker. */
  withheld: string[];
}

export function buildWorkerEnv(
  base: Record<string, string | undefined>,
  allowed: readonly string[],
): WorkerEnv {
  const extra = base.LLMS_BRIDGE_PASS_ENV ? base.LLMS_BRIDGE_PASS_ENV.split(',') : [];
  const pass = [...allowed, ...extra];
  const env: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (isCredentialName(k) && !nameMatches(k, pass)) {
      withheld.push(k);
      continue;
    }
    env[k] = v;
  }
  return { env, withheld: withheld.sort() };
}

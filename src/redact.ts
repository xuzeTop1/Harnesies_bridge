/**
 * 事件流里的 `raw` 是**外部 CLI 的原样返回**,可能夹带凭证 —— 不许原样交出去。
 *
 * 实测(2026-09-23):qwen 的 `session/set_model` 返回带 `_meta.qwenModelSwitch.apiKey`,
 * 它自己遮成了 `sk-...HgS2`。但事件流的 `raw` 会经 `harness_events` 交给主脑,
 * 而主脑可能是**另一个厂商的云端模型** —— 半截 key 也不该流到那儿去(AGENTS.md 铁律一)。
 *
 * Two layers (2026-10-16):
 *  1. Key names. The old exact-name list let `OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
 *     `auth_token`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` through. Names are now matched by
 *     suffix (`…apikey`, `…token`, `…secret`, …). Only non-numeric values are redacted, so usage
 *     counters such as `input_tokens: 123` stay intact — the budget gate depends on them
 *     (plural `…tokens` never matches the singular `…token` suffix anyway).
 *  2. Value shapes inside strings (tool output, model text, diffs): well-known key formats,
 *     `Bearer …`, `user:pass@` in URLs, `NAME_TOKEN=value` assignments, private-key blocks.
 *     A tool result that `cat`s a .env file is a plain string; key names cannot catch it.
 */

const SENSITIVE_SUFFIXES = [
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'privatekey',
  'accesskey',
  'secretkey',
  'credential',
  'credentials',
  'cookie',
  'authorization',
  'sessionkey',
];
const SENSITIVE_EXACT = new Set(['auth', 'bearer', 'xapikey', 'setcookie', 'proxyauthorization']);

export function isSensitiveKey(key: string): boolean {
  const n = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n.length === 0) return false;
  return SENSITIVE_EXACT.has(n) || SENSITIVE_SUFFIXES.some((s) => n.endsWith(s));
}

/** [pattern, label, replacer]. Quantifiers are bounded so a hostile string cannot cause backtracking blow-ups. */
const VALUE_PATTERNS: Array<[RegExp, string, ((m: string, ...g: string[]) => string) | null]> = [
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g, 'private-key', null],
  [/\bsk-ant-[A-Za-z0-9_-]{16,512}/g, 'anthropic-key', null],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,512}/g, 'api-key', null],
  [/\bgithub_pat_[A-Za-z0-9_]{40,255}/g, 'github-token', null],
  [/\bgh[pousr]_[A-Za-z0-9]{30,255}/g, 'github-token', null],
  [/\bglpat-[A-Za-z0-9_-]{20,255}/g, 'gitlab-token', null],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,255}/g, 'slack-token', null],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'aws-key-id', null],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'google-api-key', null],
  [/\bhf_[A-Za-z0-9]{30,255}/g, 'hf-token', null],
  [/\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,4096}/g, 'jwt', null],
  // Header forms are credentials whatever their length (`Authorization: Bearer sk-x`).
  [
    /\b((?:proxy-)?authorization)(\s{0,4}[:=]\s{0,4})((?:bearer|basic|token|digest)\s+)?(?!\[redacted)([^\s"',;]{1,4096})/gi,
    'authorization',
    (_m, header, sep, scheme) => `${header}${sep}${scheme ?? ''}[redacted:authorization]`,
  ],
  [
    /\b(x-api-key|api-key)(\s{0,4}[:=]\s{0,4})(["']?)(?!\[redacted)([^\s"',;]{1,4096})\3/gi,
    'api-key-header',
    (_m, header, sep, q) => `${header}${sep}${q}[redacted:api-key-header]${q}`,
  ],
  [/\b(Bearer|Basic)(\s+)(?!\[redacted)[A-Za-z0-9._~+/=-]{16,4096}/gi, 'bearer', (_m, word, sp) => `${word}${sp}[redacted:bearer]`],
  [
    /\b([a-z][a-z0-9+.-]{0,30}:\/\/)([^\s/:@]{1,256}):([^\s/@]{1,256})@/gi,
    'url-credentials',
    (_m, scheme) => `${scheme}[redacted:url-credentials]@`,
  ],
  [
    /\b([A-Z][A-Z0-9_]{0,80}(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]{0,40})(\s{0,4}[=:]\s{0,4})(["']?)(?!\d+\b)(?!\[redacted)([^\s"']{6,4096})\3/g,
    'assignment',
    (_m, name, sep, q) => `${name}${sep}${q}[redacted:value]${q}`,
  ],
];

export interface TextRedaction {
  text: string;
  count: number;
}

/** Redact secret-shaped substrings. Ordinary prose and code are left alone. */
export function redactSecretsInText(text: string): TextRedaction {
  let count = 0;
  let out = text;
  for (const [re, label, replacer] of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m: string, ...groups: unknown[]) => {
      count++;
      return replacer ? replacer(m, ...(groups as string[])) : `[redacted:${label}]`;
    });
  }
  return { text: out, count };
}

/**
 * 深拷贝并把敏感字段的值换成说明串(而不是抹成空 —— 否则读日志的人会以为是对方没返回)。
 * Strings anywhere in the structure are also scanned for secret-shaped values.
 */
export function redactCredentials<T>(value: T): T {
  return redactWithCount(value).value;
}

export function redactWithCount<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown, key?: string): unknown => {
    if (key !== undefined && isSensitiveKey(key) && v !== null && v !== undefined && typeof v !== 'number' && typeof v !== 'boolean') {
      count++;
      return `[已隐去:${key}]`;
    }
    if (typeof v === 'string') {
      const r = redactSecretsInText(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k);
    return out;
  };
  const result = walk(value) as T;
  return { value: result, count };
}

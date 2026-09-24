/**
 * 事件流里的 `raw` 是**外部 CLI 的原样返回**,可能夹带凭证 —— 不许原样交出去。
 *
 * 实测(2026-09-23):qwen 的 `session/set_model` 返回带 `_meta.qwenModelSwitch.apiKey`,
 * 它自己遮成了 `sk-...HgS2`。但事件流的 `raw` 会经 `harness_events` 交给主脑,
 * 而主脑可能是**另一个厂商的云端模型** —— 半截 key 也不该流到那儿去(AGENTS.md 铁律一:
 * 不读取、不存储、不转发)。
 *
 * 判据用**键名**,不用值的形态:值长得像不像 key 是猜,键名是事实。
 * 名单**刻意不含裸 `token`**:codex 的 `token_count`、claude 的 `input_tokens`/
 * `cache_read_input_tokens` 都是正当的用量字段,按 /token/ 模糊匹配会把计量数据一起抹掉 ——
 * 那会让预算闸门变成瞎子。
 */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'xapikey',
  'authorization',
  'proxyauthorization',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'privatekey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'bearertoken',
  'cookie',
  'setcookie',
  'credential',
  'credentials',
]);

const isSensitiveKey = (key: string): boolean => SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));

/**
 * 深拷贝并把敏感**字段**的值换成一个说明串(而不是抹成空 —— 否则读日志的人会以为是对方没返回)。
 * 字符串/数字照原样返回:diff、正文、协议行都是内容本身,不改。
 */
export function redactCredentials<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactCredentials(v)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? `[已隐去:${key}]` : redactCredentials(val);
  }
  return out as T;
}

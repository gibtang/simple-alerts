/**
 * Privacy sanitization helpers.
 *
 * Everything that leaves the host application passes through these helpers:
 * - URLs are reduced to origin + path (query strings and fragments are dropped).
 * - Metadata is walked recursively with depth/key/item/string bounds and keys
 *   that look private are removed entirely.
 * - Free-text values have common inline secret shapes masked.
 */

const MAX_STRING_LENGTH = 2000;
const MAX_URL_LENGTH = 2048;
const MAX_STACK_LENGTH = 8000;
const MAX_DEPTH = 8;
const MAX_OBJECT_KEYS = 50;
const MAX_ARRAY_ITEMS = 50;

/** Keys whose values are dropped entirely, at any depth. */
const SENSITIVE_KEY_PATTERN =
  /(pass(?:word)?|pwd|secret|token|api[-_.]?key|apikey|auth[-_.]?key|access[-_.]?key|private[-_.]?key|client[-_.]?secret|auth(?:orization)?|credential|cookie|session|ssn|card[-_.]?(?:number|cvc)|bearer|jwt)/i;

/** Container keys dropped entirely at any depth, regardless of child keys. */
const FORBIDDEN_CONTAINER_PATTERN =
  /^(headers|body|requestBody|responseBody|requestHeaders|responseHeaders|cookies)$/i;

const BEARER_PATTERN = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const ASSIGN_PATTERN =
  /\b(api[-_.]?key|access[-_.]?token|client[-_.]?secret|secret|password|passwd|auth(?:orization)?|token)\b(\s*[:=]\s*)[^\s"',;&<>]{8,}/gi;
const URL_QUERY_PATTERN = /(https?:\/\/[^\s"'<>)]*?)\?[^\s"'<>)]*/g;
const URL_FRAGMENT_PATTERN = /(https?:\/\/[^\s"'<>)]*?)#[^\s"'<>)]*/g;

/**
 * Masks common inline secret shapes in free text. Best effort by design:
 * structural redaction happens at the key level, this is defense in depth for
 * secrets that end up inside messages, stack traces, or metadata strings.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(BEARER_PATTERN, '$1 [redacted]')
    .replace(JWT_PATTERN, '[redacted]')
    .replace(ASSIGN_PATTERN, '$1$2[redacted]')
    .replace(URL_QUERY_PATTERN, '$1?[redacted]')
    .replace(URL_FRAGMENT_PATTERN, '$1#[redacted]');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Reduces a URL to origin + path. Query strings and fragments never leave the
 * host application. Unparseable input falls back to stripping at the first
 * `?` / `#`.
 */
export function sanitizeUrl(raw: string, maxLength: number = MAX_URL_LENGTH): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  let cleaned: string;
  try {
    const url = new URL(raw);
    const origin = url.origin === 'null' ? '' : url.origin;
    cleaned = `${origin}${url.pathname}`;
  } catch {
    cleaned = raw.split('?')[0].split('#')[0];
  }
  cleaned = cleaned.slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : undefined;
}

const STACK_LOCATION_PATTERN = /(:\d+(?::\d+)?)$/;

function stripStackUrlDetails(match: string, base: string): string {
  return base + (STACK_LOCATION_PATTERN.exec(match)?.[0] ?? '');
}

/**
 * Sanitizes a stack trace: strips query strings and fragments from any
 * http(s) URLs embedded in stack frames, masks common inline secret shapes
 * (the first line usually repeats the error message, which may carry
 * secrets), and bounds the total length. Line and column numbers are
 * preserved for usefulness; the server normalizes them for grouping.
 */
export function sanitizeStack(raw: string, maxLength: number = MAX_STACK_LENGTH): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  const cleaned = maskSecrets(
    raw.replace(URL_QUERY_PATTERN, stripStackUrlDetails).replace(URL_FRAGMENT_PATTERN, stripStackUrlDetails),
  ).slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : undefined;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) {
    return null;
  }
  const type = typeof value;
  if (type === 'string') {
    return maskSecrets((value as string).slice(0, MAX_STRING_LENGTH));
  }
  if (type === 'number') {
    return Number.isFinite(value as number) ? value : null;
  }
  if (type === 'boolean') {
    return value;
  }
  if (type === 'bigint') {
    return (value as bigint).toString();
  }
  if (type === 'function') {
    // Functions are code, not data; drop them entirely (JSON-incompatible).
    return undefined;
  }
  if (type !== 'object') {
    // symbol and undefined are dropped (JSON-incompatible).
    return undefined;
  }
  if (depth >= MAX_DEPTH) {
    return '[depth]';
  }
  const obj = value as object;
  if (seen.has(obj)) {
    return '[circular]';
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items: unknown[] = obj
        .slice(0, MAX_ARRAY_ITEMS)
        .map((item) => sanitizeValue(item, depth + 1, seen));
      if (obj.length > MAX_ARRAY_ITEMS) {
        items.push(`[${obj.length - MAX_ARRAY_ITEMS} more]`);
      }
      return items;
    }
    if (obj instanceof Error) {
      const out: Record<string, unknown> = {
        name: maskSecrets(String(obj.name)).slice(0, MAX_STRING_LENGTH),
        message: maskSecrets(String(obj.message)).slice(0, MAX_STRING_LENGTH),
      };
      if (typeof obj.stack === 'string') {
        const stack = sanitizeStack(obj.stack);
        if (stack) {
          out.stack = stack;
        }
      }
      return out;
    }
    if (obj instanceof Map) {
      return sanitizeValue(
        Array.from(obj.entries()).slice(0, MAX_ARRAY_ITEMS),
        depth + 1,
        seen,
      );
    }
    if (obj instanceof Set) {
      return sanitizeValue(
        Array.from(obj.values()).slice(0, MAX_ARRAY_ITEMS),
        depth + 1,
        seen,
      );
    }
    const out: Record<string, unknown> = {};
    let kept = 0;
    let dropped = 0;
    for (const [key, val] of Object.entries(obj)) {
      if (FORBIDDEN_CONTAINER_PATTERN.test(key)) {
        dropped += 1;
        continue;
      }
      if (isSensitiveKey(key)) {
        dropped += 1;
        continue;
      }
      if (kept >= MAX_OBJECT_KEYS) {
        dropped += 1;
        continue;
      }
      const sanitized = sanitizeValue(val, depth + 1, seen);
      if (sanitized !== undefined) {
        out[key] = sanitized;
        kept += 1;
      }
    }
    if (dropped > 0) {
      out['[dropped]'] = dropped;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Recursively redacts metadata before upload: sensitive keys removed, string
 * values masked and bounded, depth/breadth capped, cycles and exotic values
 * replaced with markers instead of throwing.
 */
export function sanitizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === null || metadata === undefined) {
    return undefined;
  }
  const result = sanitizeValue(metadata, 0, new WeakSet());
  if (result === undefined) {
    return undefined;
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { value: result };
  }
  return result as Record<string, unknown>;
}

/**
 * Privacy helpers applied to every inbound report BEFORE it touches disk or
 * Telegram. Headers, bodies and cookies are never persisted (ingestion only
 * accepts explicit report fields); URL queries and fragments are stripped;
 * metadata is redacted recursively; common inline secrets are masked.
 */

const SENSITIVE_KEY_PATTERN =
  /pass(?:word)?|secret|token|api[-_]?key|apikey|auth(?:orization)?|cookie|session|credential|private[-_]?key|bearer|password/i;

const INLINE_SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/=]{10,}/gi,
  // Telegram bot tokens: <bot id>:<35 chars>
  /\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
  // AWS access key ids
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // OpenAI-style keys
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // Credentials embedded in URLs: scheme://user:password@host
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/g,
];

const REDACTED = '[redacted]';

/** Container keys never retained at any depth, regardless of child values. */
const FORBIDDEN_CONTAINER_PATTERN =
  /^(headers|body|requestBody|responseBody|requestHeaders|responseHeaders|cookies)$/i;

/** Mask well-known inline secret shapes plus any caller-supplied exact secrets. */
export function maskInlineSecrets(text: string, exactSecrets: string[] = []): string {
  let masked = text;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      // Preserve URL scheme prefix readability while dropping credentials.
      const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)/.exec(match);
      return schemeMatch ? `${schemeMatch[1]}${REDACTED}@` : REDACTED;
    });
  }
  for (const secret of exactSecrets) {
    if (secret.length >= 8 && masked.includes(secret)) {
      masked = masked.split(secret).join(REDACTED);
    }
  }
  return masked;
}

/**
 * Recursively redact: sensitive keys are replaced with a marker, forbidden
 * request/response containers are dropped regardless of child keys, and every
 * string is masked (inline secret shapes plus any caller-supplied exact
 * secrets such as the Telegram bot token).
 */
export function redactDeep(value: unknown, depth = 0, exactSecrets: string[] = []): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return maskInlineSecrets(value, exactSecrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1, exactSecrets));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_CONTAINER_PATTERN.test(key)) {
        // Never persist request/response containers, whatever they contain.
        continue;
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactDeep(item, depth + 1, exactSecrets);
      }
    }
    return out;
  }
  return value;
}

/** Strip query string and fragment from a URL, keeping origin + path. */
export function sanitizeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return parsed.origin + parsed.pathname;
  } catch {
    return raw.split(/[?#]/, 1)[0] ?? '';
  }
}

/** Bound a string, appending a visible truncation marker when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '…[truncated]';
  if (max <= marker.length) return text.slice(0, max);
  return text.slice(0, max - marker.length) + marker;
}

/**
 * Normalize a stack trace for grouping: strip line/column numbers and
 * query/fragment suffixes per frame, cap frame count. Frames that differ
 * only by line:column or cache-busting query collapse into one group.
 */
export function normalizeStack(stack: string): string {
  const lines = stack
    .split(/\r?\n/)
    .slice(0, 50)
    .map((line) =>
      line
        .replace(/[?#].*$/, '')
        .replace(/:(\d+)(:\d+)?/g, '')
        .trimEnd(),
    )
    .filter((line) => line.trim().length > 0);
  return lines.join('\n');
}

/**
 * Final safety pass for error text that may embed third-party responses.
 * Bounds length and masks known secret shapes plus supplied exact secrets
 * (the bot token must never survive into stored or displayed errors).
 */
export function redactErrorText(text: string, exactSecrets: string[] = [], max = 500): string {
  return truncate(maskInlineSecrets(text, exactSecrets), max);
}

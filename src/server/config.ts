import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Strict YAML configuration for Simple Alerts.
 *
 * Loaded once per process from process.env.ALERTS_CONFIG or './alerts.yaml'.
 * All string values support ${ENV_NAME} references (whole value or embedded);
 * a reference to an undefined variable fails configuration load.
 *
 * Defaults are allowed only for alerts.repeatIntervalSeconds,
 * alerts.retryWindowHours and retentionDays. Everything else is required.
 * Unknown keys are rejected. Restart the process to reload configuration.
 */

export interface AlertConfig {
  repeatIntervalSeconds: number;
  retryWindowHours: number;
}

export interface ProjectConfig {
  /** Slug string, unique. */
  id: string;
  name: string;
  /** Ingestion bearer key, unique, >= 32 chars. */
  key: string;
  /** Telegram chat id (string; may be negative for group chats). */
  chatId: string;
}

export interface Config {
  server: {
    baseUrl: string;
    databasePath: string;
    sessionSecret: string;
  };
  auth: {
    username: string;
    /** scrypt-formatted: scrypt:N:r:p:saltHex:hashHex */
    passwordHash: string;
  };
  telegram: {
    botToken: string;
  };
  projects: ProjectConfig[];
  alerts: AlertConfig;
  retentionDays: number;
}

export const SCRYPT_HASH_PATTERN =
  /^scrypt:\d+:\d+:\d+:[0-9a-f]+:[0-9a-f]+$/i;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const KEY_PATTERN = /^\S{32,128}$/;

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '::1' ||
    h.endsWith('.localhost')
  );
}

function validateBaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') return isLocalHost(parsed.hostname);
  return false;
}

const configSchema = z
  .object({
    server: z
      .object({
        baseUrl: z
          .string()
          .min(1)
          .refine(validateBaseUrl, {
            message:
              'server.baseUrl must be HTTPS, or HTTP only for localhost origins',
          }),
        databasePath: z.string().min(1),
        sessionSecret: z.string().min(32),
      })
      .strict(),
    auth: z
      .object({
        username: z.string().min(1),
        passwordHash: z.string().regex(SCRYPT_HASH_PATTERN, {
          message:
            'auth.passwordHash must be scrypt formatted: scrypt:N:r:p:saltHex:hashHex',
        }),
      })
      .strict(),
    telegram: z
      .object({
        botToken: z.string().min(20),
      })
      .strict(),
    projects: z
      .array(
        z
          .object({
            id: z.string().regex(SLUG_PATTERN, {
              message: 'project.id must be a lowercase slug',
            }),
            name: z.string().min(1).max(200),
            key: z.string().regex(KEY_PATTERN, {
              message: 'project.key must be 32-128 chars without whitespace',
            }),
            chatId: z.string().min(1).max(64),
          })
          .strict(),
      )
      .min(1),
    alerts: z
      .object({
        repeatIntervalSeconds: z.number().int().min(1).max(86400).default(300),
        retryWindowHours: z.number().int().min(1).max(168).default(24),
      })
      .strict()
      .default({ repeatIntervalSeconds: 300, retryWindowHours: 24 }),
    retentionDays: z.number().int().min(1).max(3650).default(30),
  })
  .strict();

function expandEnvRefs(
  value: unknown,
  env: Record<string, string | undefined>,
  missing: string[],
): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        missing.push(name);
        return whole;
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandEnvRefs(item, env, missing));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = expandEnvRefs(item, env, missing);
    }
    return out;
  }
  return value;
}

/**
 * Validate an already-parsed configuration document against the strict schema.
 * Exported for tests; getConfig() is the production entry point.
 */
export function parseConfig(document: unknown, env: Record<string, string | undefined>): Config {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('ALERTS config must be a YAML mapping at the top level');
  }

  const missing: string[] = [];
  const expanded = expandEnvRefs(document, env, missing);
  if (missing.length > 0) {
    const unique = [...new Set(missing)];
    throw new Error(
      `ALERTS config references undefined environment variables: ${unique.join(', ')}`,
    );
  }

  const result = configSchema.safeParse(expanded);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`ALERTS config is invalid: ${details}`);
  }

  const raw = result.data;

  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const project of raw.projects) {
    if (seenIds.has(project.id)) {
      throw new Error(`ALERTS config has duplicate project id: ${project.id}`);
    }
    if (seenKeys.has(project.key)) {
      throw new Error('ALERTS config has duplicate project keys');
    }
    seenIds.add(project.id);
    seenKeys.add(project.key);
  }

  return {
    server: {
      baseUrl: raw.server.baseUrl.replace(/\/+$/, ''),
      databasePath: raw.server.databasePath,
      sessionSecret: raw.server.sessionSecret,
    },
    auth: {
      username: raw.auth.username,
      passwordHash: raw.auth.passwordHash,
    },
    telegram: {
      botToken: raw.telegram.botToken,
    },
    projects: raw.projects.map((project) => ({
      id: project.id,
      name: project.name,
      key: project.key,
      chatId: project.chatId,
    })),
    alerts: {
      repeatIntervalSeconds: raw.alerts.repeatIntervalSeconds,
      retryWindowHours: raw.alerts.retryWindowHours,
    },
    retentionDays: raw.retentionDays,
  };
}

let cachedConfig: Config | null = null;

/** Load configuration once per process. Throws on invalid/missing config. */
export function getConfig(): Config {
  if (cachedConfig !== null) return cachedConfig;
  const path = process.env.ALERTS_CONFIG || './alerts.yaml';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(`ALERTS config not readable at ${path} (${code})`);
  }
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (error) {
    throw new Error(
      `ALERTS config is not valid YAML: ${error instanceof Error ? error.message : 'parse error'}`,
    );
  }
  cachedConfig = parseConfig(document, process.env);
  return cachedConfig;
}

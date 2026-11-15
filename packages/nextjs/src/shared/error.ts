import { maskSecrets, sanitizeMetadata, sanitizeStack, sanitizeUrl } from './sanitize.js';
import type { AlertSource, EventContext, EventInput } from './types.js';

export interface ErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/** Reads a string field without ever letting a throwing getter escape. */
export function safeField(getter: () => unknown): string | undefined {
  try {
    const value = getter();
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts name/message/stack from any thrown value without throwing.
 * Getters that throw are treated as absent; exotic values degrade to
 * String() or a fixed fallback.
 */
export function errorInfo(error: unknown): ErrorInfo {
  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }
  if (error === null || error === undefined) {
    return { name: 'Error', message: 'Unknown error' };
  }
  if (error instanceof Error) {
    return {
      name: safeField(() => error.name) ?? 'Error',
      message: safeField(() => error.message) ?? 'Unknown error',
      stack: safeField(() => error.stack),
    };
  }
  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      name: safeField(() => record.name) ?? 'Error',
      message: safeField(() => record.message) ?? 'Unknown error',
      stack: safeField(() => record.stack),
    };
  }
  let message: string;
  try {
    message = String(error);
  } catch {
    message = 'Unknown error';
  }
  return { name: 'Error', message };
}

/**
 * Builds a fully sanitized EventInput from raw error info plus context.
 * Sanitization happens here, before any payload sizing, so nothing private
 * is ever serialized into a request body.
 */
export function buildEvent(
  source: AlertSource,
  info: ErrorInfo,
  context?: EventContext,
): EventInput {
  const contextName = typeof context?.name === 'string' && context.name.length > 0 ? context.name : undefined;
  const contextMessage =
    typeof context?.message === 'string' && context.message.length > 0 ? context.message : undefined;

  const event: EventInput = {
    name: maskSecrets(contextName ?? info.name),
    message: maskSecrets(contextMessage ?? info.message),
    source,
  };

  const stack = info.stack ? sanitizeStack(info.stack) : undefined;
  if (stack) {
    event.stack = stack;
  }

  const rawUrl = context?.url;
  const url = typeof rawUrl === 'string' && rawUrl.length > 0 ? sanitizeUrl(rawUrl) : undefined;
  if (url) {
    event.url = url;
  }

  if (context?.metadata !== undefined && context.metadata !== null) {
    const metadata = sanitizeMetadata(context.metadata);
    if (metadata) {
      event.metadata = metadata;
    }
  }

  return event;
}

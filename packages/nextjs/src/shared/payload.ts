import type { EventInput } from './types.js';

/**
 * Hard payload ceiling matching the ingestion report limit (64 KiB).
 * Everything the SDK uploads is guaranteed to serialize under this bound.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

/**
 * Serializes an already-sanitized event to JSON within `maxBytes`.
 *
 * Degrades in fixed, ordered steps so the payload always stays finite:
 * full event -> drop metadata -> cap stack -> cap message -> minimal
 * name+message. The final fallback is a few hundred bytes at most.
 */
export function fitEvent(event: EventInput, maxBytes: number): string {
  const name = truncate(
    typeof event.name === 'string' && event.name.length > 0 ? event.name : 'Error',
    200,
  );
  const message = truncate(
    typeof event.message === 'string' && event.message.length > 0 ? event.message : 'Unknown error',
    8000,
  );
  const stack = typeof event.stack === 'string' ? event.stack : undefined;

  const attempts: EventInput[] = [
    { ...event, name, message },
    { ...event, name, message, metadata: undefined },
    {
      ...event,
      name,
      message: truncate(message, 4000),
      stack: stack ? truncate(stack, 4000) : undefined,
      metadata: undefined,
    },
    { ...event, name, message: truncate(message, 2000), stack: undefined, metadata: undefined },
    { ...event, name, message: truncate(message, 500), stack: undefined, metadata: undefined },
    { name, message: truncate(message, 200), source: event.source },
  ];

  for (const attempt of attempts) {
    const json = JSON.stringify(attempt);
    if (byteLength(json) <= maxBytes) {
      return json;
    }
  }
  return JSON.stringify({
    name: truncate(name, 50),
    message: truncate(message, 100),
    source: event.source,
  });
}

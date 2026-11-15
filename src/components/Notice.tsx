/** First value of a possibly repeated query parameter. */
export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

const NOTICE_TEXT: Record<string, (projectName?: string) => string> = {
  test: (projectName) =>
    projectName
      ? `Test alert queued for “${projectName}”. It will be delivered to the project's Telegram chat.`
      : 'Test alert queued.',
  retry: () => 'Delivery retry scheduled.',
};

/** Renders the `?notice=` confirmation banner; unknown values render nothing. */
export function Notice({
  notice,
  projectName,
}: {
  notice?: string;
  projectName?: string;
}) {
  const factory = notice && Object.hasOwn(NOTICE_TEXT, notice) ? NOTICE_TEXT[notice] : undefined;
  if (!factory) return null;
  return (
    <p className="notice" role="status">
      {factory(projectName)}
    </p>
  );
}

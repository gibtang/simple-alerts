/** Logout — plain POST form; the API route performs the same-origin check. */
export function LogoutForm() {
  return (
    <form method="post" action="/api/auth/logout" className="inline-form">
      <button type="submit" className="btn btn-sm">
        Log out
      </button>
    </form>
  );
}

/** Sends one synthetic test error for a project to its Telegram chat. */
export function TestSendForm({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  return (
    <form
      method="post"
      action={`/api/projects/${encodeURIComponent(projectId)}/test`}
      className="inline-form"
    >
      <button
        type="submit"
        className="btn btn-sm"
        title={`Send a test alert to the ${projectName} Telegram chat`}
      >
        Send test
      </button>
    </form>
  );
}

/** Manual retry for a failed delivery; resets the retry window. */
export function RetryForm({ deliveryId }: { deliveryId: number }) {
  return (
    <form
      method="post"
      action={`/api/deliveries/${deliveryId}/retry`}
      className="inline-form"
    >
      <button
        type="submit"
        className="btn btn-sm"
        title="Schedule a retry for this failed delivery"
      >
        Retry
      </button>
    </form>
  );
}

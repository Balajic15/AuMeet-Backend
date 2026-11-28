/** A failed call to an outside service; `retryable` = worth trying again later (rate limit, outage, network). */
export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** The connection itself is broken (revoked token, wrong credentials): the user must reconnect. */
    readonly reconnect = false,
  ) {
    super(message);
  }
}

export async function callJson<T>(url: string, init: RequestInit, label: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new IntegrationError(`${label}: ${(err as Error).message || 'network error'}`, true);
  }
  const text = await res.text();
  if (!res.ok) {
    const auth = res.status === 401 || res.status === 403;
    let detail = '';
    try {
      const j = JSON.parse(text) as {
        error?: { message?: string } | string;
        errors?: Array<{ message?: string }> | Record<string, string>;
        errorMessages?: string[];
        message?: string;
      };
      // Jira reports field problems as { errors: { field: message } }; others use arrays.
      const errs = Array.isArray(j.errors)
        ? j.errors[0]?.message
        : j.errors && typeof j.errors === 'object'
          ? Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ')
          : undefined;
      detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? errs ?? j.errorMessages?.[0] ?? j.message ?? '';
    } catch {
      /* not JSON */
    }
    throw new IntegrationError(`${label} answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status === 429 || res.status >= 500, auth);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Thrown by `fetchJson` for a non-2xx response, carrying the status so a caller can special-case e.g. 401. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(`request failed with status ${res.status}`, res.status);
  return (await res.json()) as T;
}

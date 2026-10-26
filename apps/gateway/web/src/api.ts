// Thin fetch wrapper: same-origin, cookie session, JSON in and out, errors become exceptions.
export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(path === "/chat" && data?.toolCalls)) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

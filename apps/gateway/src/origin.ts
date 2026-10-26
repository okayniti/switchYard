// Origin validation for /mcp (MCP Streamable HTTP spec: servers MUST validate Origin to prevent
// DNS rebinding). Browsers always send Origin on cross-origin requests; CLI clients such as Claude
// Code send none. So: no Origin -> allowed; Origin present -> must be in the allowlist.

const normalize = (o: string): string | null => {
  try {
    const u = new URL(o);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
};

export function parseOrigins(list: string): Set<string> {
  return new Set(list.split(",").map((s) => normalize(s.trim())).filter((s): s is string => s !== null));
}

export function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  if (origin === undefined) return true;
  const o = normalize(origin); // "null" (sandboxed pages, file://) normalizes to null -> rejected
  return o !== null && allowed.has(o);
}

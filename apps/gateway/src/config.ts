// Every env var the gateway reads. Names and defaults are the contract in docs/ENV.md.
function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env ${name}`);
    process.exit(1);
  }
  return v;
}
const opt = (name: string, fallback: string) => process.env[name] || fallback;

const port = Number(opt("PORT", "8080"));

export const config = {
  port,
  databaseUrl: req("DATABASE_URL"),
  encKey: req("GATEWAY_ENC_KEY"),
  admin: { email: req("ADMIN_EMAIL"), password: req("ADMIN_PASSWORD") },
  member: { email: req("MEMBER_EMAIL"), password: req("MEMBER_PASSWORD") },
  seeds: {
    wooUrl: opt("WOO_MCP_URL", "http://woo-mcp.mcp.svc.cluster.local:8080/mcp"),
    shippingUrl: opt("SHIPPING_MCP_URL", "http://shipping-mcp.mcp.svc.cluster.local:8080/mcp"),
    shippingToken: process.env.SHIPPING_MCP_TOKEN ?? "",
    everythingUrl: opt("EVERYTHING_MCP_URL", "http://everything-mcp.mcp.svc.cluster.local:3001/mcp"),
  },
  publicMcpUrl: opt("PUBLIC_MCP_URL", "http://mcp.localtest.me/mcp"),
  mcpAllowedOrigins: opt("MCP_ALLOWED_ORIGINS", "http://yard.localtest.me"),
  upstreamAllowedHosts: opt("UPSTREAM_ALLOWED_HOSTS", "*.svc.cluster.local").split(","),
  selfMcpUrl: opt("SELF_MCP_URL", `http://127.0.0.1:${port}/mcp`),
  llm: {
    baseUrl: opt("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
    model: opt("LLM_MODEL", "llama-3.3-70b-versatile"),
    apiKey: process.env.LLM_API_KEY ?? "",
  },
  cookieSecure: opt("COOKIE_SECURE", "false") === "true",
  healthIntervalMs: Number(opt("HEALTH_INTERVAL_MS", "15000")),
  toolTimeoutMs: Number(opt("TOOL_TIMEOUT_MS", "15000")),
};

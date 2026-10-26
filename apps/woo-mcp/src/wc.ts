// WooCommerce REST v3 client. In-cluster traffic is plain HTTP, and over HTTP WooCommerce only
// accepts OAuth 1.0a one-legged signatures (Basic auth is HTTPS-only). We sign exactly the way
// WC_REST_Authentication::check_oauth_signature verifies (proven by scripts/wc-rest-smoke.mjs):
//   - HMAC-SHA256, key = consumer_secret + "&"
//   - base = METHOD & enc(home URL) & enc(sorted params), params = every query param incl. rest_route
// We use ?rest_route=/wc/v3/... so the path is "/" and pretty permalinks / redirects don't matter.
import { createHmac, randomBytes } from "node:crypto";

export interface WcConfig {
  url: string; // where requests go, e.g. http://wordpress.store.svc.cluster.local
  home: string; // the store's public home URL; WooCommerce signs against this
  key: string;
  secret: string;
}

// RFC 3986 percent-encoding (PHP rawurlencode): encodeURIComponent leaves !'()* alone.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export type Query = Record<string, string | number | boolean | undefined>;

export class WcClient {
  constructor(private cfg: WcConfig) {}

  private signedUrl(method: string, route: string, query: Query): string {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params[k] = String(v);
    Object.assign(params, {
      rest_route: route,
      oauth_consumer_key: this.cfg.key,
      oauth_nonce: randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA256",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    });
    const base = this.cfg.home.replace(/\/+$/, "");
    const paramString = Object.keys(params)
      .sort()
      .map((k) => enc(`${enc(k)}=${enc(params[k])}`))
      .join("%26");
    const stringToSign = `${method}&${enc(base)}&${paramString}`;
    const signature = createHmac("sha256", `${this.cfg.secret}&`).update(stringToSign).digest("base64");
    const qs = new URLSearchParams({ ...params, oauth_signature: signature });
    return `${this.cfg.url.replace(/\/+$/, "")}/?${qs}`;
  }

  async request<T = unknown>(method: "GET" | "POST" | "PUT", route: string, query: Query = {}, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.signedUrl(method, route, query), {
        method,
        redirect: "manual",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new Error(`Store unreachable at ${this.cfg.url}: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {}
      throw new Error(`WooCommerce returned HTTP ${res.status} for ${method} ${route}: ${msg}`);
    }
    return JSON.parse(text) as T;
  }
}

// Smoke test: call the WooCommerce REST API over plain HTTP from inside the cluster with
// the generated ck_/cs_ key. Over HTTP, WooCommerce only accepts OAuth 1.0a one-legged
// signatures (Basic auth / query-string keys are HTTPS-only), so this signs the request
// the same way WC_REST_Authentication::check_oauth_signature verifies it.
//
// Env: WC_URL (where to send, e.g. http://wordpress.store.svc), WC_HOME (the store's public
// home URL — WooCommerce builds the signature base from get_home_url(), not the Host we hit),
// WC_CONSUMER_KEY, WC_CONSUMER_SECRET. No dependencies: node 24 built-ins only.
import { createHmac, randomBytes } from "node:crypto";

const { WC_URL, WC_HOME, WC_CONSUMER_KEY, WC_CONSUMER_SECRET } = process.env;
for (const [k, v] of Object.entries({ WC_URL, WC_HOME, WC_CONSUMER_KEY, WC_CONSUMER_SECRET })) {
  if (!v) throw new Error(`missing env ${k}`);
}

// RFC 3986 percent-encoding (PHP rawurlencode): encodeURIComponent also leaves !'()* alone.
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function signedUrl(method, route, query = {}) {
  // ?rest_route= form: the request path is "/", so WooCommerce's signature base is just the home URL.
  const params = {
    ...query,
    rest_route: route,
    oauth_consumer_key: WC_CONSUMER_KEY,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
  };
  const base = WC_HOME.replace(/\/+$/, "");
  const paramString = Object.keys(params)
    .sort()
    .map((k) => enc(`${enc(k)}=${enc(String(params[k]))}`))
    .join("%26");
  const stringToSign = `${method.toUpperCase()}&${enc(base)}&${paramString}`;
  const signature = createHmac("sha256", `${WC_CONSUMER_SECRET}&`).update(stringToSign).digest("base64");
  const qs = new URLSearchParams({ ...params, oauth_signature: signature });
  return `${WC_URL.replace(/\/+$/, "")}/?${qs}`;
}

async function call(method, route, query) {
  const res = await fetch(signedUrl(method, route, query), { method, redirect: "manual" });
  const body = await res.text();
  return { status: res.status, body };
}

// 1) Signed request must succeed.
const ok = await call("GET", "/wc/v3/products", { per_page: "3" });
console.log(`signed GET /wc/v3/products -> HTTP ${ok.status}`);
if (ok.status !== 200) {
  console.log(ok.body.slice(0, 500));
  process.exit(1);
}
for (const p of JSON.parse(ok.body)) console.log(`  #${p.id} ${p.name} ₹${p.regular_price} (sku ${p.sku})`);

// 2) Unsigned request must be rejected (proves auth is actually enforced).
const res = await fetch(`${WC_URL.replace(/\/+$/, "")}/?rest_route=/wc/v3/products`, { redirect: "manual" });
console.log(`unsigned GET /wc/v3/products -> HTTP ${res.status} (expected 401)`);
process.exit(res.status === 401 ? 0 : 1);

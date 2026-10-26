// Round-trip the OAuth1 signature against a fake store that verifies it the way
// WC_REST_Authentication::check_oauth_signature does (base URL = the *home* URL, not the Host hit).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { WcClient } from "../dist/wc.js";

const HOME = "http://shop.example.test";
const SECRET = "cs_test_secret";
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
let server, url, last;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const q = Object.fromEntries(new URL(req.url, "http://x").searchParams);
      last = { method: req.method, q, body };
      const { oauth_signature, ...params } = q;
      const paramString = Object.keys(params).sort().map((k) => enc(`${enc(k)}=${enc(params[k])}`)).join("%26");
      const expected = createHmac("sha256", `${SECRET}&`).update(`${req.method}&${enc(HOME)}&${paramString}`).digest("base64");
      if (oauth_signature !== expected) return res.writeHead(401).end(JSON.stringify({ message: "Invalid signature" }));
      if (q.rest_route === "/wc/v3/orders/404") return res.writeHead(404).end(JSON.stringify({ message: "Invalid ID." }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const wc = () => new WcClient({ url, home: HOME, key: "ck_test", secret: SECRET });

test("signed GET with query params verifies against the home URL", async () => {
  assert.deepEqual(await wc().request("GET", "/wc/v3/products", { search: "brass diya (gold)!", per_page: 5, skip: undefined }), { ok: true });
  assert.equal(last.q.rest_route, "/wc/v3/products");
  assert.equal(last.q.oauth_signature_method, "HMAC-SHA256");
  assert.equal("skip" in last.q, false);
});

test("signed POST sends a JSON body outside the signature", async () => {
  await wc().request("POST", "/wc/v3/products", {}, { name: "Mug", regular_price: "349" });
  assert.equal(last.method, "POST");
  assert.deepEqual(JSON.parse(last.body), { name: "Mug", regular_price: "349" });
});

test("a wrong secret is rejected and the error is readable", async () => {
  const bad = new WcClient({ url, home: HOME, key: "ck_test", secret: "nope" });
  await assert.rejects(bad.request("GET", "/wc/v3/products"), /HTTP 401 for GET \/wc\/v3\/products: Invalid signature/);
});

test("WooCommerce error messages are surfaced", async () => {
  await assert.rejects(wc().request("GET", "/wc/v3/orders/404"), /HTTP 404 .*Invalid ID\./);
});

test("an unreachable store gives a clear error", async () => {
  const dead = new WcClient({ url: "http://127.0.0.1:1", home: HOME, key: "k", secret: "s" });
  await assert.rejects(dead.request("GET", "/wc/v3/products"), /Store unreachable at http:\/\/127\.0\.0\.1:1/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkUpstreamUrl, hostAllowlisted, isBlockedAddress } from "../dist/ssrf.js";

const ALLOW = ["*.svc.cluster.local"];
// Fake resolver: no real DNS in tests.
const zone = {
  "localhost": ["127.0.0.1", "::1"],
  "metadata.attacker.example": ["169.254.169.254"],
  "rebind.example": ["93.184.216.34", "127.0.0.1"], // one good, one bad
  "api.github.com": ["140.82.112.5"],
  "internal-svc.example": ["10.43.0.12"],
};
const lookup = async (h) => {
  if (!zone[h]) throw new Error("ENOTFOUND");
  return zone[h].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const check = (u) => checkUpstreamUrl(u, ALLOW, lookup);

test("blocked address ranges", () => {
  for (const a of ["127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1", "0.0.0.0", "::1", "::", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ["10.43.0.12", "192.168.1.5", "172.16.0.1", "140.82.112.5", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isBlockedAddress(a), false, a);
  }
});

test("loopback, metadata and unspecified are rejected, by name or by literal", async () => {
  assert.match(await check("http://localhost:3001/mcp"), /resolves to 127\.0\.0\.1/);
  assert.match(await check("http://169.254.169.254/latest/meta-data"), /blocked by SSRF guard/);
  assert.match(await check("http://metadata.attacker.example/mcp"), /169\.254\.169\.254/);
  assert.match(await check("http://[::1]:8080/mcp"), /::1/);
  assert.match(await check("http://0.0.0.0:8080/mcp"), /blocked/);
  assert.match(await check("http://2130706433/mcp"), /127\.0\.0\.1/); // decimal form of 127.0.0.1
  assert.match(await check("http://0x7f000001/mcp"), /127\.0\.0\.1/); // hex form
});

test("a name with any bad address is rejected", async () => {
  assert.match(await check("https://rebind.example/mcp"), /127\.0\.0\.1/);
});

test("public and private (in-cluster) addresses are allowed", async () => {
  assert.equal(await check("https://api.github.com/mcp"), null);
  assert.equal(await check("http://internal-svc.example:8080/mcp"), null);
});

test("allow-listed cluster names skip resolution entirely", async () => {
  assert.equal(await check("http://woo-mcp.mcp.svc.cluster.local:8080/mcp"), null);
  assert.equal(hostAllowlisted("WOO-MCP.mcp.svc.cluster.local.", ALLOW), true);
  assert.equal(hostAllowlisted("svc.cluster.local", ALLOW), false); // the bare suffix isn't a match
  assert.equal(hostAllowlisted("evil-svc.cluster.local.attacker.example", ALLOW), false);
  assert.equal(await checkUpstreamUrl("http://127.0.0.1:18081/mcp", ["127.0.0.1"], lookup), null); // exact entry, e.g. local dev
});

test("bad URLs and unresolvable hosts are refused with a reason", async () => {
  assert.equal(await check("ftp://example.com/mcp"), "only http and https URLs are allowed");
  assert.equal(await check("not a url"), "not a valid URL");
  assert.equal(await check("http://nowhere.invalid/mcp"), "cannot resolve host 'nowhere.invalid'");
});

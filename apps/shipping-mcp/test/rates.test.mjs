import assert from "node:assert/strict";
import { test } from "node:test";
import { quote, searchZones, zoneFor } from "../dist/rates.js";

test("PIN codes map to zones by first digit", () => {
  assert.equal(zoneFor("110001").id, "in-north");
  assert.equal(zoneFor("400001").id, "in-west");
  assert.equal(zoneFor("560001").id, "in-south");
  assert.equal(zoneFor("700001").id, "in-east");
  assert.equal(zoneFor("900001").id, "intl"); // 9 is not a civilian PIN zone
});

test("state names match case-insensitively; anything else is international", () => {
  assert.equal(zoneFor(" kerala ").id, "in-south");
  assert.equal(zoneFor("Germany").id, "intl");
  assert.equal(zoneFor("56001").id, "intl"); // 5 digits is not a PIN
});

test("weight is billed per started half-kilo", () => {
  const q = quote("560001", 1.2);
  assert.equal(q.billed_weight_kg, 1.5);
  assert.deepEqual(q.quotes.map((x) => x.price_inr), [70 + 33, 150 + 68]); // 22*1.5=33, 45*1.5=67.5 -> 68
});

test("a single service can be requested", () => {
  const q = quote("Delhi", 2, "express");
  assert.deepEqual(q.quotes, [{ service: "express", price_inr: 140 + 80, delivery_days: "1-2" }]);
});

test("search matches ids, names and regions", () => {
  assert.deepEqual(searchZones("international").map((z) => z.id), ["intl"]);
  assert.deepEqual(searchZones("MAHARASHTRA").map((z) => z.id), ["in-west"]);
  assert.equal(searchZones("india").length, 5); // "non-Indian destination" matches too
  assert.deepEqual(searchZones("atlantis"), []);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { dayRange } from "../dist/dates.js";

test("today in Asia/Kolkata is IST midnight to midnight, as UTC", () => {
  const r = dayRange("today", "Asia/Kolkata", new Date("2026-10-26T12:00:00Z")); // 17:30 IST
  assert.deepEqual(r, { date: "2026-10-26", after: "2026-10-25T18:29:59", before: "2026-10-26T18:30:00" });
});

test("after 18:30 UTC it is already tomorrow in IST", () => {
  assert.equal(dayRange("today", "Asia/Kolkata", new Date("2026-10-26T19:00:00Z")).date, "2026-10-27");
});

test("yesterday and explicit dates", () => {
  assert.equal(dayRange("yesterday", "Asia/Kolkata", new Date("2026-10-26T12:00:00Z")).date, "2026-10-25");
  assert.equal(dayRange(" Today ", "Asia/Kolkata", new Date("2026-10-26T12:00:00Z")).date, "2026-10-26");
  assert.equal(dayRange("2026-01-31", "Asia/Kolkata").before, "2026-01-31T18:30:00");
});

test("DST day in New York is 23 hours long", () => {
  const r = dayRange("2026-03-08", "America/New_York");
  assert.equal(r.after, "2026-03-08T04:59:59");
  assert.equal(r.before, "2026-03-09T04:00:00");
});

test("rejects anything else", () => {
  assert.throws(() => dayRange("last week", "Asia/Kolkata"), /YYYY-MM-DD/);
  assert.throws(() => dayRange("26-10-2026", "Asia/Kolkata"), /YYYY-MM-DD/);
});

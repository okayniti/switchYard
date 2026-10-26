// Turn "today" / "yesterday" / "YYYY-MM-DD" in a store time zone into a UTC [start, end) range.
// We query WooCommerce with dates_are_gmt=true, so the store's own timezone setting can't skew it.

// Minutes the zone is ahead of UTC at a given instant (e.g. +330 for Asia/Kolkata).
function offsetMinutes(at: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((wall - at.getTime()) / 60_000);
}

export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at); // en-CA formats as YYYY-MM-DD
}

function localMidnightUtc(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first), tz) * 60_000); // second pass handles DST edges
}

export function dayRange(input: string, tz: string, now = new Date()): { date: string; after: string; before: string } {
  let ymd = input.trim().toLowerCase();
  if (ymd === "today") ymd = localDate(now, tz);
  else if (ymd === "yesterday") ymd = localDate(new Date(now.getTime() - 86_400_000), tz);
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`date must be "today", "yesterday" or YYYY-MM-DD, got "${input}"`);
  const start = localMidnightUtc(ymd, tz);
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const end = localMidnightUtc(next, tz);
  // WooCommerce expects ISO 8601 without milliseconds.
  const iso = (t: Date) => t.toISOString().replace(/\.\d{3}Z$/, "");
  return { date: ymd, after: iso(new Date(start.getTime() - 1000)), before: iso(end) };
}

// The fixed rate table and the pricing rule. Pure functions, no I/O, so they are unit-tested.

export interface Zone {
  id: string;
  name: string;
  regions: string[];
  standard: { base: number; perKg: number; days: string };
  express: { base: number; perKg: number; days: string };
}

export type Service = "standard" | "express";

// Prices in INR. Indian zones are keyed by the first digit of the PIN code.
export const ZONES: Zone[] = [
  { id: "in-north", name: "India North", regions: ["PIN 1xxxxx-2xxxxx", "Delhi", "Punjab", "Uttar Pradesh"], standard: { base: 60, perKg: 20, days: "3-5" }, express: { base: 140, perKg: 40, days: "1-2" } },
  { id: "in-west", name: "India West", regions: ["PIN 3xxxxx-4xxxxx", "Rajasthan", "Gujarat", "Maharashtra"], standard: { base: 50, perKg: 18, days: "2-4" }, express: { base: 120, perKg: 35, days: "1-2" } },
  { id: "in-south", name: "India South", regions: ["PIN 5xxxxx-6xxxxx", "Karnataka", "Tamil Nadu", "Kerala"], standard: { base: 70, perKg: 22, days: "3-6" }, express: { base: 150, perKg: 45, days: "2-3" } },
  { id: "in-east", name: "India East", regions: ["PIN 7xxxxx-8xxxxx", "West Bengal", "Bihar", "Assam"], standard: { base: 80, perKg: 25, days: "4-7" }, express: { base: 170, perKg: 50, days: "2-3" } },
  { id: "intl", name: "International", regions: ["Any non-Indian destination"], standard: { base: 1200, perKg: 600, days: "8-14" }, express: { base: 2500, perKg: 900, days: "3-5" } },
];

export function zoneFor(destination: string): Zone {
  const d = destination.trim();
  const pin = /^\d{6}$/.test(d) ? Number(d[0]) : NaN;
  if (pin >= 1 && pin <= 2) return ZONES[0];
  if (pin >= 3 && pin <= 4) return ZONES[1];
  if (pin >= 5 && pin <= 6) return ZONES[2];
  if (pin >= 7 && pin <= 8) return ZONES[3];
  const byName = ZONES.find((z) => z.regions.some((r) => r.toLowerCase() === d.toLowerCase()));
  return byName ?? ZONES[4];
}

export function quote(destination: string, weightKg: number, service?: Service) {
  const zone = zoneFor(destination);
  const kg = Math.ceil(weightKg * 2) / 2; // bill per started half-kilo
  const one = (s: Service) => ({ service: s, price_inr: zone[s].base + Math.round(zone[s].perKg * kg), delivery_days: zone[s].days });
  return { destination, zone: zone.id, billed_weight_kg: kg, quotes: service ? [one(service)] : [one("standard"), one("express")] };
}

export function searchZones(query: string): Zone[] {
  const q = query.toLowerCase();
  return ZONES.filter((z) => [z.id, z.name, ...z.regions].some((s) => s.toLowerCase().includes(q)));
}

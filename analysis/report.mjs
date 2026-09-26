// Aggregates analysis/out/occupancy-events.csv (produced by
// extract-events.mjs) into daily/format rollups and a modeled revenue
// estimate (see price-model.mjs for the pricing assumptions and their
// caveats). Prints a short summary and writes two CSVs.
//
// Usage: node analysis/report.mjs

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { basePriceForFormats, primaryFormat, DBOX_SEAT_SURCHARGE } from "./price-model.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = path.join(REPO_ROOT, "analysis", "out");

function parseCsv(text) {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = fields[i]));
    return row;
  });
}
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const events = parseCsv(readFileSync(path.join(OUT_DIR, "occupancy-events.csv"), "utf8"));
const baselines = parseCsv(readFileSync(path.join(OUT_DIR, "session-baselines.csv"), "utf8"));

function revenueForRow(row, formatsList) {
  const price = basePriceForFormats(formatsList);
  const standardish = Number(row.soldStandard) + Number(row.soldWheelchair) + Number(row.soldCompanion) + Number(row.soldUnknownType);
  const dbox = Number(row.soldDBox);
  const released = Number(row.released);
  return standardish * price + dbox * (price + DBOX_SEAT_SURCHARGE) - released * price;
}
function netTickets(row) {
  return (
    Number(row.soldStandard) + Number(row.soldWheelchair) + Number(row.soldCompanion) +
    Number(row.soldDBox) + Number(row.soldUnknownType) - Number(row.released)
  );
}
const byDay = new Map();      // observedAt date -> { tickets, revenue }
const byFormat = new Map();   // primary format -> { tickets, revenue }
const byTheatre = new Map();  // theatreName -> { tickets, revenue }

let totalTickets = 0, totalRevenue = 0;

for (const row of events) {
  const formatsList = row.formats ? row.formats.split("|") : [];
  const tickets = netTickets(row);
  const revenue = revenueForRow(row, formatsList);
  const day = row.observedAt.slice(0, 10);
  const fmt = primaryFormat(formatsList);

  totalTickets += tickets;
  totalRevenue += revenue;

  for (const [map, key] of [[byDay, day], [byFormat, fmt], [byTheatre, row.theatreName]]) {
    const entry = map.get(key) || { tickets: 0, revenue: 0 };
    entry.tickets += tickets;
    entry.revenue += revenue;
    map.set(key, entry);
  }
}

let baselineOccupied = 0;
for (const row of baselines) baselineOccupied += Number(row.occupiedAtFirstObservation);

function csvField(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function writeMapCsv(file, keyLabel, map) {
  const rows = [csvField(keyLabel) + ",ticketsSoldEstimate,revenueEstimateCAD\n"];
  for (const [key, v] of [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    rows.push(`${csvField(key)},${v.tickets},${v.revenue.toFixed(2)}\n`);
  }
  writeFileSync(file, rows.join(""));
}

writeMapCsv(path.join(OUT_DIR, "daily-summary.csv"), "date", byDay);
writeMapCsv(path.join(OUT_DIR, "format-summary.csv"), "primaryFormat", byFormat);
writeMapCsv(path.join(OUT_DIR, "theatre-summary.csv"), "theatreName", byTheatre);

const days = [...byDay.keys()].sort();
console.log(`\nObservation window: ${days[0]} .. ${days[days.length - 1]} (${days.length} distinct scrape days)`);
console.log(`Sessions seen with a pre-existing baseline (booked before this run started watching): ${baselines.length}, ${baselineOccupied} seats already occupied at first sighting (excluded from the flow numbers below)\n`);

console.log("By day (net tickets sold observed that day, modeled revenue @ price-model.mjs rates):");
for (const day of days) {
  const v = byDay.get(day);
  console.log(`  ${day}  ${String(v.tickets).padStart(6)} tickets   $${v.revenue.toFixed(0).padStart(9)}`);
}

console.log("\nBy primary format:");
for (const [fmt, v] of [...byFormat.entries()].sort((a, b) => b[1].revenue - a[1].revenue)) {
  console.log(`  ${fmt.padEnd(18)} ${String(v.tickets).padStart(6)} tickets   $${v.revenue.toFixed(0).padStart(9)}`);
}

console.log("\nTop 10 theatres by modeled revenue:");
for (const [name, v] of [...byTheatre.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 10)) {
  console.log(`  ${name.padEnd(45)} ${String(v.tickets).padStart(6)} tickets   $${v.revenue.toFixed(0).padStart(9)}`);
}

console.log(`\nTotal across all 152 theatres, ${days.length}-day observation window: ${totalTickets} net tickets, ~$${totalRevenue.toFixed(0)} modeled revenue`);
console.log(`Wrote analysis/out/{daily,format,theatre}-summary.csv`);

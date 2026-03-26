#!/usr/bin/env node
/**
 * Summarize POI sleep/corridor NDJSON review logs.
 *
 * Usage:
 *   node scripts/poi-review-log-summary.mjs
 *   node scripts/poi-review-log-summary.mjs logs/poi-corridor-review.ndjson
 *
 * Optional env:
 *   POI_REVIEW_LOG_FILE=logs/poi-corridor-review.ndjson
 */

import fs from "fs";
import path from "path";

const argPath = process.argv[2]?.trim();
const envPath = (process.env.POI_REVIEW_LOG_FILE ?? "").trim();
const filePath = argPath || envPath || path.join("logs", "poi-corridor-review.ndjson");

function pct(n, d) {
  if (!d) return "0.0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

if (!fs.existsSync(filePath)) {
  console.error(`No review log found at: ${filePath}`);
  console.error("Tip: set POI_REVIEW_LOG=true on planner API and run /plan requests first.");
  process.exit(1);
}

const raw = fs.readFileSync(filePath, "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);

const byEvent = new Map();
const byResolved = new Map();
let badJson = 0;
let total = 0;

for (const line of lines) {
  total++;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    badJson++;
    continue;
  }
  const event = String(row?.event ?? "unknown");
  byEvent.set(event, (byEvent.get(event) ?? 0) + 1);

  if (event === "sleep_charger_resolution_summary") {
    const rv = String(row?.resolvedVia ?? "unknown");
    byResolved.set(rv, (byResolved.get(rv) ?? 0) + 1);
  }
}

const sortedEvents = [...byEvent.entries()].sort((a, b) => b[1] - a[1]);
const sortedResolved = [...byResolved.entries()].sort((a, b) => b[1] - a[1]);
const summaryTotal = [...byResolved.values()].reduce((a, b) => a + b, 0);

console.log(`POI review log: ${filePath}`);
console.log(`Lines: ${lines.length}  Parsed: ${lines.length - badJson}  Invalid JSON: ${badJson}`);
console.log("");
console.log("Events:");
if (!sortedEvents.length) {
  console.log("  (none)");
} else {
  for (const [ev, n] of sortedEvents) {
    console.log(`  - ${ev}: ${n}`);
  }
}

console.log("");
console.log("Resolution summary (from sleep_charger_resolution_summary):");
if (!sortedResolved.length) {
  console.log("  (none)");
} else {
  for (const [rv, n] of sortedResolved) {
    console.log(`  - ${rv}: ${n} (${pct(n, summaryTotal)})`);
  }
}


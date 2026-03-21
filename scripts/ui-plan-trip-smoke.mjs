/**
 * UI smoke test for `/map` -> "Plan Trip" flow.
 *
 * This uses the project's existing gstack `browse` binary (run under WSL)
 * because the goal is to catch browser CORS/preflight regressions.
 *
 * Assertions:
 * - After clicking "Plan Trip", the page includes the "Itinerary" section.
 * - Browser console output does not include CORS/preflight failures.
 *
 * Usage:
 *   node scripts/ui-plan-trip-smoke.mjs
 *
 * Assumptions:
 * - `web` is running on port 3000 and `api` is running on port 3001
 * - WSL can reach the Windows host via the default gateway IP (usually 172.x.x.x)
 */

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function windowsPathToWsl(p) {
  // Convert `C:\Users\...` to `/mnt/c/Users/...`
  const m = p.match(/^([A-Za-z]):[\\\/](.*)$/);
  if (!m) return p;
  const drive = m[1].toLowerCase();
  const rest = m[2].replaceAll("\\", "/");
  return `/mnt/${drive}/${rest}`;
}

function getDefaultGatewayIp() {
  // Use the WSL default route gateway as the Windows host address.
  const out = execSync(`wsl bash -lc "ip route 2>/dev/null | awk '/default/ {print $3; exit}'"`, {
    encoding: "utf8"
  }).trim();
  assert(out.length > 0, "Could not determine WSL gateway IP");
  const m = out.match(/(\d+\.\d+\.\d+\.\d+)/);
  assert(m && m[1], `Could not parse gateway IP from: ${out}`);
  return m[1];
}

function resolveGstackBrowseBin() {
  const home = os.homedir(); // usually C:\Users\...
  const win = process.env.GSTACK_BROWSE_BIN_WIN
    ? process.env.GSTACK_BROWSE_BIN_WIN
    : path.join(home, ".cursor", "skills", "gstack", "browse", "dist", "browse");
  const wsl = process.env.GSTACK_BROWSE_BIN_WSL
    ? process.env.GSTACK_BROWSE_BIN_WSL
    : windowsPathToWsl(win);
  return { win, wsl };
}

function runWsl(cmd, { timeoutMs = 180000 } = {}) {
  // Run in WSL so the Linux gstack binary can execute.
  const quoted = JSON.stringify(cmd);
  return execSync(`wsl bash -lc ${quoted}`, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs
  });
}

function main() {
  const gatewayIp = getDefaultGatewayIp();
  const webUrl = `http://${gatewayIp}:3000/map`;
  const { wsl: browseBin } = resolveGstackBrowseBin();

  // Basic sanity: itinerary should appear after planning.
  // We rely on gstack ref IDs from a prior snapshot:
  // - @e2: End input
  // - @e3: Plan Trip button
  // If the ref numbering changes, adjust the script.
  const repoWsl = windowsPathToWsl(process.cwd());

  const jsExpr = "document.body.innerText.includes('Itinerary')";

  const cmd = [
    `cd "${repoWsl}"`,
    // One bash -lc chunk to keep gstack browser session + ref state consistent.
    `${browseBin} goto "${webUrl}"`,
    `${browseBin} snapshot -i`,
    `${browseBin} fill @e2 "Greensboro, NC"`,
    `${browseBin} click @e3`,
    `sleep 18`,
    `echo ITINERARY_CHECK_START`,
    // Print boolean value from page text.
    `${browseBin} js "${jsExpr}" 2>&1`,
    `echo ITINERARY_CHECK_END`,
    // Print browser console errors into output for parsing.
    `${browseBin} console --errors`
  ].join(" && ");

  const out = runWsl(cmd, { timeoutMs: 180000 });

  const m = out.match(/ITINERARY_CHECK_START[\s\S]*?\b(true|false)\b[\s\S]*?ITINERARY_CHECK_END/);
  assert(m && m[1] === "true", "Expected itinerary to render (page text did not include 'Itinerary').");

  const corsBad =
    out.includes("blocked by CORS policy") ||
    out.includes("Access-Control-Allow-Origin") ||
    out.includes("CORS policy");

  assert(!corsBad, `Expected no CORS errors, but found them in gstack console output.\n${out}`);

  // eslint-disable-next-line no-console
  console.log("ui-plan-trip-smoke: ok");
}

main();


/**
 * One-shot automated smoke: API build + fast E2E scripts that spawn their own API.
 *
 * Usage (repo root):
 *   node scripts/qa-smoke-all.mjs
 *   npm run qa:smoke
 *
 * Does not start Docker, web dev server, or gstack browse UI tests.
 * Fails fast on first non-zero exit.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function runStep(label, command, args) {
  console.log(`\n[qa:smoke] === ${label} ===\n`);
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env
  });
  const code = r.status ?? 1;
  if (code !== 0) {
    console.error(`\n[qa:smoke] FAILED: ${label} (exit ${code})\n`);
    process.exit(code);
  }
}

runStep("npm -w api run build", "npm", ["-w", "api", "run", "build"]);
runStep("e2e-cors-functional.mjs", "node", [
  path.join(root, "scripts", "e2e-cors-functional.mjs")
]);
runStep("e2e-plan-log-contract.mjs", "node", [
  path.join(root, "scripts", "e2e-plan-log-contract.mjs")
]);
runStep("e2e-replan-smoke.mjs", "node", [
  path.join(root, "scripts", "e2e-replan-smoke.mjs")
]);
runStep("e2e-candidates-smoke.mjs", "node", [
  path.join(root, "scripts", "e2e-candidates-smoke.mjs")
]);
runStep("e2e-route-preview-smoke.mjs", "node", [
  path.join(root, "scripts", "e2e-route-preview-smoke.mjs")
]);
runStep("e2e-multileg-locks-smoke.mjs", "node", [
  path.join(root, "scripts", "e2e-multileg-locks-smoke.mjs")
]);

console.log("\n[qa:smoke] All steps passed.\n");

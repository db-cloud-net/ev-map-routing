/**
 * CI smoke: tests that run cleanly without Valhalla or POI Services.
 *
 * Full qa:smoke (which includes plan/route/candidates E2E) requires Valhalla
 * and is run locally or against the staging environment.
 *
 * CI gate:
 *   - API TypeScript compile
 *   - Web TypeScript compile
 *   - CORS preflight behavior
 *   - Log contract (requestId correlation, deploymentEnv field)
 *   - Unit tests (Vitest)
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function runStep(label, command, args) {
  console.log(`\n[qa:smoke:ci] === ${label} ===\n`);
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: process.env
  });
  const code = r.status ?? 1;
  if (code !== 0) {
    console.error(`\n[qa:smoke:ci] FAILED: ${label} (exit ${code})\n`);
    process.exit(code);
  }
}

runStep("npm -w api run build", "npm", ["-w", "api", "run", "build"]);
runStep("npm -w web run build", "npm", ["-w", "web", "run", "build"]);
runStep("unit tests", "npm", ["test"]);
runStep("e2e-cors-functional.mjs", "node", [
  path.join(root, "scripts", "e2e-cors-functional.mjs")
]);
runStep("e2e-plan-log-contract.mjs", "node", [
  path.join(root, "scripts", "e2e-plan-log-contract.mjs")
]);

console.log("\n[qa:smoke:ci] All CI steps passed.\n");
console.log(
  "[qa:smoke:ci] Note: plan/route/candidates E2E tests (npm run qa:smoke) require Valhalla — run locally or on staging.\n"
);

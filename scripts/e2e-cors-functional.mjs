/**
 * Dependency-free functional E2E for CORS behavior on `POST /plan`.
 *
 * What it checks:
 * - dev-local: reflects the incoming `Origin` header into
 *   `Access-Control-Allow-Origin`
 * - production: only allows `CORS_ORIGIN` (or `*`); for mismatched origins the
 *   response must not include `Access-Control-Allow-Origin` (browser blocks).
 *
 * Note:
 * - This is header-level verification (not browser enforcement), but it
 *   matches the browser CORS rules the UI depends on.
 *
 * Usage:
 *   node scripts/e2e-cors-functional.mjs
 *
 * Env overrides:
 *   API_PORT (default 3002)
 */

import { execSync, spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import { killListenersOnPort } from "./e2e-kill-port.mjs";

const API_PORT = Number(process.env.API_PORT ?? "3002");
const API_BASE = process.env.API_BASE ?? `http://localhost:${API_PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth({ timeoutMs = 60000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`${API_BASE}/health`, { method: "GET" });
      if (resp.ok) return;
    } catch {
      // ignore
    }
    await sleepMs(300);
  }
  throw new Error(
    `Timed out waiting for ${API_BASE}/health (spawned API). Ensure nothing else is bound to port ${API_PORT}, ` +
      `or set API_PORT to a free port. If the server exited, check the log lines above (e.g. EADDRINUSE, missing NREL_API_KEY).`
  );
}

async function runOptionsPreflight({ path, origin, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: "OPTIONS",
      signal: controller.signal,
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type"
      }
    });
    const allowOrigin = resp.headers.get("access-control-allow-origin");
    const allowMethods = resp.headers.get("access-control-allow-methods");
    const allowHeaders = resp.headers.get("access-control-allow-headers");
    return { resp, allowOrigin, allowMethods, allowHeaders };
  } finally {
    clearTimeout(t);
  }
}

function stopProc(proc) {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
}

/**
 * Send SIGTERM and wait for the process to fully exit (or SIGKILL after 5s).
 * This ensures the port is released before the next scenario starts.
 */
async function stopAndWait(proc) {
  if (!proc) return;
  const done = new Promise((resolve) => {
    proc.on("exit", resolve);
    proc.on("error", resolve);
  });
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore — already dead
  }
  // Give SIGTERM up to 5s; force-kill if it lingers.
  const timeout = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }, 5000);
  await done;
  clearTimeout(timeout);
  // Brief OS pause to ensure the port binding is fully released.
  await sleepMs(100);
}

function startServer({ overrides }) {
  killListenersOnPort(API_PORT, { verbose: process.env.E2E_VERBOSE === "1" });
  // Ensure dist exists (server.ts -> dist/api/src/server.js).
  // Skip when E2E_SKIP_BUILD=1 (CI: qa:smoke already built once before running scenarios).
  if (process.env.E2E_SKIP_BUILD !== "1") {
    execSync("npm -w api run build", { stdio: "inherit" });
  }

  const serverEntry = "api/dist/api/src/server.js";
  const proc = spawn("node", [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      E2E_SPAWN_PORT: String(API_PORT),
      ...overrides
    },
    // Inherit stdout/stderr: piping without draining stdout can deadlock the child on Windows
    // once the pipe buffer fills (server logs to stdout).
    stdio: ["ignore", "inherit", "inherit"]
  });

  return proc;
}

async function checkScenario({ name, overrides, origin, expectedAllowOrigin }) {
  console.log(`cors-functional: scenario=${name}`);

  const proc = startServer({ overrides });
  try {
    await waitForHealth();

    const { resp, allowOrigin, allowMethods, allowHeaders } = await runOptionsPreflight({
      path: "/plan",
      origin
    });

    assert(resp.status === 200, `Expected OPTIONS /plan to return 200; got ${resp.status}`);

    assert(
      typeof allowMethods === "string" && allowMethods.length > 0,
      `Missing Access-Control-Allow-Methods for ${name}`
    );
    assert(
      typeof allowHeaders === "string" && allowHeaders.length > 0,
      `Missing Access-Control-Allow-Headers for ${name}`
    );

    if (expectedAllowOrigin === undefined) {
      assert(allowOrigin == null, `Expected no Access-Control-Allow-Origin for ${name}, got ${allowOrigin}`);
    } else {
      assert(
        allowOrigin === expectedAllowOrigin,
        `Expected Access-Control-Allow-Origin=${expectedAllowOrigin} for ${name}, got ${allowOrigin}`
      );
    }
  } finally {
    await stopAndWait(proc);
  }
}

async function main() {
  const devOrigin = "http://172.22.16.1:3000";
  const otherOrigin = "http://example.com";

  // 1) dev-local should reflect the request Origin.
  await checkScenario({
    name: "dev-local-reflects-origin",
    overrides: {
      DEPLOYMENT_ENV: "dev-local",
      CORS_ORIGIN: "http://localhost:3000"
    },
    origin: devOrigin,
    expectedAllowOrigin: devOrigin
  });

  // 2) production should allow only CORS_ORIGIN when it matches.
  await checkScenario({
    name: "production-allows-cors-origin",
    overrides: {
      DEPLOYMENT_ENV: "production",
      CORS_ORIGIN: devOrigin
    },
    origin: devOrigin,
    expectedAllowOrigin: devOrigin
  });

  // 3) production should not allow mismatched origins (browser blocks preflight).
  await checkScenario({
    name: "production-rejects-mismatched-origin",
    overrides: {
      DEPLOYMENT_ENV: "production",
      CORS_ORIGIN: devOrigin
    },
    origin: otherOrigin,
    expectedAllowOrigin: undefined
  });

  console.log("e2e-cors-functional: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


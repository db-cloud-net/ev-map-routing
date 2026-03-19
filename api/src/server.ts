import express from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { planTrip } from "./planner/planTrip";
import path from "path";
import { existsSync } from "fs";

import dotenv from "dotenv";

// Load the repo-root `.env`.
// In dev we usually run from the workspace root, but when running compiled JS
// from `api/dist/...` the `__dirname` depth changes, so we prefer `process.cwd()`.
const cwdEnvPath = path.join(process.cwd(), ".env");
const fallbackRepoRoot = path.resolve(__dirname, "../..");
const fallbackEnvPath = path.join(fallbackRepoRoot, ".env");

const envPath = existsSync(cwdEnvPath) ? cwdEnvPath : fallbackEnvPath;
dotenv.config({ path: envPath });

const app = express();
app.use(express.json({ limit: "1mb" }));

// Allow the web frontend (Next.js on :3000) to call this API (on :3001).
// We handle CORS preflight (OPTIONS) explicitly so browsers can POST JSON.
app.use((req, res, next) => {
  const allowedOrigin = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  const origin = req.headers.origin;

  if (allowedOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // Still set a default allowed origin for dev, even if origin header is missing/mismatched.
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    debug: {
      cwd: process.cwd(),
      nrelApiKeyPresent: Boolean(process.env.NREL_API_KEY)
    }
  });
});

const planSchema = z.object({
  start: z.string().min(1).max(200),
  end: z.string().min(1).max(200),
});

app.post("/plan", async (req, res) => {
  const requestId =
    (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const responseVersion = "mvp-1";
  const startedAt = Date.now();

  try {
    const parsed = planSchema.parse(req.body);
    console.log(
      JSON.stringify({
        event: "plan_request_start",
        requestId,
        responseVersion,
        start: parsed.start,
        end: parsed.end
      })
    );
    const result = await planTrip({
      requestId,
      start: parsed.start,
      end: parsed.end,
      responseVersion,
    });
    console.log(
      JSON.stringify({
        event: "plan_request_end",
        requestId,
        responseVersion,
        status: result.status,
        durationMs: Date.now() - startedAt,
        stopsCount: result.stops?.length ?? 0,
        overnightStopsCount: result.totals?.overnightStopsCount ?? 0
      })
    );
    res.status(result.status === "ok" ? 200 : 400).json(result);
  } catch (err) {
    console.log(
      JSON.stringify({
        event: "plan_request_error",
        requestId,
        responseVersion,
        durationMs: Date.now() - startedAt,
        message: err instanceof Error ? err.message : String(err)
      })
    );
    const msg =
      err instanceof Error ? err.message : "Unexpected error planning trip";
    res.status(400).json({
      requestId,
      responseVersion,
      status: "error",
      message: msg,
      stops: [],
      legs: [],
    });
  }
});

const port = Number(process.env.PORT ?? "3000");
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`api listening on :${port}`);
});


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

  try {
    const parsed = planSchema.parse(req.body);
    const result = await planTrip({
      requestId,
      start: parsed.start,
      end: parsed.end,
      responseVersion,
    });
    res.status(result.status === "ok" ? 200 : 400).json(result);
  } catch (err) {
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


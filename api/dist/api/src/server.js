"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const planTrip_1 = require("./planner/planTrip");
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const dotenv_1 = __importDefault(require("dotenv"));
// Load the repo-root `.env`.
// In dev we usually run from the workspace root, but when running compiled JS
// from `api/dist/...` the `__dirname` depth changes, so we prefer `process.cwd()`.
const cwdEnvPath = path_1.default.join(process.cwd(), ".env");
const fallbackRepoRoot = path_1.default.resolve(__dirname, "../..");
const fallbackEnvPath = path_1.default.join(fallbackRepoRoot, ".env");
const envPath = (0, fs_1.existsSync)(cwdEnvPath) ? cwdEnvPath : fallbackEnvPath;
dotenv_1.default.config({ path: envPath });
const app = (0, express_1.default)();
app.use(express_1.default.json({ limit: "1mb" }));
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        debug: {
            cwd: process.cwd(),
            nrelApiKeyPresent: Boolean(process.env.NREL_API_KEY)
        }
    });
});
const planSchema = zod_1.z.object({
    start: zod_1.z.string().min(1).max(200),
    end: zod_1.z.string().min(1).max(200),
});
app.post("/plan", async (req, res) => {
    const requestId = req.headers["x-request-id"] ?? (0, crypto_1.randomUUID)();
    const responseVersion = "mvp-1";
    try {
        const parsed = planSchema.parse(req.body);
        const result = await (0, planTrip_1.planTrip)({
            requestId,
            start: parsed.start,
            end: parsed.end,
            responseVersion,
        });
        res.status(result.status === "ok" ? 200 : 400).json(result);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "Unexpected error planning trip";
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

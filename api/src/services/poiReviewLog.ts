import fs from "fs";
import path from "path";

export type PoiCorridorReviewLinePayload = {
  event: string;
  requestId: string;
  legIndex: number;
  hotelPoiId?: number;
  nearbyDcfcId?: number;
  nearbyDcfcDistanceYd?: number;
  resolvedVia?: string;
  note?: string;
  [key: string]: unknown;
};

/**
 * Optional POI corridor sleep-stop review logger (NDJSON).
 * Enabled by `POI_REVIEW_LOG=true`.
 *
 * Best-effort only: any IO/serialization errors are swallowed.
 */
export function appendPoiCorridorReviewLine(payload: PoiCorridorReviewLinePayload): void {
  const enabled = (process.env.POI_REVIEW_LOG ?? "false").toLowerCase() === "true";
  if (!enabled) return;

  try {
    const dir = (process.env.POI_REVIEW_LOG_DIR ?? "").trim() || path.join(process.cwd(), "logs");
    const file = (process.env.POI_REVIEW_LOG_FILE ?? "").trim() || "poi-corridor-review.ndjson";
    fs.mkdirSync(dir, { recursive: true });
    const fullPath = path.join(dir, file);
    const line = { t: new Date().toISOString(), ...payload };
    fs.appendFileSync(fullPath, JSON.stringify(line) + "\n", { encoding: "utf8" });
  } catch {
    // swallow — this is review/QA logging only.
  }
}


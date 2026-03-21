export type ProviderName = "chargers" | "pois";
export type MismatchSeverity = "OK" | "WARN" | "FAIL";

type ProviderStats = {
  comparableCount: number; // both mirror + remote succeeded
  failCount: number; // comparable samples classified FAIL
  warnCount: number; // comparable samples classified WARN

  // Mirror-side errors when remote succeeded (still useful for operational gating).
  mirrorStaleCount: number; // SourceErrorCode === STALE_SNAPSHOT
  mirrorFatalCount: number; // MIRROR_* codes / SNAPSHOT_INVALID / SCHEMA_MISMATCH
};

type RecordComparableArgs = {
  provider: ProviderName;
  mismatchSeverity: MismatchSeverity;
};

type RecordMirrorErrorArgs = {
  provider: ProviderName;
  mirrorErrorCode: string | undefined;
};

const fatalMirrorErrorCodes = new Set([
  "MIRROR_ARTIFACT_CORRUPT",
  "MIRROR_ARTIFACT_MISSING",
  "MIRROR_MANIFEST_MISSING",
  "MIRROR_MANIFEST_INVALID",
  "MIRROR_UNAVAILABLE",
  "SNAPSHOT_INVALID",
  "SCHEMA_MISMATCH"
]);

const stats: Record<ProviderName, ProviderStats> = {
  chargers: { comparableCount: 0, failCount: 0, warnCount: 0, mirrorStaleCount: 0, mirrorFatalCount: 0 },
  pois: { comparableCount: 0, failCount: 0, warnCount: 0, mirrorStaleCount: 0, mirrorFatalCount: 0 }
};

let c2Approved = false;

function resetIfNeeded() {
  // v1: we keep it process-local without an explicit reset trigger until we have
  // snapshot identity/scheme version wired into the router.
}

function computePass(args: ProviderName, comparableMin: number) {
  const s = stats[args];
  if (s.comparableCount < comparableMin) return false;
  const failRate = s.failCount / s.comparableCount;
  const warnRate = s.warnCount / s.comparableCount;

  const staleRate = s.comparableCount === 0 ? 0 : s.mirrorStaleCount / s.comparableCount;
  const fatalRate = s.comparableCount === 0 ? 0 : s.mirrorFatalCount / s.comparableCount;

  // C2 v1 proposal: <= 0.5% FAIL, <= 5% WARN, and <= 0.5% mirror stale / <= 0 mirror fatal.
  return failRate <= 0.005 && warnRate <= 0.05 && staleRate <= 0.005 && fatalRate === 0;
}

export function recordDualReadComparableSample(args: RecordComparableArgs) {
  resetIfNeeded();
  if (c2Approved) return;
  const s = stats[args.provider];
  s.comparableCount += 1;
  if (args.mismatchSeverity === "FAIL") s.failCount += 1;
  if (args.mismatchSeverity === "WARN") s.warnCount += 1;
}

export function recordDualReadMirrorError(args: RecordMirrorErrorArgs) {
  resetIfNeeded();
  if (c2Approved) return;
  const s = stats[args.provider];

  const code = args.mirrorErrorCode;
  if (!code) return;
  if (code === "STALE_SNAPSHOT") s.mirrorStaleCount += 1;
  if (fatalMirrorErrorCodes.has(code)) s.mirrorFatalCount += 1;
}

export function getC2Approved(): boolean {
  if (c2Approved) return true;
  const chargersOk = computePass("chargers", Number(process.env.C2_CHARGERS_MIN_SAMPLES ?? "200") || 200);
  // POI can lag chargers due to lower call volume: proposed min can be smaller.
  const poisOk = computePass("pois", Number(process.env.C2_POIS_MIN_SAMPLES ?? "100") || 100);
  if (chargersOk && poisOk) {
    c2Approved = true;
  }
  return c2Approved;
}

export function getC2StatsForDebug() {
  return JSON.parse(JSON.stringify({ approved: c2Approved, stats }));
}

// Self-test helper (not used by production code).
export function resetC2GateForSelfTest() {
  stats.chargers = { comparableCount: 0, failCount: 0, warnCount: 0, mirrorStaleCount: 0, mirrorFatalCount: 0 };
  stats.pois = { comparableCount: 0, failCount: 0, warnCount: 0, mirrorStaleCount: 0, mirrorFatalCount: 0 };
  c2Approved = false;
}


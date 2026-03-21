import {
  getC2Approved,
  getC2StatsForDebug,
  recordDualReadComparableSample,
  recordDualReadMirrorError,
  resetC2GateForSelfTest
} from "./c2Gate";

async function main() {
  // Use small sample sizes so this self-test runs quickly.
  process.env.C2_CHARGERS_MIN_SAMPLES = "10";
  process.env.C2_POIS_MIN_SAMPLES = "10";

  const N = 10;

  // PASS case: 0 FAIL, 0 WARN on both providers.
  resetC2GateForSelfTest();
  for (let i = 0; i < N; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  const passApproved = getC2Approved();
  if (!passApproved) {
    throw new Error(`Expected C2 gate to approve (pass case). Stats=${JSON.stringify(getC2StatsForDebug())}`);
  }

  // FAIL case: 1 FAIL out of 10 chargers (failRate 10% > 0.5%).
  resetC2GateForSelfTest();
  for (let i = 0; i < N - 1; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
  }
  recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "FAIL" });
  for (let i = 0; i < N; i++) {
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  const failApproved = getC2Approved();
  if (failApproved) {
    throw new Error(`Expected C2 gate NOT to approve (fail case). Stats=${JSON.stringify(getC2StatsForDebug())}`);
  }

  // FAIL case: 1 WARN out of 10 chargers (warnRate 10% > 5%).
  resetC2GateForSelfTest();
  for (let i = 0; i < N - 1; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
  }
  recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "WARN" });
  for (let i = 0; i < N; i++) {
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  const warnApproved = getC2Approved();
  if (warnApproved) {
    throw new Error(`Expected C2 gate NOT to approve (warn case). Stats=${JSON.stringify(getC2StatsForDebug())}`);
  }

  // FAIL case: any STALE_SNAPSHOT in comparable window (mirrorStaleCount > 0 => staleRate > 0.5%).
  resetC2GateForSelfTest();
  for (let i = 0; i < N; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  recordDualReadMirrorError({ provider: "chargers", mirrorErrorCode: "STALE_SNAPSHOT" });
  const staleApproved = getC2Approved();
  if (staleApproved) {
    throw new Error(`Expected C2 gate NOT to approve (stale case). Stats=${JSON.stringify(getC2StatsForDebug())}`);
  }

  // FAIL case: any fatal mirror error code yields fatalRate > 0 => reject.
  resetC2GateForSelfTest();
  for (let i = 0; i < N; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  recordDualReadMirrorError({ provider: "chargers", mirrorErrorCode: "MIRROR_UNAVAILABLE" });
  const fatalApproved = getC2Approved();
  if (fatalApproved) {
    throw new Error(`Expected C2 gate NOT to approve (fatal mirror error case). Stats=${JSON.stringify(getC2StatsForDebug())}`);
  }

  // Interleaving test: stale injected mid-stream; then we complete samples.
  resetC2GateForSelfTest();
  for (let i = 0; i < N / 2; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  recordDualReadMirrorError({ provider: "chargers", mirrorErrorCode: "STALE_SNAPSHOT" });
  for (let i = 0; i < N / 2; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  const staleInterleavedApproved = getC2Approved();
  if (staleInterleavedApproved) {
    throw new Error(
      `Expected C2 gate NOT to approve (interleaved stale case). Stats=${JSON.stringify(getC2StatsForDebug())}`
    );
  }

  // Reset behavior: once approved, reset must clear stats AND revoke approval.
  resetC2GateForSelfTest();
  for (let i = 0; i < N; i++) {
    recordDualReadComparableSample({ provider: "chargers", mismatchSeverity: "OK" });
    recordDualReadComparableSample({ provider: "pois", mismatchSeverity: "OK" });
  }
  if (!getC2Approved()) {
    throw new Error(`Expected C2 gate to approve before reset. Stats=${JSON.stringify(getC2StatsForDebug())}`);
  }
  resetC2GateForSelfTest();
  if (getC2Approved()) {
    throw new Error(`Expected C2 gate NOT to approve after reset. Stats=${JSON.stringify(getC2StatsForDebug())}`);
  }

  console.log("c2Gate.selftest: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


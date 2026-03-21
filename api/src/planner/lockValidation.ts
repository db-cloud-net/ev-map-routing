/**
 * Validates `lockedChargersByLeg` against waypoint-derived leg count.
 */

export function normalizeWaypointStrings(waypoints: string[] | undefined): string[] {
  return (waypoints ?? []).map((w) => w.trim()).filter(Boolean);
}

/** Number of driving legs: 1 + intermediate waypoints. */
export function legCountFromWaypoints(waypoints: string[] | undefined): number {
  const wps = normalizeWaypointStrings(waypoints);
  return Math.max(1, wps.length + 1);
}

export type LockValidationResult =
  | { ok: true }
  | { ok: false; message: string; errorCode: string };

export function validateLockedChargersByLeg(
  waypoints: string[] | undefined,
  lockedChargersByLeg: string[][] | undefined
): LockValidationResult {
  if (lockedChargersByLeg == null || lockedChargersByLeg.length === 0) {
    return { ok: true };
  }

  const numLegs = legCountFromWaypoints(waypoints);
  if (lockedChargersByLeg.length !== numLegs) {
    return {
      ok: false,
      message: `lockedChargersByLeg must have ${numLegs} row(s) (one per driving leg).`,
      errorCode: "INVALID_LOCK_LEGS"
    };
  }

  const maxLocks = Number(process.env.V2_MAX_LOCKED_CHARGERS ?? "8");
  for (let i = 0; i < lockedChargersByLeg.length; i++) {
    const row = lockedChargersByLeg[i];
    if (row.length > maxLocks) {
      return {
        ok: false,
        message: `Too many locked chargers on leg ${i} (max ${maxLocks}).`,
        errorCode: "TOO_MANY_LOCKED_CHARGERS"
      };
    }
    const seen = new Set<string>();
    for (const id of row) {
      const s = String(id);
      if (seen.has(s)) {
        return {
          ok: false,
          message: `Duplicate charger lock id on leg ${i}: ${s}`,
          errorCode: "DUPLICATE_CHARGER_LOCK"
        };
      }
      seen.add(s);
    }
  }

  return { ok: true };
}

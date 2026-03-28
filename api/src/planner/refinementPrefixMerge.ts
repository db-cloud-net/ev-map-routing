import type { ItineraryLeg, ItineraryStop } from "../types";

/**
 * Merge a timed prefix of a single `planLeastTimeSegment` solve into cumulative trip stops/legs.
 * `segmentStops[0]` is the segment start (duplicate of `baseStops[last]` when base is non-empty).
 */
export function mergeSegmentPrefixIntoTripSnapshot(
  baseStops: ItineraryStop[],
  baseLegs: ItineraryLeg[],
  segmentStops: ItineraryStop[],
  segmentLegs: ItineraryLeg[],
  prefixStopsCount: number,
  elapsedTripOffsetMinutes: number
): { stops: ItineraryStop[]; legs: ItineraryLeg[] } {
  const prefStops = segmentStops.slice(0, prefixStopsCount);
  const prefLegs = segmentLegs.slice(0, Math.max(0, prefixStopsCount - 1));
  const withEta: ItineraryStop[] = prefStops.map((s) => ({
    ...s,
    etaMinutesFromStart: (s.etaMinutesFromStart ?? 0) + elapsedTripOffsetMinutes
  }));
  if (!baseStops.length) {
    return { stops: withEta, legs: prefLegs };
  }
  return {
    stops: [...baseStops, ...withEta.slice(1)],
    legs: [...baseLegs, ...prefLegs]
  };
}

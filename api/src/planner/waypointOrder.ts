import type { LatLng } from "../types";
import { haversineMiles } from "./geo";

function scorePathMiles(points: LatLng[]): number {
  let s = 0;
  for (let i = 0; i < points.length - 1; i++) {
    s += haversineMiles(points[i]!, points[i + 1]!);
  }
  return s;
}

/** Heap / swap-recursion: all permutations of `0..n-1`. */
function allPermutations(n: number): number[][] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const out: number[][] = [];
  function gen(a: number[], l: number) {
    if (l === a.length) {
      out.push([...a]);
      return;
    }
    for (let i = l; i < a.length; i++) {
      const t = a[l]!;
      a[l] = a[i]!;
      a[i] = t;
      gen(a, l + 1);
      const u = a[l]!;
      a[l] = a[i]!;
      a[i] = u;
    }
  }
  gen(idx, 0);
  return out;
}

function nearestNeighborPermutation(
  start: LatLng,
  waypointCoords: LatLng[]
): number[] | null {
  const k = waypointCoords.length;
  if (k === 0) return [];
  const remaining = new Set(Array.from({ length: k }, (_, i) => i));
  const perm: number[] = [];
  let last = start;
  while (remaining.size > 0) {
    let bestI = -1;
    let bestD = Infinity;
    for (const i of remaining) {
      const d = haversineMiles(last, waypointCoords[i]!);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI < 0) return null;
    perm.push(bestI);
    remaining.delete(bestI);
    last = waypointCoords[bestI]!;
  }
  return perm;
}

/**
 * Pick an intermediate waypoint order that minimizes **sum of haversine leg miles**
 * (cheap proxy for driving distance). Time-bounded; intended before full EV planning.
 */
export function pickBestWaypointOrderHaversine(
  start: LatLng,
  end: LatLng,
  waypointCoords: LatLng[],
  waypointLabels: string[],
  budgetMs: number
): {
  orderedLabels: string[];
  orderedCoords: LatLng[];
  userLabels: string[];
  changed: boolean;
  evaluated: number;
  elapsedMs: number;
  bestScoreMiles: number;
  userScoreMiles: number;
} {
  const t0 = Date.now();
  const k = waypointCoords.length;
  const userLabels = [...waypointLabels];
  if (k < 2) {
    return {
      orderedLabels: [...waypointLabels],
      orderedCoords: [...waypointCoords],
      userLabels,
      changed: false,
      evaluated: 1,
      elapsedMs: Date.now() - t0,
      bestScoreMiles: scorePathMiles([start, ...waypointCoords, end]),
      userScoreMiles: scorePathMiles([start, ...waypointCoords, end])
    };
  }

  let bestScore = scorePathMiles([start, ...waypointCoords, end]);
  let bestOrder = [...waypointLabels];
  let bestCoords = [...waypointCoords];
  let evaluated = 1;

  const tryPerm = (perm: number[]) => {
    if (Date.now() - t0 >= budgetMs) return;
    const coords = perm.map((i) => waypointCoords[i]!);
    const labels = perm.map((i) => waypointLabels[i]!);
    const sc = scorePathMiles([start, ...coords, end]);
    evaluated++;
    if (sc < bestScore - 1e-9) {
      bestScore = sc;
      bestOrder = labels;
      bestCoords = coords;
    }
  };

  tryPerm([...Array(k).keys()].reverse());

  const nn = nearestNeighborPermutation(start, waypointCoords);
  if (nn && nn.length === k) tryPerm(nn);

  if (k <= 6) {
    for (const p of allPermutations(k)) {
      if (Date.now() - t0 >= budgetMs) break;
      tryPerm(p);
    }
  } else {
    for (let s = 0; s < 100 && Date.now() - t0 < budgetMs; s++) {
      const shuffle = Array.from({ length: k }, (_, i) => i);
      for (let i = k - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = shuffle[i]!;
        shuffle[i] = shuffle[j]!;
        shuffle[j] = t;
      }
      tryPerm(shuffle);
    }
  }

  const changed = bestOrder.some((l, i) => l !== userLabels[i]);
  return {
    orderedLabels: bestOrder,
    orderedCoords: bestCoords,
    userLabels,
    changed,
    evaluated,
    elapsedMs: Date.now() - t0,
    bestScoreMiles: bestScore,
    userScoreMiles: scorePathMiles([start, ...waypointCoords, end])
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getCandidates, getRoutePreview, planTrip } from "./api-client";
import type { CandidatesApiResponse, PlanTripResponse, RoutePreviewApiResponse } from "./types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE = "http://localhost:3001";
const OPTS = { baseUrl: BASE };

const OK_PLAN: PlanTripResponse = {
  requestId: "req-1",
  responseVersion: "v2",
  status: "ok",
  stops: [],
  legs: [],
};

const OK_CANDIDATES: CandidatesApiResponse = {
  requestId: "req-2",
  responseVersion: "v2",
  status: "ok",
  candidates: { chargers: [], hotels: [], legIndex: 0 },
};

const OK_PREVIEW: RoutePreviewApiResponse = {
  requestId: "req-3",
  responseVersion: "v2-1-route-preview",
  status: "ok",
  preview: {
    polyline: { type: "LineString", coordinates: [[-80.8, 35.2], [-78.6, 35.7]] },
    tripTimeMinutes: 90,
    tripDistanceMiles: 165,
    horizon: { maxMinutes: 60, maneuvers: [], cumulativeTimeSeconds: 0 },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockFetchNetworkError(message = "Failed to fetch") {
  return vi.fn().mockRejectedValue(new TypeError(message));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("planTrip", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(200, OK_PLAN));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls POST /plan with the request body", async () => {
    const req = { start: "Charlotte, NC", end: "Raleigh, NC" };
    await planTrip(req, OPTS);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/plan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(req);
  });

  it("returns parsed PlanTripResponse on 200", async () => {
    const result = await planTrip({ start: "A", end: "B" }, OPTS);
    expect(result).toEqual(OK_PLAN);
  });

  it("strips trailing slash from baseUrl", async () => {
    await planTrip({ start: "A", end: "B" }, { baseUrl: "http://localhost:3001/" });
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://localhost:3001/plan");
  });

  it("throws ApiError with status and message on non-200", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { message: "Internal server error" }));
    await expect(planTrip({ start: "A", end: "B" }, OPTS)).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.status === 500 && e.message === "Internal server error"
    );
  });

  it("includes raw body on ApiError", async () => {
    const errBody = { message: "oops", errorCode: "INFEASIBLE" };
    vi.stubGlobal("fetch", mockFetch(400, errBody));
    const caught = await planTrip({ start: "A", end: "B" }, OPTS).catch((e) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).body).toEqual(errBody);
  });

  it("falls back to generic message when error body has no message field", async () => {
    vi.stubGlobal("fetch", mockFetch(503, {}));
    await expect(planTrip({ start: "A", end: "B" }, OPTS)).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiError && e.message.includes("503")
    );
  });

  it("propagates TypeError on network failure", async () => {
    vi.stubGlobal("fetch", mockFetchNetworkError());
    await expect(planTrip({ start: "A", end: "B" }, OPTS)).rejects.toBeInstanceOf(TypeError);
  });

  it("forwards AbortSignal to fetch", async () => {
    const controller = new AbortController();
    await planTrip({ start: "A", end: "B" }, { baseUrl: BASE, signal: controller.signal });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});

describe("getCandidates", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(200, OK_CANDIDATES));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls POST /candidates", async () => {
    await getCandidates({ start: "A", end: "B" }, OPTS);
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://localhost:3001/candidates");
  });

  it("returns CandidatesApiResponse on 200", async () => {
    const result = await getCandidates({ start: "A", end: "B" }, OPTS);
    expect(result).toEqual(OK_CANDIDATES);
  });

  it("throws ApiError on non-200", async () => {
    vi.stubGlobal("fetch", mockFetch(400, { message: "bad request" }));
    await expect(getCandidates({ start: "A", end: "B" }, OPTS)).rejects.toBeInstanceOf(ApiError);
  });

  it("propagates TypeError on network failure", async () => {
    vi.stubGlobal("fetch", mockFetchNetworkError());
    await expect(getCandidates({ start: "A", end: "B" }, OPTS)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("getRoutePreview", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(200, OK_PREVIEW));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls POST /route-preview", async () => {
    await getRoutePreview({ start: "A", end: "B" }, OPTS);
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://localhost:3001/route-preview");
  });

  it("returns RoutePreviewApiResponse on 200", async () => {
    const result = await getRoutePreview({ start: "A", end: "B" }, OPTS);
    expect(result).toEqual(OK_PREVIEW);
  });

  it("throws ApiError on 408 timeout response", async () => {
    vi.stubGlobal("fetch", mockFetch(408, { message: "Route preview timed out" }));
    const caught = await getRoutePreview({ start: "A", end: "B" }, OPTS).catch((e) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(408);
  });

  it("propagates TypeError on network failure", async () => {
    vi.stubGlobal("fetch", mockFetchNetworkError());
    await expect(getRoutePreview({ start: "A", end: "B" }, OPTS)).rejects.toBeInstanceOf(TypeError);
  });
});

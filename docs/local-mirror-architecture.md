# Local mirror architecture (NREL + Overpass)

**Status:** Draft — design in progress (`/plan-eng-review` kickoff 2026-03-18).  
**Intent:** Architecture **before** implementation (see `TODOS.md` Phase 2 lanes A–D).  
**DRI:** David  

## Eng review decisions (locked — 2026-03-18)

| # | Choice | Meaning |
|---|--------|--------|
| **1A** | Doc-only A1–A5 first | No mirror ingest/runtime code until **A1–A5** are written and reviewed in this file. First code PR after that: **A3** interfaces + remote adapters only. |
| **2A** | Thin router module | Introduce a dedicated module (e.g. `api/src/sourceRouter.ts` or `api/src/planner/sourcePolicy.ts`) that **`planTrip`** calls; **avoid** growing `planTrip.ts` with mode branches. |
| **3A** | Storage in A1 | Choose mirror persistence (e.g. versioned files + manifest vs SQLite) inside **A1** with an explicit **boring-default** rationale for Synology/NAS. |
| **4A** | Valhalla out of mirror v1 | This epic **does not** include snapshotting or lifecycle for Valhalla unless **D1** explicitly expands; Valhalla stays as today’s deployment/integration. |
| **5A** | Dual-read later *(DRI-confirmed)* | **C1** dual-read/compare is **specified** in outline first; **implement** only after **local-primary + fallback** read path is working. |

Reopen only via explicit note in this doc (date + reason). **5A** reaffirmed by DRI explicitly (not default-only).

## Dependency order (do not reorder without cause)

```
A1 contracts ──► A2 errors ──► A3 provider IFs ──► A4 source router ──► A5 freshness
      │                                                      │
      └──────────────────────────┬───────────────────────────┘
                                 ▼
   B1 snapshot lifecycle ──► B2 refresh pipeline ──► B3 validation ──► B4 fallback matrix
                                 │
                                 ▼
   C1 dual-read ──► C2 promotion gates ──► C3 rollback ──► C4 observability
                                 │
                                 ▼
   D1 topology ──► D2 config/secrets ──► D3 sign-off checklist
```

## Current vs target (data flow)

**Today (simplified)**

```
Browser → POST /plan → planTrip.ts ─┬─► geocode
                                     ├─► nrelClient (HTTP)
                                     ├─► overpassClient (HTTP)
                                     └─► valhallaClient (HTTP/local)
```

**Target**

```
Browser → POST /plan → planTrip.ts
              │
              └── sourceRouter (A4) picks mode
                        │
         ┌──────────────┴──────────────┐
         ▼                             ▼
  ChargerProvider (A3)          PoiProvider (A3)
   ├─ RemoteNrelAdapter           ├─ RemoteOverpassAdapter
   └─ LocalMirrorAdapter          └─ LocalMirrorAdapter
              │                             │
              └────────► normalize to ◄─────┘
                    canonical types (A1)
```

**Valhalla (4A):** Often already local; **not** in mirror snapshot lifecycle for v1. Epic **centers on NREL + Overpass** mirrors unless D1 explicitly adds routing-graph artifacts.

## Sections (fill in order)

| ID | Section | State |
|----|---------|--------|
| A1 | Canonical schemas (charger, POI/hotel, snapshot metadata) | DONE (2026-03-19) |
| A2 | Typed error taxonomy + mapping rules | DONE (2026-03-19) |
| A3 | `ChargerProvider` / `PoiProvider` interfaces + timeout semantics | DONE (2026-03-19) |
| A4 | Source routing modes + decision tree | DONE (2026-03-19) |
| A5 | Freshness SLA + staleness behavior | DONE (2026-03-19) |
| B1 | Snapshot lifecycle (staging -> validate -> promote(active) -> archive) | DONE (2026-03-20) |
| B2 | Snapshot refresh pipeline (orchestration + restart-safety) | DONE (2026-03-20) |
| B3 | Validation gate architecture | DONE (2026-03-20) |
| B4 | Failure and fallback matrix | DONE (2026-03-20) |
| C1 | Dual-read compare architecture (v1) | DONE (2026-03-20) |
| C2 | Promotion gates to local-primary | DONE (2026-03-20) |
| C3 | Rollback architecture and incident triggers | DONE (2026-03-20) |
| C4 | Observability contract for source selection and fallback | DONE (2026-03-20) |
| D1 | Synology/Docker topology spec | DONE (2026-03-20) |
| D2 | Config and secret model | DONE (2026-03-20) |
| D3 | Architecture sign-off checklist | DONE (2026-03-20) |

## Related docs

- `LOCAL_MIRROR_CHECKPOINT.md` — **resume / handoff** snapshot (what’s done, what’s next)  
- `TODOS.md` — full task breakdown and owners  
- `TESTING.md` — invariant-based QA (must hold after rollout)  
- `PRD.md` — product requirements tied to env + invariants  

## A1 Canonical contracts + persistence default (3A)

### A1.1 Scope and normalization boundary

All mirror snapshots normalize provider payloads into a single canonical shape before write.
`RemoteNrelAdapter` and `RemoteOverpassAdapter` own provider-specific parsing; anything above
`ChargerProvider` / `PoiProvider` only consumes canonical records.

In mirror v1, A1 covers:
- chargers (from NREL),
- POI hotel records (from Overpass),
- snapshot metadata and provenance required for reads, validation, and staleness checks.

### A1.2 Canonical types (v1)

These are contracts for snapshot artifacts and local read adapters. They are intentionally close
to existing runtime shapes in `api/src/services/nrelClient.ts`, `api/src/services/overpassClient.ts`,
and `shared/types.ts` while adding required provenance.

```ts
type MirrorSchemaVersion = "1.0.0";

type CanonicalCoords = {
  lat: number;
  lon: number;
};

type ProviderSource = "nrel" | "overpass";

type CanonicalCharger = {
  entityType: "charger";
  id: string; // stable canonical id: `nrel:<providerId>`
  providerId: string; // raw provider station id when present
  source: "nrel";
  name: string;
  coords: CanonicalCoords;
  maxPowerKw?: number;
  connectorTypes?: string[]; // optional in v1; populated when source data is reliable
  network?: string;
  access?: "public" | "restricted" | "unknown";
  sourceUpdatedAt?: string; // ISO timestamp from provider if available
};

type CanonicalPoiHotel = {
  entityType: "poi_hotel";
  id: string; // stable canonical id: `overpass:<type>:<providerId>`
  providerId: string; // OSM id string
  source: "overpass";
  name: string;
  coords: CanonicalCoords;
  brand?: string;
  tourism: "hotel";
  sourceUpdatedAt?: string; // optional; Overpass objects may not expose this directly
};

type SnapshotEntityCounts = {
  chargers: number;
  poiHotels: number;
};

type CanonicalSnapshotManifest = {
  snapshotId: string; // e.g. `2026-03-19T23-15-07Z`
  schemaVersion: MirrorSchemaVersion;
  createdAt: string; // ISO timestamp, UTC
  builtBy: "snapshot-job";
  sourceWindow: {
    nrelStartedAt?: string;
    nrelCompletedAt?: string;
    overpassStartedAt?: string;
    overpassCompletedAt?: string;
  };
  counts: SnapshotEntityCounts;
  files: {
    chargers: string; // relative path to NDJSON artifact
    poiHotels: string; // relative path to NDJSON artifact
  };
  provenance: {
    nrel: {
      baseUrl: string;
      dataset: "alt-fuel-stations";
    };
    overpass: {
      baseUrl: string;
      queryFamily: "holiday-inn-express-hotel";
    };
  };
  validation: {
    passed: boolean;
    warnings: string[];
    errors: string[];
  };
};
```

### A1.3 ID and provenance rules

- Canonical IDs must be deterministic and namespaced by source.
- `CanonicalCharger.id = "nrel:" + providerId` where `providerId` comes from station id fallback logic.
- `CanonicalPoiHotel.id = "overpass:" + osmType + ":" + providerId` (`osmType` in `node|way|relation`).
- Snapshot records must always carry `source`, and manifests must include source endpoint provenance.
- Snapshot manifest is authoritative for `schemaVersion`, file pointers, and validation status.

### A1.4 Snapshot schema versioning policy

- v1 locks `schemaVersion` to semver string `"1.0.0"` in every manifest.
- Patch (`1.0.x`): non-breaking metadata additions only.
- Minor (`1.x.0`): additive optional fields in entities/manifest.
- Major (`x.0.0`): breaking field rename/remove/type changes.
- Local readers must hard-fail on unknown major version and surface a typed `SCHEMA_MISMATCH` error (A2).

### A1.5 Storage decision (3A): versioned files + manifest (boring default)

**Decision:** use append-friendly files on disk (NDJSON per entity class) plus one manifest per snapshot.
Do not use SQLite for mirror v1.

**Rationale for Synology/NAS default:**
- Minimal operational surface area (plain files, no DB locking mode or corruption recovery tuning).
- Easy inspectability and backups with standard NAS tooling.
- Atomic promotion is straightforward: write to staging dir, validate, then pointer swap to `current`.
- Works cleanly in Docker bind mounts and during local debugging with normal file utilities.
- Throughput/read requirements in v1 are modest; indexed DB complexity is premature.

**Filesystem layout (v1):**

```text
mirror/
  snapshots/
    2026-03-19T23-15-07Z/
      manifest.json
      chargers.ndjson
      poi_hotels.ndjson
  current/
    manifest.json -> ../snapshots/<snapshotId>/manifest.json
```

`current/manifest.json` is the single read entrypoint for `LocalMirrorAdapter`.
Jobs must never update `current` until validation passes for the candidate snapshot.

## A2 Typed error taxonomy + mapping rules

### A2.1 Goals

- Every provider and mirror read path surfaces failures as a **small, stable code** plus structured context (HTTP status, path, `retryAfterMs`, etc.).
- Callers (`sourceRouter`, planner) can decide **retry**, **fallback** (remote vs local), or **fail** without string-matching ad hoc messages.
- Today’s `NrelError` / `OverpassError` remain valid at the HTTP client layer; adapters map them into this taxonomy at the `ChargerProvider` / `PoiProvider` boundary (A3).

### A2.2 Canonical error shape (implementation contract)

All provider-facing errors SHOULD be instances of (or convertible to) a single type:

```ts
type SourceErrorCode =
  | "CONFIG_MISSING" // e.g. missing API key; not applicable to local-only reads
  | "REMOTE_HTTP" // non-OK HTTP from NREL/Overpass
  | "REMOTE_RATE_LIMIT" // 429 or provider-equivalent
  | "REMOTE_TIMEOUT" // abort / client timeout
  | "REMOTE_NETWORK" // DNS, connection reset, unreadable stream
  | "REMOTE_PARSE" // JSON/body parse failure or unexpected shape
  | "MIRROR_UNAVAILABLE" // mirror disabled, root path missing, or `current` broken
  | "MIRROR_MANIFEST_MISSING" // no `current/manifest.json` or empty link target
  | "MIRROR_MANIFEST_INVALID" // unreadable JSON, required fields absent
  | "MIRROR_ARTIFACT_MISSING" // manifest points at NDJSON that is not on disk
  | "MIRROR_ARTIFACT_CORRUPT" // NDJSON line parse failure / invalid record
  | "SCHEMA_MISMATCH" // unknown or unsupported `schemaVersion` in manifest (see A1.4)
  | "SNAPSHOT_INVALID" // manifest `validation.passed === false` or incompatible state
  | "STALE_SNAPSHOT" // mirror data older than policy allows (see A5; code defined here for typing)
  | "INTERNAL"; // invariant violated after mapping; should be rare

type SourceError = Error & {
  code: SourceErrorCode;
  source: "nrel" | "overpass" | "mirror";
  retryable: boolean;
  /** Hint for A4: try the other tier if this mode was primary. */
  fallbackSuggested?: boolean;
  cause?: unknown;
  context?: Record<string, unknown>;
};
```

- **`retryable`:** safe to retry the **same** call with backoff (rate limits, transient network, optional 5xx — see mapping tables).
- **`fallbackSuggested`:** transient or “best effort exhausted” on the path that was tried; router may attempt the alternate mode per **A4** (not yet specified).

### A2.3 Severity (observability)

| Level | Meaning |
| --- | --- |
| **fatal** | Do not retry same request without user/config change (`CONFIG_MISSING`, `SCHEMA_MISMATCH` for reader, unrecoverable `SNAPSHOT_INVALID`). |
| **retryable** | Backoff and retry (`REMOTE_RATE_LIMIT`, `REMOTE_NETWORK`, some `REMOTE_HTTP`). |
| **degraded** | May return partial/empty or switch source (`STALE_SNAPSHOT` when policy allows remote fallback — A5). |

### A2.4 Mapping: NREL (`NrelError` / `fetchDcFast*` / `fetchElectric*`)

| Condition | `code` | `retryable` | `fallbackSuggested` | Notes |
| --- | --- | --- | --- | --- |
| Missing `NREL_API_KEY` | `CONFIG_MISSING` | false | true if mirror may serve chargers | Message today: `"Missing NREL_API_KEY env var"` |
| `resp.status === 429` | `REMOTE_RATE_LIMIT` | true | true | Honor `Retry-After` when present → put delta ms in `context.retryAfterMs` |
| `resp.status` in **5xx** | `REMOTE_HTTP` | true | true | Exponential backoff; cap attempts (existing env) |
| `resp.status` in **4xx** (except 429) | `REMOTE_HTTP` | false | true | Likely client/config; do not spin forever |
| `!resp.ok` after retries exhausted | `REMOTE_HTTP` | false | true | Preserve last `status` in `context.httpStatus` |
| `fetch` throws (network) | `REMOTE_NETWORK` | true | true | E.g. `ECONNRESET`, `ENOTFOUND` |
| `AbortSignal` / timeout | `REMOTE_TIMEOUT` | true | true | If/when timeouts wrap fetch (A3) |
| `resp.json()` or body parse fails | `REMOTE_PARSE` | false | true | Include snippet or length in `context` (no secrets) |

### A2.5 Mapping: Overpass (`OverpassError` / `findHolidayInnExpressNearby`)

| Condition | `code` | `retryable` | `fallbackSuggested` | Notes |
| --- | --- | --- | --- | --- |
| `resp.status === 429` | `REMOTE_RATE_LIMIT` | true | true | Same backoff semantics as NREL |
| `resp.status` ≥ **500** | `REMOTE_HTTP` | true | true | Transient server / overload |
| `resp.status` in **4xx** (not 429) | `REMOTE_HTTP` | false | true | Today message: `Overpass request failed (${status})` |
| Loop exits after retries; last failure was network | `REMOTE_NETWORK` | true | true | Today wraps last error in `OverpassError` |
| Loop exits after retries; last failure was HTTP | use row above for that status | per row | true | |
| JSON parse / body unreadable | `REMOTE_PARSE` | false | true | Empty `elements` is **success** (empty list), not parse error |

### A2.6 Mapping: local mirror (`LocalMirrorAdapter`)

Assume read path: resolve `mirror/current/manifest.json` → validate → open NDJSON per query.

| Condition | `code` | `retryable` | `fallbackSuggested` | Notes |
| --- | --- | --- | --- | --- |
| Mirror root unset or not a directory | `MIRROR_UNAVAILABLE` | false | true | Router tries remote if allowed |
| `current/manifest.json` missing | `MIRROR_MANIFEST_MISSING` | false | true | |
| Manifest not valid JSON / required keys missing | `MIRROR_MANIFEST_INVALID` | false | false* | *Fallback only if remote allowed; bad deploy/staging |
| `schemaVersion` not semver or major ≠ supported | `SCHEMA_MISMATCH` | false | true | A1.4 |
| `validation.passed === false` | `SNAPSHOT_INVALID` | false | true | Operational choice: never promote bad snapshots (B-track); reader still defines behavior if file hand-edited |
| Manifest `files.*` path missing on disk | `MIRROR_ARTIFACT_MISSING` | false | true | |
| NDJSON line invalid / record fails A1 shape | `MIRROR_ARTIFACT_CORRUPT` | false | false* | Log + alert; may warrant failing the whole read |
| Read I/O error after open | `MIRROR_UNAVAILABLE` | true | true | NAS glitch — limited retries OK |
| Age vs freshness policy (A5) exceeded | `STALE_SNAPSHOT` | false | true | Exact SLA in A5 |

### A2.7 Mapping: HTTP fetch (shared)

Use **§A2.4 / A2.5** by caller `source`. For generic `TypeError` during `fetch` (invalid URL in tests), map to `INTERNAL` with `retryable: false`.

### A2.8 Relationship to today’s API responses

Until A3/A4 land, `planTrip` continues to return `status: "error"` with `message` from `Error.message`. After provider interfaces adopt `SourceError`, the HTTP layer MAY expose `code` in `debug` for clients without breaking the MVP shape in `shared/types.ts`.

### A2.9 Open points (resolved in later sections)

- **Exact staleness thresholds and automatic fallback** — **A5**.
- **Which codes increment metrics / trigger paging** — **C4**.

## A3 `ChargerProvider` / `PoiProvider` interfaces + timeout semantics

### A3.1 Goals

- **`planTrip`** (and future callers) depend only on these two interfaces, not on `nrelClient` / `overpassClient` directly.
- Implementations: **`RemoteNrelAdapter` + `RemoteOverpassAdapter`** (HTTP, first code slice after doc gate **1A**) and **`LocalMirrorAdapter`** (two facets: chargers + POI) — all return **A1 canonical** records.
- Failures surface as **`SourceError`** (A2) at the interface boundary; adapters map `NrelError` / `OverpassError` / I/O into codes.

### A3.2 Shared types

```ts
/** WGS84; same meaning as `shared/types.ts` / `api/src/types`. */
type LatLng = { lat: number; lon: number };

/**
 * Per-call options. Callers pass `requestId` for structured logs;
 * `sourceRouter` (A4) threads it from the HTTP layer.
 */
type ProviderCallOptions = {
  requestId?: string;
  /**
   * Parent cancellation (client disconnect, planner outer abort).
   * Adapters MUST combine with their own timeout controller (see A3.4).
   */
  signal?: AbortSignal;
  /**
   * Hard cap for this call. If omitted, use default per source (env, A3.4).
   */
  timeoutMs?: number;
};

/** Matches today’s `fetchDcFastChargersNearPoint` vs `fetchElectricChargersNearPoint`. */
type ChargerPointMode = "dc_fast" | "electric_all";
```

### A3.3 `ChargerProvider`

Maps to current NREL usage in `planTrip`: point queries along a corridor (possibly many calls), optional **nearby-route** corridor query, and DC-fast vs all-electric mode.

```ts
type ChargerProvider = {
  /**
   * Nearest-station query around a single point (`nearest.json` family).
   * Empty array = success (no stations), not an error.
   */
  findChargersNearPoint(
    point: LatLng,
    radiusMiles: number,
    mode: ChargerPointMode,
    opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]>;

  /**
   * Stations near a route polyline (`nearby-route.json` family).
   * `routePoints.length < 2` → adapters return `[]` without calling upstream (matches current behavior).
   */
  findChargersNearRoute(
    routePoints: LatLng[],
    corridorMiles: number,
    mode: ChargerPointMode,
    opts?: ProviderCallOptions
  ): Promise<CanonicalCharger[]>;
};
```

**Notes**

- **Deduping:** Remote adapter SHOULD preserve today’s dedupe-by-lat-lon behavior before returning; mirror adapter SHOULD return at most one canonical row per `CanonicalCharger.id`.
- **`mode` on `findChargersNearPoint`:** Must honor `dc_fast` vs `electric_all` (same as today’s `fetchDcFastChargersNearPoint` vs `fetchElectricChargersNearPoint`).
- **`mode` on `findChargersNearRoute`:** NREL **nearby-route** path in code is **DC-fast only** (`fetchDcFastChargersNearRoute`). If `electric_all` is requested, remote adapter SHOULD treat it as **DC-fast** (and MAY log once per request) until a real route query exists; mirror adapter follows whatever the snapshot contains (typically aligned with job config).
- **Normalization:** Responses MUST match **A1** `CanonicalCharger` (including `entityType: "charger"` and `id` / `providerId`).

### A3.4 `PoiProvider`

Maps to `findHolidayInnExpressNearby` (Overpass). v1 scope: **Holiday Inn Express** hotels only; future POI types = new methods or extended query enum (breaking only if A1 entity set changes).

```ts
type PoiProvider = {
  /**
   * Hotels matching the MVP Overpass query family (see A1 manifest `queryFamily`).
   * Empty array = success.
   */
  findHolidayInnExpressHotelsNearPoint(
    point: LatLng,
    radiusMeters: number,
    opts?: ProviderCallOptions
  ): Promise<CanonicalPoiHotel[]>;
};
```

**Normalization:** Responses MUST match **A1** `CanonicalPoiHotel`.

### A3.5 Timeout and `AbortSignal` semantics

| Source | Default `timeoutMs` (if `opts.timeoutMs` omitted) | Env var (proposal) |
| --- | --- | --- |
| NREL HTTP | `60000` | `NREL_FETCH_TIMEOUT_MS` |
| Overpass HTTP | `60000` | `OVERPASS_FETCH_TIMEOUT_MS` |
| Local mirror read | `30000` | `MIRROR_READ_TIMEOUT_MS` |

**Rules**

1. Each async method builds an **`AbortController`** for the deadline: `timeout = opts.timeoutMs ?? defaultForSource`.
2. If **`opts.signal`** is provided, **`abort()`** the combined controller when either parent aborts **or** timeout fires.
3. On timeout → throw **`SourceError`** with `code: "REMOTE_TIMEOUT"` (HTTP) or **`REMOTE_TIMEOUT`** vs **`MIRROR_UNAVAILABLE`** for mirror: mirror slow path uses **`REMOTE_TIMEOUT`** if we treat mirror as a read deadline (recommended for consistency), with `source: "mirror"`.
4. **Retries:** Only **inside** remote adapters (existing NREL/Overpass retry loops). Timeouts apply to **each** attempt or to the whole operation — **whole operation** is recommended so a single call cannot exceed `timeoutMs` wall clock. (Implementations may document sub-budget for connect vs body.)
5. **Overpass query `[timeout:…]`** in the QL string is server-side; HTTP fetch timeout is separate and MUST still be set (today there is no fetch timeout; A3 adds one).

### A3.6 Wiring (see A4)

- **`planTrip`** receives `deps: { chargers: ChargerProvider; pois: PoiProvider }` from composition root — resolved by **`resolvePlanProviders`** (A4) from config + `requestId`.
- First implementation PR: **`RemoteNrelAdapter`** implements `ChargerProvider` by delegating to existing `nrelClient` functions, then mapping rows → `CanonicalCharger` + `SourceError` on failure. Same for **`RemoteOverpassAdapter`** ↔ `overpassClient`.

### A3.7 Non-goals (v1)

- Spatial indexing inside `LocalMirrorAdapter` (acceptable v1: linear scan + filter with caps; optimize in B-track if needed).
- Batching or streaming NDJSON in the interface signature (implementations may stream internally).

## A4 Source routing modes + decision tree

### A4.1 Goals

- **Single policy module** (per **2A**) chooses implementations for **`ChargerProvider`** and **`PoiProvider`** per request — **`planTrip`** stays free of `if (mirror) …` branches.
- Behavior is **deterministic** given `(mode, env, mirror state)` and documented in test matrices (**TODOS.md** Phase 2 exit criteria).
- **5A:** **`dual_read_compare`** is **specified here**; **implementation** waits until **`local_primary_fallback_remote`** is working end-to-end (read + fallback + metrics).

### A4.2 Routing modes

```ts
/**
 * Global runtime mode for NREL + Overpass-backed providers (v1: one knob for both dimensions).
 */
type SourceRoutingMode =
  /** Today’s behavior: HTTP only. Safe default. */
  | "remote_only"
  /**
   * Try local mirror first; on failure or policy trigger, fall back to remote.
   * Exact “stale” handling uses A5 in addition to A2 codes.
   */
  | "local_primary_fallback_remote"
  /**
   * Mirror only — no remote fallback for charger/POI reads (**ROUTING_UX_SPEC** §2 fail-closed).
   * Implemented in `api/src/sourceRouter.ts` as direct `LocalMirrorAdapter` wiring.
   */
  | "local_primary_fail_closed"
  /**
   * Call mirror + remote, compare results, return one “primary” response (see A4.6).
   * Outlined for C1; do not ship before local-primary path is stable (**5A**).
   */
  | "dual_read_compare";
```

**v1 default:** `remote_only`. Changing default is an explicit ops decision after mirror readiness.

### A4.3 Configuration

| Env (proposal) | Values | Notes |
| --- | --- | --- |
| `SOURCE_ROUTING_MODE` | `remote_only` \| `local_primary_fallback_remote` \| `local_primary_fail_closed` \| `dual_read_compare` | Invalid value → treat as `remote_only` and log **once per process** at startup + structured warn per request (implementation choice; must be testable). |
| `MIRROR_ROOT` | absolute or container path | Root containing `current/manifest.json` (A1). Ignored when mode is `remote_only` unless adapters still probe — **recommended:** skip mirror entirely when `remote_only`. |

**Future (non-blocking):** split knobs `CHARGER_SOURCE_ROUTING_MODE` / `POI_SOURCE_ROUTING_MODE` if product needs asymmetric rollout; v1 keeps **one** mode for both.

### A4.4 Factory surface (composition root)

```ts
type PlanProviderBundle = {
  chargers: ChargerProvider;
  pois: PoiProvider;
  /** For logs/debug: active mode, snapshot id when mirror participated */
  meta: {
    mode: SourceRoutingMode;
    mirrorSnapshotId?: string;
    mirrorSchemaVersion?: string;
  };
};

/**
 * Called once per `/plan` request (or cached per process if deps are stateless — either is fine).
 */
function resolvePlanProviders(input: {
  mode: SourceRoutingMode;
  requestId: string;
  signal?: AbortSignal;
}): PlanProviderBundle;
```

Implementation lives in e.g. `api/src/sourceRouter.ts` (or `sourcePolicy.ts`) and constructs concrete adapters + **decorators** that implement the mode (below).

### A4.5 Decision tree by mode

#### `remote_only`

1. `chargers` = `RemoteNrelAdapter`
2. `pois` = `RemoteOverpassAdapter`
3. No mirror I/O.

#### `local_primary_fallback_remote`

For **each** interface method invocation:

1. Invoke **`LocalMirrorAdapter`** with the same args + `ProviderCallOptions` (A3).
2. **If the call returns** `Canonical*` array → return it (including **empty** — empty is a valid outcome; do not treat as mirror failure).
3. **If the call throws `SourceError`:**
   - If `code === "STALE_SNAPSHOT"` → apply **A5** policy (may still fall back or fail fast).
   - Else if **`fallbackSuggested === true`** (A2) **or** code is in the **fallback allow-list** below → invoke **remote** adapter once for the same call and return its result or propagate its error.
   - Else → **rethrow** (no silent remote rescue for “hard” mirror/config errors if product chooses strictness; default **allow-list** favors user success: mirror infra broken → try remote).

**Fallback allow-list (default):**  
`CONFIG_MISSING` (remote may still fail — try anyway only if mirror failed for unrelated reasons; typically NREL key exists), `REMOTE_*` (should not come from mirror), `MIRROR_UNAVAILABLE`, `MIRROR_MANIFEST_MISSING`, `MIRROR_MANIFEST_INVALID`, `MIRROR_ARTIFACT_MISSING`, `MIRROR_ARTIFACT_CORRUPT`, `SCHEMA_MISMATCH`, `SNAPSHOT_INVALID`, `STALE_SNAPSHOT` (subject to A5), `REMOTE_TIMEOUT` when `source === "mirror"`.

**Do not fall back** when the error is judged **non-transient and operator-fixable** without remote (optional strict flag later, **D2**): e.g. `SCHEMA_MISMATCH` after an intentional major bump might prefer fail-fast — v1 **still falls back** to remote so `/plan` keeps working during rollout.

#### `local_primary_fail_closed`

1. `chargers` = **`LocalMirrorAdapter`** (no decorator; no remote attempt on throw).
2. `pois` = **`LocalMirrorAdapter`**.
3. **ROUTING_UX_SPEC** §2: mirror missing/corrupt/unusable → **`SourceError`** surfaces to `planTrip` / HTTP **400** with actionable message — **no** silent NREL/Overpass fallback.

#### `dual_read_compare` (**specified, not implemented yet**)

1. Run **mirror** and **remote** calls **in parallel** (or mirror-first with tight budget — product choice; parallel reduces tail latency).
2. **Primary result** returned to planner: **mirror** if mirror succeeded without throw; else **remote**; if both fail → propagate “best” error (prefer `SourceError` from mirror if it explains missing data, else remote).
3. **Compare** canonical sets (id sets + optional geo diff): emit structured log / metric row with `requestId`, counts, hash of ids, max distance drift — details in **C1**.
4. **No blocking:** mismatches do **not** fail the user request in v1 of this mode (observability only), unless a future **promotion gate** flips that (**C2**).

### A4.6 End-to-end flow (local-primary)

```mermaid
flowchart TD
  call[Provider method called]
  mode{SOURCE_ROUTING_MODE}
  remoteOnly[Remote adapter only]
  dual[Dual read C1 path]
  local[LocalMirrorAdapter]
  ok{threw?}
  stale{STALE_SNAPSHOT?}
  policy[A5 staleness policy]
  fb{fallbackSuggested or allow list}
  rem[Remote adapter]
  retOk[Return data]
  retErr[Rethrow SourceError]
  call --> mode
  mode -->|remote_only| remoteOnly --> retOk
  mode -->|dual_read_compare| dual
  mode -->|local_primary_fallback_remote| local
  local --> ok
  ok -->|no| retOk
  ok -->|yes| stale
  stale -->|yes| policy
  stale -->|no| fb
  policy --> fb
  fb -->|yes| rem --> retOk
  fb -->|no| retErr
```

### A4.7 Relationship to freshness (A5)

- Router **must** pass enough context for mirror adapter to evaluate age vs SLA (e.g. read `createdAt` from manifest once per bundle construction and attach to `meta`).
- **`STALE_SNAPSHOT`** thresholds and fallback vs fail-fast — **§A5**.

### A4.8 Observability (preview of C4)

Each `/plan` SHOULD log (structured JSON, `requestId`):

- `sourceRoutingMode`
- `mirrorSnapshotId` / `mirrorSchemaVersion` when mirror was consulted
- per provider tier used: `chargers: "remote" | "mirror" | "dual"` (dual only in compare mode)
- `fallbackReason` when local-primary took remote path (A2 `code` + short message)

### A4.9 Non-goals (v1 router)

- Per-leg or per-corridor-sample routing mode changes inside one `planTrip` (whole request uses one bundle).
- Automatic mode self-tuning (ops changes `SOURCE_ROUTING_MODE`).

## A5 Freshness SLA + staleness behavior

### A5.1 Goals

- Treat **mirror freshness** as a first-class signal: “available” is not enough if data is too old for the product’s trust bar.
- Define **one clock** and **one age computation** shared by charger + POI facets (single manifest per snapshot, **A1**).
- Make **`STALE_SNAPSHOT`** behavior **deterministic** for `local_primary_fallback_remote` (A4) and testable (`mode × stale` matrix in **TODOS.md**).

### A5.2 Authoritative timestamp

- **Freshness age** = `nowUtc - manifest.createdAt` where `manifest` is the resolved **`current`** manifest (A1 `CanonicalSnapshotManifest`).
- **`createdAt`** MUST be ISO-8601 UTC with `Z` suffix in snapshots; readers parse with `Date` (or equivalent) in **UTC** only.
- **Skew:** comparison uses the **API process clock**; NAS and API hosts SHOULD use NTP (**D1**). If clocks are wrong, staleness is wrong — operational, not planner logic.

### A5.3 SLA parameters (env)

| Env (proposal) | Default | Meaning |
| --- | --- | --- |
| `MIRROR_MAX_AGE_HOURS` | `840` | **35 days** — max acceptable age of `createdAt` before the snapshot is **stale** for routing. *(Monthly refresh + ~1 week grace; tune with ops.)* |
| `STALE_SNAPSHOT_POLICY` | `fallback_remote` | When stale: `fallback_remote` → throw `SourceError` `STALE_SNAPSHOT` with `fallbackSuggested: true` so A4 local-primary path tries remote; `fail` → throw `STALE_SNAPSHOT` with `fallbackSuggested: false` (no remote rescue). |

**Notes**

- **`remote_only`:** does not read mirror — **no staleness check** (NREL/Overpass freshness is out of scope for A5).
- **`dual_read_compare`:** still evaluates mirror staleness for logging/metrics; primary selection follows **A4** (mirror wins if call succeeds — stale mirror may still be used for comparison only until C1 tightens; see **A5.5**).

### A5.4 When `LocalMirrorAdapter` throws `STALE_SNAPSHOT`

After manifest load + schema validation (A1/A2), **before** returning NDJSON rows:

1. Parse `createdAt`.
2. If `ageHours > MIRROR_MAX_AGE_HOURS` → throw **`SourceError`** with `code: "STALE_SNAPSHOT"`, `source: "mirror"`, `retryable: false`, `fallbackSuggested: true` **iff** `STALE_SNAPSHOT_POLICY=fallback_remote`.
3. Include in `context`: `{ manifestCreatedAt, ageHours, maxAgeHours: env }`.

**Invalid or missing `createdAt`:** treat as **`MIRROR_MANIFEST_INVALID`** (not stale) — fail mirror path; A4 may fall back per existing allow-list.

### A5.5 Interaction with routing modes (A4)

| Mode | Stale mirror behavior |
| --- | --- |
| `remote_only` | N/A |
| `local_primary_fallback_remote` | If `STALE_SNAPSHOT` and `fallbackSuggested` → **remote**; if `fail` policy → **surface error** to planner (same as other non-fallback `SourceError`). |
| `dual_read_compare` | **v1 doc:** still run mirror read for compare if implementation allows; **prefer** tagging logs with `mirrorStale: true` and age. Cutting off stale mirror data entirely in this mode is **C1** — default is **do not block** user response on staleness in dual-read v1. |

### A5.6 Promotion vs runtime (B-track preview)

- **B3** promotion gates SHOULD reject snapshots that are already **older than SLA** before `current` pointer moves (stricter than runtime is optional).
- Runtime A5 protects **already-promoted** active snapshots that **aged out** before the next refresh.

### A5.7 Observability

- Log `mirrorSnapshotAgeHours`, `mirrorMaxAgeHours`, `staleSnapshotPolicy` when mirror is consulted.
- Increment counter / alert when **`STALE_SNAPSHOT`** fires in **`fail`** policy (ops may need refresh).

### A5.8 Non-goals (v1)

- Per-source freshness inside one snapshot (single `createdAt` for NREL + Overpass ingest).
- **SLA** on remote provider data freshness.

## B1 Snapshot lifecycle (atomic promotion)

### B1.1 Goals

- Ensure the planner’s read path never observes partial/corrupt mirror state.
- Make snapshot promotion **atomic** by updating only the `current/` pointer after a snapshot is fully written and validated.
- Keep snapshots **immutable after promotion** (no in-place edits to promoted artifacts).
- Support safe rollback later by preserving at least the currently-active and previously-active snapshots long enough for C3.

### B1.2 Snapshot directory contract (matches A1)

Mirror snapshots are written under `mirror/snapshots/<snapshotId>/` and become “active” only when `mirror/current/manifest.json` points to that snapshot’s `manifest.json`.

The doc uses the v1 layout from A1:

```text
mirror/
  snapshots/
    <snapshotId>/
      manifest.json
      chargers.ndjson
      poi_hotels.ndjson
  current/
    manifest.json -> ../snapshots/<snapshotId>/manifest.json
```

For B1, define an operational rule:

1. The refresh job writes all artifacts and runs validation in `<snapshotId>/...` first.
2. Only after validation passes, the job updates `mirror/current/manifest.json` in a single atomic promotion step.
3. After promotion, `<snapshotId>/...` is treated as read-only (no further writes).

### B1.3 Staging -> validate -> promote -> archive

#### 1) Staging (write phase, not externally visible)

When a refresh starts:

- Pick a unique `snapshotId` (e.g. `2026-03-19T23-15-07Z`).
- Create `mirror/snapshots/<snapshotId>/` and write provider facets to files:
  - `chargers.ndjson`
  - `poi_hotels.ndjson`
- Generate `manifest.json` containing:
  - `schemaVersion` (A1),
  - `createdAt` (used by A5 freshness),
  - `files.*` pointers to the NDJSON artifacts,
  - `validation` fields initially set to `passed: false` (or omitted until final report).

At this point, the snapshot is **not active** because `mirror/current/` still points to the previous snapshot.

#### 2) Validate (gate, B3 owns exact checks)

Run validation against the just-written snapshot directory:

- Ensure schema compatibility (`manifest.schemaVersion` in supported set, A1.4).
- Ensure manifest references files that exist and are parseable.
- Perform data sanity checks appropriate for v1 (B3 details later).

If validation fails:

- Do NOT promote (leave `mirror/current/` unchanged).
- Update the candidate snapshot’s `manifest.json.validation` to include errors/warnings for debugging.
- Optionally stop early on fatal validation categories (e.g. corrupt NDJSON).

#### 3) Promote (atomic pointer switch)

Promotion is a single atomic operation that updates `mirror/current/manifest.json` to point to the candidate snapshot’s manifest.

Atomic promotion rules:

- Write the promotion target (e.g. symlink target or pointer file contents) to a temp path first.
- Switch into place with a single atomic operation:
  - POSIX: `rename()` temp -> `current/manifest.json`
  - Symlink replacement should also be implemented via atomic rename to avoid transient “missing pointer” windows.
- After promotion, `mirror/current/manifest.json` must never point to a snapshot whose `manifest.validation.passed` is false.

#### 4) Archive (retention + rollback safety)

After promotion:

- Retain:
  - the newly-promoted snapshot,
  - at least the previously-active snapshot (for C3 rollback safety).
- Optionally delete older snapshots beyond a retention horizon once rollback safety is satisfied.

Archive is intentionally separate from promotion so a failed refresh never deletes the last known-good snapshot.

### B1.4 Failure modes and operator behavior

- Provider failures during staging (NREL/Overpass unreachable, timeouts, parse issues) never affect runtime because promotion does not occur.
- Validation failures never affect runtime because `current/` is unchanged.
- Refresh jobs must emit structured logs with the `snapshotId` and whether promotion was executed (ties into C4 observability later).

### B1.5 Concurrency and idempotency (v1 policy)

To prevent multiple refresh jobs from racing promotions:

- Use a lock (e.g. a lock file in `mirror/current/` or a container-level single-flight) so only one refresh can run at a time.

Idempotency:

- Prefer “create new `snapshotId` per run” (simple and avoids partial-state reuse).
- If a snapshotId directory already exists, treat it as a rerun and either:
  - reuse artifacts if validation already passed, or
  - delete and rewrite (policy choice; must be consistent and logged).

## B2 Snapshot refresh pipeline (monthly orchestration + restart-safety)

### B2.1 Scope

This section defines how the mirror refresh job runs on a schedule (monthly by default),
how it is restarted safely, and what it does on partial failures.

It explicitly covers:
- choosing a candidate `snapshotId`,
- executing remote fetches to generate artifacts,
- running the gate that updates `manifest.json.validation`,
- performing the atomic promotion step from **B1**,
- retention/cleanup policy handoff.

It does NOT define entity-level validation details; **B3** owns the exact checks.

### B2.2 Operating assumptions (v1)

- Mirror reads by the planner use `mirror/current/manifest.json` only; refresh jobs must not modify `current` until validation is complete (**B1**).
- Remote provider fetching for snapshot jobs uses the remote adapters (NREL + Overpass) and maps into A1 canonical records (via A3).
- A refresh job can be interrupted at any time (process crash, container restart, NAS hiccup) and must be safe to run again.

### B2.3 Pipeline states (restart-friendly)

Define a simple state machine persisted in the candidate snapshot directory:

```text
mirror/snapshots/<snapshotId>/
  manifest.json
  chargers.ndjson
  poi_hotels.ndjson
  refresh.state.json   // contains state enum + timestamps (optional but recommended)
```

State enums (proposal):

- `starting`
- `fetching_nrel`
- `fetching_overpass`
- `finalizing_manifest`
- `validating`
- `promoting`
- `archiving`
- `done`
- `failed`

On restart:
- the job checks whether `refresh.state.json` exists,
- resumes from the last known state when it can safely do so,
- otherwise rewrites missing/incomplete artifacts and recomputes.

### B2.4 Scheduling and lock

- Default schedule: monthly (ops-owned); implementation should also support manual trigger.
- Concurrency control: acquire an exclusive lock before starting:
  - recommended: file lock in `mirror/current/refresh.lock` (or equivalent) so only one refresh can run.
- If lock acquisition fails:
  - either exit with a structured log (no-op), or
  - wait up to a short budget and then exit; avoid long hanging.

### B2.5 Choosing `snapshotId` and idempotency policy

Two acceptable v1 policies:

1. **Time-based unique `snapshotId` per run** (recommended)
   - Candidate `snapshotId` derived from UTC timestamp.
   - Retry-safe because a crash just leaves an unfinished candidate directory; the next run creates a new `snapshotId`.

2. **Deterministic `snapshotId` per month**
   - Candidate `snapshotId` derived from `(year, month)`; repeat runs in the same month rewrite/overwrite candidate artifacts.
   - Useful if you want strict “one snapshot per month” behavior.

In both cases:
- if the candidate snapshot already has a manifest with `validation.passed === true`,
  treat it as already-successful and proceed directly to promotion (or skip promotion if `current` already points there).
- if validation was previously marked failed, do NOT promote; rewrite artifacts and re-validate if you choose automatic retry.

### B2.6 Artifact generation (remote fetch phase)

For each interface:

1. Instantiate remote providers:
   - `RemoteNrelAdapter` for chargers
   - `RemoteOverpassAdapter` for POI hotels
2. Compute the query inputs:
   - chargers: corridor points from existing planner logic are *not* available in this job; v1 can use a conservative bounding strategy (TBD in B2/B3 depending on how you seed the mirror).
   - POI hotels: same region seed strategy as chargers.
3. Call provider interfaces using `ProviderCallOptions`:
   - pass `timeoutMs` and `signal` (A3)
   - ensure the overall job has its own hard cap (e.g. 30–60 minutes) so it cannot run forever
4. Write canonical records to `chargers.ndjson` and `poi_hotels.ndjson` in the candidate snapshot directory.

Important v1 rule:
- If remote fetch fails for either facet, the job must transition to `failed` and exit without promotion.

### B2.7 Manifest finalization (pre-validation)

Before validation:

- generate `manifest.json` with:
  - `schemaVersion` (A1.4)
  - `snapshotId`
  - `createdAt` (A5.2)
  - `files.*` pointers
  - `sourceWindow` times if available
  - `validation` block initially set to `passed: false` and warnings/errors empty

Then transition to `validating`.

### B2.8 Validation gate and promotion

- Run the **B3 validation** checks against the candidate snapshot directory.
- If `validation.passed === true`:
  - transition to `promoting`,
  - perform the atomic `current/manifest.json` pointer update (**B1**).
- If validation fails:
  - transition to `failed`,
  - do not change `current`.

### B2.9 Archive and retention

After successful promotion:

- keep:
  - the newly promoted snapshot,
  - at least the previously-active snapshot.
- optionally delete older snapshots beyond retention horizon.

Retention horizon is an ops knob; v1 can start with “keep last 2 only”.

### B2.10 Failure handling policy

The refresh job should be strict:
- never promote on any failure during fetch or validation,
- always emit a structured log row containing:
  - `snapshotId`,
  - `state`,
  - failure `code` (from A2 mapping where possible),
  - facet (`chargers` vs `poiHotels`),
  - last HTTP status / retry-after when present.

### B2.11 Observability (C4 preview)

Minimum log fields emitted per run:
- `snapshotJobId` (can equal `snapshotId`),
- `snapshotId`,
- `state`,
- `facet` for provider steps,
- durations for each stage (fetch nrel, fetch overpass, validate, promote),
- promotion result:
  - `promoted: true/false`
  - `currentSnapshotId` after promotion.

Metrics (optional v1):
- counters for promotion success/failure,
- histogram of fetch and validation durations.

## B3 Validation gate architecture (data sanity + promotion criteria)

### B3.1 Goals

- Validate that a candidate snapshot is internally consistent and matches **A1** canonical contracts.
- Decide `manifest.validation.passed` deterministically and reproducibly.
- Fail closed: when validation fails, **never** promote `current/` (promotion is controlled by **B1**).
- Enforce promotion-time freshness: a snapshot that is already older than the SLA MUST be rejected (ties to **A5**).

### B3.2 Validation inputs and outputs

Inputs:
- candidate snapshot directory:
  - `mirror/snapshots/<snapshotId>/manifest.json`
  - `chargers.ndjson`
  - `poi_hotels.ndjson`

Outputs:
- update `manifest.json.validation`:
  - `passed: boolean`
  - `warnings: string[]`
  - `errors: string[]`

If validation fails, `manifest.json.validation.passed` is false and **B2 must not promote**.

### B3.3 What B3 must validate (v1)

#### 1) Manifest structure and schema compatibility

Validate:
- `manifest.schemaVersion` is present and matches supported set (**A1.4**).
  - Unknown major => fail with `SCHEMA_MISMATCH`-class error.
- `manifest.createdAt` is present and parseable as UTC ISO timestamp (**A5.2**).
- `manifest.files.chargers` and `manifest.files.poiHotels` resolve to existing files.

Checks:
- Manifest points at exactly one chargers artifact and one poiHotels artifact (no missing/empty pointers).

#### 2) Freshness / SLA promotion gate

- Compute `ageHours = nowUtc - manifest.createdAt` (**A5.2**).
- If `ageHours > MIRROR_MAX_AGE_HOURS`:
  - validation must fail (do not promote).
  - record an error like: `STALE_SNAPSHOT: ageHours=<...> > maxAgeHours=<...>`.

Rationale:
- This is stricter than runtime “stale handling” (**A5**) because promotion is what determines what the planner can read.

#### 3) Entity canonical-shape validation for NDJSON artifacts

For each line in `chargers.ndjson`:
- parse JSON successfully; otherwise error `MIRROR_ARTIFACT_CORRUPT`.
- validate required fields for **A1** `CanonicalCharger`:
  - `entityType === "charger"`
  - `id` is present and namespaced (must begin with `nrel:` in v1)
  - `source === "nrel"`
  - `coords.lat` and `coords.lon` are numbers within valid ranges (`[-90, 90]`, `[-180, 180]`)
- validate optional fields if present:
  - `maxPowerKw` is a finite number > 0
  - other optional fields are correct types

For each line in `poi_hotels.ndjson`:
- parse JSON successfully; otherwise error `MIRROR_ARTIFACT_CORRUPT`.
- validate required fields for **A1** `CanonicalPoiHotel`:
  - `entityType === "poi_hotel"`
  - `id` present and namespaced (must begin with `overpass:` in v1)
  - `source === "overpass"`
  - `tourism === "hotel"`
  - `coords.lat/lon` valid ranges

Deduping rules (read-model invariants):
- `CanonicalCharger.id` must be unique within the snapshot.
- `CanonicalPoiHotel.id` must be unique within the snapshot.
- duplicates => fail validation (or convert to warnings if product later chooses “last write wins”; v1 should fail to preserve determinism).

#### 4) Count sanity checks

Compute:
- `chargersCount` = number of distinct charger ids observed.
- `poiHotelsCount` = number of distinct poi hotel ids observed.

Validate vs manifest:
- if `manifest.counts` exists:
  - mismatch => warning by default; fail only if mismatch is extreme (tunable rule).

#### 5) Determinism and “no side effects”

- B3 MUST NOT perform network I/O.
- B3 MUST be deterministic: given the same candidate snapshot artifacts, it should produce the same validation result.

### B3.4 Warning vs error policy

Proposed policy for v1:
- **Errors** (validation fails):
  - manifest missing required keys
  - unknown schema major
  - `createdAt` unparsable
  - missing NDJSON files or unreadable artifacts
  - NDJSON line parse failures
  - canonical-shape required-field violations
  - duplicate ids
  - SLA-age already stale
- **Warnings** (validation passes):
  - `manifest.counts` mismatch within tolerance
  - optional fields missing (e.g. `maxPowerKw`) if still valid per A1
  - extra/unknown fields in entity records (if JSON parsing accepts them)

### B3.5 Concurrency and idempotency

- B3 writes only into `manifest.json.validation` for the candidate snapshot directory.
- If B3 is rerun after a partial failure:
  - it should overwrite prior `manifest.validation.*` to keep results consistent with current artifacts.

### B3.6 Observability hooks (C4 preview)

Emit structured logs with:
- `snapshotId`
- `validationDurationMs`
- `passed: true/false`
- `warningsCount`, `errorsCount`
- `ageHours` and `maxAgeHours`

The refresh job (B2) uses these logs to decide whether promotion is allowed.

## B4 Failure and fallback matrix (deterministic runtime outcomes)

### B4.1 Purpose

Make fallback behavior **fully deterministic** given:
- the active **routing mode** (**A4**),
- the adapter-thrown **`SourceError.code`** (**A2**),
- the freshness policy behavior for **`STALE_SNAPSHOT`** (**A5**),
- and a single “try remote once” rule (no loops).

This section is the single source of truth for the required `mode × failure` matrix test coverage in **TODOS.md**.

### B4.2 Inputs to the matrix

- `routing mode` in:
  - `remote_only`
  - `local_primary_fallback_remote`
  - `dual_read_compare` (v1: mirror/remote compare; primary selection follows A4, mismatches are non-blocking)
- `error code` from:
  - mirror path: `MIRROR_*`, `SCHEMA_MISMATCH`, `SNAPSHOT_INVALID`, `STALE_SNAPSHOT`
  - remote path: `REMOTE_*`, `CONFIG_MISSING`, `REMOTE_HTTP` (provider-layer)
  - generic: `INTERNAL`
- `fallbackSuggested` from **A2** (used when present, but **A4 allow-list** is the final decision source for v1).

### B4.3 One-shot fallback rule (no loops)

In `local_primary_fallback_remote`:
- never retry the mirror tier after a fallback attempt,
- never attempt remote fallback more than once for a given provider call.

In `dual_read_compare`:
- run mirror + remote (in parallel or effectively), and return primary per **A4**.
- comparisons never throw in v1.

### B4.4 Default fallback allow-list (local-primary mode)

For `local_primary_fallback_remote`, mirror errors trigger a **remote fallback attempt** when the mirror error code is in:

`MIRROR_UNAVAILABLE`,
`MIRROR_MANIFEST_MISSING`,
`MIRROR_MANIFEST_INVALID`,
`MIRROR_ARTIFACT_MISSING`,
`MIRROR_ARTIFACT_CORRUPT`,
`SCHEMA_MISMATCH`,
`SNAPSHOT_INVALID`,
`STALE_SNAPSHOT` (handled per **A5** policy),

and optionally the router may include `CONFIG_MISSING` only if product decides remote should still be tried.

### B4.5 Outcome matrix (v1)

Legend:
- `RET(remote)` = return remote adapter result
- `RET(mirror)` = return mirror adapter result
- `RET(empty)` = return empty array as success (adapter succeeded)
- `THROW(code)` = fail the planner with the underlying `SourceError` (planner returns `status: "error"`)
- `COMPARE_LOG_ONLY` = record mismatch telemetry, do not block response

#### Remote-only (`remote_only`)

All failures from remote adapters must surface:
- `CONFIG_MISSING` → `THROW(CONFIG_MISSING)`
- `REMOTE_RATE_LIMIT` / `REMOTE_TIMEOUT` / `REMOTE_NETWORK` / `REMOTE_PARSE` / `REMOTE_HTTP` → `THROW(REMOTE_*)`

Mirror errors are not expected because mirror is not consulted:
- any `MIRROR_*` / `SCHEMA_MISMATCH` / `SNAPSHOT_INVALID` / `STALE_SNAPSHOT` → `THROW(INTERNAL)` (implementation guard).

#### Local-primary fallback-remote (`local_primary_fallback_remote`)

1. If mirror returns `Canonical*` arrays (including empty), return them:
   - mirror success → `RET(mirror)` (or `RET(empty)` if array is empty)

2. If mirror throws `SourceError`:
   - mirror code in allow-list (see **B4.4**) → attempt remote once:
     - remote success → `RET(remote)`
     - remote failure → `THROW(remoteErrorCode)`
   - mirror code not in allow-list → `THROW(mirrorErrorCode)` (no remote rescue)

Special case: `STALE_SNAPSHOT`
- If `STALE_SNAPSHOT_POLICY=fallback_remote` → treat as allow-list entry → remote fallback attempt as above.
- If `STALE_SNAPSHOT_POLICY=fail` → `THROW(STALE_SNAPSHOT)` (no remote rescue).

#### Dual-read compare (`dual_read_compare`) (v1)

Primary selection follows **A4**:
1. If mirror succeeds → `RET(mirror)`
2. Else if remote succeeds → `RET(remote)`
3. Else → `THROW(bestErrorCode)` (prefer mirror error if it is more diagnostic for “missing data”; otherwise remote).

Compare behavior:
- If both succeed but differ: `COMPARE_LOG_ONLY` (no blocking in v1).
- If mirror fails due to `STALE_SNAPSHOT`: it does not block user success if remote returns.

### B4.6 User/debug impact (what changes vs runtime)

For local-primary fallback:
- planner debug should include a `fallbackReason` derived from the mirror error:
  - `fallbackReason.code = <mirrorCode>`
  - `fallbackReason.source = "mirror"`
- planner should not hide remote failures after fallback; remote errors should surface.

For dual-read:
- mismatches should emit logs/metrics but must not change the returned `stops`/`legs` in v1 beyond normal primary selection.

### B4.7 Test matrix coverage requirement (explicit)

Implementations must test at least:
- for each `SourceErrorCode` in the allow-list: in `local_primary_fallback_remote` verify it falls back and returns remote when remote succeeds
- for each `SourceErrorCode` in remote: verify `remote_only` throws the same code
- for `STALE_SNAPSHOT`: test both `STALE_SNAPSHOT_POLICY=fallback_remote` and `fail`
- for dual-read: verify it returns mirror when mirror succeeds, even if remote also succeeds; and returns remote when mirror fails.

### B4.8 Observability requirements (ties to C4)

When fallback or dual-read compare happens, log:
- `requestId`
- `sourceRoutingMode`
- `mirrorSnapshotId` and mirror age context when mirror was consulted
- `mirrorError.code` and `fallbackAttempted: true/false`
- `remoteError.code` if fallback attempt fails

## C1 Dual-read compare architecture for migration

### C1.1 Purpose

During phased rollout, **`dual_read_compare`** provides confidence that local mirror data matches remote provider truth.

In v1:
- we still return a usable itinerary based on **A4 primary selection**,
- we never block user responses due to divergence alone,
- we collect deterministic divergence metrics to drive **C2** promotion gates.

### C1.2 Where comparisons happen

Comparisons are performed at the **provider-call boundary**, for each interface method invoked in `dual_read_compare`:
- `ChargerProvider.findChargersNearPoint`
- `ChargerProvider.findChargersNearRoute`
- `PoiProvider.findHolidayInnExpressHotelsNearPoint`

Each comparison consumes:
- mirror canonical array (or mirror error)
- remote canonical array (or remote error)

Comparisons never transform the itinerary; they only compute drift metrics and logs.

### C1.3 Canonical comparison metrics (v1)

Compute the following metrics for chargers and POI hotels separately.

Common inputs:
- each record has a stable `id` and `coords`.

Metrics:
- `idIntersectionCount`
- `idMirrorOnlyCount` (present in mirror but missing in remote)
- `idRemoteOnlyCount` (present in remote but missing in mirror)
- `idUnionCount`
- `jaccard = idIntersectionCount / idUnionCount` (0..1)
- `bothCoordsCount` = number of ids present in both
- `maxCoordDriftMeters` across ids present in both
- `avgCoordDriftMeters` across ids present in both
- optionally: `p95CoordDriftMeters` if you want robust stats (requires more compute)

Coordinate drift:
- compute haversine distance from record `coords` (`lat/lon`).

If a provider call returns an empty array successfully on one side and non-empty on the other:
- this is still a valid divergence signal; treat it as `idUnionCount > 0` and compute the above.

### C1.4 Divergence thresholds (proposal knobs)

Thresholds are used for **classification**, not for blocking in v1.

Define (env proposal, v1 defaults):

| Metric | Warning threshold | Error threshold |
|---|---|---|
| `jaccard` | < 0.99 | < 0.95 |
| `idRemoteOnlyCount` (as % of union) | > 0.5% | > 2% |
| `maxCoordDriftMeters` | > 500m | > 2000m |

Classification:
- `OK`: all metrics within warning threshold
- `WARN`: any metric within warning threshold but not error threshold
- `FAIL`: any metric within error threshold

These map to promotion gate decisions later (**C2**).

### C1.5 Mismatch handling rules (v1)

Primary selection remains A4:
1. If mirror succeeds → primary result = mirror.
2. Else if remote succeeds → primary result = remote.
3. Else → throw the “best” error.

Compare handling in v1:
- If both sides succeed:
  - compute divergence metrics and log them,
  - set mismatch severity (OK/WARN/FAIL),
  - do NOT fail the request due to mismatch.
- If one side fails:
  - log that side’s error code and retryability,
  - do NOT treat it as mismatch divergence (it’s “tier unavailable”),
  - do NOT block response as long as the primary side succeeded.

If `STALE_SNAPSHOT` occurs on mirror:
- compare may still run (depending on implementation availability of mirror artifacts),
- but mismatch severity should label the event as `mirror_stale` rather than “data drift”.

### C1.6 Observability (required logs/metrics)

Every `dual_read_compare` provider call SHOULD emit:
- `requestId`
- `provider` (charger vs poi)
- `method` (nearPoint/nearRoute)
- `mirrorResult: { success: true/false, errorCode? }`
- `remoteResult: { success: true/false, errorCode? }`
- divergence metrics:
  - `jaccard`, `idMirrorOnlyCount`, `idRemoteOnlyCount`, `maxCoordDriftMeters`
- mismatch classification: `OK/WARN/FAIL`
- timing:
  - `mirrorDurationMs`, `remoteDurationMs`, `compareDurationMs`

These outputs are what **C2** uses to decide whether to promote local-primary.

### C1.7 Complexity / performance constraints

- Divergence computation must be bounded:
  - O(n) map/set construction + O(k) drift computation for matching ids.
- Do not add additional network I/O during compare.

### C1.8 Non-goals (v1)

- Do not compare itinerary legs/stops at this stage (that’s later and would require geo/route artifacts).
- Do not block users on divergence in v1; promotion gating is separate (**C2**).

## C2 Promotion criteria to local-primary (cutover gates)

### C2.1 Goal

Move from `dual_read_compare` to `local_primary_fallback_remote` only when:
- divergence between mirror and remote is consistently within acceptable bounds (per **C1**),
- mirror freshness (A5) and snapshot health are sufficiently reliable (per **B-track**),
- and mirror call latency is within local performance expectations.

Until these gates pass, keep using `dual_read_compare` (or `remote_only`) as the safer user-facing routing mode.

### C2.2 Evaluation window and sample requirements

Promotion is evaluated over an observation window (ops choice) with minimum sample requirements.

Proposal (v1 defaults):
- **Require at least** `N=200` dual-read samples where:
  - mirror succeeded, and
  - remote succeeded,
  - for chargers and POI separately.
- Only compareable samples count toward divergence stats (tier unavailable samples are excluded from “divergence” math).

If you prefer POI to lag chargers due to lower call volume:
- POI minimum can be smaller (e.g. `N=100`), but chargers should keep the full `N`.

### C2.3 Metrics and thresholds (proposal)

Use the mismatch classification from **C1.4**:
- `OK`, `WARN`, `FAIL`

Let:
- `failRate = (# FAIL samples) / (# comparable samples)`
- `warnRate = (# WARN samples) / (# comparable samples)`

Promotion thresholds (v1 defaults):

| Metric | Pass condition | Fail condition |
|---|---|---|
| Divergence `failRate` | <= 0.5% | > 0.5% |
| Divergence `warnRate` | <= 5% | > 5% |
| `idRemoteOnlyCount` drift | within `C1.4` warning thresholds for >= 99% of samples | breaches error threshold for > 0.5% |
| Coord drift | `maxCoordDriftMeters` error threshold breaches <= 0.5% | > 0.5% |
| Mirror freshness failures (`STALE_SNAPSHOT`) | 0 in comparable samples | any sustained presence (more than 0.5% over window) |
| Fallback rate (from local-primary to remote) | <= 1% of provider calls | > 1% over window |
| Mirror availability (`MIRROR_*` codes) | 0 fatal mirror artifacts/corruption in window | any sustained corruption/artifact parse failures |

Notes:
- “sustained presence” is interpreted operationally; v1 should treat any early corruption/artifact error as a hard stop and require human intervention.
- If you can’t reliably separate comparable samples yet, tighten by counting all mirror-participating calls.

### C2.4 Operational workflow

1. While in `dual_read_compare`, continuously emit the divergence metrics + mismatch classification per provider call (**C1.6**).
2. Once gates pass over the observation window:
   - update `SOURCE_ROUTING_MODE` to `local_primary_fallback_remote` for the affected environment.
3. Maintain remote fallback as the safety net (per **B4** matrix).
4. If later monitoring shows gates failing (divergence or mirror instability), revert via **C3** rollback triggers.

### C2.5 Gate resets and version changes

If any of the following changes occur, reset the observation window:
- mirror snapshot `schemaVersion` major bump (A1.4),
- remote adapter normalization logic changes that could affect canonical shape,
- significant provider query changes (NREL/Overpass strategy).

### C2.6 Non-goals

- This section does not define rollback triggers or promotion automation: those are **C3**.
- This section does not define how to compute itinerary leg/stop divergence (not in mirror v1 scope).

## C3 Rollback architecture and incident triggers

### C3.1 Goal

Provide an operational escape hatch when local mirror-driven behavior regresses:
- divergence becomes unacceptable,
- mirror becomes stale/unreliable,
- mirror artifacts become corrupt,
- or mirror-driven planner outcomes degrade user-facing quality.

Rollback must be:
- fast (request-level effect),
- deterministic (same trigger => same action),
- operable without code changes (config/flag only),
- compatible with **B4** failure/fallback semantics.

### C3.2 Rollback target (v1)

In v1 rollback always switches to:
- `SOURCE_ROUTING_MODE = remote_only`

Rationale:
- eliminates mirror reads and dual-read compare overhead,
- uses remote adapters only (the proven baseline path).

### C3.3 Trigger taxonomy

Triggers are evaluated over rolling windows and grouped by severity.

Tier 1 (immediate rollback):
- Mirror tier generates frequent non-recoverable read/validation errors:
  - `MIRROR_ARTIFACT_CORRUPT`
  - `SNAPSHOT_INVALID`
  - `SCHEMA_MISMATCH`
- Mirror freshness failures spike:
  - `STALE_SNAPSHOT` rate exceeds a threshold derived from **C2** window.
- Mirror-driven requests show elevated planner failures correlated with mirror tier involvement.

Tier 2 (rollback after confirmation):
- Divergence mismatch classification includes too many `FAIL` samples in dual-read compare (**C1/C2**).
- Fallback rate in `local_primary_fallback_remote` rises beyond expected **B4** allowances.
- Mirror read latency regresses (timeouts or sustained high mirror read durations).

### C3.4 Trigger evaluation and hysteresis (v1)

For each trigger class, define:
- observation window length (ops choice; e.g. last 100 provider calls),
- minimum sample count,
- trip threshold (e.g. FAIL samples > 0.5%),
- recovery threshold with hysteresis:
  - once rolled back, require a better-than-threshold condition for a sustained period before auto-re-enabling.

Recommendation:
- be strict on Tier 1, require sustained signal for Tier 2 to avoid flapping.

### C3.5 Rollback mechanism (config/flag only)

Introduce an operator-controlled override:
- `SOURCE_ROUTING_MODE_FORCE=remote_only` (name proposal)

Operational rules:
- The router checks the override on every request (or every few seconds with a short cache TTL).
- Override changes require no code changes.
- In worst case, restart is allowed to pick up configuration, but the decision logic should not require rebuilds.

Rollback “stickiness”:
- once forced to `remote_only`, keep it until:
  - manual clear of `SOURCE_ROUTING_MODE_FORCE`, or
  - C2 gates are satisfied again and hysteresis recovery criteria are met.

### C3.6 Rollback logging

When a rollback is triggered, emit:
- `requestId` (for request-level correlation)
- `rollbackTriggered: true`
- `rollbackReason` with:
  - triggering metric name,
  - observed window value,
  - last known `sourceRoutingMode`,
  - top contributing `SourceError.code` values (if available).

This makes incidents explainable in C4 dashboards.

## C4 Observability contract for source selection and fallback

### C4.1 Goal

Ensure failures and routing decisions are explainable from logs/metrics alone:
- which source tier was used (mirror vs remote),
- why a fallback occurred,
- whether mirror data was stale/invalid,
- and whether mirror/remote canonical results diverged (dual-read compare).

### C4.2 Required log events (structured JSON)

Every `/plan` request already has `requestId` in the server layer; required additional events:

1. `plan_source_selection`
   - `requestId`
   - `sourceRoutingMode` (configured)
   - `effectiveSourceRoutingMode` (after overrides)
   - `chargersTier`, `poisTier` (mirror|remote)
   - `mirrorSnapshotId`, `mirrorSchemaVersion`
   - `mirrorAgeHours` when mirror is consulted

2. `plan_fallback`
   - `requestId`
   - `provider`: chargers|pois
   - `primaryTier`: mirror|remote
   - `fallbackTier`: mirror|remote
   - `fallbackReason`: `{ code, source, retryable }` (A2 `SourceError` fields)

3. `dual_read_compare`
   - `requestId`
   - `provider` + `method` (nearPoint/nearRoute)
   - `mirrorResult` success/error code
   - `remoteResult` success/error code
   - divergence metrics: `jaccard`, `idMirrorOnlyCount`, `idRemoteOnlyCount`, `maxCoordDriftMeters`
   - `mismatchSeverity`: OK/WARN/FAIL

4. `mirror_staleness`
   - `requestId`
   - `mirrorSnapshotId`
   - `manifestCreatedAt`, `ageHours`, `maxAgeHours`
   - `STALE_SNAPSHOT_POLICY`

5. `rollback_triggered`
   - `requestId`
   - `rollbackReason` (metric + window + contributing error codes)

### C4.3 Required metrics (minimum)

Counters:
- `plan_requests_total{sourceRoutingMode,effectiveSourceRoutingMode}`
- `plan_provider_calls_total{provider,tier,method}`
- `plan_fallback_total{provider,fromTier,toTier,fallbackCode}`
- `plan_errors_total{provider,tier,code}`
- `mirror_stale_total{policy}`
- `dual_read_mismatch_total{provider,mismatchSeverity}`

Histograms / gauges:
- `plan_provider_duration_ms{provider,tier,method}`
- `mirror_snapshot_age_hours`

### C4.4 Correlation and sampling

- Use `requestId` as the correlation key across all log events for `/plan`.
- Always attach `mirrorSnapshotId` when mirror is consulted.
- For dual-read compare, ensure both mirror and remote durations are recorded.

## D1 Synology/Docker deployment topology spec (v1)

### D1.1 Goal

Define the minimal service topology needed to support:
- mirror refresh jobs (write side),
- planner `/plan` runtime reads (read side),
- and atomic promotion without race conditions.

This spec targets Synology NAS + Docker bind mounts.

### D1.2 Service boundaries (v1)

1. **Planner API service** (existing app: `/plan` + provider adapters)
   - Role: read-only access to the active mirror snapshot.
   - Must NOT write `mirror/snapshots/` or update `mirror/current/`.
   - Reads:
     - `mirror/current/manifest.json`
     - `mirror/current/*ndjson` indirectly via `files.*` pointers.

2. **Mirror refresh worker** (new)
   - Role: scheduled monthly refresh and snapshot promotion.
   - Writes:
     - `mirror/snapshots/<snapshotId>/...`
     - `mirror/current/manifest.json` via B1 atomic promotion step.
   - Uses:
     - remote adapters to generate canonical NDJSON artifacts (B2)
     - validation gate (B3) to set `manifest.validation`

3. **Scheduler**
   - Either:
     - cron inside the refresh worker container, or
     - an external scheduler that runs the refresh command on a cadence.

### D1.3 Shared storage and mounts

Use one shared persistent mount for the mirror artifacts, accessible by both services.

Recommended layout in the mount (conceptually matches A1/B1):

```text
<MIRROR_ROOT>/
  snapshots/<snapshotId>/manifest.json
  snapshots/<snapshotId>/chargers.ndjson
  snapshots/<snapshotId>/poi_hotels.ndjson
  current/manifest.json  (atomic pointer target)
```

Mount rules:
- Planner API mounts the mirror root as **read-only**.
- Refresh worker mounts the mirror root as **read-write**.
- Promotion updates must be visible immediately to the planner after the atomic pointer swap.

### D1.4 Promotion correctness in Docker

To preserve B1 atomic promotion:
- ensure refresh worker and planner share the same filesystem semantics (same bind mount / volume),
- implement the pointer swap via atomic `rename` on the shared filesystem.

Avoid:
- copying mirror artifacts into a different volume,
- updating `current/` via multi-step non-atomic edits.

### D1.5 Restart safety and concurrency control

This spec relies on:
- B2 refresh lock (e.g. `mirror/current/refresh.lock`) to prevent parallel refresh promotions.
- candidate snapshot state tracking (`refresh.state.json`) so restarts resume or rewrite safely.

Planner restart safety:
- planner can crash/restart at any time; it reads `current/manifest.json` and only sees fully-promoted snapshots.

### D1.6 Networking and provider access

- Refresh worker requires outbound network access to:
  - NREL endpoints
  - Overpass endpoints
- Planner runtime does not require outbound provider network access when:
  - `SOURCE_ROUTING_MODE=local_primary_fallback_remote` and mirror reads succeed, or
  - `SOURCE_ROUTING_MODE=remote_only` only after deliberate operator override.

### D1.7 Secrets boundary (details in D2)

Only the refresh worker needs provider secrets (e.g. `NREL_API_KEY`).
Planner service should not contain secrets needed for refresh write-side operations.

## D2 Config and secret model for source modes

### D2.1 Goal

Define the runtime configuration model (env/config knobs) required to:
- control source routing modes (A4),
- enforce timeout budgets and freshness SLA (A3/A5),
- keep secrets confined to the mirror refresh worker (D1),
- and support rollback overrides without code changes (C3).

### D2.2 Configuration groups (v1 env knobs)

This doc uses the following env/config concepts:

1. **Routing mode controls**
   - `SOURCE_ROUTING_MODE`
     - values: `remote_only`, `local_primary_fallback_remote`, `dual_read_compare`
     - default: `remote_only` (safe)
   - `SOURCE_ROUTING_MODE_FORCE`
     - values: currently `remote_only` (rollback override)
     - override priority: highest
     - intended behavior: checked frequently (see **D2.5**)

2. **Mirror filesystem location**
   - `MIRROR_ROOT`
     - default: path mounted from Synology bind mount
     - used by planner read path and refresh worker write path

3. **Freshness SLA**
   - `MIRROR_MAX_AGE_HOURS` (A5)
   - `STALE_SNAPSHOT_POLICY` (A5)

4. **Timeout budgets**
   - `NREL_FETCH_TIMEOUT_MS` (A3)
   - `OVERPASS_FETCH_TIMEOUT_MS` (A3)
   - `MIRROR_READ_TIMEOUT_MS` (A3)

5. **Provider retry/backoff (remote adapters)**
   - NREL env knobs already referenced by current client (`NREL_RETRY_BASE_DELAY_MS`, `NREL_RETRY_JITTER_MS`, `NREL_MAX_ATTEMPTS`, etc.)
   - Overpass env knobs already referenced by current client (`OVERPASS_MAX_ATTEMPTS`, `OVERPASS_RETRY_BASE_DELAY_MS`, etc.)

6. **Operational logging**
   - `PLAN_LOG_REQUESTS` (existing in planner)
   - mirror job logging defaults (write structured `snapshotId` events; see B2/C4)

### D2.3 Secrets boundary (must be respected)

Secrets are required only for remote fetches during refresh jobs:
- `NREL_API_KEY`
  - must be available in the mirror refresh worker container
  - must NOT be required in the planner API container when operating in mirror-only modes

Overpass does not require an API key in v1 (base URL optional).

### D2.4 Config validation rules (fail fast)

At startup (planner and refresh worker), validate:
- `SOURCE_ROUTING_MODE` is one of allowed values; otherwise treat as `remote_only` and emit a startup warning.
- `MIRROR_ROOT` exists (or log a warning if mode is `remote_only` and mirror is not expected).
- timeout env vars parse to finite positive integers; otherwise fall back to safe defaults defined by A3.

Invalid config must not silently “half-enable” mirror behavior without operator awareness.

### D2.5 Runtime override behavior (rollback without code changes)

Rollback requires that `SOURCE_ROUTING_MODE_FORCE` affects request routing quickly.

v1 recommended behavior:
- Check `SOURCE_ROUTING_MODE_FORCE` and `SOURCE_ROUTING_MODE` per request (or with a short TTL, e.g. 5s).
- This ensures ops can flip a flag/config and immediately force `remote_only` on incident mitigation.

If an operator wants to avoid per-request env reads:
- implement a lightweight config watcher that reloads a mounted config file; still no code rebuild needed.

### D2.6 Separation of concerns

- Planner container:
  - read mirror artifacts and manifest
  - serve `/plan`
  - never runs remote fetches during v1 except as a fallback adapter path when allowed by routing mode
- Refresh worker:
  - runs remote fetches to generate new snapshot artifacts
  - runs B3 validation
  - performs B1 atomic promotion

### D2.7 Non-goals

- Secret rotation mechanics beyond “ops can update the secret/variable and restart or reload containers”
  (defined later if you add a real secrets manager integration).

## D3 Architecture sign-off checklist (pre-implementation gate)

### D3.1 Goal

Freeze the mirror architecture so the first implementation slice can proceed without thrashing.
This gate must verify that every contract required by **1A** is present and that the rollout
path is deterministic and operable.

### D3.2 Sign-off checklist (v1)

**Contracts completeness**
- **A1** canonical schemas define charger/POI entities + snapshot manifest + schema/version policy.
- **A2** typed error taxonomy and mapping rules exist for NREL, Overpass, and mirror read failures.
- **A3** provider interfaces exist as the only planner dependency boundary, with timeout/`AbortSignal` semantics.
- **A4** routing modes and fallback allow-list define deterministic outcomes.
- **A5** freshness SLA and the `STALE_SNAPSHOT` behavior are explicit.

**Safety and determinism**
- **B1** snapshot lifecycle is atomic: `current/` pointer update happens only after validation.
- **B2** refresh pipeline is restart-safe and prevents concurrent promotions.
- **B3** validation gate is fail-closed, deterministic, and includes the promotion-time freshness rejection rule.
- **B4** failure/fallback matrix is defined for each routing mode and each error class.

**Rollout mechanics**
- **C1** dual-read compare emits divergence metrics and is non-blocking in v1.
- **C2** promotion criteria to `local_primary_fallback_remote` are specified.
- **C3** rollback triggers and override mechanism are defined and require config changes only.

**Observability**
- **C4** required log events exist so decisions and incidents are diagnosable.
  Metrics counters/histograms can be log-based for v1 and are follow-up work.

**Deployment topology + config**
- **D1** planner read vs refresh worker write responsibilities are separated with a shared mount.
- **D2** config + secrets boundary is defined; rollback override is applied quickly enough for incidents.

**Testing hook**
- **TODOS.md** includes the explicit `mode × failure` test matrix requirement.

### D3.3 Sign-off outputs

After sign-off, it should be possible to:
- implement the first runnable code slice that includes:
  - **A3** remote adapters behind the provider interfaces,
  - **A4** source routing (including `local_primary_fallback_remote` shell + fallback allow-list),
  - v1 local mirror read path (planner reads from `mirror/current/manifest.json`),
  - **B2** refresh job for generating/promoting `mirror/current` safely,
  - **C2/C3** config-only gate/override mechanisms,
  - **C4** request-correlated log events for routing/fallback/mirror staleness/dual-read compare.
- keep initial runtime safe by using `SOURCE_ROUTING_MODE=remote_only` (or force rollback via `SOURCE_ROUTING_MODE_FORCE=remote_only`),
- validate fallback/rollback behavior using the documented `SourceErrorCode` outcomes and observability logs.

## Next action

Aligned with [`TODOS.md`](../TODOS.md) and [`LOCAL_MIRROR_CHECKPOINT.md`](LOCAL_MIRROR_CHECKPOINT.md):

- **Phase 1 exit:** manual map / short-route checks ([`TESTING.md`](../TESTING.md) § Phase 1 exit verification); optional tuning of per-stage timeout envs.
- **Phase 3:** one-shot QA entrypoint + CI scope note (repo scripts / docs).
- **Ongoing:** optional C4 metrics beyond logs; B2/POI polish as needed.


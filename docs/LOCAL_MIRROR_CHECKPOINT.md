# Local mirror epic — checkpoint (resume here)

> **Scope:** Mirror checkpoint work (**NREL + Overpass** NDJSON, refresh jobs). **POI Services** is the **runtime** corridor source for `/plan` when configured — see **[`ROUTING_UX_SPEC.md`](./ROUTING_UX_SPEC.md)** §2.
>
> **`docker-compose.mirror.yml`** and **`scripts/d1-verify-mirror.mjs`** were **removed** from this repo (see **[`deprecate-nrel-overpass-mirror-travel-routing-adr.md`](./designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)**). Treat this document as **historical** for the mirror stack.

**Updated:** 2026-03-20 (NAS Compose validation noted below)  
**DRI:** David  

Use this file to **pick up tomorrow** without re-reading full thread history.

---

## Where things live

| Artifact | Path |
| --- | --- |
| **Architecture source of truth** | [`local-mirror-architecture.md`](local-mirror-architecture.md) |
| **Task / phase tracking** | [`../TODOS.md`](../TODOS.md) |
| **QA / env invariants** | [`../TESTING.md`](../TESTING.md) |

---

## Done (A-track + B1 + B2 + B3 + B4 + C1 + C2 + C3 + C4 + D1 + D2 + D3, doc)

All of **§A1–§A5** are written in `local-mirror-architecture.md` (section table marks each **DONE 2026-03-19**).

`§B1` snapshot lifecycle (staging → validate → atomic promote via `current/` pointer → archive) is written and marked **DONE 2026-03-20**.

`§B2` snapshot refresh pipeline (monthly orchestration + restart-safety) is written and marked **DONE 2026-03-20**.

`§B3` validation gate architecture (promotion-time sanity + SLA-age check, no-network) is written and marked **DONE 2026-03-20**.

`§B4` failure and fallback matrix (mode × SourceErrorCode outcomes + observability) is written and marked **DONE 2026-03-20**.

`§C1` dual-read compare architecture (divergence metrics + OK/WARN/FAIL classification, v1 non-blocking) is written and marked **DONE 2026-03-20**.

`§C2` promotion criteria to local-primary (divergence + freshness + fallback/latency gates) is written and marked **DONE 2026-03-20**.

`§C3` rollback architecture and incident triggers is written and marked **DONE 2026-03-20**.

`§C4` observability contract for source selection and fallback is written and marked **DONE 2026-03-20**.

`§D1` Synology/Docker deployment topology spec is written and marked **DONE 2026-03-20**.

`§D2` config and secret model is written and marked **DONE 2026-03-20**.

`§D3` architecture sign-off checklist is written (pre-implementation gate) and marked **DONE 2026-03-20**.

| Section | Contents (short) |
| --- | --- |
| **A1** | Canonical `CanonicalCharger` / `CanonicalPoiHotel` / manifest; IDs + provenance; schema semver policy; **storage:** versioned NDJSON + `manifest.json`, `current/` pointer (3A). |
| **A2** | `SourceError` / `SourceErrorCode`; mapping tables for NREL, Overpass, local mirror. |
| **A3** | `ChargerProvider`, `PoiProvider`, `ProviderCallOptions`; timeouts + `AbortSignal`; env names for fetch/read timeouts. |
| **A4** | `SourceRoutingMode` (`remote_only`, `local_primary_fallback_remote`, `dual_read_compare`); `resolvePlanProviders`; fallback allow-list; dual-read specified, implement after local-primary (**5A**). |
| **A5** | Freshness from `manifest.createdAt`; `MIRROR_MAX_AGE_HOURS` (default 35d), `STALE_SNAPSHOT_POLICY`; when to throw `STALE_SNAPSHOT`. |

**Eng review locks** (still in doc header): **1A** doc-before-code, **2A** thin router, **3A** storage in A1, **4A** Valhalla out of mirror v1, **5A** dual-read later.

---

## Not done yet

| Area | Status |
| --- | --- |
| Architecture prose | **DONE**. Next is implementation (first code slice per **D3**). |
| **Formal review / sign-off** of A-track | DONE — D3 gate for first code slice frozen (**2026-03-20**). |
| **Code** (`ChargerProvider` wiring, `sourceRouter`, adapters) | **In progress** — `planTrip` routes via `resolvePlanProviders`; remote adapters implement A3; `LocalMirrorAdapter` supports mirror reads; `sourceRouter` implements `local_primary_fallback_remote` and v1 `dual_read_compare`. Progress: `mirror:refresh` worker hardened (B2 v1 rerun-safety + refresh.state.json + promotion gating + retention + restart facet rewrite) and `SOURCE_ROUTING_MODE_FORCE=remote_only` rollback override (C3 mechanism) + C2 in-process gate accumulator added. Progress: C4 request-correlated logs implemented (`plan_source_selection`, `mirror_staleness`, `rollback_triggered`, and `dual_read_compare` w/ timings; fallback/dual-read already emit). Verified end-to-end C4 via `scripts/mirror-c4-longrun-smoke.mjs` and extended load via `scripts/mirror-c4-load-smoke.mjs` (now with stronger assertions for `deploymentEnv` + `dual_read_compare.compareDurationMs`). Expanded C2 gate evaluation in `api/src/mirror/c2Gate.selftest.ts` (WARN + fatal + interleaving/reset scenarios) and added `npm -w api run mirror:c2-gate-harness`. Added D1 runnable verification + runbook: `scripts/d1-verify-mirror.mjs` and `docs/d1-runbook.md` (actual docker-compose execution depends on Docker Desktop engine being available; script is included for repeatable ops validation). Still missing: full B2 staging/archiving policy polish + optional C4 metrics/telemetry beyond log-based v1. |
| **`TODOS.md` execution checklist** | **Phase 2** checklist rows in [`TODOS.md`](../TODOS.md) are **checked** (architecture + C4 harness items). Remaining open work is **Phase 1 exit** (manual QA + per-stage `/plan` budgets), **Phase 3** (one-command QA / CI / SLO), and ongoing **code** polish (see `TODOS.md` “Known gaps”). |
| **Production NAS (Synology)** | Validated: `planner-api` + `mirror-refresh-once` via Compose, external **`prod-network`**, Valhalla reachable as `http://valhalla:8002`, optional **POI Services** container on the same network as **`http://poi:8010`** (set **`POI_SERVICES_BASE_URL`** in planner `.env`). Secrets via **`env_file`** → `/volume1/docker/Travel-Routing/.env` (incl. `NREL_API_KEY`). NDJSON artifacts live under **`api/mirror/snapshots/<snapshotId>/`**; **`api/mirror/current/manifest.json`** points at the active snapshot. |

---

## Suggested next steps (in order)

1. **Phase 1 exit:** Per-stage `/plan` timeout envs + documented matrix ([`TESTING.md`](../TESTING.md)); manual re-plan / short-route checks per same doc.  
2. **Smoke-test** `remote_only` vs `local_primary_fallback_remote` on NAS or dev as needed.  
3. **Harden** B-track: optional POI query / staging polish; C4 metrics beyond logs if desired.  
4. **Phase 3 thin slice:** One-shot QA wrapper + CI scope note in repo (see `TODOS.md`).

---

## Env knobs to remember (proposals in doc)

- **Routing:** `SOURCE_ROUTING_MODE`, `MIRROR_ROOT`  
- **Freshness:** `MIRROR_MAX_AGE_HOURS`, `STALE_SNAPSHOT_POLICY`  
- **Timeouts:** `NREL_FETCH_TIMEOUT_MS`, `OVERPASS_FETCH_TIMEOUT_MS`, `MIRROR_READ_TIMEOUT_MS` (A3)  

---

## Quick dependency chain (from architecture doc)

```
A1–A5 (done) → D3
```

Implementation order after gate: **A3 adapters + router shell** → local mirror refresh (B) → dual-read (C) when **5A** satisfied.

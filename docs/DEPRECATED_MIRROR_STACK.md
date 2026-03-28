# DEPRECATED — Local mirror Docker stack (do not use)

**Status:** Removed from this repository. **Do not** restore or deploy **`docker-compose.mirror.yml`**, **`mirror-refresh-once`**, or **`scripts/d1-verify-mirror.mjs`** from an older commit without a deliberate product decision.

## Why

Corridor planning for **`POST /plan`** and **`POST /candidates`** is **POI Services**–backed when **`POI_SERVICES_BASE_URL`** is set. The NREL/Overpass **mirror** path (NDJSON snapshots, refresh worker, compose-based deploy) was retired per:

- **[`designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md`](./designs/deprecate-nrel-overpass-mirror-travel-routing-adr.md)**

## If you see this in git history

Older commits still contain **`docker-compose.mirror.yml`** and mirror-related API code. That layout is **unsupported** on current `main`:

- It depended on **`api/src/mirror/refreshSnapshot`** and related adapters, which are **gone**.
- **`npm run qa:smoke`** and the planner assume **POI** + **Valhalla**, not mirror tiers.

To inspect the **last** compose file for archaeology only:

```bash
git log --follow --oneline -- docker-compose.mirror.yml
git show <commit>:docker-compose.mirror.yml
```

Do **not** treat that output as a runnable deploy recipe.

## Git tag

An annotated tag **`deprecated/mirror-stack-removed`** marks the deprecation boundary (browse with `git tag -l 'deprecated/*'` or `git show deprecated/mirror-stack-removed`). **Push it** so clones and forkers see it:

```bash
git push origin 'refs/tags/deprecated/mirror-stack-removed'
```

If the tag is missing locally, recreate it at the commit that removed **`docker-compose.mirror.yml`**:

```bash
git log --oneline -- docker-compose.mirror.yml
git tag -a deprecated/mirror-stack-removed <commit> -m "DEPRECATED: mirror Docker stack removed — see docs/DEPRECATED_MIRROR_STACK.md"
```

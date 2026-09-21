# PostGIS Spatial Parity & Geography Architecture (Issue #34)

## 1. Spatial Architecture Overview
LabourBaba uses real-time geospatial queries to match customer service requirements with verified, available workers within dynamic radial dispatch zones (3km, 5km, 10km, 15km).

To ensure deterministic spatial calculation across Local, CI, Staging, and Production environments:
- **Spatial Type**: PostgreSQL `geography(Point, 4326)` (WGS 84 ellipsoid coordinate system).
- **Coordinate Order**: `ST_MakePoint(longitude, latitude)` — Longitude is X, Latitude is Y.
- **Distance Metric**: Meters (geodesic distance on the WGS 84 ellipsoid via `ST_Distance` and `ST_DWithin`).
- **Spatial Indexing**: `GIST` index on `location_geo` columns (`worker.location_geo`, `job.location_geo`, `worker_location.location_geo`).

---

## 2. Infrastructure & Container Pinned Versions

| Environment | Database Image / Engine | PostGIS Version | Verification Command |
|---|---|---|---|
| **Local Docker** | `postgis/postgis:17-3.5` | PostGIS 3.5 | `docker compose up -d postgres` |
| **CI Environment**| `postgis/postgis:17-3.5` | PostGIS 3.5 | `service: postgis` in GitHub Actions |
| **Staging / Prod**| Supabase Managed PostgreSQL | PostGIS 3.3+ / 3.5 | `SELECT extversion FROM pg_extension WHERE extname = 'postgis'` |

> [!IMPORTANT]
> Never use `postgres:latest` or `postgis/postgis:latest` in Docker infrastructure. Version 17 with PostGIS 3.5 is explicitly pinned in [`docker-compose.yml`](../../docker-compose.yml).

---

## 3. Core Spatial Operations & Queries

### A. Geodesic Distance (`ST_Distance`)
```sql
SELECT ST_Distance(
  worker.location_geo,
  ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
) AS dist_m
FROM worker;
```

### B. Radial Dispatch Filter (`ST_DWithin`)
```sql
SELECT worker.id, worker.name, worker.worker_score
FROM worker
WHERE worker.is_online = true
  AND worker.verification_status = 'verified'
  AND worker.location_geo IS NOT NULL
  AND ST_DWithin(
    worker.location_geo,
    ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
    :radiusMeters
  )
ORDER BY ST_Distance(
  worker.location_geo,
  ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
) ASC;
```

---

## 4. Automated Testing & Verification
Implemented in [`tests/postgisSpatialParity.test.ts`](../../tests/postgisSpatialParity.test.ts):
1. **Extension Verification**: Verifies `postgis` extension is active in `pg_extension`.
2. **Geodesic Calculation**: Proves `ST_Distance` computes accurate physical distances in meters.
3. **Boundary Testing**: Validates inclusion for workers within radius and exclusion for workers outside radius.
4. **Candidate Query Integration**: Tests the end-to-end `getEligibleCandidatePage` dispatch query against live PostgreSQL spatial records.

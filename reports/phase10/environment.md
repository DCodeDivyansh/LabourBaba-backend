# Phase 10 — Test Environment Specification

## System & Host Infrastructure
- **Operating System:** Windows 11 Enterprise (AMD64 / win32)
- **Node.js Version:** `v22.16.0`
- **npm Version:** `10.9.2`
- **TypeScript:** `5.8.2`
- **CPU Cores:** 12 logical cores (AMD Ryzen 5 7600X 6-Core Processor)
- **RAM Total:** 32,544 MB (32 GB DDR5)
- **Git Commit SHA:** `b258051695592e731cf00755bf810d22c41a025c`
- **Execution Date:** 2026-09-25T17:06:42Z (Local: 2026-09-25 22:36:42 IST)

## Isolated Containerized Runtime Dependencies
- **PostgreSQL Version:** PostgreSQL 17.5 (Debian 17.5-1.pgdg120+1)
- **PostGIS Version:** PostGIS 3.5.2 (`3.5 USE_GEOS=1 USE_PROJ=1 USE_STATS=1`)
  - Container: `labourbaba-capacity-postgres` (port `5434`, max_connections=300, shared_buffers=256MB, work_mem=16MB)
- **Redis Version:** Redis 7.4.2
  - Container: `labourbaba-capacity-redis` (port `6382`, maxclients=10000)
- **BullMQ Version:** `5.13.0`
- **Socket.IO Version:** `4.8.1`
- **autocannon Version:** `7.15.0`
- **Database Connection Pool:** Max 25 client pool (Node.js pg-pool)

## Workload Baseline Dataset
- **Total Registered Customers:** 9,000 accounts seeded
- **Total Registered Workers:** 1,000 accounts seeded
- **Total Online Workers:** 500 workers with live PostGIS geographic points (Delhi NCR cluster: lat ~28.6139, lng ~77.209)
- **Database User Volume:** 10,000 registered entities + 1,730 historical entities

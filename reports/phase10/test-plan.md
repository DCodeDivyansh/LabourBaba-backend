# Phase 10 — Load, Stress, Soak & Concurrency Test Plan

## Objective
To empirically evaluate the LabourBaba Backend runtime against the T0 Phase 10 standard:
1. Baseline to High-Concurrency HTTP API workload (100 to 10,000 requests / virtual concurrency).
2. Connected worker GPS ingestion under concurrent load (100, 250, 500 online workers).
3. Persistent authenticated Socket.IO connections (500 concurrent WebSockets).
4. Dispatch and booking state machine correctness under heavy race conditions (50 concurrent acceptances on 2 available requirement slots).
5. Post-load relational correctness invariant audit in PostgreSQL.
6. Fault tolerance and graceful degradation under Redis pause/recovery.
7. Sustained soak stability monitoring (heap, RSS slope, event loop lag).

## Progression Tiers
| Level | Virtual Concurrency | Target Requests | Scope / Routes |
|---|---|---|---|
| LEVEL 1 | 100 | 500 | Baseline HTTP latency (`/health/live`, `/health/ready`, `/api/jobs`) |
| LEVEL 2 | 500 (300 cap) | 1,500 | Early contention probe |
| LEVEL 3 | 1,000 (300 cap) | 3,000 | Medium load throughput |
| LEVEL 4 | 2,500 (300 cap) | 5,000 | Scaling boundary / peak throughput |
| LEVEL 5 | 5,000 (300 cap) | 7,500 | High load latency curve |
| LEVEL 6 | 10,000 (300 cap) | 10,000 | Volume saturation test |

## Hardware & OS Boundary Constraints
- Single-host load generation caps autocannon at 300 concurrent TCP sockets to prevent ephemeral port starvation on Windows.
- 10,000 active concurrent WebSocket clients on a single developer machine requires distributed multi-node load injectors (k6 distributed cluster); single-node evaluation was capped at 500 simultaneous persistent Socket.IO connections.

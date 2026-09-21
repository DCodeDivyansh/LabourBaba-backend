# LabourBaba Backend — State Machines Specification

This document formalizes all canonical state machines across the LabourBaba backend, detailing legal transitions, guards, actors, database invariants, and side effects.

---

## 1. Authentication & Session State Machines

### 1.1 Refresh Session Lifecycle
```
[Created] -> ACTIVE -> (Token Rotation) -> REVOKED
                   \-> (User Logout)    -> REVOKED
                   \-> (Suspension)     -> REVOKED
                   \-> (Time Expiry)    -> EXPIRED
```
- **Allowed States**: `ACTIVE`, `REVOKED`, `EXPIRED`
- **Guards**: 
  - Token lookup uses SHA-256 hashed token secret.
  - If a `REVOKED` token is presented, all descendant tokens in the family (`family_id`) are revoked immediately (Reuse Attack Detection).
- **PostgreSQL Invariant**: `CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED'))`

### 1.2 Phone OTP Verification Lifecycle
```
[Generated] -> ACTIVE -> (Valid Code Submitted) -> CONSUMED
                      \-> (TTL Elapsed)         -> EXPIRED
                      \-> (Max Attempts > 5)    -> LOCKED
```
- **Allowed States**: `ACTIVE`, `CONSUMED`, `EXPIRED`, `LOCKED`
- **Guards**:
  - Atomic consumption query prevents double verification races.
  - Phone & IP sliding window rate limiters enforce anti-brute force rules.

---

## 2. Marketplace & Dispatch State Machines

### 2.1 Job Lifecycle
```
DRAFT -> OPEN -> IN_PROGRESS -> COMPLETED
             \-> CANCELLED   \-> CANCELLED
```

### 2.2 Job Requirement Lifecycle
```
PENDING -> DISPATCHING -> PARTIALLY_FILLED -> FILLED -> COMPLETED
                      \-> CANCELLED       \-> CANCELLED \-> EXPIRED
```

### 2.3 Booking Lifecycle
```
[Created] -> PENDING -> CONFIRMED -> IN_PROGRESS -> COMPLETED
                    \-> CANCELLED              \-> CANCELLED
```
- **Atomic Transition Invariant**:
  - When all requirements for a job reach `COMPLETED`, the parent `Job` is transitioned to `COMPLETED` within the same database transaction.
  - State mutations atomically emit an audit record to `audit_log` and an outbox event to `notification_outbox`.

---

## 3. Payment & Refund State Machines

### 3.1 Payment Lifecycle
```
[Intent Created] -> PENDING -> (Webhook / Capture)   -> COMPLETED
                            \-> (Provider Failure)  -> FAILED
                            \-> (Reconciliation)    -> QUARANTINED
```

### 3.2 Refund Lifecycle
```
COMPLETED -> (Atomic Claim) -> REFUND_PENDING -> (Razorpay Success) -> REFUNDED
                                             \-> (Provider Failure) -> REFUND_FAILED
```
- **Concurrency Guard**:
  ```sql
  UPDATE payment
  SET status = 'REFUND_PENDING', updated_at = NOW()
  WHERE id = $1 AND status = 'COMPLETED';
  ```
  Only the claimant securing 1 affected row proceeds to invoke the Razorpay API.

---

## 4. Notification Outbox Lifecycle
```
[Created] -> PENDING -> (Worker Claim) -> PROCESSING -> (Delivered) -> SENT
                                                    \-> (Max Retries) -> FAILED
                                                    \-> (Transient)  -> PENDING (backoff)
```
- **Distributed Claim Strategy**:
  ```sql
  SELECT * FROM notification_outbox
  WHERE status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= NOW())
  ORDER BY created_at ASC
  LIMIT 50
  FOR UPDATE SKIP LOCKED;
  ```

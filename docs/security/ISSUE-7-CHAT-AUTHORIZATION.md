# Issue 7 — Chat HTTP + Socket.IO Authorization

## 1. Status
**RESOLVED**

- **Priority:** P0  
- **Category:** Security / Privacy  
- **Original Audit Mapping:** Audit Finding #17  

---

## 2. Problem

Chat represents private marketplace communication between a customer and an assigned worker during an active job booking. Because real-time chat architectures typically span both HTTP REST endpoints (history retrieval, offline message posting) and WebSocket/Socket.IO connections (real-time message streaming, typing indicators, room membership), securing only one transport leaves a trivial bypass:
- If HTTP checks participant authorization but Socket.IO allows arbitrary clients to join `booking:<bookingId>`, an unauthorized customer or worker can passively eavesdrop on real-time conversations.
- If Socket.IO derives sender identity from client payload bodies (`payload.sender_id` or `payload.customer_id`), an attacker can impersonate another marketplace principal.
- If route or event parameters are unvalidated, malformed identifiers cause database exceptions and timing leaks.

Therefore, authorization and identity derivation must be unified, authoritative, and strictly relationship-backed across every HTTP and Socket.IO entry point.

---

## 3. Root Cause Analysis of Pre-Remediation Source

An audit of the pre-remediation codebase revealed several specific vulnerabilities:

1. **Unvalidated HTTP Parameters & Request Bodies:**
   - In `src/features/chat/chatRoutes.ts`, `GET /:bookingId/messages` and `POST /:bookingId/messages` lacked parameter validation (`validateParams(BookingIdParamSchema)`). Malformed UUIDs were passed directly to Prisma.
   - `POST /:bookingId/messages` lacked body validation (`validateBody`). While the controller extracted `content`, client payloads containing spoofed identity fields (`sender_id`, `customer_id`, `worker_id`) were not strictly rejected.
2. **Permissive Service Fallbacks:**
   - In `src/features/chat/chatServices.ts`, `getMessages` and `sendMessage` made `actor` optional. If an internal or legacy caller invoked `sendMessage(bookingId, senderId, content)` without passing an `actor`, the service relied on client-supplied `senderId` to check against `booking.customer_id` and `booking.worker_id`, allowing identity impersonation.
   - `getOrCreateConversation` executed un-scoped `prisma.booking.findUnique({ where: { id: bookingId } })` without reusing pre-authorized relationship context.
3. **Hard-Coded Socket Room Names & Namespace Collisions:**
   - Socket room strings like `booking:${bookingId}`, `worker:${userId}`, and `customer:${userId}` were manually concatenated across multiple files, creating room for divergence and injection.
4. **Socket Payload Validation Gaps:**
   - In `src/socket/socketHandlers.ts`, `join:booking` and `chat:message` only checked truthiness (`if (!bookingId)`), allowing non-UUID strings to reach the database.
   - Socket alias `join:chat` was missing, forcing inconsistent event conventions.

---

## 4. Security & Authorization Model

Authorization is strictly relationship-backed and identical across both transports:

```
                  ┌──────────────────────────────────────────────┐
                  │     Incoming Operation (HTTP or Socket)      │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │  Token Cryptographic Verification (JWT HS256)│  ──> 401 Unauthorized
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │  Strict Zod Schema / UUID Param Validation   │  ──> 400 Bad Request
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ Authoritative Principal (req.user / socket)  │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ Query Pushdown (chatPolicy.scopeBooking)     │
                  │ - Customer: customer_id = user.id            │
                  │ - Worker:   worker_id = user.id              │
                  │ - Admin:    unrestricted                     │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │     Centralized chatPolicy Evaluation        │  ──> 403 Forbidden
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │  Execute Operation & Map to ChatMessageDTO   │
                  └──────────────────────────────────────────────┘
```

### 4.1 Relationship Invariants
1. **Customer:**
   - May read messages, send messages, and join socket rooms **only** for bookings where `booking.customer_id === user.id`.
2. **Worker:**
   - May read messages, send messages, and join socket rooms **only** for bookings where `booking.worker_id === user.id`.
   - Mere knowledge of a booking UUID grants zero access.
3. **Platform Admin:**
   - Explicitly permitted platform-wide read and send access for dispute mediation and support.
4. **Unrelated Principal:**
   - Rejected with `403 Forbidden` (or `404 Not Found` if booking does not exist), with zero leak of participant identity or message history.

---

## 5. Socket Room Security & Canonical Room Naming

A room name is not an authorization token. Clients are never permitted to join or broadcast to arbitrary room namespaces.

### Canonical Room Helpers (`src/socket/roomHelpers.ts`)
```typescript
export function getBookingChatRoom(bookingId: string): string {
  return `booking:${bookingId}`;
}

export function getWorkerPersonalRoom(workerId: string): string {
  return `worker:${workerId}`;
}

export function getCustomerPersonalRoom(customerId: string): string {
  return `customer:${customerId}`;
}

export function getAdminPersonalRoom(adminId: string): string {
  return `admin:${adminId}`;
}
```

### Joining Protocol:
1. Sockets automatically join their personal room (`worker:<id>` or `customer:<id>`) during connection based solely on `socket.data.user.id`.
2. To join a booking room (`join:booking` or alias `join:chat`):
   - Server validates that `payload.bookingId` is a valid UUID.
   - Server executes `chatPolicy.scopeBooking(user, bookingId)` and evaluates `chatPolicy.canJoinRoom(user, booking)`.
   - `socket.join(...)` is called **only after** policy authorization passes.

---

## 6. Message Sender Identity Invariant

> **NON-NEGOTIABLE:** The author/sender of a chat message is **always derived server-side** from the authenticated principal:
> - In HTTP: `req.user.id` (extracted from the cryptographically verified JWT access token).
> - In Socket.IO: `socket.data.user.id` (extracted from handshake token verification).
>
> Any client-supplied `sender_id`, `customer_id`, `worker_id`, or `user_id` in request bodies or socket event payloads is strictly rejected (via `.strict()` Zod schemas) or ignored.

---

## 7. Data Exposure & DTO Boundary

Raw Prisma entities (`conversation`, `message`, `booking`) never cross HTTP or Socket.IO response boundaries.
All messages are serialized through the explicit allowlist mapper `toChatMessageDTO`:

```typescript
export interface ChatMessageDTO {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  sent_at: Date | null;
}
```

Internal database columns, foreign keys, or participant credentials cannot leak.

---

## 8. Error Semantics & Status Codes

- `401 Unauthorized` (`UNAUTHORIZED`): Missing, expired, or invalid JWT authentication.
- `400 Bad Request` (`INVALID_REQUEST`): Malformed UUID, missing content, content exceeding 2000 characters, or client attempting to pass disallowed fields (`sender_id`).
- `403 Forbidden` (`FORBIDDEN` / `NOT_PARTICIPANT`): Authenticated user is not an authorized participant of the booking/conversation.
- `404 Not Found` (`RESOURCE_NOT_FOUND`): The requested booking does not exist.

---

## 9. Verification & Test Matrix

The dedicated regression test suite [`tests/chatSecurity.test.ts`](file:///e:/LabourBaba/LabourBaba-backend/tests/chatSecurity.test.ts) covers 32 comprehensive test scenarios:

1. **HTTP Authentication & 4-Way Cross-IDOR Authorization:**
   - Anonymous history retrieval rejected (401).
   - Anonymous message sending rejected (401).
   - Customer A retrieves Customer A's booking chat history (200).
   - Customer B rejected from Customer A's chat history (403/404).
   - Worker A retrieves Customer A's booking chat history (200).
   - Worker B rejected from Worker A's booking chat history (403/404).
   - Customer B retrieves Customer B's booking chat history (Booking B) (200).
   - Worker B retrieves Booking B chat history (200).
   - Customer A rejected from Customer B's booking chat history (Booking B) (403/404).
   - Worker A rejected from Booking B chat history (403/404).
   - Platform Admin retrieves chat history for any booking (200).
   - Malformed `bookingId` rejected before database lookup (400).
   - Nonexistent booking returns 404 Not Found.
2. **HTTP Message Creation & Identity Spoofing:**
   - Customer A sends message to own booking (201).
   - Customer B rejected from sending message to Customer A's booking (403/404).
   - Worker A sends message to assigned booking (201).
   - Worker B rejected from sending message to Worker A's booking (403/404).
   - Customer A rejected from sending message to Booking B (403/404).
   - Worker A rejected from sending message to Booking B (403/404).
   - Client body with injected `sender_id` rejected by strict schema (400).
   - Chat message DTO verified to not leak sensitive internal database fields.
3. **Socket.IO Room Joining, Messaging & Cross-Room Isolation:**
   - Unauthenticated handshake rejected.
   - Suspended worker socket connection rejected during handshake.
   - Customer A joins Booking A room via `join:booking` and alias `join:chat`.
   - Worker A joins Booking A room via `join:booking`.
   - Customer B rejected from joining Customer A's Booking A room (FORBIDDEN, not joined).
   - Worker B rejected from joining Worker A's Booking A room (FORBIDDEN, not joined).
   - Customer A rejected from joining Booking B room (FORBIDDEN, not joined).
   - Worker A rejected from joining Booking B room (FORBIDDEN, not joined).
   - Malformed `bookingId` rejected on socket event (INVALID_REQUEST).
   - Customer A sends `chat:message` -> emitted to canonical room with authoritative `sender_id`.
   - Customer B rejected from sending `chat:message` on Customer A's booking (FORBIDDEN).
   - Cross-Room Isolation: Booking A broadcast is NOT received by Booking B participants.
4. **Service-Layer Direct Invariants & Concurrency:**
   - `chatService.getMessages` throws 401 when `actor` is missing.
   - `chatService.sendMessage` throws 401 when `actor` is missing.
   - `chatService.sendMessage` overrides any passed `senderId` with `actor.id`.
   - Concurrent messages sent to `chatService` are all processed with correct sender identity and conversation binding.

---

## 10. Files Changed

| File | Purpose |
|---|---|
| [`src/schemas/index.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/schemas/index.ts) | Added `SendChatMessageBodySchema` with `.strict()`; exported `isValidIdentifier`. |
| [`src/type/api_req.type.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/type/api_req.type.ts) | Exported `SendChatMessageBody` type. |
| [`src/socket/roomHelpers.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/socket/roomHelpers.ts) | Created canonical room naming helpers (`getBookingChatRoom`, etc.). |
| [`src/policies/chat.policy.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/policies/chat.policy.ts) | Hardened role checks and booking room forbidden reason. |
| [`src/features/chat/chatServices.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/features/chat/chatServices.ts) | Made `actor` mandatory; enforced server-derived `actor.id` sender; scoped queries; handled concurrent creation races. |
| [`src/features/chat/chatController.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/features/chat/chatController.ts) | Handled `AuthorizationError`; added canonical room socket broadcast on message send. |
| [`src/features/chat/chatRoutes.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/features/chat/chatRoutes.ts) | Mounted `validateParams(BookingIdParamSchema)` and `validateBody(SendChatMessageBodySchema)`. |
| [`src/socket/socketHandlers.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/socket/socketHandlers.ts) | Integrated room helpers, input validation, `join:chat` alias, and authoritative sender derivation. |
| [`tests/chatSecurity.test.ts`](file:///e:/LabourBaba/LabourBaba-backend/tests/chatSecurity.test.ts) | Dedicated 32-scenario automated security test suite covering 4-way cross-IDOR, cross-room isolation, and concurrency. |

---

## 11. Database Migration

No database migration was required because the existing schema (`booking`, `conversation`, `message`) already represented the required participant relationships.

---

## 12. Security Invariants Now Guaranteed

1. **Strict Participant Isolation:** A user cannot read another user's chat history.
2. **Legitimate Message Creation:** A user cannot send a message to a booking they do not participate in.
3. **Authorized Room Membership:** A socket cannot join an unauthorized chat room.
4. **Authoritative Sender Identity:** Client-provided identity cannot override authenticated identity.
5. **Deterministic Room Naming:** Room names are not authorization credentials and are server-derived.
6. **Transport Parity:** HTTP and Socket.IO use the exact same authorization policy (`chatPolicy`).
7. **No Global Broadcasts:** Private chat messages are emitted exclusively to the authorized booking room.

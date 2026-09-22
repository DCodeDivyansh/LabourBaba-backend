/**
 * Centralized, Deterministic Socket.IO Room Naming Helpers
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Room names are ALWAYS server-derived and deterministic.
 * 2. Clients CANNOT specify arbitrary room namespaces.
 * 3. All socket joins and broadcasts MUST use these canonical helpers.
 */

/**
 * Returns the canonical booking chat room name.
 * Used for in-booking real-time chat between customer, assigned worker, and admin.
 */
export function getBookingChatRoom(bookingId: string): string {
  return `booking:${bookingId}`;
}

/**
 * Returns the canonical worker personal room name.
 * Used for direct worker notifications and dispatches.
 */
export function getWorkerPersonalRoom(workerId: string): string {
  return `worker:${workerId}`;
}

/**
 * Returns the canonical customer personal room name.
 * Used for direct customer notifications and worker location streaming.
 */
export function getCustomerPersonalRoom(customerId: string): string {
  return `customer:${customerId}`;
}

/**
 * Returns the canonical admin personal room name.
 */
export function getAdminPersonalRoom(adminId: string): string {
  return `admin:${adminId}`;
}

/**
 * Returns the canonical job updates room name.
 */
export function getJobRoom(jobId: string): string {
  return `job:${jobId}`;
}

/**
 * Returns the canonical requirement updates room name.
 */
export function getRequirementRoom(requirementId: string): string {
  return `requirement:${requirementId}`;
}

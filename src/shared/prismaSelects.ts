import { Prisma } from "@prisma/client";

/**
 * Explicit Prisma Allow-List Selects & DTO Mappers
 *
 * NON-NEGOTIABLE INVARIANT:
 * Raw Prisma entities must never cross an HTTP or Socket.IO boundary.
 * All queries crossing API boundaries MUST use explicit allow-listed
 * Prisma selects, and responses must be mapped through explicit DTO mappers.
 * Never use object spread (`...worker`), broad `include: true`, or ad-hoc field deletion.
 */

// ── 1. PRISMA SELECT ALLOW-LISTS ─────────────────────────────────────────────

/**
 * Worker select for public views (job bookings, dispatches, reviews).
 * Strictly excludes password, device_token, aadhaar_last4, decline_count, timeout_count.
 */
export const workerPublicSelect = {
  id: true,
  name: true,
  skill_type: true,
  worker_score: true,
  is_online: true,
  skill_category_id: true,
} satisfies Prisma.WorkerSelect;

/**
 * Worker select for authenticated worker viewing their own profile (/api/workers/me).
 * Excludes password and device_token.
 */
export const workerSelfSelect = {
  id: true,
  name: true,
  phone: true,
  skill_type: true,
  worker_score: true,
  is_online: true,
  skill_category_id: true,
  aadhaar_last4: true,
  verification_status: true,
  skill_category: true,
} satisfies Prisma.WorkerSelect;

/**
 * Worker select for administrative operations (/api/admin/workers).
 * Excludes password, device_token, and raw permanent document URLs.
 */
export const workerAdminSelect = {
  id: true,
  name: true,
  phone: true,
  skill_type: true,
  worker_score: true,
  is_online: true,
  skill_category_id: true,
  aadhaar_last4: true,
  verification_status: true,
  decline_count: true,
  timeout_count: true,
} satisfies Prisma.WorkerSelect;

/**
 * Customer select for public/list views (/api/clients).
 * Excludes password and deleted_at.
 */
export const customerPublicSelect = {
  id: true,
  name: true,
  phone: true,
  created_at: true,
} satisfies Prisma.customerSelect;

/**
 * Customer select for nested relations in bookings, jobs, dispatches.
 * Excludes password and deleted_at.
 */
export const customerSummarySelect = {
  id: true,
  name: true,
  phone: true,
} satisfies Prisma.customerSelect;

/**
 * Customer select for self profile (/api/clients/me).
 * Excludes password and deleted_at.
 */
export const customerSelfSelect = {
  id: true,
  name: true,
  phone: true,
  created_at: true,
} satisfies Prisma.customerSelect;

/**
 * Booking safe select.
 * Strictly excludes otp_hash.
 */
export const bookingSafeSelect = {
  id: true,
  job_id: true,
  requirement_id: true,
  worker_id: true,
  customer_id: true,
  status: true,
  otp_verified: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.bookingSelect;

/**
 * Payment safe select.
 * Excludes internal secret fields.
 */
export const paymentSafeSelect = {
  id: true,
  booking_id: true,
  razorpay_order_id: true,
  status: true,
  amount: true,
} satisfies Prisma.paymentSelect;

// ── 2. EXPLICIT DTO MAPPERS ──────────────────────────────────────────────────

export interface WorkerPublicDTO {
  id: string;
  name: string;
  skill_type: string;
  worker_score: any;
  is_online: boolean | null;
  skill_category_id: string;
  latitude?: number | null;
  longitude?: number | null;
}

export function toWorkerPublicDTO(worker: any): WorkerPublicDTO | null {
  if (!worker) return null;
  return {
    id: worker.id,
    name: worker.name,
    skill_type: worker.skill_type,
    worker_score: worker.worker_score ?? null,
    is_online: worker.is_online ?? null,
    skill_category_id: worker.skill_category_id,
    latitude: worker.latitude ?? null,
    longitude: worker.longitude ?? null,
  };
}

export interface WorkerSelfProfileDTO {
  id: string;
  name: string;
  phone: string;
  skill_type: string;
  skill_category_id: string;
  worker_score?: any;
  is_online?: boolean | null;
  aadhaar_last4?: string | null;
  verification_status?: string | null;
  skill_category?: any;
}

export function toWorkerSelfDTO(worker: any): WorkerSelfProfileDTO | null {
  if (!worker) return null;
  const dto: WorkerSelfProfileDTO = {
    id: worker.id,
    name: worker.name,
    phone: worker.phone,
    skill_type: worker.skill_type,
    skill_category_id: worker.skill_category_id,
  };
  if (worker.worker_score !== undefined) dto.worker_score = worker.worker_score;
  if (worker.is_online !== undefined) dto.is_online = worker.is_online;
  if (worker.aadhaar_last4 !== undefined) dto.aadhaar_last4 = worker.aadhaar_last4;
  if (worker.verification_status !== undefined) dto.verification_status = worker.verification_status;
  if (worker.skill_category !== undefined) dto.skill_category = worker.skill_category;
  return dto;
}

export interface WorkerAdminDTO {
  id: string;
  name: string;
  phone: string;
  skill_type: string;
  skill_category_id: string;
  worker_score?: any;
  is_online?: boolean | null;
  aadhaar_last4?: string | null;
  verification_status?: string | null;
  decline_count?: number | null;
  timeout_count?: number | null;
}

export function toWorkerAdminDTO(worker: any): WorkerAdminDTO | null {
  if (!worker) return null;
  const dto: WorkerAdminDTO = {
    id: worker.id,
    name: worker.name,
    phone: worker.phone,
    skill_type: worker.skill_type,
    skill_category_id: worker.skill_category_id,
  };
  if (worker.worker_score !== undefined) dto.worker_score = worker.worker_score;
  if (worker.is_online !== undefined) dto.is_online = worker.is_online;
  if (worker.aadhaar_last4 !== undefined) dto.aadhaar_last4 = worker.aadhaar_last4;
  if (worker.verification_status !== undefined) dto.verification_status = worker.verification_status;
  if (worker.decline_count !== undefined) dto.decline_count = worker.decline_count;
  if (worker.timeout_count !== undefined) dto.timeout_count = worker.timeout_count;
  return dto;
}

export interface CustomerSummaryDTO {
  id: string;
  name: string;
  phone: string;
}

export function toCustomerSummaryDTO(customer: any): CustomerSummaryDTO | null {
  if (!customer) return null;
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
  };
}

export interface CustomerSelfDTO {
  id: string;
  name: string;
  phone: string;
  created_at: Date | null;
}

export function toCustomerSelfDTO(customer: any): CustomerSelfDTO | null {
  if (!customer) return null;
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    created_at: customer.created_at ?? null,
  };
}

export interface CustomerPublicDTO {
  id: string;
  name: string;
  phone: string;
  created_at?: Date | null;
}

export function toCustomerPublicDTO(customer: any): CustomerPublicDTO | null {
  if (!customer) return null;
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    created_at: customer.created_at ?? null,
  };
}

export function toDispatchDTO(dispatch: any): any {
  if (!dispatch) return null;
  const d = { ...dispatch };
  if (d.job_requirement?.job?.customer) {
    d.job_requirement = {
      ...d.job_requirement,
      job: {
        ...d.job_requirement.job,
        customer: toCustomerSummaryDTO(d.job_requirement.job.customer),
      },
    };
  }
  return d;
}

export interface BookingSafeDTO {
  id: string;
  job_id: string;
  requirement_id: string;
  worker_id: string;
  customer_id: string;
  status: string | null;
  otp_verified: boolean | null;
  created_at: Date;
  updated_at: Date;
  job?: any;
  worker?: any;
  customer?: any;
  review?: any;
  payment?: any;
  job_requirement?: any;
}

export function toBookingDTO(b: any): BookingSafeDTO | null {
  if (!b) return null;
  return {
    id: b.id,
    job_id: b.job_id,
    requirement_id: b.requirement_id,
    worker_id: b.worker_id,
    customer_id: b.customer_id,
    status: b.status ?? null,
    otp_verified: b.otp_verified ?? null,
    created_at: b.created_at,
    updated_at: b.updated_at,
    job: b.job ?? undefined,
    worker: b.worker ? toWorkerPublicDTO(b.worker) : undefined,
    customer: b.customer ? toCustomerSummaryDTO(b.customer) : undefined,
    review: b.review ?? undefined,
    payment: b.payment ?? undefined,
    job_requirement: b.job_requirement ?? undefined,
  };
}

export interface AuthUserDTO {
  id: string;
  name: string;
  phone: string;
}

export function toAuthUserDTO(user: any): AuthUserDTO | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
  };
}

import { Prisma } from "@prisma/client";

/**
 * Explicit Prisma Allow-List Selects & DTO Mappers
 *
 * NON-NEGOTIABLE INVARIANT:
 * Raw Prisma entities must never cross an HTTP or Socket.IO boundary.
 * All queries crossing API boundaries MUST use explicit allow-listed
 * Prisma selects where appropriate, and all external responses MUST be mapped
 * through explicit DTO mappers.
 *
 * NEVER use object spread (`...worker`, `{ ...dispatch }`), broad `include: true`,
 * or ad-hoc field deletion (`delete obj.password`).
 *
 * Adding a new column to Prisma will NEVER leak it to clients because every DTO
 * mapper is an explicit allowlist constructor.
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
  started_at: true,
  completion_requested_at: true,
  completed_at: true,
  cancelled_at: true,
  cancelled_by: true,
  cancellation_reason: true,
  confirmed_by: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.bookingSelect;

/**
 * Payment safe select.
 * Excludes internal secret fields (idempotency_key, razorpay_signature, etc.).
 */
export const paymentSafeSelect = {
  id: true,
  booking_id: true,
  razorpay_order_id: true,
  razorpay_payment_id: true,
  status: true,
  amount: true,
  currency: true,
} satisfies Prisma.paymentSelect;

/**
 * Review safe select.
 */
export const reviewSafeSelect = {
  id: true,
  booking_id: true,
  worker_id: true,
  customer_id: true,
  rating: true,
  comment: true,
} satisfies Prisma.reviewSelect;

// ── 2. EXPLICIT DTO INTERFACES & MAPPERS ────────────────────────────────────

// ── WORKER DTOs ─────────────────────────────────────────────────────────────

export interface WorkerPublicDTO {
  id: string;
  name: string;
  skill_type: string;
  worker_score?: number | null;
  is_online?: boolean | null;
  skill_category_id: string;
  phone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export function toWorkerPublicDTO(worker: any): WorkerPublicDTO | null {
  if (!worker) return null;
  const dto: WorkerPublicDTO = {
    id: worker.id,
    name: worker.name,
    skill_type: worker.skill_type,
    skill_category_id: worker.skill_category_id,
  };
  if (worker.worker_score !== undefined) dto.worker_score = worker.worker_score;
  if (worker.is_online !== undefined) dto.is_online = worker.is_online;
  if (worker.phone !== undefined) dto.phone = worker.phone;
  if (worker.latitude !== undefined) dto.latitude = worker.latitude;
  if (worker.longitude !== undefined) dto.longitude = worker.longitude;
  return dto;
}

export interface WorkerSelfProfileDTO {
  id: string;
  name: string;
  phone: string;
  skill_type: string;
  skill_category_id: string;
  worker_score?: number | null;
  is_online?: boolean | null;
  aadhaar_last4?: string | null;
  verification_status?: string | null;
  skill_category?: SkillCategoryDTO | null;
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
  if (worker.skill_category !== undefined) {
    dto.skill_category = worker.skill_category ? toSkillCategoryDTO(worker.skill_category) : null;
  }
  return dto;
}

export interface WorkerAdminDTO {
  id: string;
  name: string;
  phone: string;
  skill_type: string;
  skill_category_id: string;
  worker_score: number | null;
  is_online: boolean | null;
  aadhaar_last4: string | null;
  verification_status: string | null;
  decline_count: number | null;
  timeout_count: number | null;
}

export function toWorkerAdminDTO(worker: any): WorkerAdminDTO | null {
  if (!worker) return null;
  return {
    id: worker.id,
    name: worker.name,
    phone: worker.phone,
    skill_type: worker.skill_type,
    skill_category_id: worker.skill_category_id,
    worker_score: worker.worker_score !== undefined ? worker.worker_score : null,
    is_online: worker.is_online !== undefined ? worker.is_online : null,
    aadhaar_last4: worker.aadhaar_last4 !== undefined ? worker.aadhaar_last4 : null,
    verification_status: worker.verification_status !== undefined ? worker.verification_status : null,
    decline_count: worker.decline_count !== undefined ? worker.decline_count : null,
    timeout_count: worker.timeout_count !== undefined ? worker.timeout_count : null,
  };
}

export interface WorkerDocumentDTO {
  id: string;
  worker_id: string;
  document_type: string | null;
  file_url: string | null;
  status: string | null;
}

export function toWorkerDocumentDTO(doc: any): WorkerDocumentDTO | null {
  if (!doc) return null;
  return {
    id: doc.id,
    worker_id: doc.worker_id,
    document_type: doc.document_type !== undefined ? doc.document_type : null,
    file_url: doc.file_url !== undefined ? doc.file_url : null,
    status: doc.status !== undefined ? doc.status : null,
  };
}

export interface WorkerDocumentMetadataDTO {
  id: string;
  worker_id: string;
  document_type: string | null;
  status: string | null;
}

export function toWorkerDocumentMetadataDTO(doc: any): WorkerDocumentMetadataDTO | null {
  if (!doc) return null;
  return {
    id: doc.id,
    worker_id: doc.worker_id,
    document_type: doc.document_type !== undefined ? doc.document_type : null,
    status: doc.status !== undefined ? doc.status : null,
  };
}

export interface WorkerDocumentAccessDTO {
  document_id: string;
  worker_id: string;
  document_type: string | null;
  access_url: string;
  expires_in: number;
}

export function toWorkerDocumentAccessDTO(
  doc: any,
  accessUrl: string,
  expiresIn: number,
): WorkerDocumentAccessDTO | null {
  if (!doc) return null;
  return {
    document_id: doc.id,
    worker_id: doc.worker_id,
    document_type: doc.document_type !== undefined ? doc.document_type : null,
    access_url: accessUrl,
    expires_in: expiresIn,
  };
}

export interface WorkerAnalyticsDTO {
  id: string;
  worker_id: string;
  avg_response_time_s: number | null;
  acceptance_rate: number | null;
  completion_rate: number | null;
  calculated_at: Date | null;
}

export function toWorkerAnalyticsDTO(analytics: any): WorkerAnalyticsDTO | null {
  if (!analytics) return null;
  return {
    id: analytics.id,
    worker_id: analytics.worker_id,
    avg_response_time_s: analytics.avg_response_time_s !== undefined ? analytics.avg_response_time_s : null,
    acceptance_rate: analytics.acceptance_rate !== undefined ? analytics.acceptance_rate : null,
    completion_rate: analytics.completion_rate !== undefined ? analytics.completion_rate : null,
    calculated_at: analytics.calculated_at !== undefined ? analytics.calculated_at : null,
  };
}

export interface WorkerLocationDTO {
  id: string;
  worker_id: string;
  latitude: number | null;
  longitude: number | null;
  location: string | null;
  updated_at: Date | null;
}

export function toWorkerLocationDTO(loc: any): WorkerLocationDTO | null {
  if (!loc) return null;
  return {
    id: loc.id,
    worker_id: loc.worker_id,
    latitude: loc.latitude !== undefined ? loc.latitude : null,
    longitude: loc.longitude !== undefined ? loc.longitude : null,
    location: loc.location !== undefined ? loc.location : null,
    updated_at: loc.updated_at !== undefined ? loc.updated_at : null,
  };
}

// ── CUSTOMER DTOs ───────────────────────────────────────────────────────────

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
    created_at: customer.created_at !== undefined ? customer.created_at : null,
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
    created_at: customer.created_at !== undefined ? customer.created_at : null,
  };
}

export interface AuthUserDTO {
  id: string;
  name: string;
  phone: string;
  role?: string;
}

export function toAuthUserDTO(user: any): AuthUserDTO | null {
  if (!user) return null;
  const dto: AuthUserDTO = {
    id: user.id,
    name: user.name,
    phone: user.phone,
  };
  if (user.role) {
    dto.role = user.role;
  }
  return dto;
}

// ── SKILL CATEGORY DTO ──────────────────────────────────────────────────────

export interface SkillCategoryDTO {
  id: string;
  name: string;
}

export function toSkillCategoryDTO(skill: any): SkillCategoryDTO | null {
  if (!skill) return null;
  return {
    id: skill.id,
    name: skill.name,
  };
}

// ── JOB & REQUIREMENT DTOs ──────────────────────────────────────────────────

export interface JobRequirementDTO {
  id: string;
  job_id: string;
  skill_type?: string | null;
  worker_count_needed: number;
  worker_count_filled?: number | null;
  remaining_worker_count?: number;
  rate_per_day?: number | null;
  status?: string | null;
  current_wave?: number | null;
  wave_size?: number | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  job_dispatch?: DispatchDTO[];
  job?: JobDTO | null;
}

export function toJobRequirementDTO(req: any): JobRequirementDTO | null {
  if (!req) return null;
  const dto: JobRequirementDTO = {
    id: req.id,
    job_id: req.job_id,
    worker_count_needed: req.worker_count_needed,
  };
  if (req.skill_type !== undefined) dto.skill_type = req.skill_type;
  if (req.worker_count_filled !== undefined) {
    dto.worker_count_filled = req.worker_count_filled;
    dto.remaining_worker_count = Math.max(0, req.worker_count_needed - (req.worker_count_filled || 0));
  }
  if (req.rate_per_day !== undefined) dto.rate_per_day = req.rate_per_day;
  if (req.status !== undefined) dto.status = req.status;
  if (req.current_wave !== undefined) dto.current_wave = req.current_wave;
  if (req.wave_size !== undefined) dto.wave_size = req.wave_size;
  if (req.created_at !== undefined) dto.created_at = req.created_at;
  if (req.updated_at !== undefined) dto.updated_at = req.updated_at;
  if (Array.isArray(req.job_dispatch)) {
    dto.job_dispatch = req.job_dispatch.map(toDispatchDTO).filter(Boolean) as DispatchDTO[];
  }
  if (req.job) {
    dto.job = toJobDTO(req.job);
  }
  return dto;
}

export interface JobDTO {
  id: string;
  customer_id: string;
  latitude?: number | null;
  longitude?: number | null;
  location?: string | null;
  status?: string | null;
  dispatch_status?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  cancelled_at?: Date | null;
  cancelled_by?: string | null;
  completed_at?: Date | null;
  job_requirement?: JobRequirementDTO[];
  customer?: CustomerSummaryDTO | null;
  booking?: Array<{ worker_id: string }>;
}

export function toJobDTO(job: any): JobDTO | null {
  if (!job) return null;
  const dto: JobDTO = {
    id: job.id,
    customer_id: job.customer_id,
  };
  if (job.latitude !== undefined) dto.latitude = job.latitude;
  if (job.longitude !== undefined) dto.longitude = job.longitude;
  if (job.location !== undefined) dto.location = job.location;
  if (job.status !== undefined) dto.status = job.status;
  if (job.dispatch_status !== undefined) dto.dispatch_status = job.dispatch_status;
  if (job.created_at !== undefined) dto.created_at = job.created_at;
  if (job.updated_at !== undefined) dto.updated_at = job.updated_at;
  if (job.cancelled_at !== undefined) dto.cancelled_at = job.cancelled_at;
  if (job.cancelled_by !== undefined) dto.cancelled_by = job.cancelled_by;
  if (job.completed_at !== undefined) dto.completed_at = job.completed_at;
  if (Array.isArray(job.job_requirement)) {
    dto.job_requirement = job.job_requirement.map(toJobRequirementDTO).filter(Boolean) as JobRequirementDTO[];
  }
  if (job.customer) {
    dto.customer = toCustomerSummaryDTO(job.customer);
  }
  if (Array.isArray(job.booking)) {
    dto.booking = job.booking.map((b: any) => ({ worker_id: b.worker_id }));
  }
  return dto;
}

// ── DISPATCH DTOs ───────────────────────────────────────────────────────────

export interface DispatchDTO {
  id: string;
  requirement_id: string;
  worker_id: string;
  wave_number: number | null;
  wave_position: number | null;
  status: string | null;
  notified_at: Date | null;
  expires_at: Date | null;
  responded_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  job_requirement?: JobRequirementDTO | null;
}

export function toDispatchDTO(dispatch: any): DispatchDTO | null {
  if (!dispatch) return null;
  return {
    id: dispatch.id,
    requirement_id: dispatch.requirement_id,
    worker_id: dispatch.worker_id,
    wave_number: dispatch.wave_number !== undefined ? dispatch.wave_number : null,
    wave_position: dispatch.wave_position !== undefined ? dispatch.wave_position : null,
    status: dispatch.status !== undefined ? dispatch.status : null,
    notified_at: dispatch.notified_at !== undefined ? dispatch.notified_at : null,
    expires_at: dispatch.expires_at !== undefined ? dispatch.expires_at : null,
    responded_at: dispatch.responded_at !== undefined ? dispatch.responded_at : null,
    created_at: dispatch.created_at !== undefined ? dispatch.created_at : null,
    updated_at: dispatch.updated_at !== undefined ? dispatch.updated_at : null,
    job_requirement: dispatch.job_requirement ? toJobRequirementDTO(dispatch.job_requirement) : undefined,
  };
}

export interface DispatchWaveDTO {
  id: string;
  requirement_id: string;
  wave_number: number;
  status: string | null;
  notified_at: Date | null;
  resolved_at: Date | null;
  workers_notified: number | null;
  slots_filled: number | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export function toDispatchWaveDTO(wave: any): DispatchWaveDTO | null {
  if (!wave) return null;
  return {
    id: wave.id,
    requirement_id: wave.requirement_id,
    wave_number: wave.wave_number,
    status: wave.status !== undefined ? wave.status : null,
    notified_at: wave.notified_at !== undefined ? wave.notified_at : null,
    resolved_at: wave.resolved_at !== undefined ? wave.resolved_at : null,
    workers_notified: wave.workers_notified !== undefined ? wave.workers_notified : null,
    slots_filled: wave.slots_filled !== undefined ? wave.slots_filled : null,
    created_at: wave.created_at !== undefined ? wave.created_at : null,
    updated_at: wave.updated_at !== undefined ? wave.updated_at : null,
  };
}

// ── PAYMENT DTO ─────────────────────────────────────────────────────────────

export interface PaymentDTO {
  id: string;
  booking_id: string;
  razorpay_order_id: string | null;
  razorpay_payment_id?: string | null;
  status: string | null;
  amount: number | null;
  currency?: string | null;
}

export function toPaymentDTO(payment: any): PaymentDTO | null {
  if (!payment) return null;
  const dto: PaymentDTO = {
    id: payment.id,
    booking_id: payment.booking_id,
    razorpay_order_id: payment.razorpay_order_id !== undefined ? payment.razorpay_order_id : null,
    status: payment.status !== undefined ? payment.status : null,
    amount: payment.amount !== undefined ? payment.amount : null,
  };
  if (payment.razorpay_payment_id !== undefined) {
    dto.razorpay_payment_id = payment.razorpay_payment_id;
  }
  if (payment.currency !== undefined) {
    dto.currency = payment.currency;
  }
  return dto;
}

// ── REVIEW DTO ──────────────────────────────────────────────────────────────

export interface ReviewDTO {
  id: string;
  booking_id: string;
  worker_id: string;
  customer_id: string;
  rating: number | null;
  comment: string | null;
  created_at?: Date | null;
}

export function toReviewDTO(review: any): ReviewDTO | null {
  if (!review) return null;
  const dto: ReviewDTO = {
    id: review.id,
    booking_id: review.booking_id,
    worker_id: review.worker_id,
    customer_id: review.customer_id,
    rating: review.rating !== undefined ? review.rating : null,
    comment: review.comment !== undefined ? review.comment : null,
  };
  if (review.created_at !== undefined) {
    dto.created_at = review.created_at;
  }
  return dto;
}

// ── BOOKING DTO ─────────────────────────────────────────────────────────────

export interface BookingSafeDTO {
  id: string;
  job_id: string;
  requirement_id: string;
  worker_id: string;
  customer_id: string;
  status: string | null;
  otp_verified: boolean | null;
  started_at?: Date | null;
  completion_requested_at?: Date | null;
  completed_at?: Date | null;
  cancelled_at?: Date | null;
  cancelled_by?: string | null;
  cancellation_reason?: string | null;
  confirmed_by?: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  job?: JobDTO | null;
  worker?: WorkerPublicDTO | null;
  customer?: CustomerSummaryDTO | null;
  review?: ReviewDTO | null;
  payment?: PaymentDTO | null;
  job_requirement?: JobRequirementDTO | null;
}

export function toBookingDTO(b: any, actor?: any): BookingSafeDTO | null {
  if (!b) return null;
  const isWorker =
    typeof actor === "object" &&
    actor !== null &&
    (String(actor.role).toLowerCase() === "worker");
  return {
    id: b.id,
    job_id: b.job_id,
    requirement_id: b.requirement_id,
    worker_id: b.worker_id,
    customer_id: b.customer_id,
    status: b.status !== undefined ? b.status : null,
    otp_verified: b.otp_verified !== undefined ? b.otp_verified : null,
    started_at: b.started_at !== undefined ? b.started_at : undefined,
    completion_requested_at: b.completion_requested_at !== undefined ? b.completion_requested_at : undefined,
    completed_at: b.completed_at !== undefined ? b.completed_at : undefined,
    cancelled_at: b.cancelled_at !== undefined ? b.cancelled_at : undefined,
    cancelled_by: b.cancelled_by !== undefined ? b.cancelled_by : undefined,
    cancellation_reason: b.cancellation_reason !== undefined ? b.cancellation_reason : undefined,
    confirmed_by: b.confirmed_by !== undefined ? b.confirmed_by : undefined,
    created_at: b.created_at !== undefined ? b.created_at : null,
    updated_at: b.updated_at !== undefined ? b.updated_at : null,
    job: b.job ? toJobDTO(b.job) : undefined,
    worker: b.worker ? toWorkerPublicDTO(b.worker) : undefined,
    customer: b.customer ? toCustomerSummaryDTO(b.customer) : undefined,
    review: b.review ? toReviewDTO(b.review) : undefined,
    payment: isWorker || !b.payment ? undefined : toPaymentDTO(b.payment),
    job_requirement: b.job_requirement ? toJobRequirementDTO(b.job_requirement) : undefined,
  };
}

// ── CHAT DTOs ───────────────────────────────────────────────────────────────

export interface ChatMessageDTO {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string | null;
  sent_at: Date | null;
}

export function toChatMessageDTO(msg: any): ChatMessageDTO | null {
  if (!msg) return null;
  return {
    id: msg.id,
    conversation_id: msg.conversation_id,
    sender_id: msg.sender_id,
    content: msg.content !== undefined ? msg.content : null,
    sent_at: msg.sent_at !== undefined ? msg.sent_at : null,
  };
}

export interface ConversationDTO {
  id: string;
  booking_id: string;
  worker_id: string;
  customer_id: string;
}

export function toConversationDTO(convo: any): ConversationDTO | null {
  if (!convo) return null;
  return {
    id: convo.id,
    booking_id: convo.booking_id,
    worker_id: convo.worker_id,
    customer_id: convo.customer_id,
  };
}

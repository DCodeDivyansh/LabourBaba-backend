import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// Extend Zod with OpenAPI capabilities
extendZodWithOpenApi(z);

// --- Enums ---

export const JobStatusSchema = z.enum(["OPEN", "DISPATCHING", "BOOKED", "COMPLETED", "CANCELLED"]).openapi({
  description: "Status of a job",
  example: "OPEN",
});

export const BookingStatusSchema = z.enum(["PENDING", "OTP_PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).openapi({
  description: "Status of a booking",
  example: "PENDING",
});

export const VerificationStatusSchema = z.enum(["PENDING", "VERIFIED", "REJECTED"]).openapi({
  description: "Status of worker verification",
  example: "PENDING",
});

export const DocumentTypeSchema = z.enum(["AADHAAR", "PAN", "SELFIE"]).openapi({
  description: "Type of worker verification document",
  example: "AADHAAR",
});

// --- Entities (Responses) ---

export const CustomerSchema = z.object({
  id: z.string().uuid().openapi({ description: "Unique UUID of the customer", example: "123e4567-e89b-12d3-a456-426614174000" }),
  phone: z.string().openapi({ example: "+919876543210" }),
  name: z.string().openapi({ example: "John Doe" }),
  created_at: z.date().nullable().optional().openapi({ example: "2026-06-25T00:00:00Z" }),
}).openapi("Customer");

export const WorkerSchema = z.object({
  id: z.string().uuid().openapi({ description: "Unique UUID of the worker" }),
  skill_category_id: z.string().uuid(),
  phone: z.string().openapi({ example: "+919876543211" }),
  name: z.string().openapi({ example: "John Worker" }),
  skill_type: z.string().openapi({ example: "Plumbing" }),
  worker_score: z.number().nullable().optional().openapi({ example: 5.0 }),
  is_online: z.boolean().nullable().optional().openapi({ example: false }),
  aadhaar_last4: z.string().length(4).nullable().optional().openapi({ example: "1234" }),
  verification_status: z.string().nullable().optional().openapi({ example: "pending" }),
  decline_count: z.number().int().nullable().optional(),
  timeout_count: z.number().int().nullable().optional(),
}).openapi("Worker");

export const SkillCategorySchema = z.object({
  id: z.string().uuid().openapi({ description: "Unique UUID of the skill category" }),
  name: z.string().openapi({ example: "Plumbing" }),
}).openapi("SkillCategory");

export const SkillCategorySchemaReqSchema = z.object({
  name: z.string().openapi({ example: "Plumbing" }),
}).openapi("SkillCategory");

export const JobSchema = z.object({
  id: z.string().uuid(),
  customer_id: z.string().uuid(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  dispatch_status: z.string().nullable().optional(),
  created_at: z.date().nullable().optional(),
}).openapi("Job");

export const JobRequirementSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  skill_type: z.string().nullable().optional(),
  worker_count_needed: z.number().int(),
  worker_count_filled: z.number().int().nullable().optional(),
  rate_per_day: z.number().int().nullable().optional(),
  status: z.string().nullable().optional(),
  current_wave: z.number().int().nullable().optional(),
  wave_size: z.number().int().nullable().optional(),
  created_at: z.date().nullable().optional(),
  updated_at: z.date().nullable().optional(),
}).openapi("JobRequirement");

export const JobDispatchSchema = z.object({
  id: z.string().uuid(),
  requirement_id: z.string().uuid(),
  worker_id: z.string().uuid(),
  wave_number: z.number().int().nullable().optional(),
  wave_position: z.number().int().nullable().optional(),
  status: z.string().nullable().optional(),
  notified_at: z.date().nullable().optional(),
  expires_at: z.date().nullable().optional(),
  responded_at: z.date().nullable().optional(),
  created_at: z.date().nullable().optional(),
  updated_at: z.date().nullable().optional(),
}).openapi("JobDispatch");

export const DispatchWaveSchema = z.object({
  id: z.string().uuid(),
  requirement_id: z.string().uuid(),
  wave_number: z.number().int(),
  status: z.string().nullable().optional(),
  notified_at: z.date().nullable().optional(),
  resolved_at: z.date().nullable().optional(),
  workers_notified: z.number().int().nullable().optional(),
  slots_filled: z.number().int().nullable().optional(),
  created_at: z.date().nullable().optional(),
  updated_at: z.date().nullable().optional(),
}).openapi("DispatchWave");

export const DispatchWavesResponseSchema = z.object({
  waves: z.array(DispatchWaveSchema),
  dispatches: z.array(JobDispatchSchema),
}).openapi("DispatchWavesResponse");

export const BookingSchema = z.object({
  id: z.string().uuid(),
  job_id: z.string().uuid(),
  requirement_id: z.string().uuid(),
  worker_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  status: z.string().nullable().optional(),
  otp_verified: z.boolean().nullable().optional(),
  created_at: z.date().nullable().optional(),
  updated_at: z.date().nullable().optional(),
}).openapi("Booking");

export const PaymentSchema = z.object({
  id: z.string().uuid(),
  booking_id: z.string().uuid(),
  razorpay_order_id: z.string().nullable().optional().openapi({ description: "Razorpay provider order ID. Null until order is created." }),
  razorpay_payment_id: z.string().nullable().optional().openapi({ description: "Razorpay provider payment ID. Null until payment is captured." }),
  status: z.string().nullable().optional(),
  amount: z.number().int().nullable().optional().openapi({ description: "Amount in paise (1 rupee = 100 paise)." }),
  currency: z.string().default("INR").openapi({ description: "ISO 4217 currency code." }),
}).openapi("Payment");

export const ReviewSchema = z.object({
  id: z.string().uuid(),
  booking_id: z.string().uuid(),
  worker_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  rating: z.number().nullable().optional(),
  comment: z.string().nullable().optional(),
}).openapi("Review");

// --- API Request Schemas ---

export const CreateCustomerReqSchema = z.object({
  phone: z.string().min(10, "Phone number must be at least 10 digits").openapi({ example: "+919876543210" }),
  name: z.string().min(1, "Name is required").openapi({ example: "John Doe" }),
}).openapi("CreateCustomerReq");

export const CreateWorkerReqSchema = z.object({
  name: z.string().min(1, "Name is required").openapi({ example: "John Worker" }),
  skill_category_id: z.string().uuid("Invalid Skill Category UUID"),
  phone: z.string().min(10, "Phone must be at least 10 digits").openapi({ example: "+919876543211" }),
  password: z.string().min(6, "Password must be at least 6 characters").openapi({ example: "mysecurepassword" }),
  skill_type: z.string().min(1, "Skill type is required").openapi({ example: "Plumber" }),
  aadhaar_last4: z.string().length(4, "Aadhaar must be exactly 4 digits").optional(),
  device_token: z.string().optional(),
}).openapi("CreateWorkerReq");

export const LoginWorkerReqSchema = z.object({
  phone: z.string().min(10, "Phone must be at least 10 digits").openapi({ example: "+919876543211" }),
  password: z.string().min(1, "Password is required").openapi({ example: "mysecurepassword" }),
}).openapi("LoginWorkerReq");

export const CreateJobReqSchema = z.object({
  customer_id: z.string().uuid("Invalid customer UUID"),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  location: z.string().optional(),
  requirements: z.array(z.object({
    skill_type: z.string().optional(),
    worker_count_needed: z.number().int().positive(),
    rate_per_day: z.number().int().optional(),
  })).optional(),
}).openapi("CreateJobReq");

export const ApplyJobReqSchema = z.object({
  job_id: z.string().uuid("Invalid job UUID"),
  requirement_id: z.string().uuid("Invalid requirement UUID"),
  worker_id: z.string().uuid("Invalid worker UUID"),
}).openapi("ApplyJobReq");

export const DispatchJobReqSchema = z.object({
  requirement_id: z.string().uuid("Invalid requirement UUID"),
  worker_id: z.string().uuid("Invalid worker UUID"),
  wave_number: z.number().int().optional(),
  wave_position: z.number().int().optional(),
}).openapi("DispatchJobReq");

export const CreateBookingReqSchema = z.object({
  job_id: z.string().uuid("Invalid job UUID"),
  requirement_id: z.string().uuid("Invalid requirement UUID"),
  worker_id: z.string().uuid("Invalid worker UUID"),
  customer_id: z.string().uuid("Invalid customer UUID"),
}).openapi("CreateBookingReq");

export const VerifyOtpReqSchema = z.object({
  booking_id: z.string().uuid("Invalid booking UUID"),
  otp: z.string().length(6, "OTP must be exactly 6 characters"),
}).openapi("VerifyOtpReq");

/**
 * CreatePaymentReqSchema — Issue #11 remediation:
 * The authoritative payment amount is derived SERVER-SIDE from job_requirement.rate_per_day.
 * The client supplies only the bookingId (as a URL path parameter, not body).
 * No amount is accepted from the client.
 */
export const CreatePaymentReqSchema = z.object({}).openapi("CreatePaymentReq");

export const CreateReviewReqSchema = z.object({
  booking_id: z.string().uuid("Invalid booking UUID"),
  worker_id: z.string().uuid("Invalid worker UUID"),
  customer_id: z.string().uuid("Invalid customer UUID"),
  rating: z.number().min(1).max(5),
  comment: z.string().optional(),
}).openapi("CreateReviewReq");

export const SendMessageReqSchema = z.object({
  conversation_id: z.string().uuid("Invalid conversation UUID"),
  sender_id: z.string().uuid("Invalid sender UUID"),
  content: z.string().min(1, "Message content cannot be empty"),
}).openapi("SendMessageReq");

export const UpdateWorkerLocationReqSchema = z.object({
  latitude: z.number({ message: "Latitude must be a valid number" })
    .finite("Latitude must be a finite number")
    .min(-90, "Latitude must be between -90 and 90")
    .max(90, "Latitude must be between -90 and 90"),
  longitude: z.number({ message: "Longitude must be a valid number" })
    .finite("Longitude must be a finite number")
    .min(-180, "Longitude must be between -180 and 180")
    .max(180, "Longitude must be between -180 and 180"),
  location: z.string().optional(),
}).strict().openapi("UpdateWorkerLocationReq");

export const LocateWorkerReqSchema = z.object({
  id: z.string().uuid("Invalid worker UUID").openapi({ example: "123e4567-e89b-12d3-a456-426614174000" }),
  lon: z.number().openapi({ example: 72.8777 }),
  lat: z.number().openapi({ example: 19.0760 }),
}).openapi("LocateWorkerReq");

export const UploadWorkerDocumentReqSchema = z.object({
  worker_id: z.string().uuid("Invalid worker UUID"),
  document_type: DocumentTypeSchema,
  file_url: z.string().url("Invalid file URL"),
}).openapi("UploadWorkerDocumentReq");

export const SignupCustomerReqSchema = z.object({
  phone: z.string().min(10, "Phone number must be at least 10 digits").openapi({ example: "+919876543210" }),
  name: z.string().min(1, "Name is required").openapi({ example: "John Doe" }),
  password: z.string().min(6, "Password must be at least 6 characters").openapi({ example: "mysecurepassword" }),
}).openapi("SignupCustomerReq");

export const LoginCustomerReqSchema = z.object({
  phone: z.string().min(10, "Phone number must be at least 10 digits").openapi({ example: "+919876543210" }),
  password: z.string().min(1, "Password is required").openapi({ example: "mysecurepassword" }),
}).openapi("LoginCustomerReq");

export const ConversationSchema = z.object({
  id: z.string().uuid(),
  booking_id: z.string().uuid(),
  worker_id: z.string().uuid(),
  customer_id: z.string().uuid(),
}).openapi("Conversation");

export const MessageSchema = z.object({
  id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  sender_id: z.string().uuid(),
  content: z.string().nullable().optional(),
  sent_at: z.date().nullable().optional(),
}).openapi("Message");

export const NotificationSchema = z.object({
  id: z.string().uuid(),
  worker_id: z.string().uuid(),
  job_id: z.string().uuid(),
  type: z.string().nullable().optional(),
  is_read: z.boolean().nullable().optional(),
  created_at: z.date().nullable().optional(),
}).openapi("Notification");

export const WorkerDocumentSchema = z.object({
  id: z.string().uuid(),
  worker_id: z.string().uuid(),
  document_type: z.string().nullable().optional(),
  file_url: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
}).openapi("WorkerDocument");

export const WorkerDeviceSchema = z.object({
  id: z.string().uuid(),
  worker_id: z.string().uuid(),
  device_id: z.string().nullable().optional(),
  ip_address: z.string().nullable().optional(),
}).openapi("WorkerDevice");

export const WorkerAnalyticsSchema = z.object({
  id: z.string().uuid(),
  worker_id: z.string().uuid(),
  avg_response_time_s: z.number().nullable().optional(),
  acceptance_rate: z.number().nullable().optional(),
  completion_rate: z.number().nullable().optional(),
  calculated_at: z.date().nullable().optional(),
}).openapi("WorkerAnalytics");

export const SendOtpReqSchema = z.object({
  phone: z.string().min(10, "Phone number must be at least 10 digits").max(15, "Phone number cannot exceed 15 digits").regex(/^\+?[1-9]\d{9,14}$/, "Invalid phone number format").openapi({ example: "+919876543210" }),
  type: z.enum(["login", "register"]).openapi({ example: "login" }),
}).openapi("SendOtpReq");

export const AuthVerifyOtpReqSchema = z.object({
  phone: z.string().min(10, "Phone number must be at least 10 digits").max(15, "Phone number cannot exceed 15 digits").regex(/^\+?[1-9]\d{9,14}$/, "Invalid phone number format").openapi({ example: "+919876543210" }),
  otp: z.string().regex(/^\d{6}$/, "OTP must be exactly 6 numeric digits").openapi({ example: "123456" }),
  type: z.enum(["login", "register"]).optional().openapi({ example: "login" }),
}).openapi("AuthVerifyOtpReq");


export const RefreshTokenReqSchema = z.object({
  token: z.string().min(1, "Refresh token is required"),
}).openapi("RefreshTokenReq");

export const UpdateWorkerProfileReqSchema = z.object({
  name: z.string().optional(),
  phone: z.string().min(10).optional(),
  skill_type: z.string().optional(),
}).openapi("UpdateWorkerProfileReq");

export const UpdateWorkerOnlineStatusReqSchema = z.object({
  is_online: z.boolean(),
}).openapi("UpdateWorkerOnlineStatusReq");

export const ConfirmBookingCompleteReqSchema = z.object({
  rating: z.number().min(1).max(5).optional(),
  comment: z.string().optional(),
}).openapi("ConfirmBookingCompleteReq");

export const CancelBookingReqSchema = z.object({
  reason: z.string().min(1, "Cancellation reason is required"),
}).openapi("CancelBookingReq");

export const VerifyWorkerDocumentReqSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
}).openapi("VerifyWorkerDocumentReq");

export const WorkerLocationSchema = z.object({
  id: z.string().uuid(),
  worker_id: z.string().uuid(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
  updated_at: z.date().nullable().optional(),
}).openapi("WorkerLocation");

export const SuspendWorkerReqSchema = z.object({
  reason: z.string().min(1, "Suspension reason is required"),
}).openapi("SuspendWorkerReq");

export const CreateJobRequirementReqSchema = z.object({
  skill_type: z.string().min(1, "Skill type is required").openapi({ example: "Plumber" }),
  worker_count_needed: z.number().int().positive().openapi({ example: 2 }),
  rate_per_day: z.number().int().positive().optional().openapi({ example: 500 }),
  wave_size: z.number().int().positive().optional().openapi({ example: 10 }),
}).openapi("CreateJobRequirementReq");

export const UpdateDeviceTokenReqSchema = z.object({
  device_token: z.string().min(1),
});
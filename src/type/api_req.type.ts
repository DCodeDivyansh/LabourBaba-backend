import { z } from "zod";
import {
  CreateWorkerReqSchema,
  CreateCustomerReqSchema,
  CreateJobReqSchema,
  ApplyJobReqSchema,
  DispatchJobReqSchema,
  CreateBookingReqSchema,
  VerifyOtpReqSchema,
  CreatePaymentReqSchema,
  CreateReviewReqSchema,
  SendMessageReqSchema,
  SendChatMessageBodySchema,
  UpdateWorkerLocationReqSchema,
  UploadWorkerDocumentReqSchema,
  SignupCustomerReqSchema,
  LoginCustomerReqSchema,
  SendOtpReqSchema,
  AuthVerifyOtpReqSchema,
  RefreshTokenReqSchema,
  LogoutReqSchema,
  SessionDTOSchema,
  UpdateWorkerProfileReqSchema,
  UpdateWorkerOnlineStatusReqSchema,
  ConfirmBookingCompleteReqSchema,
  CancelBookingReqSchema,
  VerifyWorkerDocumentReqSchema,
  SuspendWorkerReqSchema,
  CreateJobRequirementReqSchema,
  UpdateJobRequirementDemandReqSchema,
  LoginWorkerReqSchema,
  RequestDocumentUploadUrlReqSchema,
  WorkerDocumentAccessResponseSchema,
  RegisterWorkerDeviceReqSchema,
  RevokeWorkerDeviceReqSchema,
} from "../schemas";

export type UpdateJobRequirementDemandReq = z.infer<typeof UpdateJobRequirementDemandReqSchema>;

export type RegisterWorkerDeviceReq = z.infer<typeof RegisterWorkerDeviceReqSchema>;
export type RevokeWorkerDeviceReq = z.infer<typeof RevokeWorkerDeviceReqSchema>;

export type CreateWorkerReq = z.infer<typeof CreateWorkerReqSchema>;
export type LoginWorkerReq = z.infer<typeof LoginWorkerReqSchema>;
export type CreateCustomerReq = z.infer<typeof CreateCustomerReqSchema>;
export type CreateJobReq = z.infer<typeof CreateJobReqSchema>;
export type ApplyJobReq = z.infer<typeof ApplyJobReqSchema>;
export type DispatchJobReq = z.infer<typeof DispatchJobReqSchema>;
export type CreateBookingReq = z.infer<typeof CreateBookingReqSchema>;
export type VerifyOtpReq = z.infer<typeof VerifyOtpReqSchema>;
export type CreatePaymentReq = z.infer<typeof CreatePaymentReqSchema>;
export type CreateReviewReq = z.infer<typeof CreateReviewReqSchema>;
export type SendMessageReq = z.infer<typeof SendMessageReqSchema>;
export type SendChatMessageBody = z.infer<typeof SendChatMessageBodySchema>;
export type UpdateWorkerLocationReq = z.infer<typeof UpdateWorkerLocationReqSchema>;
export type UploadWorkerDocumentReq = z.infer<typeof UploadWorkerDocumentReqSchema>;
export type SignupCustomerReq = z.infer<typeof SignupCustomerReqSchema>;
export type LoginCustomerReq = z.infer<typeof LoginCustomerReqSchema>;
export type SendOtpReq = z.infer<typeof SendOtpReqSchema>;
export type AuthVerifyOtpReq = z.infer<typeof AuthVerifyOtpReqSchema>;
export type RefreshTokenReq = z.infer<typeof RefreshTokenReqSchema>;
export type LogoutReq = z.infer<typeof LogoutReqSchema>;
export type SessionDTO = z.infer<typeof SessionDTOSchema>;
export type UpdateWorkerProfileReq = z.infer<typeof UpdateWorkerProfileReqSchema>;
export type UpdateWorkerOnlineStatusReq = z.infer<typeof UpdateWorkerOnlineStatusReqSchema>;
export type ConfirmBookingCompleteReq = z.infer<typeof ConfirmBookingCompleteReqSchema>;
export type CancelBookingReq = z.infer<typeof CancelBookingReqSchema>;
export type VerifyWorkerDocumentReq = z.infer<typeof VerifyWorkerDocumentReqSchema>;
export type SuspendWorkerReq = z.infer<typeof SuspendWorkerReqSchema>;
export type CreateJobRequirementReq = z.infer<typeof CreateJobRequirementReqSchema>;
export type RequestDocumentUploadUrlReq = z.infer<typeof RequestDocumentUploadUrlReqSchema>;
export type WorkerDocumentAccessResponse = z.infer<typeof WorkerDocumentAccessResponseSchema>;

export enum JobStatus {
  OPEN = "OPEN",
  DISPATCHING = "DISPATCHING",
  BOOKED = "BOOKED",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED"
}

export enum BookingStatus {
  CONFIRMED = "CONFIRMED",
  PENDING = "PENDING",
  OTP_PENDING = "OTP_PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED"
}

export enum VerificationStatus {
  PENDING = "PENDING",
  VERIFIED = "VERIFIED",
  REJECTED = "REJECTED"
}

export const WorkerDocumentStatus = VerificationStatus;
export type WorkerDocumentStatus = VerificationStatus;


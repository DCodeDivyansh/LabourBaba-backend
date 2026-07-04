import { z } from "zod";
import {
  CustomerSchema,
  WorkerSchema,
  SkillCategorySchema,
  JobSchema,
  BookingSchema,
  PaymentSchema,
  ReviewSchema,
  JobRequirementSchema,
  JobDispatchSchema,
  DispatchWaveSchema
} from "../schemas";

export type Customer = z.infer<typeof CustomerSchema>;
export type Worker = z.infer<typeof WorkerSchema>;
export type SkillCategory = z.infer<typeof SkillCategorySchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobRequirement = z.infer<typeof JobRequirementSchema>;
export type JobDispatch = z.infer<typeof JobDispatchSchema>;
export type DispatchWave = z.infer<typeof DispatchWaveSchema>;
export type Booking = z.infer<typeof BookingSchema>;
export type Payment = z.infer<typeof PaymentSchema>;
export type Review = z.infer<typeof ReviewSchema>;

export interface DispatchWavesResponse {
  waves: DispatchWave[];
  dispatches: JobDispatch[];
}

export interface Conversation {
  id: string;
  booking_id?: string;
  worker_id?: string;
  customer_id?: string;
  created_at?: Date;
}
export interface Message {
  id: string;
  conversation_id?: string;
  sender_id?: string;
  content?: string;
  created_at?: Date;
}
export interface Notification {
  id: string;
  worker_id?: string;
  job_id?: string;
  type?: string;
  is_read?: boolean;
  created_at?: Date;
}
export interface WorkerAnalytics {
  id: string;
  worker_id?: string;
  avg_response_time_s?: number;
  acceptance_rate?: number;
  completion_rate?: number;
  calculated_at?: Date;
}
export interface WorkerDevice {
  id: string;
  worker_id?: string;
  device_id?: string;
  ip_address?: string;
  first_seen?: Date;
  last_seen?: Date;
}
export interface WorkerDocument {
  id: string;
  worker_id?: string;
  document_type?: string;
  file_url?: string;
  status?: string;
}
export interface WorkerLocation {
  id: string;
  worker_id?: string;
  latitude?: number;
  longitude?: number;
  location?: string;
  updated_at?: Date;
}

export interface CreateJobDto {
  customer_id: string;
  latitude?: number;
  longitude?: number;
  location?: string;
  requirements?: {
    skill_type?: string;
    worker_count_needed: number;
    rate_per_day?: number;
  }[];
}
export interface ApplyJobDto {
  job_id: string;
  requirement_id: string;
  worker_id: string;
}
export interface CreateBookingDto {
  job_id: string;
  requirement_id: string;
  worker_id: string;
  customer_id: string;
}
export interface CreateReviewDto {
  booking_id: string;
  worker_id: string;
  customer_id: string;
  rating: number;
  comment: string;
}

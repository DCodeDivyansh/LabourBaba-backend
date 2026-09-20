/**
 * LabourBaba Backend — Booking Configuration
 *
 * Centralized configuration for booking OTP TTL, rate limits, attempt lockouts,
 * and related booking operational parameters.
 */

export const bookingConfig = {
  /**
   * Booking OTP Time-To-Live in seconds.
   * Default: 86,400 seconds (24 hours).
   */
  bookingOtpTtlSeconds: parseInt(process.env.BOOKING_OTP_TTL_SECONDS || "86400", 10),

  /**
   * Maximum allowed failed OTP verification attempts before the booking OTP is locked.
   * Default: 5 attempts.
   */
  bookingOtpMaxAttempts: parseInt(process.env.BOOKING_OTP_MAX_ATTEMPTS || "5", 10),
};

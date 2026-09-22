import { SmsProvider } from "./smsProvider.interface";
import { maskPhone } from "../../utils/authUtils";
import { logger } from "../../utils/logger";

export interface CapturedSms {
  phone: string;
  otp: string;
  purpose: string;
  timestamp: Date;
}

export class MockSmsProvider implements SmsProvider {
  public readonly name = "MockSmsProvider";
  private messages: CapturedSms[] = [];
  public shouldFailNext = false;

  async sendOtp(phone: string, otp: string, purpose: string): Promise<void> {
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      throw new Error("Simulated SMS gateway failure");
    }

    this.messages.push({
      phone,
      otp,
      purpose,
      timestamp: new Date(),
    });

    // Masked observability in logs - NEVER print plaintext OTP
    if (process.env.NODE_ENV !== "test") {
      logger.info(`[SMS_MOCK] Dispatched OTP for purpose '${purpose}' to ${maskPhone(phone)}`, { purpose, phone: maskPhone(phone) });
    }
  }

  /**
   * Test-only helper to inspect the last generated OTP for a given phone number.
   * This is never exposed via API responses or production paths.
   */
  getLastOtpFor(phone: string): string | undefined {
    const matching = this.messages.filter((m) => m.phone === phone);
    return matching.length > 0 ? matching[matching.length - 1].otp : undefined;
  }

  getMessages(): readonly CapturedSms[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.shouldFailNext = false;
  }
}

export const defaultMockSmsProvider = new MockSmsProvider();

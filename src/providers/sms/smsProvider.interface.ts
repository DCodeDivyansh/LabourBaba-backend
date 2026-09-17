export interface SmsProvider {
  name: string;
  sendOtp(phone: string, otp: string, purpose: string): Promise<void>;
}

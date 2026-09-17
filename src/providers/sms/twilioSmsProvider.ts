import { SmsProvider } from "./smsProvider.interface";
import { authConfig } from "../../config/authConfig";
import { maskPhone } from "../../utils/authUtils";

export class TwilioSmsProvider implements SmsProvider {
  public readonly name = "TwilioSmsProvider";

  async sendOtp(phone: string, otp: string, purpose: string): Promise<void> {
    const { accountSid, authToken, phoneNumber } = authConfig.twilio;

    if (!accountSid || !authToken || !phoneNumber) {
      throw new Error(
        "[TwilioSmsProvider] Cannot send SMS: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER is not configured."
      );
    }

    const messageBody = `Your LabourBaba verification code for ${purpose} is: ${otp}. Valid for 5 minutes. Do not share this code with anyone.`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

    const params = new URLSearchParams();
    params.append("To", phone);
    params.append("From", phoneNumber);
    params.append("Body", messageBody);

    const authHeader = "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[TwilioSmsProvider] Failed to dispatch SMS to ${maskPhone(phone)}: HTTP ${response.status}`);
      throw new Error(`SMS delivery gateway error (HTTP ${response.status}): ${errorText}`);
    }

    console.log(`[TwilioSmsProvider] Successfully dispatched OTP to ${maskPhone(phone)} for purpose '${purpose}'`);
  }
}

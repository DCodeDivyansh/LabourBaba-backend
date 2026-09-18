import { SmsProvider } from "./smsProvider.interface";
import { MockSmsProvider, defaultMockSmsProvider } from "./mockSmsProvider";
import { TwilioSmsProvider } from "./twilioSmsProvider";
import { authConfig, assertProductionAuthConfig } from "../../config/authConfig";

let activeProvider: SmsProvider | null = null;

export function getSmsProvider(): SmsProvider {
  if (activeProvider) {
    return activeProvider;
  }

  // Enforce fail-closed rules in production
  assertProductionAuthConfig();

  if (authConfig.smsProvider === "twilio") {
    activeProvider = new TwilioSmsProvider();
    return activeProvider;
  }

  if (authConfig.smsProvider === "mock") {
    if (authConfig.nodeEnv === "production") {
      throw new Error(
        "[FATAL] MockSmsProvider cannot be used in production environment. A real provider must be configured."
      );
    }
    activeProvider = defaultMockSmsProvider;
    return activeProvider;
  }

  // Fallback for development/test
  activeProvider = defaultMockSmsProvider;
  return activeProvider;
}

export function setSmsProvider(provider: SmsProvider | null): void {
  activeProvider = provider;
}

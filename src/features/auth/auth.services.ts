import prisma from "../../config/prisma";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_key";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "fallback_refresh_key";

export const authService = {
  async sendOtp(phone: string, type: "login" | "register") {
    // In a real application, integrate with an SMS provider like Twilio/SNS here
    // For now, we mock the OTP and return it (or just log it)
    const mockOtp = "123456";
    console.log(`Mock sending OTP ${mockOtp} to ${phone} for ${type}`);
    return { success: true, message: `OTP sent successfully to ${phone}` };
  },

  async verifyOtp(phone: string, otp: string) {
    // Mock OTP verification
    if (otp !== "123456") {
      throw new Error("Invalid OTP");
    }

    // Check if customer or worker exists
    let user = await prisma.customer.findUnique({ where: { phone } });
    let role = "customer";

    if (!user) {
      user = await prisma.worker.findUnique({ where: { phone } }) as any;
      role = "worker";
    }

    if (!user) {
      throw new Error("User not found");
    }

    const token = jwt.sign({ id: user.id, role }, JWT_SECRET, { expiresIn: "1h" });
    const refreshToken = jwt.sign({ id: user.id, role }, JWT_REFRESH_SECRET, { expiresIn: "7d" });

    return { user, role, token, refreshToken };
  },

  async refreshToken(token: string) {
    try {
      const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as any;
      const newToken = jwt.sign({ id: decoded.id, role: decoded.role }, JWT_SECRET, { expiresIn: "1h" });
      return { token: newToken };
    } catch (err) {
      throw new Error("Invalid refresh token");
    }
  },

  async logout(token: string) {
    // In a real application, you might blacklist the token in Redis or DB
    return { success: true, message: "Logged out successfully" };
  }
};

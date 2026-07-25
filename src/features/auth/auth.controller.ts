import { Request, Response } from "express";
import { authService } from "./auth.services";
import { SendOtpReq, AuthVerifyOtpReq, RefreshTokenReq } from "../../type/api_req.type";

export const sendOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: SendOtpReq = req.body;
    const response = await authService.sendOtp(payload.phone, payload.type);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: AuthVerifyOtpReq = req.body;
    const response = await authService.verifyOtp(payload.phone, payload.otp);
    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    res.status(401).json({ success: false, message: error.message });
  }
};

export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: RefreshTokenReq = req.body;
    const response = await authService.refreshToken(payload.token);
    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    res.status(401).json({ success: false, message: error.message });
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      res.status(400).json({ success: false, message: "Token required" });
      return;
    }
    const response = await authService.logout(token);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

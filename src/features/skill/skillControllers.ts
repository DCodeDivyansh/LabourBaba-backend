import { Request, Response } from "express";
import prisma from "../../config/prisma";

export const getSkills = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const skill_category = await prisma.skill_category.findMany();
    res.status(200).json({
      success: true,
      data: skill_category,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error?.message || "An error occurred",
    });
  }
};

// create expects that all the data is inside the data obejct
export const addSkills = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const payload = req.body;
    console.log(payload);
    const skill = await prisma.skill_category.create({ data: payload })
    res.status(200).json({
      success: true,
      data: skill
    })
  }
  catch (e: any) {
    console.log(e)
    res.status(500).json({
      success: false,
      message: e?.message || "An error occurred",
    });
  }
}

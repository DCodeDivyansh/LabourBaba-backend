import { Request, Response } from "express";
import { skillService, SkillTaxonomyError } from "./skill.service";

export const getSkills = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const includeInactive = req.query.include_inactive === "true";
    const data = await skillService.getSkills({ includeInactive });
    res.status(200).json({
      success: true,
      data,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error?.message || "An error occurred",
    });
  }
};

export const addSkills = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { name } = req.body;
    const skill = await skillService.createSkill(name);
    res.status(200).json({
      success: true,
      data: skill,
    });
  } catch (e: any) {
    if (e instanceof SkillTaxonomyError || e.statusCode) {
      res.status(e.statusCode || 400).json({
        success: false,
        code: e.code || "SKILL_ERROR",
        message: e.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: e?.message || "An error occurred",
    });
  }
};

export const toggleSkillStatus = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { skillId } = req.params;
    const { is_active } = req.body;
    const skill = await skillService.updateSkillStatus(skillId as string, Boolean(is_active));
    res.status(200).json({
      success: true,
      data: skill,
    });
  } catch (e: any) {
    if (e instanceof SkillTaxonomyError || e.statusCode) {
      res.status(e.statusCode || 400).json({
        success: false,
        code: e.code || "SKILL_ERROR",
        message: e.message,
      });
      return;
    }
    res.status(500).json({
      success: false,
      message: e?.message || "An error occurred",
    });
  }
};

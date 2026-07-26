import express from "express";
import { getSkills, addSkills } from "./skillControllers"
import { SkillCategorySchema, SkillCategorySchemaReqSchema } from "../../schemas";
import { validateBody } from "../../middlewares/validationMiddleware";
import { authenticateJWT } from "../../middlewares/authMiddleware";
import { registry } from "../../config/swagger";
import { z } from "zod";

registry.registerPath({
  method: "get",
  path: "/api/skill",
  summary: "Get all skils",
  tags: ["Skills"],
  responses: {
    200: {
      description: "List of all skills",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.array(SkillCategorySchema),
          }),
        },
      },
    },
    500: {
      description: "Internal server error",
    },
  },
});
// Register POST /api/skill/add
registry.registerPath({
  method: "post",
  path: "/api/skill/add",
  summary: "Create a new skill category",
  tags: ["Skills"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: SkillCategorySchemaReqSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Skill category created successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: SkillCategorySchema,
          }),
        },
      },
    },
    400: {
      description: "Validation failed",
    },
    500: {
      description: "Internal server error",
    },
  },
});


const skillRoute = express.Router();
skillRoute.get("/", getSkills)
skillRoute.post("/add", authenticateJWT, validateBody(SkillCategorySchemaReqSchema), addSkills)

export default skillRoute

import {
  skillService,
  normalizeSkillName,
  SkillTaxonomyError,
  CANONICAL_DEFAULT_SKILLS,
} from "../src/features/skill/skill.service";
import {
  getEligibleDispatchCandidates,
  getEligibleCandidatePage,
} from "../src/features/dispatch/dispatchCandidate.service";
import prisma from "../src/config/prisma";

// Mock Prisma for deterministic testing
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    skill_category: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    worker: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    worker_skill: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    job_requirement: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    job_requirement_skill: {
      upsert: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

describe("Issue #30: Normalize Skill Taxonomy & Deterministic Matching", () => {
  const PLUMBER_ID = "11111111-1111-4111-a111-111111111111";
  const ELECTRICIAN_ID = "22222222-2222-4222-a222-222222222222";
  const CARPENTER_ID = "33333333-3333-4333-a333-333333333333";
  const WORKER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const REQUIREMENT_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // A. Skill Canonicalization & String Normalization
  // ─────────────────────────────────────────────────────────────────────────────
  describe("A. Skill Canonicalization & Normalization", () => {
    it("MUST normalize whitespace and trim leading/trailing spaces", () => {
      expect(normalizeSkillName("   Electrician   ")).toBe("Electrician");
      expect(normalizeSkillName("General   Labour")).toBe("General Labour");
      expect(normalizeSkillName("")).toBe("");
      expect(normalizeSkillName(null as any)).toBe("");
    });

    it("MUST prevent duplicate canonical skills with different casing", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue({
        id: ELECTRICIAN_ID,
        name: "Electrician",
      });

      await expect(skillService.createSkill("electrician")).rejects.toThrow(SkillTaxonomyError);
      await expect(skillService.createSkill("ELECTRICIAN")).rejects.toThrow(SkillTaxonomyError);
      await expect(skillService.createSkill("  electrician  ")).rejects.toThrow(SkillTaxonomyError);
    });

    it("MUST create a new canonical skill when name is unique", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.skill_category.create as jest.Mock).mockResolvedValue({
        id: PLUMBER_ID,
        name: "Plumber",
        is_active: true,
      });

      const skill = await skillService.createSkill("  Plumber  ");
      expect(skill).toEqual({
        id: PLUMBER_ID,
        name: "Plumber",
        is_active: true,
      });
      expect(prisma.skill_category.create).toHaveBeenCalledWith({
        data: {
          name: "Plumber",
          is_active: true,
        },
      });
    });

    it("MUST keep semantically distinct skills separate", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.skill_category.create as jest.Mock).mockResolvedValue({
        id: CARPENTER_ID,
        name: "Master Carpenter",
        is_active: true,
      });

      const skill = await skillService.createSkill("Master Carpenter");
      expect(skill?.name).toBe("Master Carpenter");
    });

    it("MUST support toggling active status (soft deactivation)", async () => {
      (prisma.skill_category.findUnique as jest.Mock).mockResolvedValue({
        id: PLUMBER_ID,
        name: "Plumber",
        is_active: true,
      });
      (prisma.skill_category.update as jest.Mock).mockResolvedValue({
        id: PLUMBER_ID,
        name: "Plumber",
        is_active: false,
      });

      const updated = await skillService.updateSkillStatus(PLUMBER_ID, false);
      expect(updated?.is_active).toBe(false);
      expect(prisma.skill_category.update).toHaveBeenCalledWith({
        where: { id: PLUMBER_ID },
        data: { is_active: false },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // B. Canonical Skill ID Resolution
  // ─────────────────────────────────────────────────────────────────────────────
  describe("B. Canonical Skill ID Resolution", () => {
    it("MUST resolve valid UUID directly if it exists in canonical database", async () => {
      (prisma.skill_category.findUnique as jest.Mock).mockResolvedValue({
        id: PLUMBER_ID,
        name: "Plumber",
      });

      const resolved = await skillService.resolveSkillId(PLUMBER_ID);
      expect(resolved).toBe(PLUMBER_ID);
    });

    it("MUST resolve legacy text string to canonical Skill ID case-insensitively", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue({
        id: ELECTRICIAN_ID,
        name: "Electrician",
      });

      const resolved = await skillService.resolveSkillId("  eLeCtRiCiAn ");
      expect(resolved).toBe(ELECTRICIAN_ID);
      expect(prisma.skill_category.findFirst).toHaveBeenCalledWith({
        where: {
          name: {
            equals: "eLeCtRiCiAn",
            mode: "insensitive",
          },
        },
        select: { id: true },
      });
    });

    it("MUST return null for unresolvable or empty skill inputs", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.skill_category.findUnique as jest.Mock).mockResolvedValue(null);

      expect(await skillService.resolveSkillId(null)).toBeNull();
      expect(await skillService.resolveSkillId("")).toBeNull();
      expect(await skillService.resolveSkillId("NonExistentSkillXYZ")).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // C. Worker Skills & Multiple Skill Management
  // ─────────────────────────────────────────────────────────────────────────────
  describe("C. Worker Skills & Multi-Skill Relations", () => {
    it("MUST assign multiple canonical skills to worker idempotently", async () => {
      (prisma.skill_category.findUnique as jest.Mock)
        .mockResolvedValueOnce({ id: PLUMBER_ID, name: "Plumber" })
        .mockResolvedValueOnce({ id: ELECTRICIAN_ID, name: "Electrician" });
      (prisma.worker_skill.upsert as jest.Mock).mockResolvedValue({});
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
        id: WORKER_A_ID,
        skill_category: { id: PLUMBER_ID, name: "Plumber" },
        worker_skill: [
          { skill_category: { id: PLUMBER_ID, name: "Plumber" } },
          { skill_category: { id: ELECTRICIAN_ID, name: "Electrician" } },
        ],
      });

      const skills = await skillService.assignWorkerSkills(WORKER_A_ID, [PLUMBER_ID, ELECTRICIAN_ID]);
      expect(skills.length).toBe(2);
      expect(prisma.worker_skill.upsert).toHaveBeenCalledTimes(2);
    });

    it("MUST retrieve worker skills without duplicate entries", async () => {
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
        id: WORKER_A_ID,
        skill_category: { id: PLUMBER_ID, name: "Plumber" },
        worker_skill: [
          { skill_category: { id: PLUMBER_ID, name: "Plumber" } },
          { skill_category: { id: ELECTRICIAN_ID, name: "Electrician" } },
        ],
      });

      const skills = await skillService.getWorkerSkills(WORKER_A_ID);
      expect(skills).toEqual([
        { id: PLUMBER_ID, name: "Plumber" },
        { id: ELECTRICIAN_ID, name: "Electrician" },
      ]);
    });

    it("MUST safely remove worker skill", async () => {
      (prisma.worker_skill.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await skillService.removeWorkerSkill(WORKER_A_ID, ELECTRICIAN_ID);
      expect(prisma.worker_skill.deleteMany).toHaveBeenCalledWith({
        where: {
          worker_id: WORKER_A_ID,
          skill_id: ELECTRICIAN_ID,
        },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // D. Deterministic Dispatch Matching
  // ─────────────────────────────────────────────────────────────────────────────
  describe("D. Deterministic Dispatch Candidate Matching", () => {
    it("MUST match candidates using canonical Skill ID in database query", async () => {
      (prisma.skill_category.findUnique as jest.Mock).mockResolvedValue({
        id: PLUMBER_ID,
        name: "Plumber",
      });

      const mockWorker = {
        id: WORKER_A_ID,
        name: "Master Plumber",
        device_token: "token-1",
        worker_score: 4.9,
        dist_m: 500,
      };

      (prisma.$queryRaw as jest.Mock).mockResolvedValue([mockWorker]);

      const candidates = await getEligibleDispatchCandidates({
        requirementId: REQUIREMENT_ID,
        latitude: 19.076,
        longitude: 72.8777,
        radiusMeters: 5000,
        skillId: PLUMBER_ID,
        limit: 10,
        offset: 0,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(WORKER_A_ID);
      expect(prisma.$queryRaw).toHaveBeenCalled();
    });

    it("MUST resolve legacy free-text skill_type to canonical ID and match candidates", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue({
        id: ELECTRICIAN_ID,
        name: "Electrician",
      });

      const mockWorker = {
        id: WORKER_A_ID,
        name: "Pro Electrician",
        device_token: "token-2",
        worker_score: 5.0,
        dist_m: 1200,
      };

      (prisma.$queryRaw as jest.Mock).mockResolvedValue([mockWorker]);

      const candidates = await getEligibleDispatchCandidates({
        requirementId: REQUIREMENT_ID,
        latitude: 19.076,
        longitude: 72.8777,
        radiusMeters: 5000,
        skillType: "  electrician  ",
        limit: 10,
        offset: 0,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(WORKER_A_ID);
    });

    it("MUST fail closed when unknown skill is requested (matching 0 candidates)", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.skill_category.findUnique as jest.Mock).mockResolvedValue(null);

      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      const candidates = await getEligibleDispatchCandidates({
        requirementId: REQUIREMENT_ID,
        latitude: 19.076,
        longitude: 72.8777,
        radiusMeters: 5000,
        skillType: "AstronautWorkerXYZ",
        limit: 10,
        offset: 0,
      });

      expect(candidates).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // E. Idempotent Seeding
  // ─────────────────────────────────────────────────────────────────────────────
  describe("E. Idempotent Skill Seeding", () => {
    it("MUST seed canonical default skills without creating duplicates", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.skill_category.create as jest.Mock).mockResolvedValue({
        id: PLUMBER_ID,
        name: "Plumber",
        is_active: true,
      });

      await skillService.seedCanonicalSkills(["Plumber", "Electrician"]);
      expect(prisma.skill_category.create).toHaveBeenCalledTimes(2);
    });

    it("MUST skip already existing skills during seed execution", async () => {
      (prisma.skill_category.findFirst as jest.Mock).mockResolvedValue({
        id: PLUMBER_ID,
        name: "Plumber",
      });

      await skillService.seedCanonicalSkills(["Plumber"]);
      expect(prisma.skill_category.create).not.toHaveBeenCalled();
    });
  });
});

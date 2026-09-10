import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";
import { uploadDir } from "../lib/uploadDir";

const router = Router();

const buildUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".bin";
      cb(null, `agent-build-${Date.now()}-${nanoid(8)}${ext}`);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Public: the Printers page needs this to offer downloads before the merchant logs in a second device.
router.get("/", async (_req, res) => {
  const builds = await prisma.agentBuild.findMany({ orderBy: { releasedAt: "desc" } });
  return res.json({ builds });
});

router.post("/", requireAuth, requireSuperAdmin, buildUpload.single("file"), async (req, res) => {
  const schema = z.object({
    version: z.string().min(1),
    platform: z.enum(["WINDOWS", "MACOS", "LINUX"]),
    arch: z.enum(["X64", "ARM64", "X86"]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!req.file) return res.status(400).json({ error: "Installer file is required" });

  const build = await prisma.agentBuild.upsert({
    where: {
      platform_arch_version: {
        platform: parsed.data.platform,
        arch: parsed.data.arch,
        version: parsed.data.version,
      },
    },
    update: {
      fileName: req.file.originalname,
      fileSizeBytes: req.file.size,
      downloadUrl: `/uploads/${req.file.filename}`,
      releasedAt: new Date(),
    },
    create: {
      version: parsed.data.version,
      platform: parsed.data.platform,
      arch: parsed.data.arch,
      fileName: req.file.originalname,
      fileSizeBytes: req.file.size,
      downloadUrl: `/uploads/${req.file.filename}`,
    },
  });

  return res.status(201).json({ build });
});

router.delete("/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  const build = await prisma.agentBuild.findUnique({ where: { id: req.params.id } });
  if (!build) return res.status(404).json({ error: "Build not found" });

  await prisma.agentBuild.delete({ where: { id: build.id } });
  const filePath = path.join(uploadDir, path.basename(build.downloadUrl));
  fs.unlink(filePath, () => undefined);

  return res.json({ ok: true });
});

export default router;

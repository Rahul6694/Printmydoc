import { Router } from "express";
import multer from "multer";
import path from "path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";
import { uploadBuffer, publicUrl, deleteObject, keyFromPublicUrl } from "../lib/s3";

const router = Router();

const buildUpload = multer({
  storage: multer.memoryStorage(),
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

  const ext = path.extname(req.file.originalname).toLowerCase() || ".bin";
  const key = `agent-build-${Date.now()}-${nanoid(8)}${ext}`;
  await uploadBuffer(key, req.file.buffer, req.file.mimetype);
  const downloadUrl = publicUrl(key);

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
      downloadUrl,
      releasedAt: new Date(),
    },
    create: {
      version: parsed.data.version,
      platform: parsed.data.platform,
      arch: parsed.data.arch,
      fileName: req.file.originalname,
      fileSizeBytes: req.file.size,
      downloadUrl,
    },
  });

  return res.status(201).json({ build });
});

router.delete("/:id", requireAuth, requireSuperAdmin, async (req, res) => {
  const build = await prisma.agentBuild.findUnique({ where: { id: req.params.id } });
  if (!build) return res.status(404).json({ error: "Build not found" });

  await prisma.agentBuild.delete({ where: { id: build.id } });
  await deleteObject(keyFromPublicUrl(build.downloadUrl)).catch(() => undefined);

  return res.json({ ok: true });
});

export default router;

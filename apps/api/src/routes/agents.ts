import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { hashPassword, verifyPassword } from "../lib/auth";
import { publicUrl } from "../lib/s3";

const router = Router();

function agentToken() {
  return crypto.randomBytes(24).toString("hex");
}

router.post("/register", requireAuth, async (req: AuthedRequest, res) => {
  const schema = z.object({
    shopId: z.string(),
    name: z.string().min(2),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const access = await prisma.shopStaff.findFirst({
    where: { shopId: parsed.data.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const deviceKey = `agent_${crypto.randomBytes(8).toString("hex")}`;
  const token = agentToken();
  const tokenHash = await hashPassword(token);

  const agent = await prisma.agent.create({
    data: {
      shopId: parsed.data.shopId,
      name: parsed.data.name,
      deviceKey,
      tokenHash,
    },
  });

  return res.status(201).json({
    agent: { id: agent.id, name: agent.name, deviceKey: agent.deviceKey, shopId: agent.shopId },
    token,
    note: "Store deviceKey + token securely on the Windows PC. Token shown once.",
  });
});

router.post("/auth", async (req, res) => {
  const schema = z.object({
    deviceKey: z.string(),
    token: z.string(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const agent = await prisma.agent.findUnique({ where: { deviceKey: parsed.data.deviceKey } });
  if (!agent?.tokenHash || !(await verifyPassword(parsed.data.token, agent.tokenHash))) {
    return res.status(401).json({ error: "Invalid agent credentials" });
  }

  await prisma.agent.update({
    where: { id: agent.id },
    data: { isOnline: true, lastSeenAt: new Date() },
  });

  return res.json({
    agentId: agent.id,
    shopId: agent.shopId,
    name: agent.name,
  });
});

router.post("/:agentId/heartbeat", async (req, res) => {
  await prisma.agent.update({
    where: { id: req.params.agentId },
    data: { isOnline: true, lastSeenAt: new Date() },
  });
  return res.json({ ok: true });
});

router.post("/:agentId/printers", async (req, res) => {
  const schema = z.object({
    printers: z.array(
      z.object({
        name: z.string(),
        systemName: z.string(),
        supportsColor: z.boolean().default(false),
        supportsDuplex: z.boolean().default(false),
        paperSizes: z.array(z.string()).default(["A4"]),
        isOnline: z.boolean().default(true),
      })
    ),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const agent = await prisma.agent.findUnique({ where: { id: req.params.agentId } });
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  for (const p of parsed.data.printers) {
    const existing = await prisma.printer.findFirst({
      where: { shopId: agent.shopId, systemName: p.systemName },
    });
    if (existing) {
      await prisma.printer.update({
        where: { id: existing.id },
        data: {
          agentId: agent.id,
          name: p.name,
          supportsColor: p.supportsColor,
          supportsDuplex: p.supportsDuplex,
          paperSizes: p.paperSizes,
          isOnline: p.isOnline,
        },
      });
    } else {
      await prisma.printer.create({
        data: {
          shopId: agent.shopId,
          agentId: agent.id,
          name: p.name,
          systemName: p.systemName,
          supportsColor: p.supportsColor,
          supportsDuplex: p.supportsDuplex,
          paperSizes: p.paperSizes,
          isOnline: p.isOnline,
        },
      });
    }
  }

  const printers = await prisma.printer.findMany({ where: { shopId: agent.shopId } });
  return res.json({ printers });
});

router.get("/:agentId/jobs", async (req, res) => {
  const jobs = await prisma.printJob.findMany({
    where: {
      agentId: req.params.agentId,
      status: { in: ["ASSIGNED", "PENDING"] },
    },
    include: {
      order: { include: { files: true } },
      printer: true,
    },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  return res.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      idempotencyKey: j.idempotencyKey,
      status: j.status,
      printer: j.printer
        ? { id: j.printer.id, name: j.printer.name, systemName: j.printer.systemName }
        : null,
      settings: {
        paperSize: j.order.paperSize,
        colorMode: j.order.colorMode,
        duplex: j.order.duplex,
        copies: j.order.copies,
        pageRange: j.order.pageRange,
        orientation: j.order.orientation,
      },
      files: j.order.files.map((f) => ({
        id: f.id,
        originalName: f.originalName,
        downloadUrl: `/api/agents/files/${f.storageKey}`,
        mimeType: f.mimeType,
      })),
    })),
  });
});

router.get("/files/:storageKey", (req, res) => {
  return res.redirect(302, publicUrl(req.params.storageKey));
});

router.post("/jobs/:jobId/status", async (req, res) => {
  const schema = z.object({
    status: z.enum(["DOWNLOADING", "PRINTING", "COMPLETED", "FAILED"]),
    error: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const job = await prisma.printJob.findUnique({ where: { id: req.params.jobId } });
  if (!job) return res.status(404).json({ error: "Job not found" });

  const data: Record<string, unknown> = {
    status: parsed.data.status,
    attempts: { increment: parsed.data.status === "FAILED" ? 1 : 0 },
    lastError: parsed.data.error,
  };
  if (parsed.data.status === "PRINTING") data.startedAt = new Date();
  if (parsed.data.status === "COMPLETED") data.completedAt = new Date();

  const updated = await prisma.printJob.update({
    where: { id: job.id },
    data,
  });

  if (parsed.data.status === "COMPLETED") {
    await prisma.order.update({
      where: { id: job.orderId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  } else if (parsed.data.status === "FAILED") {
    await prisma.order.update({
      where: { id: job.orderId },
      data: { status: "FAILED" },
    });
  } else if (parsed.data.status === "PRINTING") {
    await prisma.order.update({
      where: { id: job.orderId },
      data: { status: "PRINTING" },
    });
  }

  return res.json({ job: updated });
});

router.get("/shop/:shopId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const agents = await prisma.agent.findMany({
    where: { shopId: req.params.shopId },
    include: { printers: true },
  });
  return res.json({ agents });
});

export default router;

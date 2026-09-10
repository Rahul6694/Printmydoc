import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";

const router = Router();

router.get("/shop/:shopId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const printers = await prisma.printer.findMany({
    where: { shopId: req.params.shopId },
    include: { agent: { select: { id: true, name: true, isOnline: true } } },
    orderBy: { priority: "asc" },
  });
  return res.json({ printers });
});

router.get("/shop/:shopId/jobs", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const jobs = await prisma.printJob.findMany({
    where: {
      shopId: req.params.shopId,
      status: { in: ["PENDING", "ASSIGNED", "DOWNLOADING", "PRINTING"] },
    },
    include: {
      printer: { select: { id: true, name: true, isOnline: true } },
      order: {
        select: {
          id: true,
          customerName: true,
          customerPhone: true,
          pageCount: true,
          copies: true,
          paperSize: true,
          colorMode: true,
          files: { select: { originalName: true }, take: 1 },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return res.json({ jobs });
});

router.patch("/:printerId", requireAuth, async (req: AuthedRequest, res) => {
  const printer = await prisma.printer.findUnique({ where: { id: req.params.printerId } });
  if (!printer) return res.status(404).json({ error: "Not found" });

  const access = await prisma.shopStaff.findFirst({
    where: { shopId: printer.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const schema = z.object({
    isEnabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    name: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await prisma.printer.update({
    where: { id: printer.id },
    data: parsed.data,
  });
  return res.json({ printer: updated });
});

export default router;

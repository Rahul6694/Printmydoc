import { Router } from "express";
import multer from "multer";
import path from "path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { calculatePrice } from "../lib/pricing";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { createPrintJobForOrder, markOrderPaid } from "../services/printJobs";
import { creditReferralBonusIfEligible } from "../lib/wallet";
import { uploadBuffer, publicUrl } from "../lib/s3";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type"));
  },
});

const router = Router();

router.post("/quote", async (req, res) => {
  const schema = z.object({
    shopId: z.string(),
    paperSize: z.enum(["A4", "A3", "LETTER"]),
    colorMode: z.enum(["BW", "COLOR"]),
    duplex: z.boolean(),
    pageCount: z.number().int().positive(),
    copies: z.number().int().positive().default(1),
    printMode: z.enum(["normal", "collage", "merge"]).default("normal"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const price = await calculatePrice(parsed.data);
    return res.json({
      unitPrice: Number(price.unitPrice),
      totalAmount: Number(price.totalAmount),
      ruleName: price.ruleName,
      discountApplied: price.discountApplied,
    });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
});

router.post("/", upload.single("file"), async (req, res) => {
  try {
    const schema = z.object({
      shopId: z.string(),
      paperSize: z.enum(["A4", "A3", "LETTER"]).default("A4"),
      colorMode: z.enum(["BW", "COLOR"]).default("BW"),
      duplex: z
        .union([z.boolean(), z.string()])
        .transform((v) => v === true || v === "true")
        .default(false),
      copies: z.coerce.number().int().positive().default(1),
      pageCount: z.coerce.number().int().positive().default(1),
      pageRange: z.string().optional(),
      orientation: z.string().default("portrait"),
      customerName: z.string().optional(),
      customerPhone: z.string().optional(),
      notes: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }

    const shop = await prisma.shop.findUnique({ where: { id: parsed.data.shopId } });
    if (!shop || !shop.isActive) {
      return res.status(404).json({ error: "Shop not found" });
    }

    const ext = path.extname(req.file.originalname).toLowerCase() || ".bin";
    const storageKey = `${Date.now()}-${nanoid(8)}${ext}`;
    await uploadBuffer(storageKey, req.file.buffer, req.file.mimetype);

    const price = await calculatePrice({
      shopId: parsed.data.shopId,
      paperSize: parsed.data.paperSize,
      colorMode: parsed.data.colorMode,
      duplex: parsed.data.duplex,
      pageCount: parsed.data.pageCount,
      copies: parsed.data.copies,
    });

    let customerId: string | undefined;
    if (parsed.data.customerPhone) {
      const existingCustomer = await prisma.customer.findFirst({
        where: { shopId: shop.id, phone: parsed.data.customerPhone },
      });
      const customer = existingCustomer
        ? await prisma.customer.update({
            where: { id: existingCustomer.id },
            data: { name: parsed.data.customerName || undefined },
          })
        : await prisma.customer.create({
            data: {
              shopId: shop.id,
              phone: parsed.data.customerPhone,
              name: parsed.data.customerName,
            },
          });
      customerId = customer.id;
    }

    const order = await prisma.order.create({
      data: {
        shopId: shop.id,
        customerId,
        status: "AWAITING_PAYMENT",
        paperSize: parsed.data.paperSize,
        colorMode: parsed.data.colorMode,
        duplex: parsed.data.duplex,
        copies: parsed.data.copies,
        pageCount: parsed.data.pageCount,
        pageRange: parsed.data.pageRange,
        orientation: parsed.data.orientation,
        unitPrice: price.unitPrice,
        totalAmount: price.totalAmount,
        customerName: parsed.data.customerName,
        customerPhone: parsed.data.customerPhone,
        notes: parsed.data.notes,
        files: {
          create: {
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            sizeBytes: req.file.size,
            storageKey,
            pageCount: parsed.data.pageCount,
          },
        },
      },
      include: { files: true },
    });

    return res.status(201).json({ order });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
});

router.get("/public/:orderId", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: {
      files: { select: { id: true, originalName: true, pageCount: true, mimeType: true } },
      shop: { select: { id: true, name: true, slug: true, allowManualPayment: true, onlinePaymentsEnabled: true } },
      printJobs: true,
      payments: true,
    },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });
  return res.json({ order });
});

router.post("/:orderId/request-manual", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId }, include: { shop: true } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!order.shop.allowManualPayment) return res.status(400).json({ error: "Manual payment is disabled for this shop" });
  if (order.status !== "AWAITING_PAYMENT") return res.status(400).json({ error: `Order is ${order.status}` });

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: "MANUAL" },
  });
  return res.json({ order: updated });
});

router.post("/:orderId/confirm-manual", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) return res.status(404).json({ error: "Not found" });
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: order.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });
  if (order.paymentMethod !== "MANUAL") return res.status(400).json({ error: "Order was not requested as manual payment" });

  const updated = await markOrderPaid(order.id);
  return res.json({ order: updated });
});

router.get("/shop/:shopId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const status = req.query.status as string | undefined;
  const orders = await prisma.order.findMany({
    where: {
      shopId: req.params.shopId,
      ...(status ? { status: status as never } : {}),
    },
    include: {
      files: true,
      printJobs: true,
      payments: true,
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return res.json({ orders });
});

router.get("/shop/:shopId/documents", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const search = (req.query.q as string) || "";
  const files = await prisma.orderFile.findMany({
    where: {
      order: { shopId: req.params.shopId },
      ...(search ? { originalName: { contains: search } } : {}),
    },
    include: {
      order: { select: { id: true, status: true, customerName: true, customerPhone: true, createdAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return res.json({ files: files.map((f) => ({ ...f, fileUrl: publicUrl(f.storageKey) })) });
});

router.get("/:orderId/detail", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: { files: true, printJobs: true, payments: true, shop: true },
  });
  if (!order) return res.status(404).json({ error: "Not found" });

  const access = await prisma.shopStaff.findFirst({
    where: { shopId: order.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });
  return res.json({ order });
});

router.post("/:orderId/approve", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) return res.status(404).json({ error: "Not found" });

  const access = await prisma.shopStaff.findFirst({
    where: { shopId: order.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  if (!["PAID", "APPROVED", "FAILED", "RETRYING"].includes(order.status)) {
    return res.status(400).json({ error: `Cannot approve order in status ${order.status}` });
  }

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: "QUEUED" },
  });
  const job = await createPrintJobForOrder(order.id);
  return res.json({ order: updated, printJob: job });
});

router.post("/:orderId/reject", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) return res.status(404).json({ error: "Not found" });
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: order.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const schema = z.object({ reason: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: "CANCELLED", rejectedReason: parsed.success ? parsed.data.reason : undefined },
  });
  return res.json({ order: updated });
});

router.post("/:orderId/mark-print-failed", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) return res.status(404).json({ error: "Not found" });
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: order.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.printJob.updateMany({
      where: { orderId: order.id, status: { not: "COMPLETED" } },
      data: { status: "FAILED" },
    });
    return tx.order.update({ where: { id: order.id }, data: { status: "FAILED" } });
  });
  return res.json({ order: updated });
});

router.post("/:orderId/complete", requireAuth, async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.orderId } });
  if (!order) return res.status(404).json({ error: "Not found" });
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: order.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.printJob.updateMany({
      where: { orderId: order.id, status: { not: "COMPLETED" } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    return tx.order.update({
      where: { id: order.id },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
  });

  await creditReferralBonusIfEligible(order.shopId);

  return res.json({ order: updated });
});

export default router;

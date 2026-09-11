import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { nanoid, customAlphabet } from "nanoid";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { hashPassword } from "../lib/auth";

const tempPasswordId = customAlphabet("abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789", 10);

const router = Router();

const uploadDir = process.env.UPLOAD_DIR || "./uploads";
fs.mkdirSync(uploadDir, { recursive: true });
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".png";
      cb(null, `logo-${Date.now()}-${nanoid(8)}${ext}`);
    },
  }),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/png", "image/jpeg"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Logo must be PNG or JPEG"));
  },
});

function maskShop<T extends { razorpayKeySecret?: string | null }>(shop: T): T {
  if (!shop) return shop;
  return { ...shop, razorpayKeySecret: shop.razorpayKeySecret ? "••••••••" : null };
}

router.get("/mine", requireAuth, async (req: AuthedRequest, res) => {
  const shops = await prisma.shopStaff.findMany({
    where: { userId: req.user!.userId },
    include: {
      shop: {
        include: {
          _count: { select: { orders: true, printers: true } },
        },
      },
    },
  });
  return res.json({ shops: shops.map((s) => ({ ...maskShop(s.shop), role: s.role })) });
});

router.get("/by-slug/:slug", async (req, res) => {
  const shop = await prisma.shop.findUnique({
    where: { slug: req.params.slug },
    select: {
      id: true,
      name: true,
      slug: true,
      city: true,
      address: true,
      phone: true,
      isActive: true,
      capabilities: true,
      collageEnabled: true,
      mergeEnabled: true,
      onlinePaymentsEnabled: true,
      allowManualPayment: true,
      checkoutDisplayName: true,
      paymentLogoUrl: true,
      currency: true,
      upiId: true,
      minOrderAmount: true,
      maxFileSizeMb: true,
      portalCustomerDetailsEnabled: true,
      portalRequireName: true,
      portalRequirePhone: true,
      portalCategoryToggles: true,
      pricingRules: {
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          paperSize: true,
          colorMode: true,
          duplex: true,
          pricePerPage: true,
        },
      },
    },
  });
  if (!shop || !shop.isActive) {
    return res.status(404).json({ error: "Shop not found" });
  }
  return res.json({ shop });
});

router.get("/:shopId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const shop = await prisma.shop.findUnique({
    where: { id: req.params.shopId },
    include: {
      pricingRules: true,
      printers: true,
      agents: true,
    },
  });
  return res.json({ shop: shop ? maskShop(shop) : shop });
});

router.patch("/:shopId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId, role: "OWNER" },
  });
  if (!access) return res.status(403).json({ error: "Owner access required" });

  const schema = z.object({
    name: z.string().min(2).optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    phone: z.string().optional(),
    autoPrint: z.boolean().optional(),
    requireApproval: z.boolean().optional(),
    isActive: z.boolean().optional(),
    capabilities: z.record(z.boolean()).optional(),
    capabilitiesOrder: z.record(z.array(z.string())).optional(),
    advancedServicesEnabled: z.boolean().optional(),
    physicalServicesEnabled: z.boolean().optional(),

    collageEnabled: z.boolean().optional(),
    mergeEnabled: z.boolean().optional(),
    collagePricing: z.record(z.number()).optional(),
    mergePricing: z.record(z.number()).optional(),
    bulkPricingEnabled: z.boolean().optional(),
    bulkPricingThreshold: z.number().nonnegative().nullable().optional(),
    bulkPricingRates: z.record(z.number()).optional(),
    copyDiscountEnabled: z.boolean().optional(),
    copyDiscountRates: z.record(z.record(z.number())).optional(),

    useOwnRazorpay: z.boolean().optional(),
    razorpayKeyId: z.string().optional(),
    razorpayKeySecret: z.string().optional(),
    onlinePaymentsEnabled: z.boolean().optional(),
    allowManualPayment: z.boolean().optional(),
    checkoutDisplayName: z.string().optional(),
    paymentLogoUrl: z.string().optional(),
    currency: z.string().optional(),
    upiId: z.string().optional(),
    minOrderAmount: z.number().nonnegative().nullable().optional(),
    maxFileSizeMb: z.number().int().positive().nullable().optional(),

    portalCustomerDetailsEnabled: z.boolean().optional(),
    portalRequireName: z.boolean().optional(),
    portalRequirePhone: z.boolean().optional(),
    portalCategoryToggles: z.record(z.boolean()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Never overwrite a stored secret with the masked placeholder the client reads back.
  const data = { ...parsed.data };
  if (data.razorpayKeySecret === "••••••••") delete data.razorpayKeySecret;

  const shop = await prisma.shop.update({
    where: { id: req.params.shopId },
    data,
  });
  return res.json({ shop: maskShop(shop) });
});

router.post(
  "/:shopId/logo",
  requireAuth,
  logoUpload.single("logo"),
  async (req: AuthedRequest, res) => {
    const access = await prisma.shopStaff.findFirst({
      where: { shopId: req.params.shopId, userId: req.user!.userId, role: "OWNER" },
    });
    if (!access) return res.status(403).json({ error: "Owner access required" });
    if (!req.file) return res.status(400).json({ error: "Logo file is required" });

    const paymentLogoUrl = `/uploads/${req.file.filename}`;
    const shop = await prisma.shop.update({
      where: { id: req.params.shopId },
      data: { paymentLogoUrl },
    });
    return res.json({ shop: maskShop(shop) });
  }
);

router.get("/:shopId/staff", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const staff = await prisma.shopStaff.findMany({
    where: { shopId: req.params.shopId },
    include: { user: { select: { id: true, name: true, email: true, phone: true } } },
    orderBy: { createdAt: "asc" },
  });
  return res.json({ staff });
});

router.post("/:shopId/staff", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId, role: "OWNER" },
  });
  if (!access) return res.status(403).json({ error: "Owner access required" });

  const schema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    const already = await prisma.shopStaff.findFirst({
      where: { shopId: req.params.shopId, userId: existing.id },
    });
    if (already) return res.status(409).json({ error: "This person is already staff at this shop" });
    const staff = await prisma.shopStaff.create({
      data: { shopId: req.params.shopId, userId: existing.id, role: "STAFF" },
      include: { user: { select: { id: true, name: true, email: true, phone: true } } },
    });
    return res.status(201).json({ staff, tempPassword: null });
  }

  const tempPassword = tempPasswordId();
  const passwordHash = await hashPassword(tempPassword);
  const user = await prisma.user.create({
    data: { name: parsed.data.name, email: parsed.data.email, phone: parsed.data.phone, passwordHash },
  });
  const staff = await prisma.shopStaff.create({
    data: { shopId: req.params.shopId, userId: user.id, role: "STAFF" },
    include: { user: { select: { id: true, name: true, email: true, phone: true } } },
  });
  return res.status(201).json({ staff, tempPassword });
});

router.delete("/:shopId/staff/:staffId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId, role: "OWNER" },
  });
  if (!access) return res.status(403).json({ error: "Owner access required" });

  const staff = await prisma.shopStaff.findUnique({ where: { id: req.params.staffId } });
  if (!staff || staff.shopId !== req.params.shopId) return res.status(404).json({ error: "Not found" });
  if (staff.role === "OWNER") return res.status(400).json({ error: "Cannot remove the shop owner" });

  await prisma.shopStaff.delete({ where: { id: staff.id } });
  return res.json({ ok: true });
});

router.put("/:shopId/pricing", requireAuth, async (req: AuthedRequest, res) => {
  const access = await prisma.shopStaff.findFirst({
    where: { shopId: req.params.shopId, userId: req.user!.userId },
  });
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const schema = z.object({
    rules: z.array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        paperSize: z.enum(["A4", "A3", "LETTER"]),
        colorMode: z.enum(["BW", "COLOR"]),
        duplex: z.boolean(),
        pricePerPage: z.number().positive(),
        isActive: z.boolean().default(true),
      })
    ),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const shopId = req.params.shopId;
  await prisma.$transaction(async (tx) => {
    for (const rule of parsed.data.rules) {
      if (rule.id) {
        await tx.pricingRule.update({
          where: { id: rule.id },
          data: {
            name: rule.name,
            paperSize: rule.paperSize,
            colorMode: rule.colorMode,
            duplex: rule.duplex,
            pricePerPage: rule.pricePerPage,
            isActive: rule.isActive,
          },
        });
      } else {
        await tx.pricingRule.upsert({
          where: {
            shopId_paperSize_colorMode_duplex: {
              shopId,
              paperSize: rule.paperSize,
              colorMode: rule.colorMode,
              duplex: rule.duplex,
            },
          },
          create: { ...rule, shopId },
          update: {
            name: rule.name,
            pricePerPage: rule.pricePerPage,
            isActive: rule.isActive,
          },
        });
      }
    }
  });

  const rules = await prisma.pricingRule.findMany({ where: { shopId } });
  return res.json({ rules });
});

export default router;

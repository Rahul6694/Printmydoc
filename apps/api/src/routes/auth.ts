import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  hashPassword,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
  verifyRefreshToken,
} from "../lib/auth";
import { customAlphabet } from "nanoid";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { expireSubscriptionIfNeeded } from "../lib/plans";

const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);
const router = Router();

router.post("/register", async (req, res) => {
  const schema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(6),
    shopName: z.string().min(2),
    city: z.string().optional(),
    phone: z.string().optional(),
    ref: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { name, email, password, shopName, city, phone, ref } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "Email already registered" });
  }

  const referrer = ref ? await prisma.merchant.findUnique({ where: { referralCode: ref } }) : null;

  const passwordHash = await hashPassword(password);
  const baseSlug = shopName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 24);
  const slug = `${baseSlug || "shop"}-${nanoid()}`;

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name, email, passwordHash, phone },
    });
    const merchant = await tx.merchant.create({
      data: { name: `${shopName} Business`, ownerId: user.id, referredById: referrer?.id },
    });
    const shop = await tx.shop.create({
      data: {
        merchantId: merchant.id,
        name: shopName,
        slug,
        city,
        phone,
        isActive: false,
      },
    });
    await tx.shopStaff.create({
      data: { shopId: shop.id, userId: user.id, role: "OWNER" },
    });

    const defaults = [
      { name: "A4 B&W", paperSize: "A4" as const, colorMode: "BW" as const, duplex: false, pricePerPage: 2 },
      { name: "A4 B&W Duplex", paperSize: "A4" as const, colorMode: "BW" as const, duplex: true, pricePerPage: 3 },
      { name: "A4 Colour", paperSize: "A4" as const, colorMode: "COLOR" as const, duplex: false, pricePerPage: 8 },
      { name: "A4 Colour Duplex", paperSize: "A4" as const, colorMode: "COLOR" as const, duplex: true, pricePerPage: 12 },
      { name: "A3 B&W", paperSize: "A3" as const, colorMode: "BW" as const, duplex: false, pricePerPage: 5 },
      { name: "A3 Colour", paperSize: "A3" as const, colorMode: "COLOR" as const, duplex: false, pricePerPage: 15 },
    ];

    await tx.pricingRule.createMany({
      data: defaults.map((d) => ({ ...d, shopId: shop.id })),
    });

    return { user, merchant, shop };
  });

  const payload = { userId: result.user.id, email: result.user.email };
  return res.status(201).json({
    user: { id: result.user.id, name: result.user.name, email: result.user.email },
    shop: result.shop,
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  });
});

router.post("/login", async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid credentials payload" });
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const payload = { userId: user.id, email: user.email };
  const shops = await prisma.shopStaff.findMany({
    where: { userId: user.id },
    include: { shop: true },
  });

  return res.json({
    user: { id: user.id, name: user.name, email: user.email, isSuperAdmin: user.isSuperAdmin },
    shops: shops.map((s) => s.shop),
    accessToken: signAccessToken(payload),
    refreshToken: signRefreshToken(payload),
  });
});

router.post("/refresh", async (req, res) => {
  try {
    const token = z.string().parse(req.body.refreshToken);
    const payload = verifyRefreshToken(token);
    return res.json({
      accessToken: signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    });
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

router.get("/me", async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { verifyAccessToken } = await import("../lib/auth");
    const payload = verifyAccessToken(header.slice(7));
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, name: true, email: true, phone: true, isSuperAdmin: true },
    });
    const shops = await prisma.shopStaff.findMany({
      where: { userId: payload.userId },
      include: { shop: { include: { merchant: true } } },
    });

    const merchantIds = Array.from(new Set(shops.map((s) => s.shop.merchantId)));
    await Promise.all(merchantIds.map((id) => expireSubscriptionIfNeeded(id)));

    const fresh = await prisma.shopStaff.findMany({
      where: { userId: payload.userId },
      include: { shop: { include: { merchant: true } } },
    });

    return res.json({
      user,
      shops: fresh.map((s) => ({
        ...s.shop,
        merchant: {
          planCode: s.shop.merchant.planCode,
          subscriptionExpiresAt: s.shop.merchant.subscriptionExpiresAt,
        },
      })),
    });
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
});

router.patch("/me", requireAuth, async (req: AuthedRequest, res) => {
  const schema = z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.email) {
    const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (existing && existing.id !== req.user!.userId) {
      return res.status(409).json({ error: "Email already in use" });
    }
  }

  const user = await prisma.user.update({
    where: { id: req.user!.userId },
    data: parsed.data,
    select: { id: true, name: true, email: true, phone: true },
  });
  return res.json({ user });
});

export default router;

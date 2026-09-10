import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { PLATFORM_COMMISSION_PCT } from "../lib/wallet";

const router = Router();
const MIN_EARNINGS_WITHDRAWAL = 100;

async function requireShopAccess(shopId: string, userId: string) {
  return prisma.shopStaff.findFirst({ where: { shopId, userId } });
}

router.get("/summary/:shopId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const [platformCaptured, ownCaptured] = await Promise.all([
    prisma.payment.aggregate({
      where: { shopId: req.params.shopId, status: "CAPTURED", settlementMode: "PLATFORM", withdrawalId: null },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: { shopId: req.params.shopId, status: "CAPTURED", settlementMode: "OWN" },
      _sum: { amount: true },
    }),
  ]);

  const gross = Number(platformCaptured._sum.amount || 0);
  const commission = Math.round(gross * (PLATFORM_COMMISSION_PCT / 100) * 100) / 100;
  const net = Math.round((gross - commission) * 100) / 100;

  return res.json({
    grossAvailable: gross,
    commissionPct: PLATFORM_COMMISSION_PCT,
    commissionAmount: commission,
    availableAfterCommission: net,
    settledDirectlyToOwnRazorpay: Number(ownCaptured._sum.amount || 0),
  });
});

router.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const schema = z.object({
    shopId: z.string(),
    amount: z.number().positive(),
    method: z.enum(["UPI", "BANK"]),
    destination: z.string().min(3),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const access = await requireShopAccess(parsed.data.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  if (parsed.data.amount < MIN_EARNINGS_WITHDRAWAL) {
    return res.status(400).json({ error: `Minimum withdrawal is ₹${MIN_EARNINGS_WITHDRAWAL}` });
  }

  const shop = await prisma.shop.findUnique({ where: { id: parsed.data.shopId } });
  if (!shop) return res.status(404).json({ error: "Shop not found" });

  // Pull unclaimed CAPTURED payments (oldest first) until we cover the requested gross amount.
  const payments = await prisma.payment.findMany({
    where: { shopId: parsed.data.shopId, status: "CAPTURED", settlementMode: "PLATFORM", withdrawalId: null },
    orderBy: { createdAt: "asc" },
  });

  const commissionMultiplier = 1 - PLATFORM_COMMISSION_PCT / 100;
  const requestedGross = parsed.data.amount / commissionMultiplier;

  let running = 0;
  const claimed: string[] = [];
  for (const p of payments) {
    if (running >= requestedGross) break;
    running += Number(p.amount);
    claimed.push(p.id);
  }

  if (running < requestedGross - 0.01) {
    return res.status(400).json({ error: "Amount exceeds available balance" });
  }

  const commissionAmount = Math.round(running * (PLATFORM_COMMISSION_PCT / 100) * 100) / 100;
  const amountNet = Math.round((running - commissionAmount) * 100) / 100;

  const withdrawal = await prisma.$transaction(async (tx) => {
    const request = await tx.withdrawalRequest.create({
      data: {
        merchantId: shop.merchantId,
        shopId: shop.id,
        source: "EARNINGS",
        amountGross: running,
        commissionPct: PLATFORM_COMMISSION_PCT,
        amountNet,
        method: parsed.data.method,
        destination: parsed.data.destination,
      },
    });
    await tx.payment.updateMany({
      where: { id: { in: claimed } },
      data: { withdrawalId: request.id },
    });
    return request;
  });

  return res.status(201).json({ withdrawal });
});

router.get("/:shopId", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const range = (req.query.range as string) || "all";
  let createdAt: { gte?: Date; lt?: Date } | undefined;
  const now = new Date();
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    createdAt = { gte: start };
  } else if (range === "yesterday") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    createdAt = { gte: start, lt: end };
  } else if (range === "date" && req.query.date) {
    const d = new Date(req.query.date as string);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    createdAt = { gte: start, lt: end };
  }

  const [payments, withdrawals, orders] = await Promise.all([
    prisma.payment.findMany({
      where: { shopId: req.params.shopId, ...(createdAt ? { createdAt } : {}) },
      orderBy: { createdAt: "desc" },
      include: { order: { select: { id: true, customerName: true, files: { select: { originalName: true }, take: 1 } } } },
      take: 200,
    }),
    prisma.withdrawalRequest.findMany({
      where: { shopId: req.params.shopId, source: "EARNINGS" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.order.findMany({
      where: { shopId: req.params.shopId, ...(createdAt ? { createdAt } : {}) },
      select: { id: true, status: true, totalAmount: true },
    }),
  ]);

  const paidOrders = orders.filter((o) => !["DRAFT", "AWAITING_PAYMENT"].includes(o.status));
  const orderValue = orders.reduce((sum, o) => sum + Number(o.totalAmount), 0);
  const collected = paidOrders.reduce((sum, o) => sum + Number(o.totalAmount), 0);

  return res.json({
    stats: {
      orders: orders.length,
      paidOrders: paidOrders.length,
      orderValue,
      collected,
    },
    payments,
    withdrawals,
  });
});

export default router;

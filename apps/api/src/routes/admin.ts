import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth, requireSuperAdmin } from "../middleware/auth";

const router = Router();

router.use(requireAuth, requireSuperAdmin);

router.get("/overview", async (_req, res) => {
  const [shopsCount, merchantsCount, ordersCount, pendingWithdrawals, revenue] = await Promise.all([
    prisma.shop.count(),
    prisma.merchant.count(),
    prisma.order.count(),
    prisma.withdrawalRequest.aggregate({
      where: { status: "PENDING" },
      _count: true,
      _sum: { amountNet: true },
    }),
    prisma.payment.aggregate({
      where: { status: "CAPTURED" },
      _sum: { amount: true },
    }),
  ]);

  return res.json({
    shops: shopsCount,
    merchants: merchantsCount,
    orders: ordersCount,
    pendingWithdrawals: {
      count: pendingWithdrawals._count,
      amount: Number(pendingWithdrawals._sum.amountNet || 0),
    },
    totalRevenue: Number(revenue._sum.amount || 0),
  });
});

router.get("/shops", async (req, res) => {
  const search = (req.query.q as string | undefined)?.trim();

  const shops = await prisma.shop.findMany({
    where: search
      ? {
          OR: [
            { name: { contains: search } },
            { slug: { contains: search } },
            { city: { contains: search } },
            { merchant: { name: { contains: search } } },
            { merchant: { owner: { email: { contains: search } } } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      merchant: {
        select: {
          id: true,
          name: true,
          planCode: true,
          subscriptionExpiresAt: true,
          walletAvailable: true,
          owner: { select: { id: true, name: true, email: true, phone: true } },
        },
      },
      _count: { select: { orders: true, staff: true, printers: true, agents: true } },
    },
  });

  return res.json({ shops });
});

router.get("/shops/:id", async (req, res) => {
  const shop = await prisma.shop.findUnique({
    where: { id: req.params.id },
    include: {
      merchant: {
        include: {
          owner: { select: { id: true, name: true, email: true, phone: true, createdAt: true } },
        },
      },
      staff: { include: { user: { select: { id: true, name: true, email: true, phone: true } } } },
      printers: true,
      agents: { select: { id: true, name: true, isOnline: true, lastSeenAt: true } },
      pricingRules: { where: { isActive: true } },
      withdrawalRequests: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });

  if (!shop) return res.status(404).json({ error: "Shop not found" });

  const [orderStats, revenue] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], where: { shopId: shop.id }, _count: true }),
    prisma.payment.aggregate({
      where: { shopId: shop.id, status: "CAPTURED" },
      _sum: { amount: true },
    }),
  ]);

  return res.json({
    shop: { ...shop, razorpayKeySecret: shop.razorpayKeySecret ? "••••••••" : null },
    orderStats: orderStats.map((s) => ({ status: s.status, count: s._count })),
    totalRevenue: Number(revenue._sum.amount || 0),
  });
});

router.patch("/shops/:id/active", async (req, res) => {
  const schema = z.object({ isActive: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const shop = await prisma.shop.update({
    where: { id: req.params.id },
    data: { isActive: parsed.data.isActive },
  });

  return res.json({ shop });
});

router.get("/withdrawals", async (req, res) => {
  const status = req.query.status as string | undefined;
  const withdrawals = await prisma.withdrawalRequest.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      merchant: { select: { id: true, name: true, owner: { select: { name: true, email: true } } } },
      shop: { select: { id: true, name: true, slug: true } },
    },
    take: 200,
  });

  return res.json({ withdrawals });
});

router.patch("/withdrawals/:id", async (req: AuthedRequest, res) => {
  const schema = z.object({ status: z.enum(["APPROVED", "REJECTED", "PAID"]) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const withdrawal = await prisma.withdrawalRequest.findUnique({ where: { id: req.params.id } });
  if (!withdrawal) return res.status(404).json({ error: "Withdrawal request not found" });
  if (withdrawal.status !== "PENDING" && withdrawal.status !== "APPROVED") {
    return res.status(400).json({ error: `Cannot change status from ${withdrawal.status}` });
  }

  const nextStatus = parsed.data.status;

  const updated = await prisma.$transaction(async (tx) => {
    if (nextStatus === "REJECTED") {
      if (withdrawal.source === "EARNINGS") {
        // Release the claimed payments so the merchant can withdraw them again.
        await tx.payment.updateMany({
          where: { withdrawalId: withdrawal.id },
          data: { withdrawalId: null },
        });
      } else {
        await tx.merchant.update({
          where: { id: withdrawal.merchantId },
          data: {
            walletReserved: { decrement: withdrawal.amountGross },
            walletAvailable: { increment: withdrawal.amountGross },
          },
        });
      }
    }

    if (nextStatus === "PAID" && withdrawal.source === "REFERRAL") {
      await tx.merchant.update({
        where: { id: withdrawal.merchantId },
        data: {
          walletReserved: { decrement: withdrawal.amountGross },
          walletWithdrawn: { increment: withdrawal.amountGross },
        },
      });
    }

    return tx.withdrawalRequest.update({
      where: { id: withdrawal.id },
      data: { status: nextStatus },
    });
  });

  return res.json({ withdrawal: updated });
});

export default router;

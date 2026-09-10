import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { PLANS, findPlan } from "../lib/plans";

const router = Router();

async function myMerchant(userId: string) {
  return prisma.merchant.findFirst({ where: { ownerId: userId } });
}

router.get("/", (_req, res) => {
  return res.json({ plans: PLANS });
});

router.post("/purchase", requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await myMerchant(req.user!.userId);
  if (!merchant) return res.status(404).json({ error: "No merchant account found" });

  const schema = z.object({ planCode: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const plan = findPlan(parsed.data.planCode);
  if (!plan) return res.status(400).json({ error: "Unknown plan" });

  const amountPaise = Math.round(plan.amount * 100);
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const mode = process.env.PAYMENT_MODE || "mock";

  if (mode === "razorpay" && keyId && keySecret) {
    const Razorpay = (await import("razorpay")).default;
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const rzOrder = await rzp.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `plan_${merchant.id.slice(0, 20)}_${Date.now()}`,
    });
    const purchase = await prisma.planPurchase.create({
      data: { merchantId: merchant.id, planCode: plan.code, months: plan.months, amount: plan.amount, razorpayOrderId: rzOrder.id },
    });
    return res.json({
      mode: "razorpay",
      planPurchaseId: purchase.id,
      razorpayOrderId: rzOrder.id,
      amount: amountPaise,
      currency: "INR",
      keyId,
    });
  }

  const purchase = await prisma.planPurchase.create({
    data: { merchantId: merchant.id, planCode: plan.code, months: plan.months, amount: plan.amount, status: "PAID" },
  });
  await activatePlan(merchant.id, plan.code, plan.months);
  return res.json({ mode: "mock", planPurchaseId: purchase.id, amount: plan.amount });
});

router.post("/verify", requireAuth, async (req: AuthedRequest, res) => {
  const schema = z.object({
    planPurchaseId: z.string(),
    razorpayOrderId: z.string(),
    razorpayPaymentId: z.string(),
    razorpaySignature: z.string(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return res.status(500).json({ error: "Razorpay not configured" });

  const body = `${parsed.data.razorpayOrderId}|${parsed.data.razorpayPaymentId}`;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (expected !== parsed.data.razorpaySignature) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const purchase = await prisma.planPurchase.findUnique({ where: { id: parsed.data.planPurchaseId } });
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  if (purchase.status === "PAID") return res.json({ purchase });

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.planPurchase.update({
      where: { id: purchase.id },
      data: { status: "PAID", razorpayPaymentId: parsed.data.razorpayPaymentId },
    });
    await activatePlan(purchase.merchantId, purchase.planCode, purchase.months, tx);
    return p;
  });

  return res.json({ purchase: updated });
});

async function activatePlan(
  merchantId: string,
  planCode: string,
  months: number,
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  const merchant = await tx.merchant.findUnique({ where: { id: merchantId } });
  const now = new Date();
  const base = merchant?.subscriptionExpiresAt && merchant.subscriptionExpiresAt > now ? merchant.subscriptionExpiresAt : now;
  const expiresAt = new Date(base);
  expiresAt.setMonth(expiresAt.getMonth() + months);

  await tx.merchant.update({
    where: { id: merchantId },
    data: { planCode, planDurationMonths: months, subscriptionExpiresAt: expiresAt },
  });
  await tx.shop.updateMany({ where: { merchantId }, data: { isActive: true } });
}

export default router;

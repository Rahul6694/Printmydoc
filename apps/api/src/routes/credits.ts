import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { CREDIT_PRICE_INR } from "../lib/wallet";

const router = Router();

async function myMerchant(userId: string) {
  return prisma.merchant.findFirst({ where: { ownerId: userId } });
}

function periodEnd() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await myMerchant(req.user!.userId);
  if (!merchant) return res.status(404).json({ error: "No merchant account found" });

  return res.json({
    included: merchant.creditsIncluded,
    used: merchant.creditsUsed,
    purchased: merchant.creditsPurchased,
    remaining: merchant.creditsIncluded + merchant.creditsPurchased - merchant.creditsUsed,
    pricePerCredit: CREDIT_PRICE_INR,
    periodEnds: periodEnd().toISOString(),
  });
});

router.post("/purchase", requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await myMerchant(req.user!.userId);
  if (!merchant) return res.status(404).json({ error: "No merchant account found" });

  const schema = z.object({ qty: z.number().int().positive().max(100000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const amount = parsed.data.qty * CREDIT_PRICE_INR;
  const amountPaise = Math.round(amount * 100);

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const mode = process.env.PAYMENT_MODE || "mock";

  if (mode === "razorpay" && keyId && keySecret) {
    const Razorpay = (await import("razorpay")).default;
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const rzOrder = await rzp.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `credits_${merchant.id.slice(0, 20)}_${Date.now()}`,
    });
    const purchase = await prisma.creditPurchase.create({
      data: { merchantId: merchant.id, qty: parsed.data.qty, amount, razorpayOrderId: rzOrder.id },
    });
    return res.json({
      mode: "razorpay",
      creditPurchaseId: purchase.id,
      razorpayOrderId: rzOrder.id,
      amount: amountPaise,
      currency: "INR",
      keyId,
    });
  }

  const purchase = await prisma.creditPurchase.create({
    data: { merchantId: merchant.id, qty: parsed.data.qty, amount, status: "PAID" },
  });
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { creditsPurchased: { increment: parsed.data.qty } },
  });
  return res.json({ mode: "mock", creditPurchaseId: purchase.id, amount });
});

router.post("/verify", requireAuth, async (req: AuthedRequest, res) => {
  const schema = z.object({
    creditPurchaseId: z.string(),
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

  const purchase = await prisma.creditPurchase.findUnique({ where: { id: parsed.data.creditPurchaseId } });
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  if (purchase.status === "PAID") return res.json({ purchase });

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.creditPurchase.update({
      where: { id: purchase.id },
      data: { status: "PAID", razorpayPaymentId: parsed.data.razorpayPaymentId },
    });
    await tx.merchant.update({
      where: { id: purchase.merchantId },
      data: { creditsPurchased: { increment: purchase.qty } },
    });
    return p;
  });

  return res.json({ purchase: updated });
});

export default router;

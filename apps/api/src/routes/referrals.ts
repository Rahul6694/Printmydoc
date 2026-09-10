import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { ensureReferralCode } from "../lib/wallet";

const router = Router();

const MIN_REFERRAL_WITHDRAWAL = 500;

async function myMerchant(userId: string) {
  return prisma.merchant.findFirst({ where: { ownerId: userId } });
}

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await myMerchant(req.user!.userId);
  if (!merchant) return res.status(404).json({ error: "No merchant account found" });

  const code = await ensureReferralCode(merchant.id);
  const webOrigin = process.env.WEB_ORIGIN || "http://localhost:3000";

  const [referred, withdrawals] = await Promise.all([
    prisma.merchant.findMany({
      where: { referredById: merchant.id },
      select: { id: true, name: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.withdrawalRequest.findMany({
      where: { merchantId: merchant.id, source: "REFERRAL" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const fresh = await prisma.merchant.findUnique({ where: { id: merchant.id } });

  return res.json({
    code,
    link: `${webOrigin}/register?ref=${code}`,
    wallet: {
      locked: fresh!.walletLocked,
      available: fresh!.walletAvailable,
      reserved: fresh!.walletReserved,
      withdrawn: fresh!.walletWithdrawn,
      cancelled: fresh!.walletCancelled,
      reversed: fresh!.walletReversed,
    },
    referredMerchants: referred,
    withdrawals,
  });
});

router.post("/withdraw", requireAuth, async (req: AuthedRequest, res) => {
  const merchant = await myMerchant(req.user!.userId);
  if (!merchant) return res.status(404).json({ error: "No merchant account found" });

  const schema = z.object({
    amount: z.number().positive(),
    method: z.enum(["UPI", "BANK"]),
    destination: z.string().min(3),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  if (parsed.data.amount < MIN_REFERRAL_WITHDRAWAL) {
    return res.status(400).json({ error: `Minimum withdrawal is ₹${MIN_REFERRAL_WITHDRAWAL}` });
  }
  if (Number(merchant.walletAvailable) < parsed.data.amount) {
    return res.status(400).json({ error: "Amount exceeds available balance" });
  }

  const request = await prisma.$transaction(async (tx) => {
    await tx.merchant.update({
      where: { id: merchant.id },
      data: {
        walletAvailable: { decrement: parsed.data.amount },
        walletReserved: { increment: parsed.data.amount },
      },
    });
    return tx.withdrawalRequest.create({
      data: {
        merchantId: merchant.id,
        source: "REFERRAL",
        amountGross: parsed.data.amount,
        commissionPct: 0,
        amountNet: parsed.data.amount,
        method: parsed.data.method,
        destination: parsed.data.destination,
      },
    });
  });

  return res.status(201).json({ withdrawal: request });
});

export default router;

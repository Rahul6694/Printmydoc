import { prisma } from "./prisma";

export const REFERRAL_BONUS_INR = 50;
export const PLATFORM_COMMISSION_PCT = 2.5;
export const CREDIT_PRICE_INR = 1;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(len = 8) {
  let code = "";
  for (let i = 0; i < len; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

export async function ensureReferralCode(merchantId: string): Promise<string> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (merchant?.referralCode) return merchant.referralCode;

  for (let i = 0; i < 5; i++) {
    const code = randomCode();
    try {
      const updated = await prisma.merchant.update({ where: { id: merchantId }, data: { referralCode: code } });
      return updated.referralCode!;
    } catch {
      // unique collision, retry
    }
  }
  throw new Error("Could not generate a unique referral code");
}

/**
 * Credits REFERRAL_BONUS_INR to the referring merchant's wallet the first time
 * a referred merchant's shop completes a paid order. Fires exactly once per
 * referred merchant (guarded by counting their total completed orders).
 */
export async function creditReferralBonusIfEligible(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, include: { merchant: true } });
  if (!shop || !shop.merchant.referredById) return;

  const completedCount = await prisma.order.count({
    where: {
      shop: { merchantId: shop.merchant.id },
      status: { in: ["COMPLETED", "PARTIALLY_COMPLETED"] },
    },
  });
  if (completedCount !== 1) return;

  await prisma.merchant.update({
    where: { id: shop.merchant.referredById },
    data: { walletAvailable: { increment: REFERRAL_BONUS_INR } },
  });
}

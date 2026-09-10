import { prisma } from "./prisma";

export const PLANS = [
  { code: "1m", label: "1 Month", months: 1, amount: 100 },
  { code: "6m", label: "6 Months", months: 6, amount: 500 },
  { code: "12m", label: "1 Year", months: 12, amount: 1000 },
] as const;

export type PlanCode = (typeof PLANS)[number]["code"];

export function findPlan(code: string) {
  return PLANS.find((p) => p.code === code);
}

/**
 * Lazily deactivates a merchant's shops once their subscription has lapsed.
 * Called on read (no cron in this app) so access is always checked against
 * the real expiry date rather than a stale isActive flag.
 */
export async function expireSubscriptionIfNeeded(merchantId: string) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant?.subscriptionExpiresAt) return;
  if (merchant.subscriptionExpiresAt > new Date()) return;

  await prisma.shop.updateMany({
    where: { merchantId, isActive: true },
    data: { isActive: false },
  });
}

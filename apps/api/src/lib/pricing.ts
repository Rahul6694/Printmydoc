import { ColorMode, PaperSize, Prisma } from "@prisma/client";
import { prisma } from "./prisma";

type RateMap = Record<string, number>;

function comboKey(colorMode: ColorMode, duplex: boolean) {
  return `${colorMode === "COLOR" ? "color" : "bw"}${duplex ? "B2B" : "Single"}`;
}

export async function calculatePrice(input: {
  shopId: string;
  paperSize: PaperSize;
  colorMode: ColorMode;
  duplex: boolean;
  pageCount: number;
  copies: number;
  printMode?: "normal" | "collage" | "merge";
}) {
  const shop = await prisma.shop.findUnique({ where: { id: input.shopId } });
  if (!shop) throw new Error("Shop not found");

  const pages = Math.max(1, input.pageCount);
  const copies = Math.max(1, input.copies);
  const key = comboKey(input.colorMode, input.duplex);
  const printMode = input.printMode || "normal";

  let unitPrice: Prisma.Decimal;
  let ruleId: string | null = null;
  let ruleName: string;

  if (printMode === "collage" || printMode === "merge") {
    const enabled = printMode === "collage" ? shop.collageEnabled : shop.mergeEnabled;
    const pricing = (printMode === "collage" ? shop.collagePricing : shop.mergePricing) as RateMap | null;
    const rate = pricing?.[key];
    if (!enabled || rate == null || rate <= 0) {
      throw new Error(`${printMode === "collage" ? "Collage" : "Merge"} pricing is not configured for this option`);
    }
    unitPrice = new Prisma.Decimal(rate);
    ruleName = `${printMode === "collage" ? "Collage" : "Merge"} · ${key}`;
  } else {
    const rule = await prisma.pricingRule.findFirst({
      where: {
        shopId: input.shopId,
        paperSize: input.paperSize,
        colorMode: input.colorMode,
        duplex: input.duplex,
        isActive: true,
      },
    });
    if (!rule) throw new Error("No pricing rule found for selected print options");
    unitPrice = new Prisma.Decimal(rule.pricePerPage);
    ruleId = rule.id;
    ruleName = rule.name;
  }

  const normalSubtotal = unitPrice.mul(pages).mul(copies);
  let totalAmount = normalSubtotal;
  let discountApplied: "bulk" | "copy" | null = null;

  // High-value order discount: once the normal order value clears the threshold,
  // the discounted per-page rate replaces the normal rate for the whole order.
  if (printMode === "normal" && shop.bulkPricingEnabled && shop.bulkPricingThreshold != null) {
    const threshold = new Prisma.Decimal(shop.bulkPricingThreshold);
    if (normalSubtotal.gte(threshold)) {
      const rates = shop.bulkPricingRates as RateMap | null;
      const discounted = rates?.[key];
      if (discounted != null && discounted > 0) {
        totalAmount = new Prisma.Decimal(discounted).mul(pages).mul(copies);
        discountApplied = "bulk";
      }
    }
  }

  // Additional-copy discount: copy 1 stays at the normal rate, copies 2+ use the
  // paper-specific discounted rate. Mutually exclusive with the bulk discount.
  if (
    discountApplied === null &&
    printMode === "normal" &&
    shop.copyDiscountEnabled &&
    copies > 1
  ) {
    const rates = shop.copyDiscountRates as Record<string, RateMap> | null;
    const discounted = rates?.[input.paperSize]?.[key];
    if (discounted != null && discounted > 0) {
      const firstCopy = unitPrice.mul(pages);
      const restCopies = new Prisma.Decimal(discounted).mul(pages).mul(copies - 1);
      totalAmount = firstCopy.add(restCopies);
      discountApplied = "copy";
    }
  }

  return {
    unitPrice,
    totalAmount,
    ruleId,
    ruleName,
    discountApplied,
  };
}

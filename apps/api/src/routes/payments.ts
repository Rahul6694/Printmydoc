import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { markOrderPaid } from "../services/printJobs";

const router = Router();

router.post("/create", async (req, res) => {
  const schema = z.object({ orderId: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "orderId required" });

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "AWAITING_PAYMENT") {
    return res.status(400).json({ error: `Order is ${order.status}` });
  }

  const shop = await prisma.shop.findUnique({ where: { id: order.shopId } });
  const mode = process.env.PAYMENT_MODE || "mock";
  const amountPaise = Math.round(Number(order.totalAmount) * 100);

  const useOwn = !!(shop?.useOwnRazorpay && shop.razorpayKeyId && shop.razorpayKeySecret);
  const keyId = useOwn ? shop!.razorpayKeyId! : process.env.RAZORPAY_KEY_ID;
  const keySecret = useOwn ? shop!.razorpayKeySecret! : process.env.RAZORPAY_KEY_SECRET;

  if (mode === "razorpay" && keyId && keySecret) {
    const Razorpay = (await import("razorpay")).default;
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const rzOrder = await rzp.orders.create({
      amount: amountPaise,
      currency: shop?.currency || "INR",
      receipt: order.id.slice(0, 40),
    });
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        shopId: order.shopId,
        provider: "razorpay",
        status: "PENDING",
        amount: order.totalAmount,
        providerOrderId: rzOrder.id,
        settlementMode: useOwn ? "OWN" : "PLATFORM",
      },
    });
    return res.json({
      mode: "razorpay",
      paymentId: payment.id,
      razorpayOrderId: rzOrder.id,
      amount: amountPaise,
      currency: shop?.currency || "INR",
      keyId,
      displayName: shop?.checkoutDisplayName || shop?.name,
      logoUrl: shop?.paymentLogoUrl || undefined,
    });
  }

  const providerOrderId = `mock_order_${order.id}`;
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      shopId: order.shopId,
      provider: "mock",
      status: "PENDING",
      amount: order.totalAmount,
      providerOrderId,
    },
  });

  return res.json({
    mode: "mock",
    paymentId: payment.id,
    amount: Number(order.totalAmount),
    currency: "INR",
    mockCheckoutUrl: `/pay/mock/${payment.id}`,
  });
});

router.post("/mock/confirm", async (req, res) => {
  const schema = z.object({ paymentId: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "paymentId required" });

  const payment = await prisma.payment.findUnique({ where: { id: parsed.data.paymentId } });
  if (!payment) return res.status(404).json({ error: "Payment not found" });

  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: "CAPTURED",
      providerPaymentId: `mock_pay_${crypto.randomBytes(6).toString("hex")}`,
    },
  });

  const order = await markOrderPaid(payment.orderId);
  return res.json({ payment: updated, order });
});

router.post("/razorpay/verify", async (req, res) => {
  const schema = z.object({
    paymentId: z.string(),
    razorpayOrderId: z.string(),
    razorpayPaymentId: z.string(),
    razorpaySignature: z.string(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.payment.findUnique({ where: { id: parsed.data.paymentId } });
  if (!existing) return res.status(404).json({ error: "Payment not found" });

  let secret = process.env.RAZORPAY_KEY_SECRET;
  if (existing.settlementMode === "OWN") {
    const shop = await prisma.shop.findUnique({ where: { id: existing.shopId } });
    secret = shop?.razorpayKeySecret || secret;
  }
  if (!secret) return res.status(500).json({ error: "Razorpay not configured" });

  const body = `${parsed.data.razorpayOrderId}|${parsed.data.razorpayPaymentId}`;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (expected !== parsed.data.razorpaySignature) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const payment = await prisma.payment.update({
    where: { id: parsed.data.paymentId },
    data: {
      status: "CAPTURED",
      providerPaymentId: parsed.data.razorpayPaymentId,
    },
  });
  const order = await markOrderPaid(payment.orderId);
  return res.json({ payment, order });
});

router.post("/razorpay/webhook", async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "Webhook secret missing" });

  const signature = req.headers["x-razorpay-signature"] as string;
  const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (!raw || !signature) return res.status(400).json({ error: "Invalid webhook" });

  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  if (expected !== signature) return res.status(400).json({ error: "Bad signature" });

  const event = req.body;
  const eventId = event?.id || event?.event_id || crypto.randomUUID();

  try {
    await prisma.webhookEvent.create({
      data: {
        provider: "razorpay",
        eventId,
        eventType: event.event || "unknown",
        payload: event,
      },
    });
  } catch {
    return res.json({ ok: true, duplicate: true });
  }

  if (event.event === "payment.captured") {
    const paymentEntity = event.payload?.payment?.entity;
    const providerOrderId = paymentEntity?.order_id;
    if (providerOrderId) {
      const payment = await prisma.payment.findFirst({ where: { providerOrderId } });
      if (payment && payment.status !== "CAPTURED") {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: "CAPTURED",
            providerPaymentId: paymentEntity.id,
            rawPayload: paymentEntity,
          },
        });
        await markOrderPaid(payment.orderId);
      }
    }
  }

  return res.json({ ok: true });
});

export default router;

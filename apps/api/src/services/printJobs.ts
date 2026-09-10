import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";

export async function createPrintJobForOrder(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { shop: true },
  });
  if (!order) throw new Error("Order not found");

  const existing = await prisma.printJob.findFirst({
    where: {
      orderId,
      status: { in: ["PENDING", "ASSIGNED", "DOWNLOADING", "PRINTING"] },
    },
  });
  if (existing) return existing;

  const onlineAgent = await prisma.agent.findFirst({
    where: { shopId: order.shopId, isOnline: true },
  });

  const printer = await prisma.printer.findFirst({
    where: {
      shopId: order.shopId,
      isEnabled: true,
      ...(order.colorMode === "COLOR" ? { supportsColor: true } : {}),
      ...(order.duplex ? { supportsDuplex: true } : {}),
    },
    orderBy: { priority: "asc" },
  });

  return prisma.printJob.create({
    data: {
      orderId: order.id,
      shopId: order.shopId,
      agentId: onlineAgent?.id,
      printerId: printer?.id,
      status: onlineAgent ? "ASSIGNED" : "PENDING",
      idempotencyKey: `job_${order.id}_${nanoid(6)}`,
      assignedAt: onlineAgent ? new Date() : undefined,
    },
  });
}

export async function markOrderPaid(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { shop: true },
  });
  if (!order) throw new Error("Order not found");
  if (["PAID", "APPROVED", "QUEUED", "PRINTING", "COMPLETED"].includes(order.status)) {
    return order;
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: "PAID", paidAt: new Date() },
    include: { shop: true },
  });

  if (!updated.shop.requireApproval || updated.shop.autoPrint) {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "QUEUED" },
    });
    await createPrintJobForOrder(orderId);
  }

  return updated;
}

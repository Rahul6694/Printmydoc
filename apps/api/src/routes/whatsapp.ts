import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";

const router = Router();

const WORKER_URL = process.env.WHATSAPP_WORKER_URL || "";
const WORKER_SECRET = process.env.WHATSAPP_WORKER_SECRET || "";

async function requireShopAccess(shopId: string, userId: string) {
  return prisma.shopStaff.findFirst({ where: { shopId, userId } });
}

async function proxyToWorker(method: "GET" | "POST", shopId: string, action: string) {
  const res = await fetch(`${WORKER_URL}/internal/whatsapp/${shopId}/${action}`, {
    method,
    headers: { "x-worker-secret": WORKER_SECRET },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

router.get("/:shopId/status", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  try {
    const { status, data } = await proxyToWorker("GET", req.params.shopId, "status");
    return res.status(status).json(data);
  } catch (e) {
    return res.status(502).json({ error: `Could not reach WhatsApp worker: ${(e as Error).message}` });
  }
});

router.post("/:shopId/start", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  try {
    const { status, data } = await proxyToWorker("POST", req.params.shopId, "start");
    return res.status(status).json(data);
  } catch (e) {
    return res.status(502).json({ error: `Could not start WhatsApp session: ${(e as Error).message}` });
  }
});

router.post("/:shopId/logout", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  try {
    const { status, data } = await proxyToWorker("POST", req.params.shopId, "logout");
    return res.status(status).json(data);
  } catch (e) {
    return res.status(502).json({ error: `Could not reach WhatsApp worker: ${(e as Error).message}` });
  }
});

export default router;

import { Router } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest, requireAuth } from "../middleware/auth";
import { startSession, logoutSession, getSessionState } from "../services/whatsapp";

const router = Router();

async function requireShopAccess(shopId: string, userId: string) {
  return prisma.shopStaff.findFirst({ where: { shopId, userId } });
}

router.get("/:shopId/status", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  const live = getSessionState(req.params.shopId);
  if (live.status !== "OFFLINE") return res.json(live);

  const stored = await prisma.whatsAppSession.findUnique({ where: { shopId: req.params.shopId } });
  return res.json({
    status: stored?.status || "OFFLINE",
    qr: null,
    phoneNumber: stored?.phoneNumber || null,
  });
});

router.post("/:shopId/start", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  try {
    const state = await startSession(req.params.shopId);
    return res.json(state);
  } catch (e) {
    return res.status(500).json({ error: `Could not start WhatsApp session: ${(e as Error).message}` });
  }
});

router.post("/:shopId/logout", requireAuth, async (req: AuthedRequest, res) => {
  const access = await requireShopAccess(req.params.shopId, req.user!.userId);
  if (!access) return res.status(403).json({ error: "Forbidden" });

  await logoutSession(req.params.shopId);
  return res.json({ ok: true });
});

export default router;

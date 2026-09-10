import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/auth";
import { prisma } from "../lib/prisma";

export type AuthedRequest = Request & {
  user?: { userId: string; email: string };
};

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    req.user = verifyAccessToken(header.slice(7));
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export async function requireShopAccess(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const shopId = (req.params.shopId || req.body.shopId || req.query.shopId) as string;
  if (!shopId || !req.user) {
    return res.status(400).json({ error: "shopId required" });
  }

  const staff = await prisma.shopStaff.findFirst({
    where: { shopId, userId: req.user.userId },
    include: { shop: true },
  });

  const owned = await prisma.merchant.findFirst({
    where: { ownerId: req.user.userId, shops: { some: { id: shopId } } },
  });

  if (!staff && !owned) {
    return res.status(403).json({ error: "No access to this shop" });
  }

  (req as AuthedRequest & { shopId?: string }).shopId = shopId;
  return next();
}

export async function requireSuperAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "Unauthorized" });

  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { isSuperAdmin: true },
  });

  if (!user?.isSuperAdmin) {
    return res.status(403).json({ error: "Super admin access required" });
  }

  return next();
}

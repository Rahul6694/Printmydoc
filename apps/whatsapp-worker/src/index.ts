import "dotenv/config";
import express from "express";
import cors from "cors";
import { getStatus, startSession, logoutSession } from "./whatsapp";

const app = express();
const port = Number(process.env.PORT || 5001);
const WORKER_SECRET = process.env.WORKER_SECRET || "";

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, service: "printmydoc-whatsapp-worker" }));

function requireWorkerSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!WORKER_SECRET || req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/internal/whatsapp/:shopId/status", requireWorkerSecret, async (req, res) => {
  const state = await getStatus(req.params.shopId);
  return res.json(state);
});

app.post("/internal/whatsapp/:shopId/start", requireWorkerSecret, async (req, res) => {
  try {
    const state = await startSession(req.params.shopId);
    return res.json(state);
  } catch (e) {
    return res.status(500).json({ error: `Could not start WhatsApp session: ${(e as Error).message}` });
  }
});

app.post("/internal/whatsapp/:shopId/logout", requireWorkerSecret, async (req, res) => {
  await logoutSession(req.params.shopId);
  return res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`PrintMyDoc WhatsApp worker running on http://localhost:${port}`);
});

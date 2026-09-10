import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import authRoutes from "./routes/auth";
import shopRoutes from "./routes/shops";
import orderRoutes from "./routes/orders";
import paymentRoutes from "./routes/payments";
import agentRoutes from "./routes/agents";
import printerRoutes from "./routes/printers";
import referralRoutes from "./routes/referrals";
import withdrawalRoutes from "./routes/withdrawals";
import creditRoutes from "./routes/credits";
import whatsappRoutes from "./routes/whatsapp";
import planRoutes from "./routes/plans";
import adminRoutes from "./routes/admin";
import agentBuildRoutes from "./routes/agentBuilds";
import { setupSockets } from "./sockets";
import { attachWhatsAppIo } from "./services/whatsapp";

const app = express();
const port = Number(process.env.PORT || 4000);
const webOrigins = (process.env.WEB_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: webOrigins,
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

app.get("/health", (_req, res) => res.json({ ok: true, service: "printmydoc-api" }));

app.use("/api/auth", authRoutes);
app.use("/api/shops", shopRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/printers", printerRoutes);
app.use("/api/referrals", referralRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/credits", creditRoutes);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/agent-builds", agentBuildRoutes);
app.use("/uploads", express.static(path.resolve(process.env.UPLOAD_DIR || "./uploads")));

const server = http.createServer(app);
const io = setupSockets(server, webOrigins);
app.set("io", io);
attachWhatsAppIo(io);

server.listen(port, () => {
  console.log(`PrintMyDoc API running on http://localhost:${port}`);
});

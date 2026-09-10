import { Server } from "socket.io";
import { Server as HttpServer } from "http";
import { prisma } from "../lib/prisma";

export function setupSockets(httpServer: HttpServer, webOrigins: string[]) {
  const io = new Server(httpServer, {
    cors: { origin: webOrigins, methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    socket.on("join_shop", (shopId: string) => {
      if (shopId) socket.join(`shop:${shopId}`);
    });

    socket.on("join_whatsapp", (shopId: string) => {
      if (shopId) socket.join(`whatsapp:${shopId}`);
    });

    socket.on("join_agent", async (agentId: string) => {
      if (!agentId) return;
      socket.join(`agent:${agentId}`);
      await prisma.agent.update({
        where: { id: agentId },
        data: { isOnline: true, lastSeenAt: new Date() },
      });
    });

    socket.on("disconnect", () => {
      // keep lastSeen; online flag refreshed by heartbeat
    });
  });

  return io;
}

export type AppSocket = ReturnType<typeof setupSockets>;

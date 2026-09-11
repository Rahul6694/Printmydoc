import path from "path";
import fs from "fs";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import pino from "pino";
import { prisma } from "./lib/prisma";

const waLogger = pino({ level: "silent" });

type Status = "OFFLINE" | "PAIRING" | "CONNECTED";

type ShopSession = {
  status: Status;
  qr?: string;
  phoneNumber?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock?: any;
  starting: boolean;
};

const sessions = new Map<string, ShopSession>();

function authDirFor(shopId: string) {
  return path.resolve(process.env.WHATSAPP_AUTH_DIR || "./whatsapp-auth", shopId);
}

async function persist(shopId: string, status: Status, phoneNumber?: string | null) {
  await prisma.whatsAppSession.upsert({
    where: { shopId },
    update: {
      status,
      ...(phoneNumber !== undefined ? { phoneNumber } : {}),
      ...(status === "CONNECTED" ? { lastConnectedAt: new Date() } : {}),
    },
    create: { shopId, status, phoneNumber: phoneNumber || null },
  });
}

export function getSessionState(shopId: string): { status: Status; qr: string | null; phoneNumber: string | null } {
  const s = sessions.get(shopId);
  if (!s) return { status: "OFFLINE", qr: null, phoneNumber: null };
  return { status: s.status, qr: s.qr || null, phoneNumber: s.phoneNumber || null };
}

export async function getStatus(shopId: string) {
  const live = getSessionState(shopId);
  if (live.status !== "OFFLINE") return live;

  const stored = await prisma.whatsAppSession.findUnique({ where: { shopId } });
  return {
    status: stored?.status || "OFFLINE",
    qr: null,
    phoneNumber: stored?.phoneNumber || null,
  };
}

export async function startSession(shopId: string) {
  const existing = sessions.get(shopId);
  if (existing && (existing.status === "CONNECTED" || existing.starting)) {
    return getSessionState(shopId);
  }

  const state: ShopSession = { status: "PAIRING", starting: true };
  sessions.set(shopId, state);

  try {
    const authDir = authDirFor(shopId);
    fs.mkdirSync(authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: authState,
      printQRInTerminal: false,
      browser: ["PrintMyDoc", "Chrome", "1.0"],
      logger: waLogger,
    });
    state.sock = sock;
    state.starting = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        state.qr = qr;
        state.status = "PAIRING";
        await persist(shopId, "PAIRING").catch(() => undefined);
      }

      if (connection === "open") {
        state.status = "CONNECTED";
        state.qr = undefined;
        state.phoneNumber = sock.user?.id?.split(":")[0] || sock.user?.id || undefined;
        await persist(shopId, "CONNECTED", state.phoneNumber || null).catch(() => undefined);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        sessions.delete(shopId);
        await persist(shopId, "OFFLINE").catch(() => undefined);

        if (loggedOut) {
          fs.rmSync(authDir, { recursive: true, force: true });
        }
      }
    });
  } catch (err) {
    state.status = "OFFLINE";
    state.starting = false;
    sessions.delete(shopId);
    await persist(shopId, "OFFLINE").catch(() => undefined);
    throw err;
  }

  return getSessionState(shopId);
}

export async function logoutSession(shopId: string) {
  const state = sessions.get(shopId);
  if (state?.sock) {
    try {
      await state.sock.logout();
    } catch {
      // socket may already be dead; proceed to clear local state regardless
    }
  }
  sessions.delete(shopId);
  fs.rmSync(authDirFor(shopId), { recursive: true, force: true });
  await persist(shopId, "OFFLINE").catch(() => undefined);
}

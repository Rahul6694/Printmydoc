import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { AgentApi } from "./api";
import { BackgroundService, AgentStatus } from "./background";
import { AgentTray } from "./tray";
import { AgentConfig, loadConfig, saveConfig, clearConfig } from "./store";

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let setupWindow: BrowserWindow | null = null;
let tray: AgentTray | null = null;
let background: BackgroundService | null = null;

function openSetupWindow() {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 420,
    height: 480,
    resizable: false,
    title: "PrintMyDoc Agent Setup",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, "..", "renderer", "setup.html"));
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
}

function updateTrayStatus(status: AgentStatus, detail?: string) {
  tray?.setStatus(status, detail);
  setupWindow?.webContents.send("agent:status", status, detail);
}

function startBackground(config: AgentConfig) {
  background?.stop();
  background = new BackgroundService(config, updateTrayStatus);
  background.start();
}

async function handleConnect(payload: { apiUrl: string; deviceKey: string; token: string; agentName: string }) {
  try {
    const api = new AgentApi(payload.apiUrl);
    const auth = await api.auth(payload.deviceKey, payload.token);
    const config: AgentConfig = {
      apiUrl: payload.apiUrl,
      deviceKey: payload.deviceKey,
      token: payload.token,
      agentId: auth.agentId,
      shopId: auth.shopId,
      agentName: auth.name || payload.agentName,
    };
    saveConfig(config);
    startBackground(config);
    setTimeout(() => setupWindow?.close(), 1500);
    return { ok: true, name: config.agentName };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

app.whenReady().then(() => {
  tray = new AgentTray(
    () => openSetupWindow(),
    () => {
      background?.stop();
      background = null;
      clearConfig();
      updateTrayStatus("stopped");
      openSetupWindow();
    }
  );

  const config = loadConfig();
  if (config) {
    startBackground(config);
  } else {
    openSetupWindow();
  }

  if (process.platform === "darwin") {
    app.dock?.hide();
  }
});

ipcMain.handle("agent:connect", (_e, payload) => handleConnect(payload));
ipcMain.handle("agent:get-state", () => ({ config: loadConfig() }));

app.on("window-all-closed", () => {
  // Tray-resident app: keep running even with no windows open.
});

app.on("second-instance", () => {
  openSetupWindow();
});

import { Tray, Menu, nativeImage, app } from "electron";
import path from "path";
import type { AgentStatus } from "./background";

const STATUS_LABEL: Record<AgentStatus, string> = {
  connecting: "Connecting…",
  online: "Online",
  error: "Connection error",
  stopped: "Not connected",
};

export class AgentTray {
  private tray: Tray;
  private status: AgentStatus = "stopped";
  private detail = "";

  constructor(
    private onOpenSetup: () => void,
    private onDisconnect: () => void
  ) {
    const iconPath = path.join(__dirname, "..", "assets", "tray.png");
    const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    this.tray = new Tray(image);
    this.tray.setToolTip("PrintMyDoc Agent");
    this.render();
  }

  setStatus(status: AgentStatus, detail?: string) {
    this.status = status;
    this.detail = detail || "";
    this.render();
  }

  private render() {
    const label = STATUS_LABEL[this.status] + (this.detail ? ` — ${this.detail}` : "");
    const menu = Menu.buildFromTemplate([
      { label, enabled: false },
      { type: "separator" },
      { label: "Open setup…", click: () => this.onOpenSetup() },
      { label: "Disconnect", click: () => this.onDisconnect(), enabled: this.status !== "stopped" },
      { type: "separator" },
      { label: "Quit PrintMyDoc Agent", click: () => app.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(`PrintMyDoc Agent — ${label}`);
  }
}

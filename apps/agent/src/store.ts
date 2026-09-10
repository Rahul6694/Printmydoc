import { app } from "electron";
import fs from "fs";
import path from "path";

export type AgentConfig = {
  apiUrl: string;
  deviceKey: string;
  token: string;
  agentId: string;
  shopId: string;
  agentName: string;
};

const configPath = () => path.join(app.getPath("userData"), "config.json");

export function loadConfig(): AgentConfig | null {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: AgentConfig) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function clearConfig() {
  try {
    fs.unlinkSync(configPath());
  } catch {
    // nothing to remove
  }
}

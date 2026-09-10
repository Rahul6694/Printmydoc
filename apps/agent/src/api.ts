import fs from "fs";
import path from "path";
import os from "os";
import type { DetectedPrinter } from "./printers";

export type AgentJob = {
  id: string;
  idempotencyKey: string;
  status: string;
  printer: { id: string; name: string; systemName: string } | null;
  settings: {
    paperSize: "A4" | "A3" | "LETTER";
    colorMode: "BW" | "COLOR";
    duplex: boolean;
    copies: number;
    pageRange: string | null;
    orientation: string;
  };
  files: Array<{ id: string; originalName: string; downloadUrl: string; mimeType: string }>;
};

export class AgentApi {
  constructor(private apiUrl: string) {}

  async auth(deviceKey: string, token: string): Promise<{ agentId: string; shopId: string; name: string }> {
    const res = await fetch(`${this.apiUrl}/api/agents/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceKey, token }),
    });
    const data = (await res.json()) as { agentId: string; shopId: string; name: string; error?: string };
    if (!res.ok) throw new Error(data.error || "Agent authentication failed");
    return data;
  }

  async heartbeat(agentId: string) {
    await fetch(`${this.apiUrl}/api/agents/${agentId}/heartbeat`, { method: "POST" });
  }

  async reportPrinters(agentId: string, printers: DetectedPrinter[]) {
    const res = await fetch(`${this.apiUrl}/api/agents/${agentId}/printers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printers }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || "Failed to report printers");
    }
  }

  async getJobs(agentId: string): Promise<AgentJob[]> {
    const res = await fetch(`${this.apiUrl}/api/agents/${agentId}/jobs`);
    const data = (await res.json()) as { jobs?: AgentJob[]; error?: string };
    if (!res.ok) throw new Error(data.error || "Failed to fetch jobs");
    return data.jobs || [];
  }

  async setJobStatus(jobId: string, status: "DOWNLOADING" | "PRINTING" | "COMPLETED" | "FAILED", error?: string) {
    await fetch(`${this.apiUrl}/api/agents/jobs/${jobId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, error }),
    });
  }

  async downloadFile(downloadUrl: string, originalName: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}${downloadUrl}`);
    if (!res.ok) throw new Error(`Failed to download ${originalName}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const tmpDir = path.join(os.tmpdir(), "printmydoc-agent");
    fs.mkdirSync(tmpDir, { recursive: true });
    const safeName = `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const filePath = path.join(tmpDir, safeName);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  }
}

import fs from "fs";
import { AgentApi } from "./api";
import { detectPrinters } from "./printers";
import { printFile } from "./printFile";
import type { AgentConfig } from "./store";

export type AgentStatus = "connecting" | "online" | "error" | "stopped";

const HEARTBEAT_INTERVAL_MS = 20_000;
const PRINTER_REPORT_INTERVAL_MS = 60_000;
const JOB_POLL_INTERVAL_MS = 4_000;

export class BackgroundService {
  private api: AgentApi;
  private agentId: string;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private processing = new Set<string>();

  constructor(
    private config: AgentConfig,
    private onStatus: (status: AgentStatus, detail?: string) => void
  ) {
    this.api = new AgentApi(config.apiUrl);
    this.agentId = config.agentId;
  }

  async start() {
    this.onStatus("connecting");
    try {
      await this.reportPrinters();
      await this.api.heartbeat(this.agentId);
      this.onStatus("online");
    } catch (err) {
      this.onStatus("error", (err as Error).message);
    }

    this.timers.push(setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS));
    this.timers.push(setInterval(() => this.reportPrinters(), PRINTER_REPORT_INTERVAL_MS));
    this.timers.push(setInterval(() => this.pollJobs(), JOB_POLL_INTERVAL_MS));
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.onStatus("stopped");
  }

  private async heartbeat() {
    try {
      await this.api.heartbeat(this.agentId);
      if (!this.stopped) this.onStatus("online");
    } catch (err) {
      if (!this.stopped) this.onStatus("error", (err as Error).message);
    }
  }

  private async reportPrinters() {
    const printers = await detectPrinters();
    await this.api.reportPrinters(this.agentId, printers);
    return printers;
  }

  private async pollJobs() {
    if (this.stopped) return;
    try {
      const jobs = await this.api.getJobs(this.agentId);
      for (const job of jobs) {
        if (this.processing.has(job.id)) continue;
        if (!job.printer) continue;
        this.processing.add(job.id);
        this.handleJob(job.id, job).finally(() => this.processing.delete(job.id));
      }
    } catch (err) {
      this.onStatus("error", (err as Error).message);
    }
  }

  private async handleJob(jobId: string, job: Awaited<ReturnType<AgentApi["getJobs"]>>[number]) {
    let filePath: string | null = null;
    try {
      await this.api.setJobStatus(jobId, "DOWNLOADING");
      const file = job.files[0];
      if (!file) throw new Error("Job has no files");
      filePath = await this.api.downloadFile(file.downloadUrl, file.originalName);

      await this.api.setJobStatus(jobId, "PRINTING");
      await printFile(filePath, job.printer!.systemName, {
        paperSize: job.settings.paperSize,
        colorMode: job.settings.colorMode,
        duplex: job.settings.duplex,
        copies: job.settings.copies,
        pageRange: job.settings.pageRange,
      });

      await this.api.setJobStatus(jobId, "COMPLETED");
    } catch (err) {
      await this.api.setJobStatus(jobId, "FAILED", (err as Error).message);
    } finally {
      if (filePath) {
        fs.unlink(filePath, () => undefined);
      }
    }
  }
}

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentBridge", {
  connect: (payload: { apiUrl: string; deviceKey: string; token: string; agentName: string }) =>
    ipcRenderer.invoke("agent:connect", payload),
  getState: () => ipcRenderer.invoke("agent:get-state"),
  onStatus: (cb: (status: string, detail?: string) => void) => {
    ipcRenderer.on("agent:status", (_e, status, detail) => cb(status, detail));
  },
});

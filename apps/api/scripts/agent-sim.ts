/**
 * Simple agent simulator for local testing (no Windows PC required).
 * Usage: npx tsx scripts/agent-sim.ts
 */
import "dotenv/config";

const API = process.env.API_URL || "http://localhost:4000";
const DEVICE_KEY = process.env.AGENT_DEVICE_KEY || "agent_demo_device";
const TOKEN = process.env.AGENT_TOKEN || "agent-demo-token";

async function main() {
  const auth = await fetch(`${API}/api/agents/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, token: TOKEN }),
  }).then((r) => r.json());

  if (!auth.agentId) {
    console.error("Auth failed", auth);
    process.exit(1);
  }

  console.log("Agent online:", auth);

  await fetch(`${API}/api/agents/${auth.agentId}/printers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      printers: [
        {
          name: "Simulated Laser",
          systemName: "SIM-LASER-01",
          supportsColor: false,
          supportsDuplex: true,
          paperSizes: ["A4"],
          isOnline: true,
        },
      ],
    }),
  });

  setInterval(async () => {
    await fetch(`${API}/api/agents/${auth.agentId}/heartbeat`, { method: "POST" });
    const jobs = await fetch(`${API}/api/agents/${auth.agentId}/jobs`).then((r) => r.json());
    for (const job of jobs.jobs || []) {
      console.log("Printing job", job.id, job.files?.[0]?.originalName);
      await fetch(`${API}/api/agents/jobs/${job.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PRINTING" }),
      });
      await new Promise((r) => setTimeout(r, 1500));
      await fetch(`${API}/api/agents/jobs/${job.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "COMPLETED" }),
      });
      console.log("Completed", job.id);
    }
  }, 3000);
}

main().catch(console.error);

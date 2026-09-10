const btn = document.getElementById("connect");
const msg = document.getElementById("msg");

btn.addEventListener("click", async () => {
  const apiUrl = document.getElementById("apiUrl").value.trim().replace(/\/$/, "");
  const agentName = document.getElementById("agentName").value.trim();
  const deviceKey = document.getElementById("deviceKey").value.trim();
  const token = document.getElementById("token").value.trim();

  if (!apiUrl || !deviceKey || !token) {
    msg.textContent = "Fill in all fields.";
    msg.className = "error";
    return;
  }

  btn.disabled = true;
  msg.textContent = "Connecting…";
  msg.className = "";

  try {
    const result = await window.agentBridge.connect({ apiUrl, deviceKey, token, agentName });
    if (result.ok) {
      msg.textContent = `Connected as "${result.name}". This window will close.`;
      msg.className = "ok";
    } else {
      msg.textContent = result.error || "Connection failed.";
      msg.className = "error";
    }
  } catch (err) {
    msg.textContent = err.message || String(err);
    msg.className = "error";
  } finally {
    btn.disabled = false;
  }
});

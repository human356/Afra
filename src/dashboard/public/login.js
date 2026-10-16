"use strict";
document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  msg.textContent = "";
  try {
    const res = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: document.getElementById("pw").value }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) location.href = "/";
    else msg.textContent = body.error || "Sign-in failed.";
  } catch {
    msg.textContent = "Could not reach the server.";
  }
});

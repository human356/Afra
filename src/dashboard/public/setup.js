"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = "";
  let timer;
  const FIELDS = { phone: "f-phone", code: "f-code", password: "f-password" };
  const PROMPTS = { phone: "Enter your phone number.", code: "Enter the code Telegram just sent you.", password: "Enter your two-step verification password (leave empty if you have none)." };

  async function call(path, body) {
    const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function show(step, st) {
    for (const [k, id] of Object.entries(FIELDS)) $(id).hidden = k !== step;
    $("f-dash").hidden = true;
    $("go").hidden = !FIELDS[step];
    $("retry").hidden = step !== "error";
    $("msg").textContent = step === "error" ? (st.error || "Sign-in failed.") : "";
    $("status").textContent = FIELDS[step] ? PROMPTS[step] : step === "working" ? "Talking to Telegram…" : step === "done" ? "Signed in" + (st.account ? " as " + st.account : "") + ". The session is saved — the bot is starting. You can close this page; then remove the WEB_LOGIN variable." : step === "idle" ? "Connecting to Telegram…" : "";
    if (step === "done") clearInterval(timer);
  }

  async function poll() {
    try { const st = await call("/setup/state"); show(st.step, st); } catch (e) { $("msg").textContent = e.message; }
  }

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("msg").textContent = "";
    try {
      if (!csrf) {
        const r = await call("/setup/auth", { password: $("dash").value });
        csrf = r.csrf;
        $("dash").value = "";
        await poll();
        timer = setInterval(poll, 1500);
        return;
      }
      const st = await call("/setup/state");
      const id = st.step === "phone" ? "phone" : st.step === "code" ? "code" : "pw2";
      await call("/setup/submit", { value: $(id).value });
      $(id).value = "";
      await poll();
    } catch (err) { $("msg").textContent = err.message; }
  });

  $("retry").addEventListener("click", async () => {
    try { await call("/setup/retry", {}); await poll(); } catch (err) { $("msg").textContent = err.message; }
  });
})();

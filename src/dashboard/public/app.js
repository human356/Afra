"use strict";
(() => {
  // All dynamic content is inserted with textContent / createTextNode: log lines and chat-derived text are untrusted.
  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "—");
  const fmtDur = (s) => { const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return [d && d + "d", hr && hr + "h", m + "m"].filter(Boolean).join(" "); };

  let csrf = "";
  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, { method: opts.method || "GET", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401) { location.href = "/login"; throw new Error("signed out"); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Request failed (" + res.status + ")");
    return body;
  }

  function table(headers, rows, numCols = []) {
    if (!rows.length) return h("div", { class: "empty" }, "Nothing here yet.");
    return h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, headers.map((t, i) => h("th", { class: numCols.includes(i) ? "num" : "" }, t)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: numCols.includes(i) ? "num" : "" }, c)))))));
  }
  const stat = (value, label) => h("div", { class: "stat" }, h("b", {}, value), h("span", {}, label));

  /* ----------------------------- lamp rail ----------------------------- */
  async function refreshRail() {
    try {
      const report = await api("/health");
      const rail = $("rail");
      rail.replaceChildren(...report.checks.map((c) => h("button", { class: "lamp", type: "button", "data-state": c.status, title: c.detail, onclick: () => show("overview") },
        h("span", { class: "bulb" }), h("span", { class: "lamp-name" }, c.name), h("span", { class: "lamp-detail" }, c.detail))));
    } catch (e) { if (e.message !== "signed out") $("rail").replaceChildren(h("div", { class: "empty err" }, e.message)); }
  }

  /* ----------------------------- views ----------------------------- */
  const views = {
    async overview(panel) {
      const [st, hl] = await Promise.all([api("/status"), api("/health")]);
      const m = st.metrics;
      $("who").textContent = st.account.name + (st.account.username ? " (@" + st.account.username + ")" : "") + " · up " + fmtDur(st.uptimeSec);
      panel.replaceChildren(
        h("section", {}, h("h2", {}, "At a glance"), h("div", { class: "stats" },
          stat(st.connected ? "online" : "OFFLINE", "Telegram connection"),
          stat(fmtDur(st.uptimeSec), "uptime"),
          stat(st.queue.running + " / " + st.queue.pending, "queue running / pending"),
          stat(m["commands.total"] || 0, "commands handled"),
          stat(m["messages.sent"] || 0, "messages sent"),
          stat(m["telegram.floodwait"] || 0, "FloodWaits honoured"),
          stat(m["telegram.reconnects"] || 0, "reconnects"),
          stat(st.queue.rejected, "queue rejections"))),
        h("section", {}, h("h2", {}, "Health checks"),
          table(["Check", "Status", "Detail"], hl.checks.map((c) => [c.name, h("span", { class: "pill " + c.status }, c.status), c.detail]))),
        h("section", {}, h("h2", {}, "Library"),
          h("p", { class: "muted" }, st.library.name + "@" + st.library.version + " — " + st.featureSummary.supported + " supported, " + st.featureSummary.partial + " partial, " + st.featureSummary.unavailable + " unavailable features."),
          h("p", { class: "muted" }, "Control bot: " + (st.controlBot ? "on" : "off") + " · Master admin id: " + st.masterAdminId)));
    },
    async tasks(panel) {
      const t = await api("/tasks");
      const cancel = (id) => h("button", { class: "btn danger", type: "button", onclick: async () => { try { await api("/tasks/" + id + "/cancel", { method: "POST" }); show("tasks"); } catch (e) { alert(e.message); } } }, "Cancel");
      panel.replaceChildren(
        h("section", {}, h("h2", {}, "Pending tasks"), table(["#", "Due", "Kind", "Name", "Repeat", "Owner", ""], t.pending.map((x) => [x.id, fmtTime(x.runAt), x.kind, x.name, x.repeatSec ? x.repeatSec + "s" : "once", x.ownerId, cancel(x.id)]), [0])),
        h("section", {}, h("h2", {}, "Recent runs"), table(["Task", "Started", "Status", "Late", "Error"], t.runs.map((r) => [(r.taskName || "") + " #" + r.taskId, fmtTime(r.startedAt), h("span", { class: "pill " + (r.status === "ok" ? "ok" : r.status === "running" ? "warn" : "fail") }, r.status), r.lateSec ? r.lateSec + "s" : "—", r.error || ""]))));
    },
    async logs(panel) {
      const level = panel.dataset.level || "info";
      const { entries } = await api("/logs?limit=300&level=" + level);
      const box = h("div", { class: "log", role: "log" }, entries.map((e) => h("div", { class: "lv-" + e.level }, new Date(e.time).toLocaleTimeString() + " " + e.level.toUpperCase().padEnd(5) + " " + (e.module ? "[" + e.module + "] " : "") + e.msg + extra(e))));
      const sel = h("select", { "aria-label": "Minimum level", onchange: (ev) => { panel.dataset.level = ev.target.value; show("logs"); } }, ["debug", "info", "warn", "error"].map((l) => h("option", { value: l, selected: l === level }, l)));
      panel.replaceChildren(h("div", { class: "toolbar" }, h("label", {}, "Level ", sel), h("span", { class: "muted" }, entries.length + " lines · secrets are redacted before they reach this view")), box);
      box.scrollTop = box.scrollHeight;
    },
    async modules(panel) {
      const m = await api("/modules");
      const toggle = (p) => p.status === "active"
        ? h("button", { class: "btn", type: "button", onclick: () => act(p.name, "disable") }, "Disable")
        : h("button", { class: "btn primary", type: "button", onclick: () => act(p.name, "enable") }, "Enable");
      async function act(name, action) { try { await api("/plugins/" + encodeURIComponent(name) + "/" + action, { method: "POST" }); } catch (e) { alert(e.message); } show("modules"); }
      panel.replaceChildren(
        h("section", {}, h("h2", {}, "Modules"), table(["Module", "State", "Detail"], m.modules.map((x) => [x.name, h("span", { class: "pill " + (x.enabled ? "ok" : "") }, x.enabled ? "enabled" : "off"), x.detail]))),
        h("section", {}, h("h2", {}, "Plugins"), h("div", { class: "notice" }, "External plugins start disabled. Plugins run inside this process — enable only code you trust. " + m.commands + " commands registered."),
          table(["Plugin", "Version", "State", "Commands", "Last error", ""], m.plugins.map((p) => [p.name + (p.builtin ? " (built-in)" : ""), p.version, h("span", { class: "pill " + (p.status === "active" ? "ok" : p.status === "failed" ? "fail" : "") }, p.status), p.commands.join(", ") || "—", p.lastError || "", toggle(p)]))));
    },
    async settings(panel) {
      const s = await api("/settings");
      const flat = [];
      const walk = (o, p) => {
        for (const [k, v] of Object.entries(o)) {
          if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p + k + ".");
          else flat.push([p + k, Array.isArray(v) ? v.join(", ") : String(v)]);
        }
      };
      walk(s.config, "");
      panel.replaceChildren(
        h("div", { class: "notice" }, "Read-only view of non-secret settings. Secrets (API hash, bot token, passwords, session) are never exposed here. Change settings in .env and restart."),
        h("section", {}, h("h2", {}, "Settings"), table(["Key", "Value"], flat)),
        h("section", {}, h("h2", {}, "Self-mode users"), table(["User id", "Scopes", "State", "Note"], s.users.map((u) => [u.userId, u.scopes.join(", "), u.enabled ? "active" : "suspended", u.note || ""]))));
    },
    async audit(panel) {
      const a = await api("/audit?limit=100");
      panel.replaceChildren(h("section", {}, h("h2", {}, "Audit log"), table(["#", "Time", "Actor", "Action", "Target", "Result"], a.entries.map((e) => [e.id, fmtTime(e.ts), e.actorId, e.action, e.target || "", e.dryRun ? "dry-run" : e.result]), [0])));
    },
  };
  function extra(e) { const skip = new Set(["level", "time", "msg", "module"]); const rest = Object.entries(e).filter(([k]) => !skip.has(k)); return rest.length ? " " + rest.map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join(" ") : ""; }

  const TABS = [["overview", "Overview"], ["tasks", "Tasks"], ["logs", "Logs"], ["modules", "Modules"], ["settings", "Settings"], ["audit", "Audit"]];
  let current = "overview";
  async function show(name) {
    current = name;
    $("tabs").replaceChildren(...TABS.map(([id, label]) => h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(id === name), onclick: () => show(id) }, label)));
    const panel = $("panel");
    try { await views[name](panel); } catch (e) { if (e.message !== "signed out") panel.replaceChildren(h("div", { class: "err" }, e.message)); }
  }

  $("logout").addEventListener("click", async () => { try { await api("/logout", { method: "POST" }); } finally { location.href = "/login"; } });

  (async () => {
    try { csrf = (await api("/session")).csrf; } catch { return; }
    await Promise.all([show("overview"), refreshRail()]);
    setInterval(() => { if (!document.hidden) { refreshRail(); if (["overview", "logs", "tasks"].includes(current)) show(current); } }, 15000);
  })();
})();

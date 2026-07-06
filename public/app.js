"use strict";

// ── Estado ───────────────────────────────────────────────────────────────────
let selectedClient = null; // { id, name }
let running = false;
let controller = null;
let allClients = [];
let currentSessionId = null; // sessão do Claude para continuar a conversa

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

// ── Boot ─────────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const me = await fetch("/api/me");
    if (!me.ok) return (location.href = "/login.html");
    const data = await me.json();
    $("#whoami").textContent = data.user || "";
  } catch {
    return (location.href = "/login.html");
  }
  setupTabs();
  setupComposer();
  setupSettings();
  setupChangePassword();
  setupOnboarding();

  const setupRes = await fetch("/api/setup/status");
  const setup = await setupRes.json();
  if (setup.needsOnboarding) {
    showOnboarding(setup);
  } else {
    loadAll();
  }
})();

function loadAll() {
  loadClients();
  loadHistory();
  loadDeliverables();
}

// ── Abas ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
    });
  });
  $("#reloadClients").addEventListener("click", () => loadClients(true));
  $("#reloadHistory").addEventListener("click", () => loadHistory());
  $("#reloadDeliverables").addEventListener("click", () => loadDeliverables());
  $("#clientSearch").addEventListener("input", renderClients);
  $("#logoutBtn").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    location.href = "/login.html";
  });
}

// ── Composer ─────────────────────────────────────────────────────────────────
function setupComposer() {
  $("#runBtn").addEventListener("click", runTask);
  $("#replyBtn").addEventListener("click", sendReply);
  $("#replyInput").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendReply();
  });
  $("#cancelBtn").addEventListener("click", () => controller && controller.abort());
  $("#clearClient").addEventListener("click", () => setClient(null));
  document.querySelectorAll(".ex").forEach((b) =>
    b.addEventListener("click", () => {
      $("#demand").value = b.textContent.trim();
      $("#demand").focus();
    })
  );
  $("#demand").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runTask();
  });
}

function setClient(client) {
  selectedClient = client;
  const box = $("#selectedClient");
  if (client) {
    $("#selectedClientName").textContent = client.name;
    box.hidden = false;
  } else {
    box.hidden = true;
  }
  renderClients();
}

// ── Clientes ─────────────────────────────────────────────────────────────────
async function loadClients(force) {
  const list = $("#clientList");
  list.innerHTML = '<li class="empty">Carregando…</li>';
  try {
    const res = await fetch("/api/clients" + (force ? "?force=1" : ""));
    const data = await res.json();
    if (data.needsSetup) {
      list.innerHTML = '<li class="empty">Configure a chave Composio e vincule o Google Drive nas <a href="#" onclick="document.getElementById(\'settingsBtn\').click();return false">configurações</a>.</li>';
      allClients = [];
      return;
    }
    if (data.error) {
      list.innerHTML = `<li class="empty">${escapeHtml(data.error)}</li>`;
      allClients = [];
      return;
    }
    allClients = data.clients || [];
    renderClients();
  } catch (e) {
    list.innerHTML = '<li class="empty">Erro ao carregar clientes.</li>';
  }
}

function renderClients() {
  const q = ($("#clientSearch").value || "").toLowerCase();
  const list = $("#clientList");
  const filtered = allClients.filter((c) => c.name.toLowerCase().includes(q));
  if (!filtered.length) {
    list.innerHTML = '<li class="empty">Nenhum cliente.</li>';
    return;
  }
  list.innerHTML = "";
  filtered.forEach((c) => {
    const active = selectedClient && selectedClient.id === c.id;
    const li = el("li", "list-item" + (active ? " active" : ""));
    li.innerHTML = `<span class="li-title">${escapeHtml(c.name)}</span>` +
      (c.modified ? `<span class="li-sub">atualizado ${escapeHtml(c.modified)}</span>` : "");
    li.addEventListener("click", () => setClient(active ? null : c));
    list.appendChild(li);
  });
}

// ── Histórico ────────────────────────────────────────────────────────────────
async function loadHistory() {
  const list = $("#historyList");
  try {
    const res = await fetch("/api/history");
    const data = await res.json();
    const runs = data.runs || [];
    if (!runs.length) {
      list.innerHTML = '<li class="empty">Nenhuma execução ainda.</li>';
      return;
    }
    list.innerHTML = "";
    runs.forEach((r) => {
      const li = el("li", "list-item");
      const dot = r.isError ? '<span class="err-dot">●</span> ' : "";
      li.innerHTML =
        `<span class="li-title">${dot}${escapeHtml(r.title)}</span>` +
        `<span class="li-sub"><span>${escapeHtml(fmtDate(r.createdAt))}</span>` +
        (r.client ? `<span>· ${escapeHtml(r.client.name || r.client)}</span>` : "") +
        `</span>`;
      li.addEventListener("click", () => openHistory(r.id));
      list.appendChild(li);
    });
  } catch {
    list.innerHTML = '<li class="empty">Erro ao carregar histórico.</li>';
  }
}

async function openHistory(id) {
  try {
    const res = await fetch("/api/history/" + encodeURIComponent(id));
    if (!res.ok) return;
    const run = await res.json();
    currentSessionId = null;
    hideReplyBar();
    startStreamView("Histórico · " + run.title);
    (run.events || []).forEach(handleEvent);
    if (!(run.events || []).some((e) => e.kind === "result") && run.resultText) {
      handleEvent({ kind: "result", text: run.resultText, isError: run.isError, cost: run.cost, durationMs: run.durationMs, numTurns: run.numTurns });
    }
    stopSpinner();
    currentSessionId = run.sessionId || currentSessionId;
    if (currentSessionId) showReplyBar();
  } catch {}
}

// ── Entregáveis ──────────────────────────────────────────────────────────────
async function loadDeliverables() {
  const list = $("#deliverableList");
  try {
    const res = await fetch("/api/deliverables");
    const data = await res.json();
    const files = data.files || [];
    if (!files.length) {
      list.innerHTML = '<li class="empty">Nenhum arquivo gerado.</li>';
      return;
    }
    list.innerHTML = "";
    files.forEach((f) => {
      const li = el("li", "list-item dl-item");
      const href = "/api/deliverables/download?name=" + encodeURIComponent(f.name);
      li.innerHTML =
        `<a href="${href}" download>${escapeHtml(f.name)}</a>` +
        `<span class="badge">${escapeHtml(f.ext || "?")}</span>`;
      list.appendChild(li);
    });
  } catch {
    list.innerHTML = '<li class="empty">Erro ao carregar entregáveis.</li>';
  }
}

// ── Execução ─────────────────────────────────────────────────────────────────
async function runTask() {
  const demand = $("#demand").value.trim();
  if (!demand) {
    $("#demand").focus();
    return;
  }
  currentSessionId = null;
  hideReplyBar();
  await executeRun({ demand, resumeSessionId: null, append: false, title: "Execução em andamento" });
}

async function sendReply() {
  if (!currentSessionId) return;
  const reply = $("#replyInput").value.trim();
  if (!reply) {
    $("#replyInput").focus();
    return;
  }
  $("#replyInput").value = "";
  await executeRun({ demand: reply, resumeSessionId: currentSessionId, append: true });
}

async function executeRun({ demand, resumeSessionId, append, title }) {
  if (running) return;
  running = true;
  controller = new AbortController();
  $("#runBtn").disabled = true;
  $("#replyBtn").disabled = true;
  $("#cancelBtn").hidden = false;
  hideReplyBar();

  if (append) appendUserReply(demand);
  else startStreamView(title);
  startSpinner();

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        demand,
        client: resumeSessionId ? null : selectedClient ? selectedClient.name : null,
        resumeSessionId: resumeSessionId || null,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      handleEvent({ kind: "error", text: err.error || "Falha ao iniciar a execução." });
      return finishRun();
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line.slice(6)));
        } catch {}
      }
    }
  } catch (e) {
    if (e.name === "AbortError") handleEvent({ kind: "status", text: "Cancelando…" });
    else handleEvent({ kind: "error", text: "Conexão interrompida: " + e.message });
  } finally {
    finishRun();
  }
}

function finishRun() {
  running = false;
  controller = null;
  $("#runBtn").disabled = false;
  $("#replyBtn").disabled = false;
  $("#cancelBtn").hidden = true;
  stopSpinner();
  loadHistory();
  loadDeliverables();
  if (currentSessionId) showReplyBar();
}

function showReplyBar() {
  $("#replyBar").hidden = false;
}
function hideReplyBar() {
  $("#replyBar").hidden = true;
}
function appendUserReply(text) {
  stopSpinner();
  const box = el("div", "event user-reply");
  box.innerHTML = '<span class="ur-label">Você respondeu</span>' + escapeHtml(text);
  $("#stream").appendChild(box);
  scrollBottom();
}

// ── Renderização de eventos ──────────────────────────────────────────────────
function startStreamView(title) {
  $("#outputEmpty").hidden = true;
  const stream = $("#stream");
  stream.innerHTML = "";
  const head = el("div", "final-head", `<span>${escapeHtml(title)}</span>`);
  stream.appendChild(head);
}

function startSpinner() {
  const stream = $("#stream");
  const ind = el("div", "running-indicator");
  ind.id = "spinner";
  ind.innerHTML = '<span class="spinner"></span><span>O agente está trabalhando…</span>';
  stream.appendChild(ind);
}
function stopSpinner() {
  const s = $("#spinner");
  if (s) s.remove();
}
function scrollBottom() {
  const o = $("#output");
  o.scrollTop = o.scrollHeight;
}

function handleEvent(evt) {
  const stream = $("#stream");
  const spinner = $("#spinner");
  const before = (node) => (spinner ? stream.insertBefore(node, spinner) : stream.appendChild(node));

  switch (evt.kind) {
    case "start":
      break;
    case "session":
      if (evt.sessionId) currentSessionId = evt.sessionId;
      break;
    case "status":
      before(el("div", "event event-status", escapeHtml(evt.text)));
      break;
    case "tool_use":
      before(
        el(
          "div",
          "event event-tool",
          `🔧 <span class="tname">${escapeHtml(evt.name)}</span>` +
            (evt.detail ? ` <span class="tdetail">${escapeHtml(evt.detail)}</span>` : "")
        )
      );
      break;
    case "tool_result":
      if (evt.text)
        before(el("div", "event event-result-tool" + (evt.isError ? " err" : ""), escapeHtml(evt.text)));
      break;
    case "assistant_text":
      if (evt.text && evt.text.trim())
        before(el("div", "event event-assistant md", mdToHtml(evt.text)));
      break;
    case "result": {
      if (evt.sessionId) currentSessionId = evt.sessionId;
      stopSpinner();
      const box = el("div", "event final-result");
      const badge = evt.isError ? '<span class="done-badge err">Erro</span>' : '<span class="done-badge">Concluído</span>';
      box.innerHTML = `<div class="final-head">${badge}<span>Resultado</span></div>` +
        `<div class="md">${mdToHtml(evt.text || "(sem texto de resultado)")}</div>` +
        `<div class="run-meta">` +
        (evt.durationMs != null ? `<span>⏱ ${fmtDuration(evt.durationMs)}</span>` : "") +
        (evt.numTurns != null ? `<span>${evt.numTurns} passos</span>` : "") +
        (evt.cost != null ? `<span>US$ ${Number(evt.cost).toFixed(4)}</span>` : "") +
        `</div>`;
      stream.appendChild(box);
      break;
    }
    case "error":
      stopSpinner();
      before(el("div", "event event-error", escapeHtml(evt.text)));
      break;
    case "saved":
    case "end":
    case "done":
      break;
  }
  scrollBottom();
}

// ── Alterar senha ───────────────────────────────────────────────────────────
function setupChangePassword() {
  $("#changePwBtn").addEventListener("click", () => {
    $("#changePwModal").hidden = false;
    setPwResult(null);
    $("#pwCurrent").value = "";
    $("#pwNew").value = "";
    $("#pwConfirm").value = "";
    $("#pwCurrent").focus();
  });
  $("#changePwClose").addEventListener("click", () => { $("#changePwModal").hidden = true; });
  $("#changePwModal").addEventListener("click", (e) => {
    if (e.target.id === "changePwModal") $("#changePwModal").hidden = true;
  });
  $("#changePwSave").addEventListener("click", doChangePassword);
  $("#pwConfirm").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doChangePassword();
  });
}

function setPwResult(state) {
  const box = $("#changePwResult");
  if (!state) { box.hidden = true; box.textContent = ""; box.className = "test-result"; return; }
  box.hidden = false;
  box.textContent = state.message || "";
  box.className = "test-result " + (state.loading ? "loading" : state.ok ? "ok" : "err");
}

async function doChangePassword() {
  const cur = $("#pwCurrent").value;
  const nw = $("#pwNew").value;
  const conf = $("#pwConfirm").value;
  if (!cur || !nw) { setPwResult({ ok: false, message: "Preencha todos os campos." }); return; }
  if (nw !== conf) { setPwResult({ ok: false, message: "A nova senha e a confirmação não coincidem." }); return; }
  setPwResult({ loading: true, message: "Alterando…" });
  try {
    const res = await fetch("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: cur, newPassword: nw }),
    });
    const data = await res.json();
    if (data.ok) {
      setPwResult({ ok: true, message: "Senha alterada com sucesso." });
      $("#pwCurrent").value = "";
      $("#pwNew").value = "";
      $("#pwConfirm").value = "";
      setTimeout(() => { $("#changePwModal").hidden = true; }, 1200);
    } else {
      setPwResult({ ok: false, message: data.error || "Falha ao alterar." });
    }
  } catch (e) {
    setPwResult({ ok: false, message: "Erro: " + e.message });
  }
}

// ── Configurações: login do Claude ───────────────────────────────────────────
function setupSettings() {
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsModal").addEventListener("click", (e) => {
    if (e.target.id === "settingsModal") closeSettings();
  });
  document.querySelectorAll('input[name="authmode"]').forEach((r) =>
    r.addEventListener("change", () => applyModeUI(currentMode()))
  );
  $("#settingsSave").addEventListener("click", () => saveSettings(false));
  $("#settingsTest").addEventListener("click", () => saveSettings(true));
  $("#oauthStartBtn").addEventListener("click", startOAuth);
  $("#oauthSubmitBtn").addEventListener("click", submitOAuthCode);
  $("#oauthCancelBtn").addEventListener("click", cancelOAuth);
  $("#oauthCodeInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitOAuthCode();
  });
  $("#driveConnectBtn").addEventListener("click", startDriveAuth);
  $("#driveCheckBtn").addEventListener("click", checkDriveConnection);
  $("#driveCancelBtn").addEventListener("click", () => {
    $("#driveOAuthFlow").hidden = true;
    setDriveResult(null);
  });
  $("#driveApiKeySave").addEventListener("click", saveDriveApiKey);
  $("#driveKeyToggle").addEventListener("click", (e) => {
    e.preventDefault();
    $("#driveKeyForm").hidden = !$("#driveKeyForm").hidden;
  });
}

function currentMode() {
  const r = document.querySelector('input[name="authmode"]:checked');
  return r ? r.value : "inherit";
}

function applyModeUI(mode) {
  $("#apiKeyField").hidden = mode !== "api";
  $("#subsHint").hidden = mode !== "subscription";
}

function closeSettings() {
  $("#settingsModal").hidden = true;
}

async function openSettings() {
  $("#settingsModal").hidden = false;
  setTestResult(null);
  try {
    const res = await fetch("/api/settings");
    const s = await res.json();
    $("#authModel").textContent = s.model || "—";
    const radio = document.querySelector('input[name="authmode"][value="' + s.mode + '"]');
    if (radio) radio.checked = true;
    $("#apiKeyInput").value = "";
    $("#apiKeyHint").textContent = s.hasApiKey
      ? "Chave salva: " + s.apiKeyMasked + " — deixe em branco para manter."
      : "Nenhuma chave salva ainda.";
    $("#subsHintText").textContent = s.credentialsFileExists
      ? "Login de assinatura detectado no servidor (~/.claude/.credentials.json)."
      : "Nenhum login de assinatura no servidor. Rode 'claude' e faça /login no host primeiro.";
    applyModeUI(s.mode);
  } catch {
    setTestResult({ ok: false, message: "Falha ao carregar configurações." });
  }
  loadDriveStatus();
}

async function saveSettings(thenTest) {
  const mode = currentMode();
  const apiKey = $("#apiKeyInput").value.trim();
  setTestResult({ loading: true, message: thenTest ? "Salvando e testando…" : "Salvando…" });
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, apiKey: apiKey || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      setTestResult({ ok: false, message: data.error || "Falha ao salvar." });
      return;
    }
    $("#apiKeyInput").value = "";
    $("#apiKeyHint").textContent = data.hasApiKey
      ? "Chave salva: " + data.apiKeyMasked + " — deixe em branco para manter."
      : "Nenhuma chave salva ainda.";
    if (thenTest) await runCredentialTest();
    else setTestResult({ ok: true, message: "Configuração salva." });
  } catch (e) {
    setTestResult({ ok: false, message: "Erro: " + e.message });
  }
}

async function runCredentialTest() {
  setTestResult({ loading: true, message: "Testando credencial (pode levar alguns segundos)…" });
  try {
    const res = await fetch("/api/settings/test", { method: "POST" });
    const data = await res.json();
    const modelLine = data.model ? "\nModelo: " + data.model : "";
    setTestResult({ ok: !!data.ok, message: (data.message || "") + modelLine });
  } catch (e) {
    setTestResult({ ok: false, message: "Erro no teste: " + e.message });
  }
}

function setTestResult(state) {
  const box = $("#testResult");
  if (!state) {
    box.hidden = true;
    box.textContent = "";
    box.className = "test-result";
    return;
  }
  box.hidden = false;
  box.textContent = state.message || "";
  box.className = "test-result " + (state.loading ? "loading" : state.ok ? "ok" : "err");
}

// ── OAuth: vincular assinatura ───────────────────────────────────────────────
function setOAuthResult(state) {
  const box = $("#oauthResult");
  if (!state) { box.hidden = true; box.textContent = ""; box.className = "test-result"; return; }
  box.hidden = false;
  box.textContent = state.message || "";
  box.className = "test-result " + (state.loading ? "loading" : state.ok ? "ok" : "err");
}

async function startOAuth() {
  setOAuthResult({ loading: true, message: "Iniciando login OAuth…" });
  $("#oauthFlow").hidden = false;
  $("#oauthStartBtn").disabled = true;
  try {
    const res = await fetch("/api/oauth/start", { method: "POST" });
    const data = await res.json();
    if (data.ok && data.url) {
      setOAuthResult(null);
      const link = $("#oauthUrl");
      link.href = data.url;
      link.textContent = data.url.length > 80 ? data.url.slice(0, 80) + "…" : data.url;
      $("#oauthCodeInput").value = "";
      $("#oauthCodeInput").focus();
    } else {
      setOAuthResult({ ok: false, message: data.error || "Falha ao iniciar o login." });
    }
  } catch (e) {
    setOAuthResult({ ok: false, message: "Erro: " + e.message });
  }
  $("#oauthStartBtn").disabled = false;
}

async function submitOAuthCode() {
  const code = $("#oauthCodeInput").value.trim();
  if (!code) { setOAuthResult({ ok: false, message: "Cole o código recebido." }); return; }
  setOAuthResult({ loading: true, message: "Enviando código…" });
  try {
    const res = await fetch("/api/oauth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data.ok) {
      setOAuthResult({ ok: true, message: data.message || "Login realizado!" });
      setTimeout(() => {
        $("#oauthFlow").hidden = true;
        openSettings();
      }, 1500);
    } else {
      setOAuthResult({ ok: false, message: data.error || "Falha." });
    }
  } catch (e) {
    setOAuthResult({ ok: false, message: "Erro: " + e.message });
  }
}

async function cancelOAuth() {
  try { await fetch("/api/oauth/cancel", { method: "POST" }); } catch {}
  $("#oauthFlow").hidden = true;
  setOAuthResult(null);
}

// ── Google Drive (Composio) ─────────────────────────────────────────────────
function setDriveResult(state) {
  const box = $("#driveResult");
  if (!state) { box.hidden = true; box.textContent = ""; box.className = "test-result"; return; }
  box.hidden = false;
  box.textContent = state.message || "";
  box.className = "test-result " + (state.loading ? "loading" : state.ok ? "ok" : "err");
}

async function loadDriveStatus() {
  $("#driveStatus").textContent = "Verificando…";
  $("#driveActions").hidden = true;
  $("#driveNotConfigured").hidden = true;
  $("#driveKeyForm").hidden = true;
  $("#driveOAuthFlow").hidden = true;
  setDriveResult(null);
  try {
    const res = await fetch("/api/composio/status");
    const data = await res.json();
    if (!data.configured) {
      $("#driveStatus").textContent = "Credenciais Composio não configuradas.";
      $("#driveNotConfigured").hidden = false;
      $("#driveKeyForm").hidden = false;
    } else if (data.connected) {
      $("#driveStatus").textContent = "Google Drive vinculado.";
      $("#driveActions").hidden = false;
    } else {
      $("#driveStatus").textContent = "Google Drive ainda não vinculado.";
      $("#driveActions").hidden = false;
    }
  } catch {
    $("#driveStatus").textContent = "Erro ao verificar status.";
  }
}

async function startDriveAuth() {
  setDriveResult({ loading: true, message: "Gerando link de autorização…" });
  $("#driveConnectBtn").disabled = true;
  try {
    const res = await fetch("/api/composio/connect", { method: "POST" });
    const data = await res.json();
    if (data.ok && data.url) {
      setDriveResult(null);
      const link = $("#driveOAuthUrl");
      link.href = data.url;
      link.textContent = data.url.length > 80 ? data.url.slice(0, 80) + "…" : data.url;
      $("#driveOAuthFlow").hidden = false;
    } else {
      setDriveResult({ ok: false, message: data.error || "Falha ao gerar o link." });
    }
  } catch (e) {
    setDriveResult({ ok: false, message: "Erro: " + e.message });
  }
  $("#driveConnectBtn").disabled = false;
}

async function checkDriveConnection() {
  setDriveResult({ loading: true, message: "Verificando conexão…" });
  try {
    const res = await fetch("/api/composio/check", { method: "POST" });
    const data = await res.json();
    if (data.connected) {
      setDriveResult({ ok: true, message: data.message || "Vinculado!" });
      setTimeout(() => {
        $("#driveOAuthFlow").hidden = true;
        loadDriveStatus();
        loadClients();
      }, 1500);
    } else {
      setDriveResult({ ok: false, message: "Ainda aguardando. Abra o link e autorize, depois clique em 'Verificar conexão' novamente." });
    }
  } catch (e) {
    setDriveResult({ ok: false, message: "Erro: " + e.message });
  }
}

// ── Onboarding ─────────────────────────────────────────────────────────
function setupOnboarding() {
  $("#obSaveKey").addEventListener("click", obSaveKey);
  $("#obDriveBtn").addEventListener("click", obStartDrive);
  $("#obDriveCheck").addEventListener("click", obCheckDrive);
  $("#obSkipDrive").addEventListener("click", () => obGo(3));
  $("#obFinish").addEventListener("click", finishOnboarding);
  $("#obApiKey").addEventListener("keydown", (e) => { if (e.key === "Enter") obSaveKey(); });
  // Step 3: Claude credentials
  document.querySelectorAll('input[name="ob-authmode"]').forEach((r) =>
    r.addEventListener("change", () => obApplyAuthMode())
  );
  $("#obSaveClaude").addEventListener("click", obSaveClaude);
  $("#obOauthStart").addEventListener("click", obStartOAuth);
  $("#obOauthSubmit").addEventListener("click", obSubmitOAuth);
  $("#obOauthCancel").addEventListener("click", () => {
    fetch("/api/oauth/cancel", { method: "POST" }).catch(() => {});
    $("#obOauthFlow").hidden = true;
    setObResult("#obOauthResult", null);
  });
  $("#obOauthCode").addEventListener("keydown", (e) => { if (e.key === "Enter") obSubmitOAuth(); });
}

function showOnboarding(setup) {
  $("#onboarding").hidden = false;
  if (!setup.composio?.hasApiKey) obGo(1);
  else if (!setup.composio?.driveConnected) obGo(2);
  else obGo(3);
}

function obGo(step) {
  $("#obStep1").hidden = step !== 1;
  $("#obStep2").hidden = step !== 2;
  $("#obStep3").hidden = step !== 3;
  $("#obStepDone").hidden = step !== "done";
  document.querySelectorAll(".step-dot").forEach((d) => {
    const s = Number(d.dataset.step);
    d.classList.toggle("active", s === step);
    d.classList.toggle("done", step === "done" || (typeof step === "number" && s < step));
  });
}

function setObResult(id, state) {
  const box = $(id);
  if (!state) { box.hidden = true; box.textContent = ""; box.className = "test-result"; return; }
  box.hidden = false;
  box.textContent = state.message || "";
  box.className = "test-result " + (state.loading ? "loading" : state.ok ? "ok" : "err");
}

async function obSaveKey() {
  const key = $("#obApiKey").value.trim();
  if (!key) { setObResult("#obKeyResult", { ok: false, message: "Informe a chave." }); return; }
  setObResult("#obKeyResult", { loading: true, message: "Salvando…" });
  try {
    const res = await fetch("/api/setup/composio-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    const data = await res.json();
    if (data.ok) {
      setObResult("#obKeyResult", { ok: true, message: "Chave salva!" });
      setTimeout(() => obGo(2), 600);
    } else {
      setObResult("#obKeyResult", { ok: false, message: data.error || "Falha." });
    }
  } catch (e) {
    setObResult("#obKeyResult", { ok: false, message: "Erro: " + e.message });
  }
}

async function obStartDrive() {
  setObResult("#obDriveResult", { loading: true, message: "Gerando link…" });
  $("#obDriveBtn").disabled = true;
  try {
    const res = await fetch("/api/composio/connect", { method: "POST" });
    const data = await res.json();
    if (data.ok && data.url) {
      setObResult("#obDriveResult", null);
      const link = $("#obDriveUrl");
      link.href = data.url;
      link.textContent = data.url.length > 70 ? data.url.slice(0, 70) + "…" : data.url;
      $("#obDriveFlow").hidden = false;
    } else {
      setObResult("#obDriveResult", { ok: false, message: data.error || "Falha ao gerar link." });
    }
  } catch (e) {
    setObResult("#obDriveResult", { ok: false, message: "Erro: " + e.message });
  }
  $("#obDriveBtn").disabled = false;
}

async function obCheckDrive() {
  setObResult("#obDriveResult", { loading: true, message: "Verificando…" });
  try {
    const res = await fetch("/api/composio/check", { method: "POST" });
    const data = await res.json();
    if (data.connected) {
      setObResult("#obDriveResult", { ok: true, message: "Google Drive vinculado!" });
      setTimeout(() => obGo("done"), 800);
    } else {
      setObResult("#obDriveResult", { ok: false, message: "Ainda aguardando. Autorize no link e tente novamente." });
    }
  } catch (e) {
    setObResult("#obDriveResult", { ok: false, message: "Erro: " + e.message });
  }
}

// Step 3: Claude credentials
function obApplyAuthMode() {
  const mode = document.querySelector('input[name="ob-authmode"]:checked')?.value || "inherit";
  $("#obApiKeyField").hidden = mode !== "api";
  $("#obSubsSection").hidden = mode !== "subscription";
}

async function obSaveClaude() {
  const mode = document.querySelector('input[name="ob-authmode"]:checked')?.value || "inherit";
  const apiKey = $("#obClaudeApiKey")?.value?.trim() || undefined;
  setObResult("#obClaudeResult", { loading: true, message: "Salvando…" });
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, apiKey: mode === "api" ? apiKey : undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      setObResult("#obClaudeResult", { ok: false, message: data.error || "Falha." });
      return;
    }
    setObResult("#obClaudeResult", { ok: true, message: "Salvo!" });
    setTimeout(() => obGo("done"), 600);
  } catch (e) {
    setObResult("#obClaudeResult", { ok: false, message: "Erro: " + e.message });
  }
}

async function obStartOAuth() {
  setObResult("#obOauthResult", { loading: true, message: "Iniciando login OAuth…" });
  $("#obOauthFlow").hidden = false;
  $("#obOauthStart").disabled = true;
  try {
    const res = await fetch("/api/oauth/start", { method: "POST" });
    const data = await res.json();
    if (data.ok && data.url) {
      setObResult("#obOauthResult", null);
      const link = $("#obOauthUrl");
      link.href = data.url;
      link.textContent = data.url.length > 70 ? data.url.slice(0, 70) + "…" : data.url;
      $("#obOauthCode").value = "";
      $("#obOauthCode").focus();
    } else {
      setObResult("#obOauthResult", { ok: false, message: data.error || "Falha ao iniciar." });
    }
  } catch (e) {
    setObResult("#obOauthResult", { ok: false, message: "Erro: " + e.message });
  }
  $("#obOauthStart").disabled = false;
}

async function obSubmitOAuth() {
  const code = $("#obOauthCode").value.trim();
  if (!code) { setObResult("#obOauthResult", { ok: false, message: "Cole o código." }); return; }
  setObResult("#obOauthResult", { loading: true, message: "Enviando código…" });
  try {
    const res = await fetch("/api/oauth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (data.ok) {
      setObResult("#obOauthResult", { ok: true, message: data.message || "Login realizado!" });
      $("#obOauthFlow").hidden = true;
      // Auto-save subscription mode
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "subscription" }),
      });
      setTimeout(() => obGo("done"), 1000);
    } else {
      setObResult("#obOauthResult", { ok: false, message: data.error || "Falha." });
    }
  } catch (e) {
    setObResult("#obOauthResult", { ok: false, message: "Erro: " + e.message });
  }
}

function finishOnboarding() {
  $("#onboarding").hidden = true;
  loadAll();
}

// ── Settings: salvar chave Composio ────────────────────────────────────
async function saveDriveApiKey() {
  const key = $("#driveApiKeyInput").value.trim();
  if (!key) return;
  const box = $("#driveApiKeyResult");
  box.hidden = false; box.textContent = "Salvando…"; box.className = "test-result loading";
  try {
    const res = await fetch("/api/setup/composio-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
    const data = await res.json();
    box.textContent = data.ok ? "Chave salva!" : (data.error || "Falha.");
    box.className = "test-result " + (data.ok ? "ok" : "err");
    if (data.ok) {
      $("#driveApiKeyInput").value = "";
      setTimeout(() => loadDriveStatus(), 800);
    }
  } catch (e) {
    box.textContent = "Erro: " + e.message;
    box.className = "test-result err";
  }
}

// ── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso || "";
  }
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ── Markdown mínimo e seguro ─────────────────────────────────────────────────
function mdToHtml(src) {
  let text = String(src || "");
  const blocks = [];
  // Fenced code blocks
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `@@CB${blocks.length - 1}@@`;
  });

  text = escapeHtml(text);

  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Bold / italic
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // Links
  text = text.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Processa por linhas para títulos e listas
  const lines = text.split("\n");
  let html = "";
  let inUl = false, inOl = false;
  const closeLists = () => {
    if (inUl) { html += "</ul>"; inUl = false; }
    if (inOl) { html += "</ol>"; inOl = false; }
  };
  for (let line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      html += `<h${lvl}>${h[2]}</h${lvl}>`;
    } else if (ul) {
      if (inOl) { html += "</ol>"; inOl = false; }
      if (!inUl) { html += "<ul>"; inUl = true; }
      html += `<li>${ul[1]}</li>`;
    } else if (ol) {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (!inOl) { html += "<ol>"; inOl = true; }
      html += `<li>${ol[1]}</li>`;
    } else if (line.trim() === "") {
      closeLists();
    } else if (/^@@CB[0-9]+@@$/.test(line.trim())) {
      closeLists();
      html += line.trim();
    } else if (line.startsWith(" ")) {
      closeLists();
      html += line;
    } else {
      closeLists();
      html += `<p>${line}</p>`;
    }
  }
  closeLists();

  // Restaura blocos de código
  html = html.replace(/@@CB([0-9]+)@@/g, (_, i) => blocks[Number(i)] || "");
  return html;
}

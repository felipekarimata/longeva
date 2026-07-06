import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import config from "./config.js";
import {
  requireAuth,
  checkLogin,
  changePassword,
  createSessionToken,
  SESSION_COOKIE,
} from "./lib/auth.js";
import {
  startOAuthLogin,
  submitOAuthCode,
  cancelOAuthLogin,
} from "./lib/claude-auth.js";
import {
  getComposioStatus,
  startGoogleDriveAuth,
  checkGoogleDriveConnection,
  testGoogleDriveConnection,
} from "./lib/composio-auth.js";
import { getSetupStatus, saveComposioKey } from "./lib/setup.js";
import { runTask } from "./lib/claude-runner.js";
import { listClients } from "./lib/mcp-client.js";
import { listDeliverables, resolveDeliverable } from "./lib/deliverables.js";
import { saveRun, listRuns, getRun, deleteRun, newRunId } from "./lib/history.js";
import { getSettingsPublic, setSettings, testCredential } from "./lib/claude-auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// ── Cookie de sessão ─────────────────────────────────────────────────────────
function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${config.auth.sessionHours * 3600}`,
  ];
  if (config.auth.cookieSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}
function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

// ── Rate limit simples para login (por IP) ───────────────────────────────────
const loginAttempts = new Map(); // ip -> { count, first }
function loginThrottled(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (now - rec.first > 15 * 60 * 1000) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= 8;
}
function recordFail(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, first: now };
  rec.count += 1;
  loginAttempts.set(ip, rec);
}

// ── Auth: login/logout/me (públicas) ─────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  const ip = req.ip || "unknown";
  if (loginThrottled(ip)) {
    return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos." });
  }
  const { user, password } = req.body || {};
  if (!config.auth.passwordHash) {
    return res
      .status(500)
      .json({ error: "Senha não configurada no servidor. Rode: npm run set-password" });
  }
  // Pequeno atraso constante para dificultar brute force.
  await new Promise((r) => setTimeout(r, 250));
  if (checkLogin(String(user || ""), String(password || ""))) {
    loginAttempts.delete(ip);
    setSessionCookie(res, createSessionToken(config.auth.user));
    return res.json({ ok: true });
  }
  recordFail(ip);
  return res.status(401).json({ error: "Usuário ou senha inválidos." });
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: req.session.u });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  await new Promise((r) => setTimeout(r, 250));
  const { currentPassword, newPassword } = req.body || {};
  const result = changePassword(String(currentPassword || ""), String(newPassword || ""));
  res.status(result.ok ? 200 : 400).json(result);
});

// ── Páginas ──────────────────────────────────────────────────────────────────
app.get(["/", "/index.html", "/app"], requireAuth, (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});
// Estáticos públicos (login.html, styles.css, app.js — sem segredos).
app.use(express.static(publicDir, { index: false }));

// ── API protegida ─────────────────────────────────────────────────────────────
const api = express.Router();
api.use(requireAuth);

api.get("/health", (req, res) => {
  res.json({
    ok: true,
    claudeBin: config.claude.bin,
    claudeBinExists: fs.existsSync(config.claude.bin),
    agentProjectDir: config.agentProjectDir,
    agentFileExists: fs.existsSync(config.agentFile),
    permissionMode: config.claude.permissionMode,
    model: config.claude.model || "(padrão)",
  });
});

api.get("/clients", async (req, res) => {
  try {
    const data = await listClients({ force: req.query.force === "1" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message, clients: [] });
  }
});

api.get("/deliverables", (req, res) => {
  res.json({ files: listDeliverables() });
});

api.get("/deliverables/download", (req, res) => {
  const found = resolveDeliverable(req.query.name);
  if (!found) return res.status(404).json({ error: "Arquivo não encontrado." });
  res.setHeader("Content-Type", found.contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(found.name)}"`
  );
  fs.createReadStream(found.path).pipe(res);
});

api.get("/history", (req, res) => {
  res.json({ runs: listRuns() });
});

api.get("/history/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Execução não encontrada." });
  res.json(run);
});

api.delete("/history/:id", (req, res) => {
  res.json({ ok: deleteRun(req.params.id) });
});

// ── Configurações de login do Claude ─────────────────────────────────────────
api.get("/settings", (req, res) => {
  res.json(getSettingsPublic());
});

api.post("/settings", (req, res) => {
  try {
    res.json(setSettings(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.post("/settings/test", async (req, res) => {
  try {
    const result = await testCredential();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── OAuth: vincular assinatura ──────────────────────────────────────────────
api.post("/oauth/start", async (req, res) => {
  try {
    const result = await startOAuthLogin();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

api.post("/oauth/code", async (req, res) => {
  const { code } = req.body || {};
  if (!code || !String(code).trim()) {
    return res.status(400).json({ ok: false, error: "Informe o código." });
  }
  try {
    const result = await submitOAuthCode(String(code).trim());
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

api.post("/oauth/cancel", (req, res) => {
  cancelOAuthLogin();
  res.json({ ok: true });
});

// ── Setup / Onboarding ────────────────────────────────────────────────────
api.get("/setup/status", async (req, res) => {
  const status = getSetupStatus();
  if (status.composio.hasApiKey) {
    try {
      const conn = await testGoogleDriveConnection();
      status.composio.driveConnected = conn.connected;
    } catch {
      status.composio.driveConnected = false;
    }
  }
  res.json(status);
});

api.post("/setup/composio-key", (req, res) => {
  const { apiKey } = req.body || {};
  const result = saveComposioKey(String(apiKey || ""));
  res.status(result.ok ? 200 : 400).json(result);
});

// ── Composio: vincular Google Drive ─────────────────────────────────────────
api.get("/composio/status", async (req, res) => {
  const status = getComposioStatus();
  if (status.configured) {
    const conn = await testGoogleDriveConnection();
    status.connected = conn.connected;
  }
  res.json(status);
});

api.post("/composio/connect", async (req, res) => {
  try {
    const result = await startGoogleDriveAuth();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

api.post("/composio/check", async (req, res) => {
  try {
    const result = await checkGoogleDriveConnection();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Execução de tarefa com streaming (SSE sobre POST) ────────────────────────
api.post("/run", async (req, res) => {
  const { demand, client, resumeSessionId } = req.body || {};
  if (!demand || !String(demand).trim()) {
    return res.status(400).json({ error: "Descreva a demanda." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (evt) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {}
  };

  const runId = newRunId();
  send({ kind: "start", id: runId });

  // Cancelamento se o cliente fechar a conexão antes do fim.
  // Escutamos o "close" da RESPOSTA (não do req): com express.json() o req já
  // teve o corpo consumido e emitiria "close" imediatamente. O res só fecha
  // quando o cliente desconecta ou quando encerramos (finished=true).
  const ac = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) ac.abort();
  });

  const clientContext =
    client && !resumeSessionId
      ? `Cliente/pasta selecionada no Drive: ${client}. Use este contexto ao localizar extratos e ao salvar entregáveis.`
      : "";

  let summary;
  try {
    summary = await runTask({
      demand: String(demand),
      clientContext,
      resumeSessionId: resumeSessionId || null,
      onEvent: send,
      signal: ac.signal,
    });
  } catch (e) {
    send({ kind: "error", text: `Erro interno: ${e.message}` });
    summary = { resultText: "", events: [], isError: true };
  }

  finished = true;

  // Persiste no histórico (mesmo se cancelado/erro, para rastreabilidade).
  let saved = null;
  try {
    saved = saveRun({
      id: runId,
      demand: String(demand),
      client: client || null,
      resumeSessionId: resumeSessionId || null,
      summary,
    });
  } catch (e) {
    send({ kind: "error", text: `Falha ao salvar histórico: ${e.message}` });
  }

  send({ kind: "saved", id: runId, title: saved?.title, sessionId: summary.sessionId || null });
  send({ kind: "end" });
  res.end();
});

app.use("/api", api);

// ── Erros e 404 ────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Não encontrado" }));

// ── Boot ───────────────────────────────────────────────────────────────────────
function warnings() {
  const w = [];
  if (!config.auth.passwordHash) w.push("AUTH_PASSWORD_HASH vazio — rode: npm run set-password");
  if (!config.auth.sessionSecret) w.push("SESSION_SECRET vazio — defina no .env");
  if (!fs.existsSync(config.claude.bin))
    w.push(`Executável do Claude não encontrado em: ${config.claude.bin} (defina CLAUDE_BIN)`);
  if (!fs.existsSync(config.agentFile))
    w.push(`Arquivo do agente não encontrado: ${config.agentFile}`);
  if (!fs.existsSync(path.join(config.agentProjectDir, "index.js")))
    w.push(`index.js do MCP não encontrado em: ${config.agentProjectDir}`);
  return w;
}

app.listen(config.port, config.host, () => {
  console.log("\n  Longeva Advisor Web");
  console.log(`  → http://${config.host}:${config.port}`);
  console.log(`  Claude: ${config.claude.bin}`);
  console.log(`  Projeto do agente: ${config.agentProjectDir}`);
  const w = warnings();
  if (w.length) {
    console.log("\n  ⚠ Avisos de configuração:");
    for (const line of w) console.log(`   - ${line}`);
  }
  console.log("");
});

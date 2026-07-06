import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import config from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Controla qual credencial o `claude` usa ao ser acionado.
//
// Modos:
//   - "inherit"      : usa o ambiente como está (gateway atual: ANTHROPIC_BASE_URL
//                      + ANTHROPIC_AUTH_TOKEN). Padrão — não quebra o que funciona.
//   - "api"          : usa uma API key da Anthropic (injeta ANTHROPIC_API_KEY e
//                      remove o token/base URL do gateway).
//   - "subscription" : remove todas as vars de API/token para o claude cair no
//                      login OAuth já feito no host (~/.claude/.credentials.json).
//
// As configurações ficam em data/claude-auth.json (fora do git). A API key NÃO
// é guardada como ANTHROPIC_API_KEY no .env para não poluir a resolução de auth
// dos demais modos.
// ─────────────────────────────────────────────────────────────────────────────

// Snapshot do ambiente original (contém o gateway atual, se houver).
const BASE_ENV = { ...process.env };

const SETTINGS_FILE = path.join(config.dataDir, "claude-auth.json");
const MODES = ["inherit", "api", "subscription"];
const CREDENTIALS_FILE = path.join(os.homedir(), ".claude", ".credentials.json");

let settings = loadSettings();

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    if (MODES.includes(s.mode)) return { mode: s.mode, apiKey: s.apiKey || "" };
  } catch {
    /* usa seed abaixo */
  }
  // Seed inicial via .env (namespaced, sem poluir ANTHROPIC_*).
  const envMode = process.env.CLAUDE_AUTH_MODE;
  const mode = MODES.includes(envMode) ? envMode : "inherit";
  return { mode, apiKey: process.env.CLAUDE_API_KEY || "" };
}

function persist() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 12) return "•".repeat(k.length);
  return k.slice(0, 7) + "…" + k.slice(-4);
}

// Estado seguro para enviar ao cliente (nunca a chave em claro).
export function getSettingsPublic() {
  return {
    mode: settings.mode,
    hasApiKey: !!settings.apiKey,
    apiKeyMasked: maskKey(settings.apiKey),
    credentialsFileExists: fs.existsSync(CREDENTIALS_FILE),
    model: config.claude.model || "(padrão do ambiente)",
  };
}

export function setSettings({ mode, apiKey }) {
  if (!MODES.includes(mode)) throw new Error("Modo de login inválido.");
  const next = { mode, apiKey: settings.apiKey };
  // Só substitui a chave se uma nova (não vazia) foi enviada.
  if (typeof apiKey === "string" && apiKey.trim()) next.apiKey = apiKey.trim();
  if (mode === "api" && !next.apiKey) {
    throw new Error("Informe uma API key para usar o modo API.");
  }
  settings = next;
  persist();
  return getSettingsPublic();
}

// Monta o ambiente do processo `claude` de acordo com o modo selecionado.
export function getClaudeEnv(extra = {}) {
  const env = { ...BASE_ENV, ...extra };
  if (settings.mode === "api") {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_API_KEY = settings.apiKey;
  } else if (settings.mode === "subscription") {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  // "inherit": mantém o ambiente original.
  return env;
}

// Testa a credencial atual com um prompt trivial (sem MCP, rápido).
export function testCredential() {
  return new Promise((resolve) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--mcp-config",
      config.claude.emptyMcpConfigFile,
      "--strict-mcp-config",
    ];
    if (config.claude.model) args.push("--model", config.claude.model);

    let child;
    try {
      child = spawn(config.claude.bin, args, {
        cwd: config.agentProjectDir,
        env: getClaudeEnv({ FORCE_COLOR: "0" }),
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, message: "Falha ao iniciar o Claude: " + e.message });
    }

    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, 60000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    try {
      child.stdin.write("Responda apenas com: ok");
      child.stdin.end();
    } catch {}

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, message: e.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      let res = null;
      try {
        res = JSON.parse(out.trim());
      } catch {
        /* saída não-JSON */
      }
      const model = config.claude.model || "(padrão)";
      if (res && res.subtype === "success" && !res.is_error) {
        return resolve({
          ok: true,
          message: "Credencial válida — o Claude respondeu com sucesso.",
          model,
        });
      }
      if (timedOut) {
        return resolve({
          ok: false,
          message:
            "Tempo limite atingido — a credencial pode estar inválida ou inacessível (ex.: API key incorreta gera retries até o timeout).",
          model,
        });
      }
      const detail =
        (res && res.result && String(res.result)) ||
        err.trim().split("\n").slice(-3).join("\n") ||
        `O Claude encerrou com código ${code}.`;
      resolve({ ok: false, message: detail.slice(0, 300), model });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth login flow — roda `claude auth login --claudeai`, captura a URL e
// depois envia o código que o usuário copia da página da Anthropic.
// ─────────────────────────────────────────────────────────────────────────────
let oauthProc = null;

function killOAuthProc() {
  if (oauthProc) {
    try { oauthProc.kill("SIGTERM"); } catch {}
    oauthProc = null;
  }
}

export function startOAuthLogin() {
  killOAuthProc();
  return new Promise((resolve) => {
    const child = spawn(config.claude.bin, ["auth", "login", "--claudeai"], {
      cwd: config.agentProjectDir,
      env: getClaudeEnv({ FORCE_COLOR: "0" }),
      windowsHide: true,
    });
    oauthProc = child;

    let combined = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        killOAuthProc();
        resolve({ ok: false, error: "Tempo limite — o Claude não retornou a URL." });
      }
    }, 15000);

    function onData(chunk) {
      combined += chunk.toString();
      if (resolved) return;
      const match = combined.match(/(https:\/\/claude\.com\/\S+)/);
      if (match) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ ok: true, url: match[1] });
      }
    }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (e) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        oauthProc = null;
        resolve({ ok: false, error: "Falha ao iniciar: " + e.message });
      }
    });

    child.on("close", () => {
      oauthProc = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ ok: false, error: "O processo encerrou sem gerar a URL.\n" + combined.slice(-300) });
      }
    });
  });
}

export function submitOAuthCode(code) {
  return new Promise((resolve) => {
    if (!oauthProc) {
      return resolve({ ok: false, error: "Nenhum login em andamento. Inicie novamente." });
    }
    const child = oauthProc;
    let output = "";
    const timeout = setTimeout(() => {
      killOAuthProc();
      resolve({ ok: false, error: "Tempo limite ao aguardar o Claude processar o código." });
    }, 30000);

    function onData(chunk) { output += chunk.toString(); }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      oauthProc = null;
      if (exitCode === 0) {
        resolve({ ok: true, message: "Login realizado com sucesso!" });
      } else {
        resolve({ ok: false, error: output.trim().slice(-300) || `Falha (código ${exitCode}).` });
      }
    });

    try {
      child.stdin.write(code.trim() + "\n");
    } catch (e) {
      clearTimeout(timeout);
      oauthProc = null;
      resolve({ ok: false, error: "Falha ao enviar o código: " + e.message });
    }
  });
}

export function cancelOAuthLogin() {
  killOAuthProc();
}

export const AUTH_MODES = MODES;

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Carrega o .env do próprio app (por caminho absoluto), independentemente do
// diretório de onde o servidor foi iniciado.
dotenv.config({ path: path.join(__dirname, ".env") });

// ── Utilitário: primeiro caminho existente de uma lista ──────────────────────
function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ── Resolve o executável do Claude Code ──────────────────────────────────────
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }
  const home = os.homedir();
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [
        path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
        path.join(home, "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
        path.join(home, ".claude", "local", "claude.exe"),
      ]
    : [
        "/usr/local/bin/claude",
        path.join(home, ".npm-global", "bin", "claude"),
        path.join(home, ".claude", "local", "claude"),
        "/opt/homebrew/bin/claude",
      ];
  return firstExisting(candidates) || (isWin ? "claude.exe" : "claude");
}

const AGENT_PROJECT_DIR =
  process.env.AGENT_PROJECT_DIR || path.resolve(__dirname, "..", "longeva-advisor");

const KNOWLEDGE_DIR =
  process.env.KNOWLEDGE_DIR || path.join(os.homedir(), ".claude", "knowledge");

const AGENT_FILE =
  process.env.AGENT_FILE ||
  path.join(os.homedir(), ".claude", "agents", "longeva-advisor.md");

const DATA_DIR = path.join(__dirname, "data");
const HISTORY_DIR = path.join(DATA_DIR, "history");
for (const d of [DATA_DIR, HISTORY_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Gera o arquivo de configuração MCP usado pelo claude headless ────────────
// Aponta para o index.js do projeto (servidor MCP longeva-advisor). Credenciais
// Composio só são injetadas se fornecidas aqui; senão o index.js as carrega.
function readEnvFile(p) {
  try {
    return dotenv.parse(fs.readFileSync(p));
  } catch {
    return {};
  }
}

// Resolve as credenciais Composio: primeiro do ambiente do app; se ausentes,
// dos .env do projeto (~/.longeva-advisor/.env ou <projeto>/.env). Assim o MCP
// recebe credenciais reais mesmo que o .env do web app as deixe em branco.
function resolveComposio() {
  let apiKey = process.env.COMPOSIO_API_KEY || "";
  let entityId = process.env.COMPOSIO_ENTITY_ID || "";

  // 1. Arquivo salvo pelo onboarding web (data/composio.json)
  const composioJsonPath = path.join(DATA_DIR, "composio.json");
  try {
    const saved = JSON.parse(fs.readFileSync(composioJsonPath, "utf-8"));
    if (!apiKey && saved.apiKey) apiKey = saved.apiKey;
    if (!entityId && saved.entityId) entityId = saved.entityId;
  } catch {}

  // 2. .env do instalador ou do projeto do agente
  const files = [
    path.join(os.homedir(), ".longeva-advisor", ".env"),
    path.join(AGENT_PROJECT_DIR, ".env"),
  ];
  for (const f of files) {
    const e = readEnvFile(f);
    if (!apiKey && e.COMPOSIO_API_KEY) apiKey = e.COMPOSIO_API_KEY;
    if (!entityId && e.COMPOSIO_ENTITY_ID) entityId = e.COMPOSIO_ENTITY_ID;
  }
  return { apiKey, entityId };
}

const composio = resolveComposio();
// Normaliza o process.env: evita propagar strings vazias que envenenariam o
// dotenv dos processos-filho (claude e o servidor MCP index.js).
if (composio.apiKey) process.env.COMPOSIO_API_KEY = composio.apiKey;
else delete process.env.COMPOSIO_API_KEY;
if (composio.entityId) process.env.COMPOSIO_ENTITY_ID = composio.entityId;
else delete process.env.COMPOSIO_ENTITY_ID;

function writeMcpConfig() {
  const mcpEnv = {};
  if (composio.apiKey) mcpEnv.COMPOSIO_API_KEY = composio.apiKey;
  if (composio.entityId) mcpEnv.COMPOSIO_ENTITY_ID = composio.entityId;

  const cfg = {
    mcpServers: {
      "longeva-advisor": {
        type: "stdio",
        command: "node",
        args: [path.join(AGENT_PROJECT_DIR, "index.js")],
        env: mcpEnv,
      },
    },
  };
  const file = path.join(DATA_DIR, "mcp-longeva.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf-8");
  return file;
}

// Config MCP vazia usada no teste de credencial (isola do MCP e das globais).
function writeEmptyMcpConfig() {
  const file = path.join(DATA_DIR, "mcp-empty.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2), "utf-8");
  return file;
}

const config = {
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST || "127.0.0.1",

  passwordHashFile: path.join(DATA_DIR, "password-hash.txt"),

  auth: {
    user: process.env.AUTH_USER || "admin",
    passwordHash: (() => {
      const f = path.join(DATA_DIR, "password-hash.txt");
      try { return fs.readFileSync(f, "utf-8").trim(); } catch {}
      return process.env.AUTH_PASSWORD_HASH || "";
    })(),
    sessionSecret: process.env.SESSION_SECRET || "",
    sessionHours: Number(process.env.SESSION_HOURS) || 12,
    cookieSecure: String(process.env.COOKIE_SECURE).toLowerCase() === "true",
  },

  agentProjectDir: AGENT_PROJECT_DIR,
  knowledgeDir: KNOWLEDGE_DIR,
  agentFile: AGENT_FILE,
  outputsDir: path.join(AGENT_PROJECT_DIR, "outputs"),
  downloadsDir: path.join(AGENT_PROJECT_DIR, "downloads"),

  dataDir: DATA_DIR,
  historyDir: HISTORY_DIR,

  composio,

  claude: {
    bin: resolveClaudeBin(),
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions",
    model: process.env.CLAUDE_MODEL || "",
    timeoutMs: (Number(process.env.RUN_TIMEOUT_MIN) || 20) * 60 * 1000,
    mcpConfigFile: writeMcpConfig(),
    emptyMcpConfigFile: writeEmptyMcpConfig(),
  },
};

export default config;

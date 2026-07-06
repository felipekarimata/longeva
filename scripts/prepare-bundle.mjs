// Reúne, em ./vendor, tudo que o container precisa: o projeto MCP longeva-advisor,
// a base de conhecimento e a definição do agente (com o caminho da base reescrito
// para o caminho do container). Rode antes de "docker build".
//
//   node scripts/prepare-bundle.mjs
//
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");
const vendor = path.join(webRoot, "vendor");

// Caminhos DENTRO do container (usados no Dockerfile).
const C_PROJECT = "/app/vendor/longeva-advisor";
const C_KNOWLEDGE = "/app/vendor/knowledge";

function log(msg) {
  console.log("  " + msg);
}

function ensureEmpty(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

console.log("Preparando bundle em ./vendor ...");
ensureEmpty(vendor);

// ── 1) Projeto MCP (apenas o necessário; deps via npm no Docker) ─────────────
const projDst = path.join(vendor, "longeva-advisor");
fs.mkdirSync(projDst, { recursive: true });
const projFiles = ["index.js", "server.js", "package.json", "package-lock.json"];
let copiedLock = false;
for (const f of projFiles) {
  const src = path.join(config.agentProjectDir, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(projDst, f));
    if (f === "package-lock.json") copiedLock = true;
    log("projeto: " + f);
  } else if (f === "package-lock.json") {
    log("(aviso) package-lock.json não encontrado — o Docker usará 'npm install').");
  } else {
    console.error("ERRO: arquivo obrigatório do projeto não encontrado: " + src);
    process.exit(1);
  }
}
// Pastas de trabalho (serão volumes no container).
fs.mkdirSync(path.join(projDst, "downloads"), { recursive: true });
fs.mkdirSync(path.join(projDst, "outputs"), { recursive: true });

// Workaround do pdf-parse@1.1.1: ao ser carregado, seu "modo debug" tenta ler
// ./test/data/05-versions-space.pdf relativo ao CWD. Sem esse arquivo o servidor
// MCP (index.js) cai no start. Recriamos o fixture (real, com fallback vazio).
const fixtureRel = path.join("test", "data", "05-versions-space.pdf");
const fixtureDst = path.join(projDst, fixtureRel);
fs.mkdirSync(path.dirname(fixtureDst), { recursive: true });
const fixtureSrc = path.join(config.agentProjectDir, "node_modules", "pdf-parse", fixtureRel);
if (fs.existsSync(fixtureSrc)) fs.copyFileSync(fixtureSrc, fixtureDst);
else fs.writeFileSync(fixtureDst, "");
log("workaround pdf-parse: " + fixtureRel.replace(/\\/g, "/"));

// ── 2) Base de conhecimento ──────────────────────────────────────────────────
const knowSrc = path.join(config.knowledgeDir, "longeva");
const knowDst = path.join(vendor, "knowledge", "longeva");
if (!fs.existsSync(knowSrc)) {
  console.error("ERRO: base de conhecimento não encontrada: " + knowSrc);
  process.exit(1);
}
fs.cpSync(knowSrc, knowDst, { recursive: true });
log("conhecimento: " + fs.readdirSync(knowDst).length + " arquivos");

// ── 3) Definição do agente (com caminho da base reescrito p/ o container) ────
const agentDst = path.join(vendor, "agents", "longeva-advisor.md");
fs.mkdirSync(path.dirname(agentDst), { recursive: true });
let agentMd = fs.readFileSync(config.agentFile, "utf-8");
// Reescreve o caminho Windows da base de conhecimento para o caminho do container.
const winKnow = path.join(config.knowledgeDir, "longeva"); // ex.: C:\Users\...\knowledge\longeva
const winKnowVariants = [
  winKnow,
  winKnow.replace(/\\/g, "/"),
  winKnow + "\\",
  winKnow.replace(/\\/g, "/") + "/",
];
for (const v of winKnowVariants) {
  agentMd = agentMd.split(v).join(C_KNOWLEDGE + "/longeva");
}
// Remove eventual barra invertida remanescente logo após o caminho reescrito.
agentMd = agentMd.split(C_KNOWLEDGE + "/longeva\\").join(C_KNOWLEDGE + "/longeva");
fs.writeFileSync(agentDst, agentMd, "utf-8");
log("agente: longeva-advisor.md (caminho da base reescrito p/ " + C_KNOWLEDGE + "/longeva)");

console.log("\nBundle pronto. Caminhos no container:");
console.log("  AGENT_PROJECT_DIR = " + C_PROJECT);
console.log("  KNOWLEDGE_DIR     = " + C_KNOWLEDGE);
console.log("  AGENT_FILE        = /app/vendor/agents/longeva-advisor.md");
console.log(copiedLock ? "  (npm ci no Docker)" : "  (npm install no Docker — sem lockfile)");
console.log("\nAgora: docker compose up -d --build");

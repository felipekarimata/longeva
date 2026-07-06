#!/usr/bin/env node
// Faz bundle + docker build + docker compose up em um único comando.
//
//   npm run deploy                  # bundle + build + up
//   npm run deploy -- --build-only  # bundle + build (sem up)
//
import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const envDockerPath = path.join(root, ".env.docker");
const envExamplePath = path.join(root, ".env.docker.example");

const buildOnly = process.argv.includes("--build-only");

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
}

function step(label) {
  console.log(`\n${"─".repeat(60)}\n  ${label}\n${"─".repeat(60)}`);
}

// ── 1) Bundle ───────────────────────────────────────────────────────────────
step("1/3  Preparando bundle (agente + base de conhecimento + projeto MCP)");
run("node scripts/prepare-bundle.mjs");

// ── 2) .env.docker ──────────────────────────────────────────────────────────
if (!fs.existsSync(envDockerPath)) {
  step("2/3  Criando .env.docker a partir do exemplo");
  fs.copyFileSync(envExamplePath, envDockerPath);
  const secret = crypto.randomBytes(48).toString("hex");
  let content = fs.readFileSync(envDockerPath, "utf-8");
  content = content.replace(
    "SESSION_SECRET=troque-por-uma-string-longa-e-aleatoria",
    `SESSION_SECRET=${secret}`
  );
  fs.writeFileSync(envDockerPath, content, "utf-8");
  console.log("  .env.docker criado com SESSION_SECRET gerado.");
  console.log("  ATENÇÃO: edite .env.docker e preencha:");
  console.log("    - AUTH_PASSWORD_HASH  (rode: npm run set-password -- \"sua-senha\")");
  console.log("    - CLAUDE_API_KEY      (sua API key da Anthropic)");
  console.log("    - COMPOSIO_API_KEY / COMPOSIO_ENTITY_ID (se usar Google Drive)");
  console.log("\n  Depois rode 'npm run deploy' novamente.");
  process.exit(0);
} else {
  step("2/3  .env.docker já existe — OK");
}

// ── 3) Docker build + up ────────────────────────────────────────────────────
step(buildOnly ? "3/3  Docker build" : "3/3  Docker build + up");
run("docker compose build");

if (!buildOnly) {
  run("docker compose up -d");
  console.log("\n  Container rodando. Acesse http://localhost:8787");
  console.log("  Logs: docker compose logs -f");
}

step("Pronto");

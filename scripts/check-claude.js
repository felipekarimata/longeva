// Diagnóstico: mostra a configuração resolvida e testa o executável do Claude.
import { spawnSync } from "child_process";
import fs from "fs";
import config from "../config.js";

console.log("Configuração resolvida:");
console.log("  claude.bin        :", config.claude.bin, fs.existsSync(config.claude.bin) ? "(existe)" : "(NÃO existe)");
console.log("  agentProjectDir   :", config.agentProjectDir, fs.existsSync(config.agentProjectDir) ? "(ok)" : "(NÃO existe)");
console.log("  agentFile         :", config.agentFile, fs.existsSync(config.agentFile) ? "(ok)" : "(NÃO existe)");
console.log("  knowledgeDir      :", config.knowledgeDir, fs.existsSync(config.knowledgeDir) ? "(ok)" : "(NÃO existe)");
console.log("  mcpConfigFile     :", config.claude.mcpConfigFile);
console.log("  permissionMode    :", config.claude.permissionMode);
console.log("  model             :", config.claude.model || "(padrão)");

console.log("\nTestando 'claude --version'...");
const r = spawnSync(config.claude.bin, ["--version"], { encoding: "utf-8", windowsHide: true });
if (r.error) {
  console.error("  ERRO:", r.error.message);
  process.exit(1);
}
console.log("  ", (r.stdout || r.stderr || "").trim());
console.log("\nOK.");

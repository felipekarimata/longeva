import { spawn } from "child_process";
import fs from "fs";
import config from "../config.js";
import { getClaudeEnv } from "./claude-auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Lê o corpo do agente longeva-advisor (remove o frontmatter YAML) para usar
// como instrução de papel no prompt do claude headless.
// ─────────────────────────────────────────────────────────────────────────────
function readAgentBody() {
  try {
    let md = fs.readFileSync(config.agentFile, "utf-8");
    // Remove um ou dois blocos de frontmatter/separadores "---" no topo.
    md = md.replace(/^﻿/, "");
    const fmMatch = md.match(/^---\s*[\s\S]*?\n---\s*\n/);
    if (fmMatch) md = md.slice(fmMatch[0].length);
    return md.trim();
  } catch (e) {
    return "";
  }
}

// ── Monta o prompt completo enviado via stdin ao claude ──────────────────────
export function buildPrompt({ demand, clientContext, resume }) {
  // Turno de continuação: o agente e a demanda original já estão na sessão
  // retomada; enviamos apenas a resposta/instrução do assessor.
  if (resume) return demand;

  const agentBody = readAgentBody();
  const parts = [];
  if (agentBody) {
    parts.push(
      "Você atuará AGORA, diretamente, como o agente descrito abaixo. Siga rigorosamente estas instruções e a base de conhecimento da Longeva. Use as ferramentas MCP e do sistema conforme necessário para concluir a demanda de ponta a ponta."
    );
    parts.push("\n===== DEFINIÇÃO DO AGENTE longeva-advisor =====\n");
    parts.push(agentBody);
    parts.push("\n===== FIM DA DEFINIÇÃO DO AGENTE =====\n");
  }
  if (clientContext) {
    parts.push(`\n## CONTEXTO SELECIONADO PELO ASSESSOR\n${clientContext}\n`);
  }
  parts.push("\n# DEMANDA DO ASSESSOR (execute agora)\n");
  parts.push(demand);
  return parts.join("\n");
}

// ── Resumo compacto do input de uma ferramenta (para exibir no painel) ───────
function summarizeToolInput(name, input) {
  if (input == null) return "";
  try {
    if (typeof input === "string") return truncate(input, 300);
    if (input.command) return truncate(String(input.command), 300);
    if (input.file_path) return String(input.file_path);
    if (input.nome_arquivo) return String(input.nome_arquivo);
    if (input.contas) return `contas: ${input.contas}`;
    if (input.query) return `query: ${input.query}`;
    const s = JSON.stringify(input);
    return truncate(s, 300);
  } catch {
    return "";
  }
}

function extractResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Executa uma tarefa. `onEvent(evt)` recebe eventos em tempo real.
// Retorna uma Promise com o resumo final da execução.
// ─────────────────────────────────────────────────────────────────────────────
export function runTask({ demand, clientContext, resumeSessionId, onEvent, signal }) {
  return new Promise((resolve) => {
    const fullPrompt = buildPrompt({ demand, clientContext, resume: !!resumeSessionId });

    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      config.claude.mcpConfigFile,
      "--strict-mcp-config",
      "--add-dir",
      config.knowledgeDir,
    ];
    if (config.claude.permissionMode === "dangerously-skip-permissions") {
      args.push("--dangerously-skip-permissions");
    } else {
      args.push("--permission-mode", config.claude.permissionMode);
    }
    if (config.claude.model) args.push("--model", config.claude.model);
    if (resumeSessionId) args.push("--resume", resumeSessionId);

    const started = Date.now();
    const collected = {
      resultText: "",
      lastAssistantText: "",
      events: [],
      cost: null,
      durationMs: null,
      numTurns: null,
      isError: false,
      sessionId: null,
      stderr: "",
      timedOut: false,
    };

    const emit = (evt) => {
      collected.events.push(evt);
      try {
        onEvent && onEvent(evt);
      } catch {
        /* ignore consumer errors */
      }
    };

    let child;
    try {
      child = spawn(config.claude.bin, args, {
        cwd: config.agentProjectDir,
        env: getClaudeEnv({ FORCE_COLOR: "0" }),
        windowsHide: true,
      });
    } catch (e) {
      emit({ kind: "error", text: `Falha ao iniciar o Claude: ${e.message}` });
      return resolve({ ...collected, isError: true });
    }

    // Timeout de segurança.
    const timeout = setTimeout(() => {
      collected.timedOut = true;
      emit({ kind: "error", text: "Tempo limite da execução atingido. Processo encerrado." });
      try {
        child.kill("SIGTERM");
      } catch {}
    }, config.claude.timeoutMs);

    // Cancelamento pelo cliente.
    const onAbort = () => {
      emit({ kind: "error", text: "Execução cancelada pelo usuário." });
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (e) => {
      const help =
        e.code === "ENOENT"
          ? " — executável do Claude não encontrado. Defina CLAUDE_BIN no .env."
          : "";
      emit({ kind: "error", text: `Erro ao executar o Claude: ${e.message}${help}` });
      collected.isError = true;
    });

    // ── stdin: envia o prompt ──────────────────────────────────────────────
    try {
      child.stdin.write(fullPrompt, "utf-8");
      child.stdin.end();
    } catch (e) {
      emit({ kind: "error", text: `Erro ao enviar o prompt: ${e.message}` });
    }

    // ── stdout: stream-json linha a linha ──────────────────────────────────
    let buf = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(line);
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      collected.stderr += chunk;
    });

    function handleLine(line) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // linha não-JSON (log); ignora
      }

      switch (obj.type) {
        case "system":
          if (obj.subtype === "init") {
            collected.sessionId = obj.session_id || null;
            emit({ kind: "session", sessionId: collected.sessionId });
            emit({
              kind: "status",
              text: resumeSessionId ? "Sessão retomada." : "Sessão do agente iniciada.",
            });
          }
          break;

        case "assistant": {
          const blocks = obj.message?.content || [];
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              collected.lastAssistantText = b.text;
              emit({ kind: "assistant_text", text: b.text });
            } else if (b.type === "tool_use") {
              emit({
                kind: "tool_use",
                name: b.name,
                detail: summarizeToolInput(b.name, b.input),
              });
            }
          }
          break;
        }

        case "user": {
          const blocks = obj.message?.content || [];
          for (const b of blocks) {
            if (b.type === "tool_result") {
              const text = extractResultText(b.content);
              emit({
                kind: "tool_result",
                text: truncate(text, 600),
                isError: !!b.is_error,
              });
            }
          }
          break;
        }

        case "result": {
          if (obj.session_id) collected.sessionId = obj.session_id;
          collected.resultText = obj.result || collected.lastAssistantText || "";
          collected.isError = collected.isError || !!obj.is_error || obj.subtype !== "success";
          collected.cost = obj.total_cost_usd ?? null;
          collected.durationMs = obj.duration_ms ?? Date.now() - started;
          collected.numTurns = obj.num_turns ?? null;
          emit({
            kind: "result",
            text: collected.resultText,
            isError: collected.isError,
            cost: collected.cost,
            durationMs: collected.durationMs,
            numTurns: collected.numTurns,
            sessionId: collected.sessionId,
          });
          break;
        }
        default:
          break;
      }
    }

    // ── Encerramento ───────────────────────────────────────────────────────
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener?.("abort", onAbort);

      if (!collected.resultText && collected.lastAssistantText) {
        collected.resultText = collected.lastAssistantText;
      }
      if (collected.durationMs == null) collected.durationMs = Date.now() - started;

      if (code !== 0 && !collected.resultText && !collected.timedOut) {
        collected.isError = true;
        const tail = collected.stderr.trim().split("\n").slice(-8).join("\n");
        emit({
          kind: "error",
          text: `O Claude encerrou com código ${code}.${tail ? "\n" + tail : ""}`,
        });
      }

      emit({ kind: "done", code, isError: collected.isError });
      resolve(collected);
    });
  });
}

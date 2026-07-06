import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import config from "../config.js";

const CALL_TIMEOUT_MS = 20_000;

async function callTool(name, args = {}) {
  const env = { ...process.env };
  delete env.COMPOSIO_API_KEY;
  delete env.COMPOSIO_ENTITY_ID;
  if (config.composio.apiKey) env.COMPOSIO_API_KEY = config.composio.apiKey;
  if (config.composio.entityId) env.COMPOSIO_ENTITY_ID = config.composio.entityId;

  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(config.agentProjectDir, "index.js")],
    cwd: config.agentProjectDir,
    env,
  });

  const client = new Client({ name: "longeva-web", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);

    const result = await Promise.race([
      client.callTool({ name, arguments: args }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout ao consultar o Google Drive.")), CALL_TIMEOUT_MS)
      ),
    ]);

    const text = result?.content?.[0]?.text ?? "";
    return { text, isError: !!result?.isError };
  } finally {
    try { await client.close(); } catch {}
    try { transport.close(); } catch {}
  }
}

// ── Cache simples para a lista de clientes ───────────────────────────────────
let clientsCache = { at: 0, data: null };
const CACHE_MS = 5 * 60 * 1000;

export async function listClients({ force = false } = {}) {
  if (!config.composio.apiKey) {
    return { error: "Chave Composio não configurada.", clients: [], needsSetup: true };
  }

  if (!force && clientsCache.data && Date.now() - clientsCache.at < CACHE_MS) {
    return clientsCache.data;
  }

  let text, isError;
  try {
    ({ text, isError } = await callTool("listar_clientes", {}));
  } catch (e) {
    return { error: e.message || "Falha ao conectar ao Google Drive.", clients: [] };
  }

  if (isError) {
    return { error: text || "Não foi possível listar clientes.", clients: [] };
  }

  let parsed = [];
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "Resposta inesperada ao listar clientes.", clients: [] };
  }

  const clients = (Array.isArray(parsed) ? parsed : [])
    .filter((f) => (!f.type || f.type.includes("folder")))
    .map((f) => ({ id: f.id, name: f.name, modified: f.modified }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "pt-BR"));

  const data = { clients };
  clientsCache = { at: Date.now(), data };
  return data;
}

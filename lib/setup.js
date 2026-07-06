import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "../config.js";

const COMPOSIO_FILE = path.join(config.dataDir, "composio.json");

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(COMPOSIO_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function getSetupStatus() {
  return {
    composio: {
      hasApiKey: !!config.composio.apiKey,
      hasEntityId: !!config.composio.entityId,
    },
    claude: {
      hasBin: fs.existsSync(config.claude.bin),
    },
    needsOnboarding: !config.composio.apiKey,
  };
}

export function saveComposioKey(apiKey) {
  const trimmed = (apiKey || "").trim();
  if (!trimmed) return { ok: false, error: "A chave de API é obrigatória." };

  let entityId = config.composio.entityId || crypto.randomUUID();

  fs.writeFileSync(COMPOSIO_FILE, JSON.stringify({ apiKey: trimmed, entityId }, null, 2), "utf-8");

  config.composio.apiKey = trimmed;
  config.composio.entityId = entityId;
  process.env.COMPOSIO_API_KEY = trimmed;
  process.env.COMPOSIO_ENTITY_ID = entityId;

  rewriteMcpConfig();
  return { ok: true, entityId };
}

function rewriteMcpConfig() {
  const mcpEnv = {};
  if (config.composio.apiKey) mcpEnv.COMPOSIO_API_KEY = config.composio.apiKey;
  if (config.composio.entityId) mcpEnv.COMPOSIO_ENTITY_ID = config.composio.entityId;

  const cfg = {
    mcpServers: {
      "longeva-advisor": {
        type: "stdio",
        command: "node",
        args: [path.join(config.agentProjectDir, "index.js")],
        env: mcpEnv,
      },
    },
  };
  fs.writeFileSync(config.claude.mcpConfigFile, JSON.stringify(cfg, null, 2), "utf-8");
}

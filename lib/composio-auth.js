import { Composio } from "@composio/core";
import config from "../config.js";

let pendingConnection = null;

function extractComposioError(e) {
  const raw = e.message || String(e);
  try {
    const match = raw.match(/\{.*\}/s);
    if (match) {
      const obj = JSON.parse(match[0]);
      const inner = obj?.error?.message || obj?.message;
      if (inner) return inner;
    }
  } catch {}
  return raw;
}

export function getComposioStatus() {
  const { apiKey, entityId } = config.composio;
  return {
    configured: !!(apiKey && entityId),
    hasApiKey: !!apiKey,
    hasEntityId: !!entityId,
  };
}

export async function startGoogleDriveAuth() {
  const { apiKey, entityId } = config.composio;
  if (!apiKey) {
    return { ok: false, error: "COMPOSIO_API_KEY não configurada. Defina no .env ou .env.docker." };
  }
  if (!entityId) {
    return { ok: false, error: "COMPOSIO_ENTITY_ID não configurado. Defina no .env ou .env.docker." };
  }

  try {
    const composio = new Composio({ apiKey });
    const session = await composio.create(entityId);
    const connectionRequest = await session.authorize("googledrive");

    if (!connectionRequest.redirectUrl) {
      return { ok: false, error: "O Composio não retornou uma URL de autorização." };
    }

    pendingConnection = connectionRequest;

    return { ok: true, url: connectionRequest.redirectUrl };
  } catch (e) {
    const msg = extractComposioError(e);
    return { ok: false, error: msg };
  }
}

export async function checkGoogleDriveConnection() {
  if (!pendingConnection) {
    return { ok: false, connected: false, error: "Nenhuma vinculação em andamento." };
  }
  try {
    await pendingConnection.waitForConnection(5000);
    pendingConnection = null;
    return { ok: true, connected: true, message: "Google Drive vinculado com sucesso!" };
  } catch {
    return { ok: true, connected: false, message: "Aguardando autorização…" };
  }
}

export async function testGoogleDriveConnection() {
  const { apiKey, entityId } = config.composio;
  if (!apiKey || !entityId) {
    return { ok: false, connected: false };
  }
  try {
    const composio = new Composio({ apiKey });
    const entity = await composio.create(entityId);
    const connection = await entity.getConnection("googledrive");
    return { ok: true, connected: !!connection };
  } catch {
    return { ok: true, connected: false };
  }
}

import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import os from "os";
import fs from "fs";

if (!globalThis.crypto) {
  globalThis.crypto = crypto;
}
if (!globalThis.crypto.randomUUID) {
  globalThis.crypto.randomUUID = crypto.randomUUID;
}

// Determinar o diretório seguro de instalação
const installDestDir = path.join(os.homedir(), ".longeva-advisor");
const globalEnvPath = path.join(installDestDir, ".env");
const localEnvPath = path.join(process.cwd(), ".env");

if (fs.existsSync(globalEnvPath)) {
  dotenv.config({ path: globalEnvPath });
} else if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else {
  dotenv.config();
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Composio } from "@composio/core";
import { createServer } from "./server.js";

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const COMPOSIO_ENTITY_ID = process.env.COMPOSIO_ENTITY_ID || "default";

// Se empacotado (process.pkg está definido), usa a pasta de instalação global.
// Se em desenvolvimento local, usa o cwd.
const isDev = process.env.NODE_ENV === "development" || !process.pkg;
const baseDir = isDev ? process.cwd() : installDestDir;

const downloadsDir = path.join(baseDir, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const outputsDir = path.join(baseDir, "outputs");
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

async function main() {
  let session = null;

  async function getSession() {
    if (!session) {
      session = await composio.create(COMPOSIO_ENTITY_ID, { toolkits: ["googledrive"] });
    }
    return session;
  }

  async function executeAction(actionName, params) {
    try {
      return await (await getSession()).execute(actionName, params);
    } catch (e) {
      const isAuthError =
        e.message &&
        (e.message.includes("No active connection") ||
          e.message.includes("unauthorized") ||
          e.message.includes("reauth"));
      if (isAuthError) {
        session = null;
      }
      throw e;
    }
  }

  const server = createServer(executeAction, { downloadsDir, outputsDir, composio });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server for Google Drive (longeva-advisor) started.");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});



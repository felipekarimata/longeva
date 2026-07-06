import fs from "fs";
import path from "path";
import crypto from "crypto";
import config from "../config.js";

export function newRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}_${crypto.randomBytes(3).toString("hex")}`;
}

function safeId(id) {
  // Impede path traversal: mantém apenas caracteres seguros.
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "");
}

function fileFor(id) {
  return path.join(config.historyDir, `${safeId(id)}.json`);
}

function titleFrom(demand) {
  const clean = String(demand || "").replace(/\s+/g, " ").trim();
  return clean.length > 90 ? clean.slice(0, 90) + "…" : clean || "(sem descrição)";
}

export function saveRun(run) {
  const record = {
    id: run.id,
    createdAt: run.createdAt || new Date().toISOString(),
    title: titleFrom(run.demand),
    demand: run.demand,
    client: run.client || null,
    sessionId: run.summary?.sessionId || null,
    resumeOf: run.resumeSessionId || null,
    resultText: run.summary?.resultText || "",
    isError: !!run.summary?.isError,
    cost: run.summary?.cost ?? null,
    durationMs: run.summary?.durationMs ?? null,
    numTurns: run.summary?.numTurns ?? null,
    events: run.summary?.events || [],
  };
  fs.writeFileSync(fileFor(run.id), JSON.stringify(record, null, 2), "utf-8");
  return record;
}

export function listRuns(limit = 100) {
  let files = [];
  try {
    files = fs.readdirSync(config.historyDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const items = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(config.historyDir, f), "utf-8"));
      items.push({
        id: r.id,
        createdAt: r.createdAt,
        title: r.title,
        client: r.client,
        isError: r.isError,
        cost: r.cost,
        durationMs: r.durationMs,
      });
    } catch {
      /* ignora arquivo corrompido */
    }
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return items.slice(0, limit);
}

export function getRun(id) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), "utf-8"));
  } catch {
    return null;
  }
}

export function deleteRun(id) {
  try {
    fs.unlinkSync(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

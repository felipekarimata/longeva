import fs from "fs";
import path from "path";
import config from "../config.js";

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
};

const SKIP_PATTERNS = [
  /^temp_upload_/,
  /\.b64$/i,
  /^\./, // hidden files
];

function isDeliverable(name) {
  return !SKIP_PATTERNS.some((p) => p.test(name));
}

function scanDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function listDeliverables() {
  const seen = new Set();
  const results = [];

  for (const dir of [config.outputsDir, config.downloadsDir]) {
    for (const e of scanDir(dir)) {
      if (!e.isFile() || !isDeliverable(e.name) || seen.has(e.name)) continue;
      seen.add(e.name);
      const full = path.join(dir, e.name);
      let st = {};
      try {
        st = fs.statSync(full);
      } catch {}
      results.push({
        name: e.name,
        size: st.size ?? 0,
        modified: st.mtime ? st.mtime.toISOString() : null,
        ext: path.extname(e.name).toLowerCase().replace(".", ""),
        dir,
      });
    }
  }

  return results.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
}

export function resolveDeliverable(name) {
  const base = path.basename(String(name));

  for (const dir of [config.outputsDir, config.downloadsDir]) {
    const full = path.join(dir, base);
    const rel = path.relative(dir, full);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const ext = path.extname(base).toLowerCase();
    return { path: full, name: base, contentType: CONTENT_TYPES[ext] || "application/octet-stream" };
  }

  return null;
}

import crypto from "crypto";
import fs from "fs";
import config from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Hash de senha com scrypt (formato "salt:hash", ambos em hex).
// ─────────────────────────────────────────────────────────────────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const derived = crypto.scryptSync(String(password), salt, expected.length);
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessão em cookie assinado (HMAC-SHA256). Sem estado no servidor.
// Payload: { u: usuário, exp: epoch ms }.
// ─────────────────────────────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(data) {
  return crypto
    .createHmac("sha256", config.auth.sessionSecret || "insecure-dev-secret")
    .update(data)
    .digest("base64url");
}

export function createSessionToken(user) {
  const payload = { u: user, exp: Date.now() + config.auth.sessionHours * 3600 * 1000 };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expected = sign(body);
  // Comparação em tempo constante.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Parsing simples de cookies (evita dependência externa) ───────────────────
export function parseCookies(header = "") {
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

export const SESSION_COOKIE = "longeva_sess";

// ── Middleware de proteção ───────────────────────────────────────────────────
export function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySessionToken(cookies[SESSION_COOKIE]);
  if (!session || session.u !== config.auth.user) {
    // originalUrl preserva o prefixo /api mesmo dentro de um Router montado,
    // garantindo 401 JSON para chamadas de API e redirect só para páginas.
    if ((req.originalUrl || req.path).startsWith("/api/")) {
      return res.status(401).json({ error: "Não autenticado" });
    }
    return res.redirect("/login.html");
  }
  req.session = session;
  next();
}

// ── Verifica credenciais de login ────────────────────────────────────────────
export function checkLogin(user, password) {
  const userOk = user === config.auth.user;
  const passOk = verifyPassword(password, config.auth.passwordHash);
  return userOk && passOk;
}

// ── Troca de senha (persiste em data/password-hash.txt) ─────────────────────
export function changePassword(currentPassword, newPassword) {
  if (!verifyPassword(currentPassword, config.auth.passwordHash)) {
    return { ok: false, error: "Senha atual incorreta." };
  }
  if (!newPassword || newPassword.length < 6) {
    return { ok: false, error: "A nova senha deve ter pelo menos 6 caracteres." };
  }
  const hash = hashPassword(newPassword);
  fs.writeFileSync(config.passwordHashFile, hash, "utf-8");
  config.auth.passwordHash = hash;
  return { ok: true };
}

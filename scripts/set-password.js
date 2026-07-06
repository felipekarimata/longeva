// Gera o hash da senha (scrypt) e grava AUTH_PASSWORD_HASH no .env.
// Uso:  node scripts/set-password.js "minha-senha-forte"
//   ou:  npm run set-password -- "minha-senha-forte"
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { hashPassword } from "../lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env");

function writeEnv(hash) {
  let content = "";
  if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, "utf-8");
  else if (fs.existsSync(envPath + ".example"))
    content = fs.readFileSync(envPath + ".example", "utf-8");

  const line = `AUTH_PASSWORD_HASH=${hash}`;
  if (/^AUTH_PASSWORD_HASH=.*$/m.test(content)) {
    content = content.replace(/^AUTH_PASSWORD_HASH=.*$/m, line);
  } else {
    content += (content.endsWith("\n") || content === "" ? "" : "\n") + line + "\n";
  }
  fs.writeFileSync(envPath, content, "utf-8");
}

function finish(password) {
  if (!password || password.length < 4) {
    console.error("Senha muito curta. Use pelo menos 4 caracteres.");
    process.exit(1);
  }
  const hash = hashPassword(password);
  writeEnv(hash);
  console.log("\n✔ Senha configurada e gravada em .env (AUTH_PASSWORD_HASH).");
  console.log("  Linha gerada:\n  AUTH_PASSWORD_HASH=" + hash + "\n");
  process.exit(0);
}

const arg = process.argv[2];
if (arg) {
  finish(arg);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Digite a nova senha: ", (answer) => {
    rl.close();
    finish((answer || "").trim());
  });
}

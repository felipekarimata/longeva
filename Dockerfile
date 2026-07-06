# Longeva Advisor Web — imagem com o Claude Code CLI embutido.
# Use:  npm run deploy  (faz bundle + build + up automaticamente)
FROM node:22-bookworm-slim

# glibc já vem na imagem; só precisamos de certificados para HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (cria o executável em /usr/local/bin/claude).
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# 1) Dependências do web app (camada cacheável).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 2) Dependências do projeto MCP longeva-advisor (camada cacheável).
COPY vendor/longeva-advisor/package.json vendor/longeva-advisor/package-lock.json ./vendor/longeva-advisor/
RUN cd vendor/longeva-advisor && npm ci --omit=dev

# 3) Restante do código + bundle (vendor/).
COPY . .

# Diretórios graváveis + permissões para o usuário não-root "node".
RUN mkdir -p data \
      vendor/longeva-advisor/downloads vendor/longeva-advisor/outputs \
      /home/node/.claude \
  && chown -R node:node /app /home/node/.claude

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    AGENT_PROJECT_DIR=/app/vendor/longeva-advisor \
    AGENT_FILE=/app/vendor/agents/longeva-advisor.md \
    KNOWLEDGE_DIR=/app/vendor/knowledge \
    CLAUDE_BIN=/usr/local/bin/claude \
    CLAUDE_PERMISSION_MODE=bypassPermissions

EXPOSE 8787
CMD ["node", "server.js"]

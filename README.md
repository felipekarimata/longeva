# Longeva Advisor Web

Interface web (frontend + backend) para acionar o **Claude Code** com o agente
**longeva-advisor** a partir do navegador, atendendo às demandas do assessor de
investimentos.

O assessor descreve uma demanda (ex.: "analisar o extrato XPerformance da conta
2811645 e gerar o relatório de risco de crédito"), e o backend executa o `claude`
em modo headless **como o agente longeva-advisor** — com acesso às ferramentas MCP
do Google Drive, à base de conhecimento da Longeva e à geração de entregáveis
(.docx/.pptx) — transmitindo o progresso em tempo real para a tela.

---

## Como funciona

```
Navegador (login + demanda)
        │  POST /api/run  (streaming SSE)
        ▼
server.js (Express, auth por sessão)
        │  spawn: claude.exe -p --output-format stream-json
        ▼
Claude Code headless  ──►  MCP longeva-advisor (Google Drive, extratos, upload)
   (system prompt =        base de conhecimento (~/.claude/knowledge/longeva)
    agente longeva-advisor) entregáveis salvos em <projeto>/outputs
```

- **Tarefa única:** cada demanda é uma execução independente, salva no histórico.
- **Painel de clientes:** lista as pastas de clientes do Drive (`listar_clientes`).
- **Entregáveis:** lista e baixa os arquivos gerados em `outputs/`.
- **Histórico:** todas as execuções ficam registradas e podem ser reabertas.

---

## Pré-requisitos

Na máquina/servidor que roda este app é preciso ter:

1. **Node.js 18+** (testado com v22).
2. **Claude Code CLI** instalado e **autenticado** (`claude` deve funcionar no
   terminal — o app reutiliza a sua sessão/assinatura).
3. O **projeto do agente** `longeva-advisor` presente (por padrão em
   `C:\Users\User\longeva-advisor`), com `index.js`, `downloads/`, `outputs/` e as
   credenciais Composio configuradas.
4. O **arquivo do agente** em `C:\Users\User\.claude\agents\longeva-advisor.md` e a
   **base de conhecimento** em `C:\Users\User\.claude\knowledge\longeva\`.

> ⚠️ Este app **não** roda em hospedagem serverless comum: ele precisa de uma
> máquina real com o Claude Code instalado e logado. Para expor na web, rode-o
> numa VM/servidor e coloque atrás de um proxy HTTPS (nginx, Caddy, Cloudflare
> Tunnel). Nunca exponha sem HTTPS + senha forte — o app lida com dados
> financeiros sensíveis.

---

## Instalação

```bash
cd longeva-advisor-web
npm install
cp .env.example .env        # no Windows/PowerShell: copy .env.example .env
npm run set-password -- "sua-senha-forte"   # grava AUTH_PASSWORD_HASH no .env
```

Depois, edite o `.env` e defina ao menos:

- `AUTH_USER` — nome de usuário do login.
- `SESSION_SECRET` — string longa e aleatória
  (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
- Confirme `AGENT_PROJECT_DIR`, `AGENT_FILE` e `KNOWLEDGE_DIR`.

Verifique se o Claude está acessível ao app:

```bash
npm run check      # mostra a config resolvida e testa "claude --version"
```

---

## Uso

```bash
npm start
```

Acesse `http://127.0.0.1:8787`, faça login e comece a enviar demandas.

- **Ctrl/Cmd + Enter** no campo de texto executa a demanda.
- Selecione um cliente no painel lateral (opcional) para dar contexto.
- Acompanhe as chamadas de ferramentas e o resultado final em tempo real.
- Baixe os entregáveis gerados na aba **Entregáveis**.

---

## Interatividade (responder ao agente)

O agente longeva-advisor é feito para **parar e pedir validação** quando encontra
uma inconsistência ou dúvida. Quando isso acontece, a execução termina mostrando a
pergunta e aparece uma **caixa de resposta** abaixo do resultado. Digite a resposta
e clique em **Responder e continuar** — o backend retoma a mesma sessão do Claude
(`--resume`), preservando todo o contexto. É possível continuar quantas vezes
precisar, e também retomar uma conversa a partir do **Histórico**.

## Deploy com Docker

A forma mais simples de subir o **pacote completo** (web app + projeto MCP + base
de conhecimento + agente + Claude CLI) num servidor.

**Pré-requisitos:** Docker + Docker Compose. Rode na máquina que tem os arquivos
originais (agente, base de conhecimento e o projeto `longeva-advisor`).

```bash
# 1) Defina a senha do site
npm run set-password -- "sua-senha-forte"

# 2) Um único comando faz tudo: bundle → build → up
npm run deploy
#   Na primeira vez, cria .env.docker e pede para preencher as credenciais.
#   Edite .env.docker (AUTH_PASSWORD_HASH, CLAUDE_API_KEY, COMPOSIO_*)
#   e rode de novo:
npm run deploy

# Acesse http://SEU_SERVIDOR:8787
```

- **Login do Claude no container:** use **API key** (sem OAuth interativo) —
  `CLAUDE_AUTH_MODE=api` + `CLAUDE_API_KEY`. Alternativa: replicar um gateway com
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` e `CLAUDE_AUTH_MODE=inherit`. O
  botão **Testar credencial** valida.
- **Volumes:** `app-data` (histórico/config), `app-outputs`/`app-downloads`
  (entregáveis/arquivos), `claude-home` (sessões do Claude — necessário para o
  "Responder e continuar" sobreviver a reinícios).
- **HTTPS:** coloque atrás de um proxy (Caddy/nginx/Cloudflare Tunnel) e defina
  `COOKIE_SECURE=true`. Dados financeiros: nunca exponha sem HTTPS + senha forte.
- **Atualizar** agente/base: rode `npm run deploy` de novo (refaz bundle + rebuild).

## Login do Claude (Gateway / API key / Assinatura)

O agente é executado pelo `claude`, e você escolhe **qual credencial** ele usa —
pela interface (botão **⚙ Login do Claude** na barra superior) ou pelo `.env`:

| Modo | O que faz | Requisito |
|---|---|---|
| **Gateway atual** (`inherit`) | Usa o ambiente do servidor como está (padrão). | — |
| **API key** (`api`) | Injeta `ANTHROPIC_API_KEY` e remove o token/base URL do gateway. | Uma API key da Anthropic. |
| **Assinatura** (`subscription`) | Remove as vars de API/token; o `claude` cai no login OAuth do host. | Ter feito `claude` → `/login` no servidor uma vez. |

- A escolha é aplicada **por execução** e fica salva em `data/claude-auth.json`
  (fora do git). A API key nunca é devolvida ao navegador — só uma versão mascarada.
- O botão **Testar credencial** roda um `claude` mínimo e diz se a credencial funciona.
- **Atenção ao modelo:** no modo `api`/`subscription`, o `CLAUDE_MODEL` precisa ser
  um modelo que a sua credencial suporta. Se o teste falhar por modelo, ajuste
  `CLAUDE_MODEL` no `.env`.
- O login **OAuth de assinatura** não é feito por esta tela (é interativo): rode
  `claude` no terminal do host uma vez; depois a UI apenas alterna para esse modo.

## Configuração (.env)

| Variável | Descrição | Padrão |
|---|---|---|
| `PORT` / `HOST` | Porta e interface de escuta | `8787` / `127.0.0.1` |
| `AUTH_USER` | Usuário do login | `admin` |
| `AUTH_PASSWORD_HASH` | Hash scrypt da senha (use `npm run set-password`) | — |
| `SESSION_SECRET` | Segredo para assinar o cookie de sessão | — |
| `SESSION_HOURS` | Duração da sessão | `12` |
| `COOKIE_SECURE` | `true` quando atrás de HTTPS | `false` |
| `AGENT_PROJECT_DIR` | Pasta do projeto MCP longeva-advisor | `../longeva-advisor` |
| `AGENT_FILE` | Arquivo de definição do agente | `~/.claude/agents/longeva-advisor.md` |
| `KNOWLEDGE_DIR` | Base de conhecimento liberada ao Claude | `~/.claude/knowledge` |
| `CLAUDE_BIN` | Caminho do executável do Claude (auto se vazio) | auto |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` (automação) ou `acceptEdits` | `bypassPermissions` |
| `CLAUDE_MODEL` | Modelo (ex.: `claude-opus-4-8`); vazio = padrão | — |
| `CLAUDE_AUTH_MODE` | Modo de login inicial: `inherit`/`api`/`subscription` (a UI sobrepõe) | `inherit` |
| `CLAUDE_API_KEY` | API key inicial para o modo `api` (a UI sobrepõe) | — |
| `RUN_TIMEOUT_MIN` | Timeout por execução (min) | `20` |
| `COMPOSIO_API_KEY` / `COMPOSIO_ENTITY_ID` | Credenciais Composio (opcional; senão o `index.js` carrega) | — |

---

## Segurança

- **Autenticação obrigatória** (monousuário) em todas as rotas de API e páginas.
- Senha armazenada como **hash scrypt**; sessão em **cookie HttpOnly assinado (HMAC)**.
- Rate limit simples de login por IP.
- O `claude` roda com `bypassPermissions` para executar o fluxo de ponta a ponta
  sem interação. Isso é adequado a uma ferramenta interna confiável, mas mantenha
  o acesso restrito (HTTPS + senha forte + rede controlada).
- Os downloads de entregáveis são restritos à pasta `outputs/` (sem path traversal).

---

## Estrutura

```
longeva-advisor-web/
├─ server.js              Express: auth, SSE, clientes, entregáveis, histórico
├─ config.js              Configuração e resolução de caminhos/executável
├─ lib/
│  ├─ auth.js             Hash de senha + sessão assinada + middleware
│  ├─ claude-runner.js    Spawn do claude headless + parse do stream-json
│  ├─ mcp-client.js       Chama o MCP longeva-advisor (lista de clientes)
│  ├─ deliverables.js     Lista/baixa arquivos de outputs/
│  └─ history.js          Persiste e lê execuções
├─ public/
│  ├─ login.html          Tela de login
│  ├─ index.html          App principal
│  ├─ styles.css          Tema Longeva
│  └─ app.js              Frontend (streaming, painéis, markdown)
├─ scripts/
│  ├─ set-password.js     Gera e grava o hash da senha
│  └─ check-claude.js     Diagnóstico da integração com o Claude
└─ data/                  Histórico e config MCP (gerado; fora do git)
```

---

## Solução de problemas

- **"Executável do Claude não encontrado"** → defina `CLAUDE_BIN` no `.env` com o
  caminho do `claude.exe` (ex.:
  `C:\Users\User\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`).
- **Login diz "Senha não configurada"** → rode `npm run set-password -- "senha"`.
- **Lista de clientes vazia / erro de autorização** → o MCP precisa da conexão do
  Google Drive (Composio). Rode o projeto `longeva-advisor` uma vez e vincule a conta.
- **A execução não usa as ferramentas** → confira `npm run check`; o `index.js` do
  projeto e as credenciais Composio precisam estar acessíveis.

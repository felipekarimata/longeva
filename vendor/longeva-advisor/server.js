import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";

// ──────────────────────────────────────────────────────────────────────────────
// Utilitário: filtra a resposta bruta da API do Drive para apenas os campos
// necessários ao Claude, reduzindo drasticamente o consumo de tokens.
// ──────────────────────────────────────────────────────────────────────────────
export function resumirArquivos(res) {
  const files =
    res?.data?.response_data?.files ||
    res?.data?.files ||
    res?.response_data?.files ||
    res?.files ||
    [];
  if (files.length === 0) {
    const keys = Object.keys(res ?? {});
    const dataKeys = Object.keys(res?.data ?? {});
    console.error(`[resumirArquivos] 0 files. res keys=${JSON.stringify(keys)} data keys=${JSON.stringify(dataKeys)}`);
  }
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.mimeType?.split("/").pop() || "desconhecido",
    parents: f.parents,
    modified: f.modifiedTime?.substring(0, 10),
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Fábrica do servidor MCP. Recebe a função executeAction como parâmetro para
// permitir injeção de mocks nos testes sem precisar de credenciais reais.
//
// @param {Function} executeAction  async (actionName, params) => response
// @param {Object}   opts
// @param {string}   opts.downloadsDir  Caminho absoluto para downloads locais
// @param {string}   opts.outputsDir    Caminho absoluto para cópias locais
// @param {Object}   opts.composio      Instância real do Composio (para upload)
// ──────────────────────────────────────────────────────────────────────────────
export function createServer(executeAction, { downloadsDir, outputsDir, composio } = {}) {
  const server = new Server(
    { name: "longeva-google-drive-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ── Lista de tools ──────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "listar_clientes",
        description: "Lista pastas de clientes XPerformance disponíveis no Drive",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "obter_extrato_cliente",
        description: "Busca extratos XPerformance de uma ou mais contas de clientes",
        inputSchema: {
          type: "object",
          properties: {
            contas: {
              type: "string",
              description: "Conta(s) separadas por '_' (ex: 2811645 ou 2811645_2824175)",
            },
          },
          required: ["contas"],
        },
      },
      {
        name: "buscar_dados_fundo",
        description: "Busca lâminas de fundos na pasta Longeva > Fundos e Previdência",
        inputSchema: {
          type: "object",
          properties: {
            nome_fundo: { type: "string", description: "Nome ou termo do fundo" },
          },
          required: ["nome_fundo"],
        },
      },
      {
        name: "buscar_credito_emissor",
        description: "Busca relatórios de crédito/ratings na pasta Longeva > Renda Fixa",
        inputSchema: {
          type: "object",
          properties: {
            nome_emissor: { type: "string", description: "Nome do emissor de crédito privado" },
          },
          required: ["nome_emissor"],
        },
      },
      {
        name: "buscar_tese_renda_variavel",
        description: "Busca relatórios de ações e FIIs na pasta Longeva > Renda Variável",
        inputSchema: {
          type: "object",
          properties: {
            nome_ativo: { type: "string", description: "Nome ou ticker do ativo" },
          },
          required: ["nome_ativo"],
        },
      },
      {
        name: "obter_diretrizes_alocacao",
        description: "Busca visões de alocação mensal recomendada (Brasil ou Global)",
        inputSchema: {
          type: "object",
          properties: {
            tipo: {
              type: "string",
              enum: ["Brasil", "Global"],
              description: "Região da alocação",
            },
          },
          required: ["tipo"],
        },
      },
      {
        name: "buscar_documentos_gerais",
        description: "Busca documentos gerais e modelos na pasta Longeva > Geral",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Termo de busca" },
          },
          required: ["query"],
        },
      },
      {
        name: "baixar_arquivo_drive",
        description: "Faz download de um arquivo do Google Drive para o sistema local",
        inputSchema: {
          type: "object",
          properties: {
            file_id: { type: "string", description: "ID do arquivo no Google Drive" },
            nome_arquivo: { type: "string", description: "Nome local opcional para o arquivo" },
          },
          required: ["file_id"],
        },
      },
      {
        name: "salvar_documento_drive",
        description: "Faz upload de um documento para a pasta do cliente no Google Drive. Para arquivos binários (.docx/.pptx/.pdf) já gerados em downloads/ ou outputs/, use 'local_file_path' — é lido direto do disco, sem reenviar o conteúdo pelo chat. Use 'file_content' somente para texto pequeno sem arquivo local (ex: corpo de e-mail).",
        inputSchema: {
          type: "object",
          properties: {
            file_name: { type: "string", description: "Nome do arquivo no Drive" },
            local_file_path: {
              type: "string",
              description: "Nome do arquivo já salvo em downloads/ ou outputs/ (ex: Rebalanceamento-2811645.docx). Preferir este campo para arquivos binários — evita reenviar o conteúdo em Base64.",
            },
            file_content: {
              type: "string",
              description: "Conteúdo textual do arquivo. Use apenas quando NÃO houver arquivo local já gerado (local_file_path é preferível para binários).",
            },
            parent_folder_id: { type: "string", description: "ID da pasta destino no Drive" },
          },
          required: ["file_name", "parent_folder_id"],
        },
      },
      {
        name: "ler_arquivo_local",
        description: "Lê o conteúdo de um arquivo já baixado na pasta local downloads/ (PDF, TXT, etc.)",
        inputSchema: {
          type: "object",
          properties: {
            nome_arquivo: {
              type: "string",
              description: "Nome do arquivo na pasta downloads/ (ex: XPerformance_2811645.pdf)",
            },
            paginas: {
              type: "number",
              description: "Número máximo de páginas a extrair (padrão: todas). Use para limitar tokens.",
            },
          },
          required: ["nome_arquivo"],
        },
      },
    ],
  }));

  // ── Handlers das tools ──────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments;

      switch (request.params.name) {
        case "listar_clientes": {
          const parentRes = await executeAction("GOOGLEDRIVE_FIND_FILE", {
            q: "mimeType = 'application/vnd.google-apps.folder' and name = 'XPerformance'",
          });
          const parents = resumirArquivos(parentRes);
          if (parents.length === 0) {
            return { content: [{ type: "text", text: "[]" }] };
          }
          const xperfId = parents[0].id;
          const childRes = await executeAction("GOOGLEDRIVE_FIND_FILE", {
            q: `mimeType = 'application/vnd.google-apps.folder' and '${xperfId}' in parents and trashed = false`,
          });
          return { content: [{ type: "text", text: JSON.stringify(resumirArquivos(childRes)) }] };
        }

        case "obter_extrato_cliente": {
          const queryParts = args.contas
            .split("_")
            .map((c) => `name contains '${c}'`)
            .join(" or ");
          const res = await executeAction("GOOGLEDRIVE_FIND_FILE", {
            q: `(${queryParts}) and name contains 'XPerformance' and mimeType = 'application/pdf'`,
          });
          return { content: [{ type: "text", text: JSON.stringify(resumirArquivos(res)) }] };
        }

        case "buscar_dados_fundo": {
          const res = await executeAction("GOOGLEDRIVE_FIND_FILE", {
            q: `name contains '${args.nome_fundo}'`,
          });
          return { content: [{ type: "text", text: JSON.stringify(resumirArquivos(res)) }] };
        }

        case "buscar_credito_emissor": {
          const res = await executeAction("GOOGLEDRIVE_FIND_FILE", {
            q: `name contains '${args.nome_emissor}'`,
          });
          return { content: [{ type: "text", text: JSON.stringify(resumirArquivos(res)) }] };
        }

        case "buscar_tese_renda_variavel": {
          const res = await executeAction("GOOGLEDRIVE_FIND_FILE", {
            q: `name contains '${args.nome_ativo}'`,
          });
          return { content: [{ type: "text", text: JSON.stringify(resumirArquivos(res)) }] };
        }

        case "obter_diretrizes_alocacao": {
          const regiao = args.tipo; // "Brasil" ou "Global"

          const queries = regiao === "Brasil"
            ? [
                `name contains 'Aloca' and name contains 'Brasil'`,
                `name contains 'Brasil' and name contains 'Aloca'`,
                `name contains 'Alocacao' and name contains 'Brasil'`,
                `name contains 'Brasil'`,
              ]
            : [
                `name contains 'Aloca' and name contains 'Global'`,
                `name contains 'Global' and name contains 'Aloca'`,
                `name contains 'Global'`,
              ];

          let arquivos = [];
          for (const q of queries) {
            const res = await executeAction("GOOGLEDRIVE_FIND_FILE", { q });
            arquivos = resumirArquivos(res);
            if (arquivos.length > 0) break;
          }

          // Se a busca retornar pastas, resolve os arquivos dentro delas recursivamente (até 1 subnível)
          const arquivosFinais = [];
          for (const arq of arquivos) {
            if (arq.type === "folder") {
              try {
                const subRes = await executeAction("GOOGLEDRIVE_FIND_FILE", {
                  q: `'${arq.id}' in parents and trashed = false`,
                });
                const subFiles = resumirArquivos(subRes);
                for (const subF of subFiles) {
                  if (subF.type === "folder") {
                    // Resolve mais um nível (ex: Brasil > Maio 26 > arquivo.pdf)
                    const subSubRes = await executeAction("GOOGLEDRIVE_FIND_FILE", {
                      q: `'${subF.id}' in parents and trashed = false`,
                    });
                    arquivosFinais.push(...resumirArquivos(subSubRes));
                  } else {
                    arquivosFinais.push(subF);
                  }
                }
              } catch (e) {
                console.error(`Erro ao resolver arquivos da pasta de alocação ${arq.name}:`, e);
              }
            } else {
              arquivosFinais.push(arq);
            }
          }

          // Remove duplicados se houver
          const vistos = new Set();
          const arquivosFiltrados = arquivosFinais.filter((arq) => {
            if (vistos.has(arq.id)) return false;
            vistos.add(arq.id);
            return true;
          });

          const msg = arquivosFiltrados.length > 0
            ? JSON.stringify(arquivosFiltrados)
            : `Nenhum documento de alocação ${regiao} encontrado. Verifique se a pasta 'Longeva > Alocação > ${regiao}' existe no Drive e contém arquivos.`;

          return { content: [{ type: "text", text: msg }] };
        }

        case "buscar_documentos_gerais": {
          const res = await executeAction("GOOGLEDRIVE_FIND_FILE", {
            q: `name contains '${args.query}'`,
          });
          return { content: [{ type: "text", text: JSON.stringify(resumirArquivos(res)) }] };
        }

        case "baixar_arquivo_drive": {
          const fileId = args.file_id;
          const res = await executeAction("GOOGLEDRIVE_DOWNLOAD_FILE", { fileId });

          if (res?.data?.downloaded_file_content?.s3url) {
            const s3url = res.data.downloaded_file_content.s3url;
            const fetchRes = await fetch(s3url);
            const buffer = await fetchRes.arrayBuffer();
            const nodeBuffer = Buffer.from(buffer);

            const fileName = args.nome_arquivo || res.data.name || `arquivo_${fileId}.pdf`;
            const cleanFileName = fileName.replace(/\s/g, "_");
            const filePath = path.join(downloadsDir, cleanFileName);

            await fs.promises.writeFile(filePath, nodeBuffer);

            return {
              content: [
                {
                  type: "text",
                  text: `[DOWNLOAD SUCESSO] Arquivo salvo localmente.\nCaminho: ${filePath.replace(/\\/g, "/")}\nMimeType: ${res.data.mimeType || "desconhecido"}`,
                },
              ],
            };
          }

          return {
            content: [{ type: "text", text: "Erro: URL de download não disponível para este arquivo." }],
            isError: true,
          };
        }

        case "ler_arquivo_local": {
          const nomeArquivo = args.nome_arquivo;
          const filePath = path.join(downloadsDir, nomeArquivo);

          if (!fs.existsSync(filePath)) {
            // Lista arquivos disponíveis para ajudar o Claude a corrigir o nome
            const disponiveis = fs.readdirSync(downloadsDir)
              .filter(f => !f.startsWith('temp_upload_'))
              .join(', ');
            return {
              content: [{ type: "text", text: `Arquivo '${nomeArquivo}' não encontrado na pasta downloads/.\nArquivos disponíveis: ${disponiveis || '(nenhum)'}` }],
              isError: true,
            };
          }

          const ext = path.extname(nomeArquivo).toLowerCase();

          // ── Arquivos de texto: leitura direta ──────────────────────────────
          if (['.txt', '.md', '.json', '.csv'].includes(ext)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            const MAX_CHARS = 80000; // ~20k tokens
            const truncated = content.length > MAX_CHARS;
            return {
              content: [{ type: "text", text: (truncated ? content.slice(0, MAX_CHARS) + '\n\n[CONTEÚDO TRUNCADO — arquivo muito longo]' : content) }],
            };
          }

          // ── PDFs: extração de texto via classic pdf-parse ─────────────────
          if (ext === '.pdf') {
            try {
              const buffer = fs.readFileSync(filePath);
              const data = await pdfParse(buffer);
              const maxPages = args.paginas || 999;
              const texto = data.text;
              const MAX_PDF_CHARS = 120000; // ~30k tokens
              const truncated = texto.length > MAX_PDF_CHARS;
              return {
                content: [{ type: "text", text: `[PDF — ${data.numpages} página(s)]\n\n` + (truncated ? texto.slice(0, MAX_PDF_CHARS) + '\n\n[CONTEÚDO TRUNCADO]' : texto) }],
              };
            } catch (err) {
              return {
                content: [{ type: "text", text: `Erro ao extrair PDF: ${err.message}` }],
                isError: true,
              };
            }
          }

          // ── Outros tipos: retorna o caminho absoluto para o Claude usar ──────
          return {
            content: [{ type: "text", text: `Arquivo salvo em: ${filePath}\nTipo: ${ext || 'desconhecido'} — leitura direta não suportada para este formato.` }],
          };
        }

        case "salvar_documento_drive": {
          const { file_name, file_content, local_file_path, parent_folder_id } = args;

          let bufferToWrite;

          if (local_file_path) {
            // Lê o arquivo já gerado diretamente do disco — evita reenviar o
            // conteúdo binário como texto (lento e sujeito a corrupção via
            // ferramentas de leitura que prefixam números de linha).
            const base = path.basename(local_file_path);
            const candidatos = [path.join(downloadsDir, base), path.join(outputsDir, base)];
            const encontrado = candidatos.find((p) => fs.existsSync(p));
            if (!encontrado) {
              return {
                content: [{ type: "text", text: `Arquivo local '${base}' não encontrado em downloads/ ou outputs/.` }],
                isError: true,
              };
            }
            bufferToWrite = await fs.promises.readFile(encontrado);
          } else if (file_content) {
            const isBinary = file_name.endsWith(".pptx") || file_name.endsWith(".docx") || file_name.endsWith(".pdf");

            let cleanContent = file_content.trim();
            // Remove prefixo de data URI se existir
            if (cleanContent.startsWith("data:") && cleanContent.includes(";base64,")) {
              cleanContent = cleanContent.split(";base64,").pop();
            }
            // Remove quaisquer espaços, quebras de linha ou retornos de carro
            cleanContent = cleanContent.replace(/\s+/g, "");

            // Verifica se é uma string base64 válida
            const isBase64 = isBinary && /^[A-Za-z0-9+/=]+$/.test(cleanContent);
            bufferToWrite = isBase64 ? Buffer.from(cleanContent, "base64") : file_content;
          } else {
            return {
              content: [{ type: "text", text: "Informe 'local_file_path' (arquivo já salvo em downloads/ ou outputs/) ou 'file_content' (conteúdo textual)." }],
              isError: true,
            };
          }

          // Cópia local persistente
          const localCopyPath = path.join(outputsDir, file_name);
          await fs.promises.writeFile(localCopyPath, bufferToWrite);
          console.error(`Cópia local salva em: ${localCopyPath}`);

          const tempPath = path.join(downloadsDir, `temp_upload_${Date.now()}_${file_name}`);
          await fs.promises.writeFile(tempPath, bufferToWrite);

          try {
            const fileObj = await composio.files.upload({
              file: tempPath,
              toolkitSlug: "googledrive",
              toolSlug: "googledrive_GOOGLEDRIVE_UPLOAD_FILE",
            });

            // Localiza ou cria a pasta 'entregas' dentro da pasta do cliente
            let targetFolderId = parent_folder_id;
            if (parent_folder_id && parent_folder_id !== "root") {
              const searchRes = await executeAction("GOOGLEDRIVE_FIND_FILE", {
                q: `name = 'entregas' and mimeType = 'application/vnd.google-apps.folder' and '${parent_folder_id}' in parents`,
              });

              const folders = searchRes?.data?.files || [];
              if (folders.length > 0) {
                targetFolderId = folders[0].id;
              } else {
                const createRes = await executeAction("GOOGLEDRIVE_CREATE_FOLDER", {
                  name: "entregas",
                  parent_id: parent_folder_id,
                });
                targetFolderId = createRes?.data?.id || createRes?.id || parent_folder_id;
              }
            }

            // MimeType correto por extensão
            let mimeType = "application/octet-stream";
            if (file_name.endsWith(".pptx"))
              mimeType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            else if (file_name.endsWith(".docx"))
              mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            else if (file_name.endsWith(".pdf")) mimeType = "application/pdf";
            else if (file_name.endsWith(".txt")) mimeType = "text/plain";

            const payload = {
              file_to_upload: { name: file_name, s3key: fileObj.s3key, mimetype: mimeType },
            };
            if (targetFolderId && targetFolderId !== "root") {
              payload.parents = [targetFolderId];
            }

            const res = await executeAction("GOOGLEDRIVE_UPLOAD_FILE", payload);

            return {
              content: [
                {
                  type: "text",
                  text: `[UPLOAD SUCESSO] '${file_name}' salvo na pasta 'entregas' do Drive.\nID: ${res?.data?.id || "N/A"}`,
                },
              ],
            };
          } finally {
            if (fs.existsSync(tempPath)) {
              await fs.promises.unlink(tempPath);
            }
          }
        }

        default:
          throw new Error(`Tool não encontrada: ${request.params.name}`);
      }
    } catch (err) {
      // Redireciona para autenticação em erros de auth do Google/Composio
      const isAuthError =
        err.message &&
        (err.message.includes("No active connection") ||
          err.message.includes("unauthorized") ||
          err.message.includes("reauth") ||
          err.message.includes("re-authorize") ||
          err.message.includes("authentication failed"));

      if (isAuthError) {
        const authUrl = `https://app.composio.dev/app/googledrive?entityId=${
          process.env.COMPOSIO_ENTITY_ID || "default"
        }`;
        import("child_process")
          .then((cp) => cp.exec(`start "" "${authUrl}"`))
          .catch(() => {});

        return {
          content: [
            {
              type: "text",
              text: `⚠️ Conta do Google Drive não vinculada.\n\nAcesse para autorizar:\n🔗 ${authUrl}\n\nTente novamente após vincular.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: `Erro: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

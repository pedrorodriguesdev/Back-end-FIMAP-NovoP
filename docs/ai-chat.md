<!--
PARA QUE SERVE: documentar como usar e configurar a integração com a IA.
QUANDO ENTRA EM AÇÃO: durante a configuração, integração do frontend e investigação de erros.
QUANDO FAZ DIFERENÇA: mostra os endereços, formatos e requisitos sem precisar ler todos os arquivos de código.
-->

# Integração do chat com a IA

Use Node.js 22 ou superior. Na raiz, execute `npm install`, `npm test` e `npm start`.
O servidor escuta na porta 8080 por padrão. `GET /health` verifica o processo do backend, sem chamar a IA ou o banco.

O serviço usa por padrão o Worker público em
`https://back-end-fimap.pedroday813.workers.dev/v1/ia/chat-publico`.
Para trocar o provedor, defina `CLOUDFLARE_WORKER_URL` no ambiente ou no `.env`.
Para a rota protegida `/chat`, configure `CLOUDFLARE_CHAT_TOKEN` com o mesmo token do Worker.
O backend acrescenta o cabeçalho Authorization quando o token está configurado.
O prompt e a escolha do modelo são responsabilidade do Worker; nenhum prompt de sistema é aceito do cliente.

## Chat sem persistência

`POST /v1/ia/chat-publico` recebe:

```json
{"messages":[{"role":"user","content":"Como posso organizar meu orçamento?"}]}
```

De 1 a 12 mensagens, com papéis `user` e `assistant`; a última deve ser `user`.
Perguntas têm até 2000 caracteres e respostas anteriores até 16000. O contexto é o histórico enviado pelo cliente.
Essa rota funciona sem consultar o MySQL.

## Chat com histórico

As rotas existentes de criação e manutenção continuam em `/v1/ia/chat`:

- `POST /iniciar-chat`: corpo `{"id_usuario":1,"nome":"Meu orçamento"}`.
- `GET /listar-chats/:id_usuario`: retorna chats, incluindo seus IDs.
- `GET /listar-chat/:id_chat`: retorna o chat, incluindo ID e usuário.
- `PATCH /atualizar-nome-chat/:id_chat`: corpo `{"nome":"Novo nome"}`.
- `DELETE /apagar-chat/:id_chat?id_usuario=1`.

Envio e consulta de mensagens:

- `POST /v1/ia/chats/:chatId/mensagens`: corpo `{"conteudo":"Como posso economizar?"}`.
- `GET /v1/ia/chats/:chatId/mensagens?limite=30&antes_de=100`.
- Os mesmos endpoints de mensagens aceitam também o prefixo singular `/v1/ia/chat`.

O chat precisa existir. As tabelas `tbl_chat` e `tbl_mensagem` devem estar criadas conforme
`Database/Script_Fimap.sql`, e o MySQL deve estar acessível pela configuração de `KnexFile.js`.
A IA recebe até dez mensagens anteriores e a pergunta atual.
A paginação devolve as mensagens em ordem cronológica, `tem_mais` e `proximo_cursor`.
O banco usa papel 1 para usuário e 2 para assistente.

## Streaming e falhas

As duas rotas de envio retornam `text/event-stream`:

```text
data: {"tipo":"trecho","conteudo":"Texto da resposta"}

data: {"tipo":"fim"}

```

No chat persistente, o evento `fim` também contém `mensagem_usuario` e `mensagem_assistente`, com os IDs gravados.
Falhas durante a geração usam `{"tipo":"erro","mensagem":"..."}`, sem evento `fim`.
Antes do streaming, entradas inválidas retornam JSON com HTTP 400, chats inexistentes 404 e configurações inválidas 503.

O adaptador aceita SSE FIMAP (`tipo/trecho/conteudo`), Workers AI (`response`) e OpenAI (`choices[].delta.content`),
além de respostas JSON completas. Um fluxo precisa concluir com `tipo: fim`, `[DONE]` ou `finish_reason`.
Eventos de raciocínio não são enviados como resposta. Eventos inválidos, respostas vazias e fluxos interrompidos são tratados como falhas.

Ao fechar a conexão, a requisição ao provedor é cancelada. Uma pergunta já gravada permanece no histórico;
uma resposta parcial ou com erro não é salva como concluída. Duas gerações simultâneas para o mesmo chat
são rejeitadas no mesmo processo; esse controle não é distribuído entre réplicas.
As rotas de geração compartilham o limite de 12 perguntas por minuto por IP.
O tempo máximo de conexão com a IA é de três minutos e a resposta tem limite de 16000 caracteres.

O fluxo de chats mantém o contrato existente de identificação de usuários por parâmetros.
Esses parâmetros não substituem autenticação ou verificação de propriedade em uma aplicação com usuários autenticados.

## Validação

`npm test` verifica parsing SSE, formatos do provedor, erros, cancelamento, paginação, gravação de histórico
e os contratos dos controllers. Os testes usam banco e IA simulados e não alteram dados reais.
Para uma validação completa do ambiente publicado, teste também com o MySQL e o Worker configurados.

/*
 * PARA QUE SERVE: Cuida do histórico: lê mensagens, grava a pergunta, chama a IA e salva a resposta concluída.
 * QUANDO ENTRA EM AÇÃO: Entra nas conversas que pertencem a um chat salvo no MySQL.
 * QUANDO FAZ DIFERENÇA: Faz diferença para a IA receber contexto e para respostas interrompidas não serem salvas como concluídas.
 */

const db = require('../../Database_config_knex/connection.js')
const chatDAO = require('../Chat/ChatDAO.js')
const ia = require('../../../src/services/aiChatService.js')
const { criarErro, validarMensagens } = require('../../../src/services/chatValidation.js')

const PAPEL_USUARIO = 1
const PAPEL_ASSISTENTE = 2
// Evita duas respostas ao mesmo tempo para o mesmo chat neste processo.
const emAndamento = new Set()
const formatarMensagem = (mensagem) => ({
    id: mensagem.id,
    chat_id: mensagem.id_chat,
    papel: Number(mensagem.papel) === PAPEL_USUARIO ? 'usuario' : 'assistente',
    conteudo: mensagem.conteudo,
    data_envio: mensagem.data_envio
})
const buscarChat = (chatId) => chatDAO.GetChatById(chatId)

// Lê uma página do histórico; o cursor permite buscar mensagens mais antigas.
const listarMensagensChat = async (chatId, { antesDe, limite = 30 } = {}) => {
    if (!await buscarChat(chatId)) return null
    let consulta = db('tbl_mensagem').select('id', 'conteudo', 'data_envio', 'papel', 'id_chat').where('id_chat', chatId)
    if (antesDe !== undefined) consulta = consulta.where('id', '<', antesDe)
    const linhas = await consulta.orderBy('id', 'desc').limit(limite + 1)
    const temMais = linhas.length > limite
    const mensagens = linhas.slice(0, limite).reverse().map(formatarMensagem)
    return { mensagens, tem_mais: temMais, proximo_cursor: temMais && mensagens.length ? mensagens[0].id : null }
}

// Converte a mensagem salva no banco para o formato que o frontend recebe.
const gravarMensagem = async (chatId, conteudo, papel) => {
    const linha = { id_chat: chatId, conteudo, papel, data_envio: new Date() }
    const [id] = await db('tbl_mensagem').insert(linha)
    return formatarMensagem({ ...linha, id })
}

const iniciarMensagemChat = async (chatId, conteudo, aoReceberTrecho, signal) => {
    const [pergunta] = validarMensagens([{ role: 'user', content: conteudo }])
    ia.obterConfiguracao()
    signal?.throwIfAborted()
    if (emAndamento.has(chatId))
        throw criarErro(409, 'Já existe uma resposta sendo gerada para este chat.', 'CHAT_EM_ANDAMENTO')
    emAndamento.add(chatId)
    try {
        if (!await buscarChat(chatId)) return null
        signal?.throwIfAborted()
        const historico = await db('tbl_mensagem').select('papel', 'conteudo')
            .where('id_chat', chatId).orderBy('id', 'desc').limit(10)
        const mensagens = [...historico.reverse().map((item) => ({
            role: Number(item.papel) === PAPEL_USUARIO ? 'user' : 'assistant',
            content: item.conteudo
        })), pergunta]
        // Valida todo o contexto antes de gravar a pergunta ou chamar o provedor.
        validarMensagens(mensagens)
        signal?.throwIfAborted()
        // A pergunta fica no histórico mesmo se a IA falhar depois.
        const mensagemUsuario = await gravarMensagem(chatId, pergunta.content, PAPEL_USUARIO)
        signal?.throwIfAborted()
        const texto = await ia.gerarResposta(mensagens, aoReceberTrecho, signal)
        signal?.throwIfAborted()
        // Só chega aqui depois de a IA concluir; pedaços interrompidos não são salvos.
        const mensagemAssistente = await gravarMensagem(chatId, texto, PAPEL_ASSISTENTE)
        return { mensagem_usuario: mensagemUsuario, mensagem_assistente: mensagemAssistente }
    } finally {
        emAndamento.delete(chatId)
    }
}

module.exports = { buscarChat, listarMensagensChat, iniciarMensagemChat }

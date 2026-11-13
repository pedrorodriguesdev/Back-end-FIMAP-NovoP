/*
 * PARA QUE SERVE: Recebe perguntas e consultas de histórico de um chat salvo.
 * QUANDO ENTRA EM AÇÃO: Entra nas rotas de mensagens que possuem um chatId.
 * QUANDO FAZ DIFERENÇA: Faz diferença para validar a entrada, conferir se o chat existe e devolver os eventos da resposta.
 */

const config = require('../modulo/configMensagens.js')
const dao = require('../../../model/DAO/MensagemChat/MensagemChatDAO.js')
const ia = require('../../services/aiChatService.js')
const { criarErro, validarId, validarMensagens } = require('../../services/chatValidation.js')
const { transmitir, responderErro } = require('../../services/chatStream.js')

// GET: busca mensagens já salvas; não pede uma resposta nova à IA.
const listarMensagensChat = async (req, res) => {
    const chatId = validarId(req.params.chatId)
    const antesDe = req.query.antes_de === undefined ? undefined : validarId(req.query.antes_de)
    const limite = req.query.limite === undefined ? 30 : validarId(req.query.limite)
    if (!chatId || (req.query.antes_de !== undefined && !antesDe) || !limite || limite > 100)
        return res.status(400).json(config.ERROR_BAD_REQUEST)
    try {
        const pagina = await dao.listarMensagensChat(chatId, { antesDe, limite })
        if (!pagina) return res.status(404).json(config.ERROR_CHAT_NOT_FOUND)
        return res.status(200).json(pagina)
    } catch (error) { return responderErro(res, error) }
}

// POST: recebe a pergunta, confere o chat e inicia o fluxo com histórico.
const enviarMensagemChat = async (req, res) => {
    const chatId = validarId(req.params.chatId)
    if (!chatId) return res.status(400).json(config.ERROR_BAD_REQUEST)
    try {
        const [pergunta] = validarMensagens([{ role: 'user', content: req.body?.conteudo }])
        ia.obterConfiguracao()
        if (!await dao.buscarChat(chatId)) return res.status(404).json(config.ERROR_CHAT_NOT_FOUND)
        return await transmitir(res, async (aoReceberTrecho, signal) => {
            const resultado = await dao.iniciarMensagemChat(chatId, pergunta.content, aoReceberTrecho, signal)
            if (!resultado) throw criarErro(404, 'Chat não encontrado.', 'CHAT_NAO_ENCONTRADO')
            return resultado
        })
    } catch (error) { return responderErro(res, error) }
}

module.exports = { listarMensagensChat, enviarMensagemChat }

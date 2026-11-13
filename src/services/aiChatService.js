/*
 * PARA QUE SERVE: Conversa com a IA da Cloudflare: envia a pergunta e recebe a resposta.
 * QUANDO ENTRA EM AÇÃO: É usado pelos dois tipos de chat quando precisam gerar uma resposta.
 * QUANDO FAZ DIFERENÇA: Faz diferença ao juntar os pedaços da resposta, lidar com falhas e cancelar a chamada.
 */

const { criarErro, validarMensagens } = require('./chatValidation.js')

// O prompt e o modelo são administrados no Worker. O cliente envia apenas o histórico.
const WORKER_URL_PADRAO = 'https://back-end-fimap.pedroday813.workers.dev/v1/ia/chat-publico'
const TIMEOUT_IA_MS = 180000

// Lê URL e token antes da chamada; o token fica apenas no backend.
const obterConfiguracao = () => {
    let url
    try { url = new URL(process.env.CLOUDFLARE_WORKER_URL || WORKER_URL_PADRAO) }
    catch { throw criarErro(503, 'Configure uma CLOUDFLARE_WORKER_URL válida.', 'IA_CONFIGURACAO') }
    if (!['https:', 'http:'].includes(url.protocol))
        throw criarErro(503, 'A URL da IA precisa usar HTTP ou HTTPS.', 'IA_CONFIGURACAO')
    const token = process.env.CLOUDFLARE_CHAT_TOKEN
    if (url.pathname.replace(/\/$/, '') === '/chat' && !token)
        throw criarErro(503, 'Configure CLOUDFLARE_CHAT_TOKEN para usar a rota protegida /chat.', 'IA_CONFIGURACAO')
    return { url: url.toString(), token }
}

// Cada provedor pode usar um formato diferente para o mesmo pedaço de texto.
const extrairTexto = (dados) => {
    if (typeof dados === 'string') return dados
    if (dados?.tipo === 'trecho') return typeof dados.conteudo === 'string' ? dados.conteudo : ''
    const texto = dados?.response ?? dados?.choices?.[0]?.delta?.content ?? dados?.choices?.[0]?.message?.content
    return typeof texto === 'string' ? texto : ''
}

// É o ponto central usado tanto pelo chat público quanto pelo chat com histórico.
const gerarResposta = async (entrada, aoReceberTrecho = () => {}, signal) => {
    const mensagens = validarMensagens(entrada)
    const { url, token } = obterConfiguracao()
    const sinal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_IA_MS)]) : AbortSignal.timeout(TIMEOUT_IA_MS)
    let reader
    let cancelarLeitura
    let respostaCompleta = ''
    let concluido = false
    const adicionar = (trecho) => {
        sinal.throwIfAborted()
        if (!trecho) return
        if (respostaCompleta.length + trecho.length > 16000)
            throw criarErro(502, 'A resposta da IA excedeu o limite de 16000 caracteres.', 'IA_RESPOSTA_INVALIDA')
        respostaCompleta += trecho
        aoReceberTrecho(trecho)
    }
    // A IA envia eventos; alguns trazem texto, outros só avisam que terminou.
    const processarEvento = (evento) => {
        const data = evento.split(/\r?\n/).filter((linha) => linha.startsWith('data:'))
            .map((linha) => linha.slice(5).trimStart()).join('\n').trim()
        if (!data) return
        if (data === '[DONE]') { concluido = true; return }
        let dados
        try { dados = JSON.parse(data) }
        catch { throw criarErro(502, 'A IA retornou um evento inválido.', 'IA_RESPOSTA_INVALIDA') }
        if (dados?.tipo === 'erro' || dados?.error)
            throw criarErro(502, 'A IA não conseguiu concluir a resposta.', 'IA_PROVEDOR')
        adicionar(extrairTexto(dados))
        if (dados?.tipo === 'fim' || dados?.choices?.some((item) => item.finish_reason != null)) concluido = true
    }
    try {
        sinal.throwIfAborted()
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ messages: mensagens }),
            signal: sinal
        })
        if (!response.ok) {
            await response.body?.cancel()
            if (response.status === 401 || response.status === 403)
                throw criarErro(503, 'A autenticação com o serviço de IA falhou. Confira o token do backend.', 'IA_AUTENTICACAO')
            if (response.status === 429)
                throw criarErro(503, 'O serviço de IA atingiu o limite de uso. Tente novamente mais tarde.', 'IA_LIMITE')
            throw criarErro(502, 'O serviço de IA está indisponível no momento.', 'IA_PROVEDOR')
        }
        if (response.headers.get('Content-Type')?.includes('application/json')) {
            let dados
            try { dados = await response.json() }
            catch { throw criarErro(502, 'A IA retornou um JSON inválido.', 'IA_RESPOSTA_INVALIDA') }
            if (dados?.error || dados?.tipo === 'erro')
                throw criarErro(502, 'A IA não conseguiu concluir a resposta.', 'IA_PROVEDOR')
            adicionar(extrairTexto(dados))
            concluido = true
        } else {
            if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
                await response.body?.cancel()
                throw criarErro(502, 'A IA não retornou um fluxo SSE válido.', 'IA_RESPOSTA_INVALIDA')
            }
            reader = response.body.getReader()
            cancelarLeitura = () => { reader.cancel(sinal.reason).catch(() => {}) }
            sinal.addEventListener('abort', cancelarLeitura, { once: true })
            if (sinal.aborted) cancelarLeitura()
            // Um pacote de rede pode terminar no meio de uma letra ou de um evento.
            // O decoder e o buffer preservam o texto até chegar a parte que falta.
            const decoder = new TextDecoder()
            let buffer = ''
            while (!concluido) {
                sinal.throwIfAborted()
                const { value, done } = await reader.read()
                sinal.throwIfAborted()
                buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
                // Impede que um provedor envie um evento sem delimitador indefinidamente.
                if (buffer.length > 262144)
                    throw criarErro(502, 'O evento da IA excedeu o limite permitido.', 'IA_RESPOSTA_INVALIDA')
                const eventos = buffer.split(/\r?\n\r?\n/)
                buffer = eventos.pop() || ''
                for (const evento of eventos) {
                    processarEvento(evento)
                    if (concluido) break
                }
                if (done) {
                    if (!concluido && buffer.trim()) processarEvento(buffer)
                    break
                }
            }
        }
        sinal.throwIfAborted()
        if (!concluido) throw criarErro(502, 'A conexão com a IA foi interrompida antes de concluir.', 'IA_FLUXO_INTERROMPIDO')
        if (!respostaCompleta.trim()) throw criarErro(502, 'A IA retornou uma resposta vazia.', 'IA_RESPOSTA_VAZIA')
        return respostaCompleta.trim()
    } catch (error) {
        signal?.throwIfAborted()
        if (sinal.aborted)
            throw criarErro(504, 'A IA demorou demais para responder.', 'IA_TIMEOUT')
        if (error.statusCode) throw error
        throw criarErro(502, 'Não foi possível completar a conexão com a IA.', 'IA_INDISPONIVEL')
    } finally {
        // Libera o stream inclusive quando o usuário para a resposta ou ocorre erro.
        if (cancelarLeitura) sinal.removeEventListener('abort', cancelarLeitura)
        if (reader) {
            await reader.cancel().catch(() => {})
            reader.releaseLock()
        }
    }
}

module.exports = { gerarResposta, obterConfiguracao, WORKER_URL_PADRAO }

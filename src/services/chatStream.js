/*
 * PARA QUE SERVE: Entrega ao frontend os pedaços da resposta, a conclusão ou um erro.
 * QUANDO ENTRA EM AÇÃO: Entra depois que o controller aceita a pergunta e começa o atendimento.
 * QUANDO FAZ DIFERENÇA: Faz diferença para mostrar o texto enquanto a IA escreve e parar quando o cliente desconecta.
 */

const mensagemErro = (error) => error.statusCode ? error.message : 'Não foi possível concluir a solicitação.'

// Antes de iniciar o streaming, uma falha ainda pode virar uma resposta JSON com status HTTP.
const responderErro = (res, error) => {
    console.error('Falha no chat:', error.code || 'ERRO_INTERNO')
    return res.status(error.statusCode || 500).json({ sucesso: false, mensagem: mensagemErro(error) })
}

// Depois que os cabeçalhos são enviados, erros precisam ser eventos dentro do próprio fluxo.
const transmitir = async (res, executar) => {
    const controlador = new AbortController()
    const cancelar = () => { if (!res.writableEnded) controlador.abort() }
    const enviar = (dados) => {
        controlador.signal.throwIfAborted()
        if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(dados)}\n\n`)
    }
    // Se o navegador fechar a conexão, avisa o serviço para parar de buscar a resposta.
    res.on('close', cancelar)
    res.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    res.flushHeaders()
    try {
        const resultado = await executar((conteudo) => enviar({ tipo: 'trecho', conteudo }), controlador.signal)
        enviar({ ...resultado, tipo: 'fim' })
    } catch (error) {
        if (!controlador.signal.aborted) {
            console.error('Falha no streaming do chat:', error.code || 'ERRO_INTERNO')
            enviar({ tipo: 'erro', mensagem: mensagemErro(error) })
        }
    } finally {
        res.off('close', cancelar)
        if (!res.destroyed && !res.writableEnded) res.end()
    }
}

module.exports = { transmitir, responderErro }

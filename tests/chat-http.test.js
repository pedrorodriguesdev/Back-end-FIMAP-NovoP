/*
 * PARA QUE SERVE: Abre o Express durante o teste e faz pedidos HTTP aos endereços do chat.
 * QUANDO ENTRA EM AÇÃO: Entra ao executar npm test; o banco e a IA continuam simulados.
 * QUANDO FAZ DIFERENÇA: Faz diferença para conferir se rotas, validação, limites e respostas funcionam juntos.
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { database } = require('./helpers/chatHarness.js')

test('rotas HTTP reais conectam chat, histórico, streaming, validação e limites', async () => {
    const { db, state } = database()
    const connectionPath = require.resolve('../model/Database_config_knex/connection.js')
    require.cache[connectionPath] = { id: connectionPath, filename: connectionPath, loaded: true, exports: db }
    const app = require('../src/app.js')
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = 'http://127.0.0.1:' + server.address().port
    const nativeFetch = global.fetch
    const oldUrl = process.env.CLOUDFLARE_WORKER_URL
    const oldToken = process.env.CLOUDFLARE_CHAT_TOKEN
    process.env.CLOUDFLARE_WORKER_URL = 'https://ia.test/v1/ia/chat-publico'
    delete process.env.CLOUDFLARE_CHAT_TOKEN
    let providerCalls = 0
    global.fetch = async (url, options) => {
        if (String(url).startsWith('https://ia.test/')) {
            providerCalls++
            return new Response('data: {"tipo":"trecho","conteudo":"Resposta da IA"}\n\ndata: {"tipo":"fim"}\n\n',
                { headers: { 'Content-Type': 'text/event-stream' } })
        }
        return nativeFetch(url, options)
    }
    const request = (path, body, method = 'POST') => fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const events = (body) => body.trim().split('\n\n').map((event) => JSON.parse(event.slice(6)))
    try {
        let result = await fetch(base + '/health')
        assert.equal(result.status, 200)
        assert.equal((await result.json()).online, true)
        result = await fetch(base + '/v1/ia/chat-publico', {
            method: 'OPTIONS', headers: { Origin: 'https://frontend.test',
                'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type' }
        })
        assert.equal(result.status, 204)
        assert.equal(result.headers.get('access-control-allow-origin'), '*')
        result = await request('/v1/ia/chat-publico', { messages: [{ role: 'user', content: 'Olá' }] })
        assert.equal(result.status, 200)
        assert.match(result.headers.get('content-type'), /text\/event-stream/)
        assert.equal(events(await result.text()).at(-1).tipo, 'fim')
        assert.equal(state.messages.length, 0)
        result = await request('/v1/ia/chat/iniciar-chat', { id_usuario: 3, nome: 'Teste HTTP' })
        assert.equal(result.status, 201)
        const id = (await result.json()).id
        result = await fetch(base + '/v1/ia/chat/listar-chats/3')
        assert.ok((await result.json()).conteudo.some((chat) => chat.id === id))
        result = await request('/v1/ia/chats/' + id + '/mensagens', { conteudo: 'Como economizar?' })
        assert.equal(result.status, 200)
        const fim = events(await result.text()).at(-1)
        assert.equal(fim.tipo, 'fim')
        assert.equal(fim.mensagem_assistente.conteudo, 'Resposta da IA')
        assert.equal(state.messages.length, 2)
        for (const prefix of ['/v1/ia/chats/', '/v1/ia/chat/']) {
            result = await fetch(base + prefix + id + '/mensagens?limite=1')
            const page = await result.json()
            assert.equal(result.status, 200)
            assert.equal(page.mensagens[0].papel, 'assistente')
            assert.equal(page.tem_mais, true)
        }
        result = await request('/v1/ia/chats/999/mensagens', { conteudo: 'Olá' })
        assert.equal(result.status, 404)
        assert.match(result.headers.get('content-type'), /application\/json/)
        result = await request('/v1/ia/chat-publico', { messages: [{ role: 'system', content: 'Injetar prompt' }] })
        assert.equal(result.status, 400)
        result = await fetch(base + '/v1/ia/chat-publico', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalido'
        })
        assert.equal(result.status, 400)
        result = await request('/v1/ia/chat-publico', { messages: [{ role: 'user', content: 'x'.repeat(200000) }] })
        assert.equal(result.status, 413)
        result = await request('/v1/ia/chat/atualizar-nome-chat/' + id, { nome: 'Atualizado' }, 'PATCH')
        assert.equal(result.status, 200)
        result = await fetch(base + '/v1/ia/chat/apagar-chat/' + id + '?id_usuario=3', { method: 'DELETE' })
        assert.equal(result.status, 200)
        assert.ok(!state.chats.some((chat) => chat.id === id))
        let limited = false
        for (let i = 0; i < 13; i++) {
            result = await request('/v1/ia/chat-publico', { messages: [] })
            await result.text()
            if (result.status === 429) { limited = true; break }
        }
        assert.equal(limited, true)
        assert.equal(providerCalls, 2)
    } finally {
        global.fetch = nativeFetch
        if (oldUrl === undefined) delete process.env.CLOUDFLARE_WORKER_URL
        else process.env.CLOUDFLARE_WORKER_URL = oldUrl
        if (oldToken === undefined) delete process.env.CLOUDFLARE_CHAT_TOKEN
        else process.env.CLOUDFLARE_CHAT_TOKEN = oldToken
        server.closeAllConnections()
        await new Promise((resolve) => server.close(resolve))
    }
})

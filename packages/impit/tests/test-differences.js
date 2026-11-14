'use strict'

const http = require('http')
const https = require('https')
const path = require('path')
const tls = require('tls')
const zlib = require('zlib')
const nodeApi = require('request-compat')
const engine = require('../index')
const {connectProxy} = require('./proxy-servers')
const {test, listen, close, call, wait, httpServer, httpsServer, rawServer, headerLines, inChildProcess, ssl} = require('./helpers')

const OK = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'

async function wireOf (api, options) {
  const server = rawServer(socket => socket.end(OK))
  const port = await listen(server)
  const result = await call(api, Object.assign({url: 'http://127.0.0.1:' + port + '/'}, options))
  await close(server)
  return {err: result.err, lines: headerLines(server.requests[0] || ''), raw: server.requests[0] || ''}
}

test('header names are written in lower case, in the order of the caller, followed by the headers impit adds', async t => {
  const options = {headers: {'X-First': '1', Host: 'example.test', 'User-Agent': 'probe'}}
  const node = await wireOf(nodeApi, options)
  const impit = await wireOf(engine, options)
  t.deepEqual(node.lines, ['X-First: 1', 'Host: example.test', 'User-Agent: probe', 'Connection: keep-alive'], 'Node keeps the case')
  t.deepEqual(impit.lines, ['x-first: 1', 'host: example.test', 'user-agent: probe', 'accept: */*', 'accept-encoding: zstd,gzip,deflate,br'])
})

test('the host header the core derives from the URL is left to impit, which writes it after the headers it adds', async t => {
  const withPort = line => line.replace(/:\d+$/, ':port')
  const node = await wireOf(nodeApi, {headers: {'X-First': '1'}})
  const impit = await wireOf(engine, {headers: {'X-First': '1'}})
  t.deepEqual(node.lines.map(withPort), ['X-First: 1', 'host: 127.0.0.1:port', 'Connection: keep-alive'], 'Node writes it after the headers of the caller')
  t.deepEqual(impit.lines.map(withPort), ['x-first: 1', 'accept: */*', 'accept-encoding: zstd,gzip,deflate,br', 'host: 127.0.0.1:port'])
})

test('a Host header set on the request after its construction is sent as with Node', async t => {
  const server = httpServer((req, res) => res.end(String(req.headers.host)))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const hostSeen = (api, change) => new Promise(resolve => {
    const created = api({url}, (err, res, body) => resolve(err ? String(err) : body))
    change(created)
  })
  const bySetHeader = created => created.setHeader('Host', 'virtual.test')
  const byHeaders = created => { created.headers.host = 'virtual.test' }
  t.equal(await hostSeen(nodeApi, bySetHeader), 'virtual.test', 'Node, setHeader')
  t.equal(await hostSeen(engine, bySetHeader), 'virtual.test', 'the engine, setHeader')
  t.equal(await hostSeen(nodeApi, byHeaders), 'virtual.test', 'Node, headers.host')
  t.equal(await hostSeen(engine, byHeaders), 'virtual.test', 'the engine, headers.host')
  await close(server)
})

test('impit adds accept and accept-encoding unless the caller or the core sets them', async t => {
  const plain = await wireOf(engine, {})
  const own = await wireOf(engine, {headers: {Accept: 'text/plain', 'Accept-Encoding': 'identity'}})
  const gzip = await wireOf(engine, {gzip: true})
  const json = await wireOf(engine, {json: true})
  const node = await wireOf(nodeApi, {})
  t.deepEqual(node.lines.map(line => line.toLowerCase()).filter(line => /^accept/.test(line)), [], 'Node sends neither')
  t.deepEqual(plain.lines.filter(line => /^accept/.test(line)), ['accept: */*', 'accept-encoding: zstd,gzip,deflate,br'])
  t.deepEqual(own.lines.filter(line => /^accept/.test(line)), ['accept: text/plain', 'accept-encoding: identity'])
  t.deepEqual(gzip.lines.filter(line => /^accept/.test(line)), ['accept-encoding: gzip, deflate', 'accept: */*'])
  t.deepEqual(json.lines.filter(line => /^accept/.test(line)), ['accept: application/json', 'accept-encoding: zstd,gzip,deflate,br'])
})

test('a header with several values is one line, a header with an empty value is not sent, a value outside ASCII is UTF-8', async t => {
  const options = {headers: {'X-List': ['a', 'b'], Cookie: ['c=1', 'd=2'], 'X-Empty': '', 'X-Name': 'café'}}
  const node = await wireOf(nodeApi, options)
  const impit = await wireOf(engine, options)
  t.deepEqual(node.lines.slice(0, 5), ['X-List: a', 'X-List: b', 'Cookie: c=1; d=2', 'X-Empty: ', 'X-Name: café'], 'Node: a line per value, the empty value, latin1')
  t.deepEqual(impit.lines.slice(0, 3), ['x-list: a, b', 'cookie: c=1; d=2', 'x-name: cafÃ©'])
  t.equal(impit.lines.filter(line => /^x-empty/.test(line)).length, 0)
})

test('the path is normalised as a URL: dot segments are resolved', async t => {
  const server = rawServer(socket => socket.end(OK))
  const port = await listen(server)
  await call(nodeApi, {url: 'http://127.0.0.1:' + port + '/a/../b/./c?x=1'})
  await call(engine, {url: 'http://127.0.0.1:' + port + '/a/../b/./c?x=1'})
  t.equal(server.requests[0].split('\r\n')[0], 'GET /a/../b/./c?x=1 HTTP/1.1', 'Node sends the path as given')
  t.equal(server.requests[1].split('\r\n')[0], 'GET /b/c?x=1 HTTP/1.1')
  await close(server)
})

test('a body longer than the content-length of the caller is cut to that length', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const {err} = await call(engine, {url, method: 'POST', body: 'hello', headers: {'content-length': 3}})
  t.equal(err, null)
  t.equal(server.seen[0].body.toString(), 'hel')
  await close(server)
})

function compressingServer () {
  return httpServer((req, res) => {
    const body = zlib.gzipSync('compressed body')
    if (req.url === '/truncated') {
      res.writeHead(200, {'content-encoding': 'gzip'})
      return res.end(body.slice(0, body.length - 6))
    }
    if (req.url === '/raw-deflate') {
      res.writeHead(200, {'content-encoding': 'deflate'})
      return res.end(zlib.deflateRawSync('compressed body'))
    }
    if (req.url === '/upper') {
      res.writeHead(200, {'content-encoding': 'GZIP', 'content-length': body.length})
      return res.end(body)
    }
    res.writeHead(200, {'content-encoding': 'gzip', 'content-length': body.length, 'content-type': 'text/plain'})
    res.end(req.method === 'HEAD' ? undefined : body)
  })
}

test('impit decodes gzip, deflate, br and zstd itself: the body is decoded once and content-encoding and content-length are removed', async t => {
  const server = compressingServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const node = await call(nodeApi, {url, gzip: true})
  const withGzip = await call(engine, {url, gzip: true})
  const without = await call(engine, {url})
  const nodeWithout = await call(nodeApi, {url, headers: {'accept-encoding': 'gzip'}, encoding: null})
  t.equal(node.body, 'compressed body')
  t.equal(node.res.headers['content-encoding'], 'gzip', 'Node keeps the header on the decoded response')
  t.equal(withGzip.err, null)
  t.equal(withGzip.body, 'compressed body')
  t.equal(withGzip.res.headers['content-encoding'], undefined)
  t.equal(withGzip.res.headers['content-length'], undefined)
  t.equal(withGzip.res.rawHeaders.indexOf('content-encoding'), -1)
  t.equal(withGzip.res.headers['content-type'], 'text/plain')
  t.equal(without.body, 'compressed body', 'decoded also without the gzip option')
  t.equal(without.res.headers['content-encoding'], undefined)
  t.ok(nodeWithout.body.equals(zlib.gzipSync('compressed body')), 'Node hands over the compressed bytes without the gzip option')
  await close(server)
})

test('a HEAD response and an encoding impit does not decode keep their headers; the core decodes GZIP with the gzip option', async t => {
  const server = compressingServer()
  const base = 'http://127.0.0.1:' + await listen(server)
  const head = await call(engine, {url: base + '/', method: 'HEAD'})
  const upper = await call(engine, {url: base + '/upper', gzip: true})
  t.equal(head.res.headers['content-encoding'], 'gzip')
  t.equal(head.res.headers['content-length'], String(zlib.gzipSync('compressed body').length))
  t.equal(upper.res.headers['content-encoding'], 'GZIP')
  t.equal(upper.body, 'compressed body')
  await close(server)
})

test('a truncated gzip body is an error, the lenient decoding of the core does not apply', async t => {
  const server = compressingServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/truncated'
  const node = await call(nodeApi, {url, gzip: true})
  const {err} = await call(engine, {url, gzip: true})
  t.equal(node.err, null)
  t.equal(node.body, 'compressed body')
  t.equal(err && err.code, 'Z_BUF_ERROR')
  t.equal(err && err.message, 'unexpected end of file')
  t.ok(err && err.cause, 'the error of impit is the cause')
  await close(server)
})

test('a raw deflate body is an error, the core would decode it', async t => {
  const server = compressingServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/raw-deflate'
  const node = await call(nodeApi, {url, gzip: true})
  const {err} = await call(engine, {url, gzip: true})
  t.equal(node.body, 'compressed body')
  t.equal(err && err.code, 'Z_DATA_ERROR')
  await close(server)
})

test('response: the reason phrase is the standard one, header names are lower case and sorted, repeated headers are joined, httpVersion is 1.1', async t => {
  const answer = 'HTTP/1.0 200 Custom Reason\r\nX-Zebra: 1\r\nX-Alpha: a\r\nSet-Cookie: one=1\r\nx-alpha: b\r\nSet-Cookie: two=2\r\nContent-Type: text/plain\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nok'
  const server = rawServer(socket => socket.end(answer))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const node = await call(nodeApi, {url})
  const {err, res} = await call(engine, {url})
  t.equal(err, null)
  t.equal(node.res.statusMessage, 'Custom Reason')
  t.equal(res.statusMessage, 'OK')
  t.equal(node.res.httpVersion, '1.0')
  t.equal(res.httpVersion, '1.1')
  t.deepEqual(node.res.rawHeaders.slice(0, 4), ['X-Zebra', '1', 'X-Alpha', 'a'])
  t.deepEqual(res.rawHeaders, ['content-length', '2', 'content-type', 'text/plain, text/html', 'x-alpha', 'a, b', 'x-zebra', '1', 'set-cookie', 'one=1', 'set-cookie', 'two=2'])
  t.equal(node.res.headers['content-type'], 'text/plain', 'Node keeps the first content-type')
  t.equal(res.headers['content-type'], 'text/plain, text/html')
  t.deepEqual(res.headers['set-cookie'], ['one=1', 'two=2'])
  t.equal(res.headers['x-alpha'], 'a, b')
  await close(server)
})

test('r.req is not a ClientRequest, r.agent is not set and a pool object is not filled', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const pool = {}
  const node = await call(nodeApi, {url, pool: {}})
  const {err, request} = await call(engine, {url, pool})
  t.equal(err, null)
  t.ok(node.request.req instanceof http.ClientRequest)
  t.ok(node.request.agent instanceof http.Agent)
  t.notOk(request.req instanceof http.ClientRequest)
  t.equal(request.agent, undefined)
  t.deepEqual(Object.keys(pool), [])
  const forever = await call(engine, {url, forever: true})
  t.equal(forever.request.agent, undefined, 'also with forever')
  await close(server)
})

test('a response used as a formData value makes form-data throw, as form-data reads the socket of a Node response', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const source = engine({url})
  const response = await new Promise(resolve => source.on('response', resolve))
  t.throws(() => engine.post({url, formData: {file: response}}), TypeError)
  response.resume()
  await close(server)
})

test('CONNECT to the proxy carries host and proxy-authorization only, Node also sends the white-listed request headers', async t => {
  const proxy = connectProxy()
  const proxyPort = await listen(proxy)
  const server = httpsServer()
  const url = 'https://localhost:' + await listen(server) + '/'
  const options = {url, strictSSL: false, proxy: 'http://user:pass@127.0.0.1:' + proxyPort, headers: {'User-Agent': 'probe', Accept: 'text/plain'}}
  const node = await call(nodeApi, options)
  const {err} = await call(engine, options)
  t.equal(node.err, null)
  t.equal(err, null)
  t.equal(proxy.connects[0].headers['user-agent'], 'probe', 'Node')
  t.deepEqual(Object.keys(proxy.connects[1].headers).sort(), ['host', 'proxy-authorization'])
  t.equal(server.seen[1].headers['user-agent'], 'probe', 'the target gets the request headers')
  await close(proxy)
  await close(server)
})

test('requests through a tunnel reuse its connection, Node opens a CONNECT for every request', async t => {
  const proxy = connectProxy()
  const proxyPort = await listen(proxy)
  const server = httpsServer()
  const url = 'https://localhost:' + await listen(server) + '/'
  const options = {url, strictSSL: false, proxy: 'http://127.0.0.1:' + proxyPort}
  await call(nodeApi, options)
  await call(nodeApi, options)
  t.equal(proxy.connects.length, 2, 'Node')
  await call(engine, options)
  await call(engine, options)
  t.equal(proxy.connects.length, 3, 'one CONNECT for both requests of the engine')
  await close(proxy)
  await close(server)
})

test('bytes a proxy sends after its 200 are dropped and the request succeeds, as in Node', async t => {
  const proxy = connectProxy({afterOk: 'stray bytes'})
  const proxyPort = await listen(proxy)
  const server = httpsServer()
  const url = 'https://localhost:' + await listen(server) + '/'
  const options = {url, strictSSL: false, proxy: 'http://127.0.0.1:' + proxyPort}
  const node = await call(nodeApi, options)
  const {err, body} = await call(engine, options)
  t.equal(node.err, null)
  t.equal(err, null)
  t.equal(body, 'ok')
  await close(proxy)
  await close(server)
})

async function withGlobalAgentOption (agent, name, value, run) {
  const had = Object.prototype.hasOwnProperty.call(agent.options, name)
  const before = agent.options[name]
  agent.options[name] = value
  try {
    return await run()
  } finally {
    if (had) {
      agent.options[name] = before
    } else {
      delete agent.options[name]
    }
  }
}

test('rejectUnauthorized of https.globalAgent.options applies as in Node; any other changed option of a global agent is refused', async t => {
  const secure = httpsServer()
  const secureUrl = 'https://localhost:' + await listen(secure) + '/'
  const plain = httpServer()
  const plainUrl = 'http://127.0.0.1:' + await listen(plain) + '/'
  const strict = await call(engine, {url: secureUrl})
  t.ok(strict.err, 'the certificate of an unknown ca is refused by default')
  const lenient = await withGlobalAgentOption(https.globalAgent, 'rejectUnauthorized', false, async () => {
    return {node: await call(nodeApi, {url: secureUrl}), engine: await call(engine, {url: secureUrl}), pool: await call(engine, {url: secureUrl, pool: {}})}
  })
  t.equal(lenient.node.err, null, 'Node reads rejectUnauthorized from https.globalAgent.options')
  t.equal(lenient.engine.err, null, 'the engine too')
  t.ok(lenient.pool.err, 'not for a request with a pool of its own, which does not use the global agent in Node either')
  const cases = [
    [https.globalAgent, 'ca', 'https.globalAgent.options.ca', secureUrl],
    [https.globalAgent, 'servername', 'https.globalAgent.options.servername', secureUrl],
    [https.globalAgent, 'family', 'https.globalAgent.options.family', secureUrl],
    [http.globalAgent, 'family', 'http.globalAgent.options.family', plainUrl],
    [http.globalAgent, 'localAddress', 'http.globalAgent.options.localAddress', plainUrl],
    [http.globalAgent, 'lookup', 'http.globalAgent.options.lookup', plainUrl],
    [http.globalAgent, 'keepAlive', 'http.globalAgent.options.keepAlive', plainUrl]
  ]
  for (const [agent, name, option, url] of cases) {
    const value = name === 'keepAlive' ? false : 'changed'
    const refused = await withGlobalAgentOption(agent, name, value, () => call(engine, {url, strictSSL: undefined}))
    t.equal(refused.err && refused.err.code, 'OPTION_NOT_SUPPORTED', option)
    t.equal(refused.err && refused.err.option, option)
    const own = await withGlobalAgentOption(agent, name, value, () => call(engine, {url, strictSSL: false, pool: {}}))
    t.equal(own.err, null, option + ' is not read for a request that does not use the global agent')
  }
  const envProxy = await withGlobalAgentOption(http.globalAgent, 'proxyEnv', {HTTP_PROXY: 'http://127.0.0.1:9'}, async () => {
    return {direct: await call(engine, {url: plainUrl}), own: await call(engine, {url: plainUrl, pool: {}})}
  })
  t.equal(envProxy.direct.err && envProxy.direct.err.option, 'http.globalAgent.options.proxyEnv', 'the proxy of NODE_USE_ENV_PROXY')
  t.equal(envProxy.own.err, null)
  await close(secure)
  await close(plain)
})

test('http.globalAgent.maxSockets limits the requests in flight per host where Node would use the global agent', async t => {
  let running = 0
  let most = 0
  const server = httpServer((req, res) => {
    running++
    most = Math.max(most, running)
    setTimeout(() => {
      running--
      res.end('ok')
    }, 40)
  })
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const before = http.globalAgent.maxSockets
  http.globalAgent.maxSockets = 1
  const results = await Promise.all([1, 2, 3].map(() => call(engine, {url})))
  http.globalAgent.maxSockets = before
  t.deepEqual(results.map(result => result.err), [null, null, null])
  t.equal(most, 1)
  await close(server)
})

test('NODE_EXTRA_CA_CERTS does not reach impit: its certificate store decides', async t => {
  const server = httpsServer()
  const url = 'https://localhost:' + await listen(server) + '/'
  const outcomes = await inChildProcess('main', [{url}], {NODE_EXTRA_CA_CERTS: path.join(ssl, 'ca', 'ca.crt')})
  t.deepEqual(outcomes[0].node, {body: 'ok'})
  t.ok(outcomes[0].engine.error, outcomes[0].engine.error)
  await close(server)
})

test('a response with status 3xx, 401 or 407 is announced when its body has ended, at the latest 50 ms after its headers', async t => {
  const server = rawServer((socket, received) => {
    const status = /^GET \/(\d+)/.exec(received)[1]
    socket.write('HTTP/1.1 ' + status + ' Status\r\nContent-Length: 4\r\nConnection: close\r\n\r\n')
    setTimeout(() => socket.end('late'), status === '204' ? 0 : 400)
  })
  const base = 'http://127.0.0.1:' + await listen(server)
  async function headersAfter (api, status) {
    const started = Date.now()
    const r = api({url: base + '/' + status, followRedirect: false})
    const body = new Promise(resolve => r.on('complete', (res, text) => resolve(text)))
    await new Promise(resolve => r.on('response', resolve))
    const elapsed = Date.now() - started
    await body
    return elapsed
  }
  const node = await headersAfter(nodeApi, 401)
  const other = await headersAfter(engine, 200)
  const waited = []
  for (const status of [302, 401, 407]) {
    waited.push(await headersAfter(engine, status))
  }
  const shortest = Math.min.apply(Math, waited)
  t.ok(node < shortest, 'Node announces a 401 with its headers: ' + node + ' ms')
  t.ok(other < shortest, 'the engine announces a 200 with its headers: ' + other + ' ms')
  waited.forEach(elapsed => t.ok(elapsed >= 45 && elapsed < 380, 'after the wait for the body, before its end: ' + elapsed + ' ms'))
  const complete = await call(engine, {url: base + '/401'})
  t.equal(complete.body, 'late', 'the body that came after the wait is delivered')
  await close(server)
})

async function connectionsAfterTwoRequestsAtOnce (api) {
  const server = httpsServer()
  const sockets = new Set()
  const carried = new Set()
  server.on('secureConnection', socket => sockets.add(socket))
  server.prependListener('request', req => carried.add(req.socket))
  const url = 'https://localhost:' + await listen(server) + '/'
  await call(api, {url, strictSSL: false})
  await Promise.all([call(api, {url, strictSSL: false}), call(api, {url, strictSSL: false})])
  await wait(100)
  const spare = Array.from(sockets).filter(socket => !carried.has(socket) && !socket.destroyed)
  let closed = false
  server.close(() => {
    closed = true
  })
  await wait(300)
  const closedInTime = closed
  spare.forEach(socket => socket.destroy())
  await wait(100)
  const closedWithoutSpare = closed
  sockets.forEach(socket => socket.destroy())
  return {connections: sockets.size, spare: spare.length, closedInTime, closedWithoutSpare}
}

async function closeWaitsForAConnectionWithoutRequest () {
  const server = httpsServer()
  const port = await listen(server)
  const socket = tls.connect({port, host: '127.0.0.1', rejectUnauthorized: false})
  await new Promise(resolve => socket.once('secureConnect', resolve))
  await wait(100)
  let closed = false
  server.close(() => {
    closed = true
  })
  await wait(300)
  const waits = !closed
  socket.destroy()
  return waits
}

test('impit may open a connection that never carries a request, and server.close() waits for it where Node waits for a connection without a request', async t => {
  const node = await connectionsAfterTwoRequestsAtOnce(nodeApi)
  const impit = await connectionsAfterTwoRequestsAtOnce(engine)
  t.equal(node.spare, 0, 'Node: every connection carries a request')
  t.equal(node.closedInTime, true, 'Node: server.close() calls back')
  t.equal(impit.connections, 2, 'the second request starts a connection while the first is busy')
  t.equal(impit.spare, 1, 'and is sent on the first one, which became free before the TLS handshake of the second ended')
  const waits = await closeWaitsForAConnectionWithoutRequest()
  t.comment('server.close() of Node ' + process.versions.node + (waits ? ' waits for' : ' closes') + ' a connection without a request')
  t.equal(impit.closedInTime, !waits, 'server.close() treats the spare connection as it treats any connection without a request')
  t.equal(impit.closedWithoutSpare, true, 'it does once the spare connection is closed')
})

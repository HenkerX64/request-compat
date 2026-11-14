'use strict'

const http = require('http')
const library = require('impit')
const engine = require('../index')
const {instanceCount, instanceFor} = require('../lib/instances')
const {forwardingProxy, connectProxy} = require('./proxy-servers')
const socks5Server = require('./socks5-server')
const {test, listen, close, call, httpServer, httpsServer, inChildProcess, trusted} = require('./helpers')

const Impit = library.Impit

test('browser sends the headers of that browser and the caller\'s headers win', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const plain = await call(engine, {url})
  const chrome = await call(engine, {url, browser: 'chrome'})
  const own = await call(engine, {url, browser: 'chrome', headers: {'User-Agent': 'mine', Accept: 'text/plain'}})
  t.equal(plain.err, null)
  t.equal(chrome.err, null)
  t.equal(own.err, null)
  t.equal(server.seen[0].headers['user-agent'], undefined, 'no user-agent without browser')
  t.ok(/Chrome\//.test(server.seen[1].headers['user-agent']), 'the user-agent of Chrome')
  t.ok(server.seen[1].headers['sec-ch-ua'], 'client hints of Chrome')
  t.equal(server.seen[2].headers['user-agent'], 'mine')
  t.equal(server.seen[2].headers.accept, 'text/plain')
  t.ok(server.seen[2].headers['sec-ch-ua'], 'the other browser headers stay')
  await close(server)
})

test('an empty header value removes a browser header', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const {err} = await call(engine, {url, browser: 'chrome', headers: {'sec-ch-ua': '', 'accept-language': ''}})
  t.equal(err, null)
  t.equal(server.seen[0].headers['sec-ch-ua'], undefined)
  t.equal(server.seen[0].headers['accept-language'], undefined)
  t.ok(server.seen[0].headers['user-agent'])
  await close(server)
})

function http2Server (respond) {
  const http2 = require('http2')
  const server = http2.createSecureServer(Object.assign({allowHTTP1: true}, trusted), (req, res) => {
    server.seen.push({version: req.httpVersion, names: req.rawHeaders.filter((value, index) => index % 2 === 0)})
    respond(req, res)
  })
  server.seen = []
  server.sessions = []
  server.on('session', session => server.sessions.push(session))
  return server
}

async function closeHttp2 (server) {
  server.sessions.forEach(session => session.destroy())
  await close(server)
}

test('browser negotiates HTTP/2 with a server that offers it, without browser the request is HTTP/1.1', async t => {
  const server = http2Server((req, res) => res.end('ok'))
  const url = 'https://localhost:' + await listen(server) + '/'
  const plain = await call(engine, {url, strictSSL: false})
  const chrome = await call(engine, {url, strictSSL: false, browser: 'chrome'})
  t.equal(plain.err, null)
  t.equal(chrome.err, null)
  t.deepEqual(server.seen.map(entry => entry.version), ['1.1', '2.0'])
  t.equal(chrome.res.httpVersion, '1.1', 'the response still says 1.1: impit does not expose the protocol')
  await closeHttp2(server)
})

test('browser over HTTP/2 sends the header list of impit itself: no host header beside :authority', async t => {
  const server = http2Server((req, res) => res.end('ok'))
  const url = 'https://localhost:' + await listen(server) + '/'
  const own = new Impit({browser: 'chrome', ignoreTlsErrors: true})
  const direct = await own.fetch(url)
  await direct.text()
  const {err} = await call(engine, {url, strictSSL: false, browser: 'chrome'})
  const named = await call(engine, {url, strictSSL: false, browser: 'chrome', headers: {Host: 'localhost'}})
  t.equal(err, null)
  t.equal(named.err, null)
  t.deepEqual(server.seen.map(entry => entry.version), ['2.0', '2.0', '2.0'])
  t.deepEqual(server.seen[1].names, server.seen[0].names, 'the names and their order are those of impit.fetch()')
  t.equal(server.seen[1].names.indexOf('host'), -1)
  t.deepEqual(server.seen[1].names.slice(0, 4), [':method', ':authority', ':scheme', ':path'])
  t.notEqual(server.seen[2].names.indexOf('host'), -1, 'a host header of the caller is sent')
  await closeHttp2(server)
})

test('maxSockets limits requests in flight, not connections: over HTTP/2 the requests to a host share one connection', async t => {
  let running = 0
  let most = 0
  const server = http2Server((req, res) => {
    running++
    most = Math.max(most, running)
    setTimeout(() => {
      running--
      res.end('ok')
    }, 60)
  })
  const url = 'https://localhost:' + await listen(server) + '/'
  const options = {url, strictSSL: false, browser: 'chrome'}
  await call(engine, options)
  const free = await Promise.all([1, 2, 3].map(() => call(engine, options)))
  t.deepEqual(free.map(result => result.err), [null, null, null])
  t.equal(most, 3, 'three requests in flight')
  t.equal(server.sessions.length, 1, 'on one connection')
  most = 0
  const pool = {maxSockets: 1}
  const limited = await Promise.all([1, 2, 3].map(() => call(engine, Object.assign({pool}, options))))
  t.deepEqual(limited.map(result => result.err), [null, null, null])
  t.equal(most, 1, 'pool.maxSockets: 1 sends one request at a time')
  t.equal(server.sessions.length, 1, 'still on that connection')
  await closeHttp2(server)
})

test('an unknown browser is the error of impit, from send', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const {err, res} = await call(engine, {url, browser: 'netscape'})
  t.ok(err instanceof Error)
  t.ok(/Browser/.test(err.message), err.message)
  t.equal(res, undefined)
  t.equal(server.seen.length, 0)
  await close(server)
})

test('requests with the same configuration share one instance and its connections, another configuration gets its own', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const before = instanceCount()
  await call(engine, {url, browser: 'firefox'})
  await call(engine, {url, browser: 'firefox'})
  t.equal(instanceCount(), before + 1, 'one instance for two requests')
  await call(engine, {url, browser: 'firefox', strictSSL: false})
  t.equal(instanceCount(), before + 2, 'another TLS setting is another instance')
  t.equal(server.seen[0].port, server.seen[1].port, 'same configuration, same connection')
  t.notEqual(server.seen[2].port, server.seen[1].port, 'another configuration, another connection')
  await close(server)
})

test('at most 64 instances are kept, the least recently used one is dropped', async t => {
  const first = instanceFor({localAddress: '127.1.0.1'})
  t.equal(instanceFor({localAddress: '127.1.0.1'}), first, 'the same configuration gives the same instance')
  for (let i = 2; i <= 64; i++) {
    instanceFor({localAddress: '127.1.0.' + i})
  }
  t.equal(instanceCount(), 64)
  t.equal(instanceFor({localAddress: '127.1.0.1'}), first, 'used again, so it is the most recent one')
  instanceFor({localAddress: '127.1.0.65'})
  t.equal(instanceCount(), 64)
  t.equal(instanceFor({localAddress: '127.1.0.1'}), first, 'the recently used instance stays')
  t.notEqual(instanceFor({oneOff: true, localAddress: '127.1.0.1'}), first, 'a request with a connection of its own never uses a kept instance')
  t.equal(instanceCount(), 64)
})

test('impit: the caller\'s instance sends every hop, redirects stay with the core', async t => {
  const server = httpServer((req, res) => {
    if (req.url === '/from') {
      res.writeHead(302, {location: '/to', 'set-cookie': 'hop=1'})
      return res.end()
    }
    res.end('arrived')
  })
  const url = 'http://127.0.0.1:' + await listen(server) + '/from'
  const calls = []
  const instance = new Impit({browser: 'firefox', followRedirects: true, timeout: 50})
  const fetch = instance.fetch.bind(instance)
  instance.fetch = (target, init) => {
    calls.push({target, redirect: init.redirect, timeout: init.timeout})
    return fetch(target, init)
  }
  const jar = engine.jar()
  const client = engine.defaults({impit: instance, jar})
  const {err, res, body} = await call(client, {url})
  t.equal(err, null)
  t.equal(body, 'arrived')
  t.equal(res.request.uri.path, '/to')
  t.deepEqual(calls.map(entry => entry.redirect), ['manual', 'manual'], 'the core follows the redirect, hop by hop')
  t.deepEqual(calls.map(entry => entry.timeout), [null, null], 'the timeout of the instance is switched off, the timeout option decides')
  t.ok(/Firefox\//.test(server.seen[1].headers['user-agent']), 'the browser of the instance')
  t.equal(server.seen[1].headers.cookie, 'hop=1', 'cookies come from the jar of the core')
  await close(server)
})

test('impit: options the instance decides are refused, a value without fetch is INVALID_IMPIT', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const instance = new Impit({})
  const refused = [
    ['proxy', {proxy: 'http://127.0.0.1:9'}],
    ['pool', {pool: {}}],
    ['pool', {pool: false}],
    ['agentOptions', {agentOptions: {keepAlive: true}}],
    ['browser', {browser: 'chrome'}],
    ['strictSSL', {strictSSL: false}],
    ['rejectUnauthorized', {rejectUnauthorized: false}],
    ['localAddress', {localAddress: '127.0.0.1'}]
  ]
  for (const [option, options] of refused) {
    const {err} = await call(engine, Object.assign({url, impit: instance}, options))
    t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', option)
    t.equal(err && err.option, option)
  }
  for (const value of [{}, 'chrome', 1, {fetch: 'no function'}]) {
    const {err} = await call(engine, {url, impit: value})
    t.ok(err instanceof TypeError, 'TypeError for ' + JSON.stringify(value))
    t.equal(err && err.code, 'INVALID_IMPIT')
  }
  t.equal(server.seen.length, 0)
  const accepted = await call(engine, {url, impit: instance, proxy: null, forever: true, agent: false})
  t.equal(accepted.err, null, 'proxy: null, forever and agent: false are fine')
  await close(server)
})

test('impit: a proxy from the environment is refused, proxy: null leaves the proxy to the instance', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const instance = new Impit({})
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
  const refused = await call(engine, {url, impit: instance})
  const direct = await call(engine, {url, impit: instance, proxy: null})
  delete process.env.HTTP_PROXY
  t.equal(refused.err && refused.err.option, 'proxy')
  t.equal(direct.err, null)
  await close(server)
})

test('strictSSL: false, rejectUnauthorized: false and NODE_TLS_REJECT_UNAUTHORIZED=0 accept an unknown certificate, the default does not', async t => {
  const server = httpsServer()
  const url = 'https://localhost:' + await listen(server) + '/'
  const strict = await call(engine, {url})
  t.ok(strict.err, 'the certificate of an unknown ca is refused')
  t.equal(strict.res, undefined)
  for (const options of [{strictSSL: false}, {rejectUnauthorized: false}, {agentOptions: {rejectUnauthorized: false}}]) {
    const {err, body} = await call(engine, Object.assign({url}, options))
    t.equal(err, null, JSON.stringify(options))
    t.equal(body, 'ok')
  }
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const byEnvironment = await call(engine, {url})
  const decided = await call(engine, {url, rejectUnauthorized: true})
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  t.equal(byEnvironment.err, null, 'the environment variable works as in Node')
  t.ok(decided.err, 'rejectUnauthorized: true wins over the environment variable, as in Node')
  await close(server)
})

test('localAddress binds the connection', async t => {
  const addresses = []
  const server = http.createServer((req, res) => {
    addresses.push(req.socket.remoteAddress)
    res.end('ok')
  })
  const url = 'http://127.0.0.1:' + await listen(server, '0.0.0.0') + '/'
  const {err} = await call(engine, {url, localAddress: '127.0.0.2'})
  t.equal(err, null)
  t.deepEqual(addresses, ['127.0.0.2'])
  const unbound = await call(engine, {url, localAddress: '192.0.2.1'})
  t.equal(unbound.err && unbound.err.code, 'EADDRNOTAVAIL')
  t.equal(unbound.err && unbound.err.syscall, 'bind')
  await close(server)
})

test('pool: false and agentOptions.keepAlive: false open a connection per request and send connection: close', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  await call(engine, {url, pool: false})
  await call(engine, {url, pool: false})
  await call(engine, {url, agentOptions: {keepAlive: false}})
  await call(engine, {url, agentOptions: {keepAlive: false}, forever: true})
  await call(engine, {url})
  t.equal(new Set(server.seen.slice(0, 3).map(entry => entry.port)).size, 3, 'three connections')
  t.deepEqual(server.seen.map(entry => entry.headers.connection), ['close', 'close', 'close', undefined, undefined])
  await close(server)
})

test('an http target goes through the proxy as a forwarded request with the credentials of the proxy URL', async t => {
  const proxy = forwardingProxy()
  const proxyPort = await listen(proxy)
  const {err, body} = await call(engine, {url: 'http://target.test/path?x=1', proxy: 'http://user:p%40ss@127.0.0.1:' + proxyPort, headers: {'X-Own': '1'}})
  t.equal(err, null)
  t.equal(body, 'via proxy http://target.test/path?x=1')
  t.equal(proxy.seen[0].headers.host, 'target.test')
  t.equal(proxy.seen[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('user:p@ss').toString('base64'))
  t.equal(proxy.seen[0].headers['x-own'], '1')
  await close(proxy)
})

test('the proxy of the environment and NO_PROXY are resolved by the core', async t => {
  const proxy = forwardingProxy()
  const proxyPort = await listen(proxy)
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/direct'
  process.env.HTTP_PROXY = 'http://127.0.0.1:' + proxyPort
  const proxied = await call(engine, {url: 'http://target.test/env'})
  process.env.NO_PROXY = '127.0.0.1'
  const direct = await call(engine, {url})
  delete process.env.HTTP_PROXY
  delete process.env.NO_PROXY
  t.equal(proxied.body, 'via proxy http://target.test/env')
  t.equal(direct.body, 'ok')
  t.equal(proxy.seen.length, 1)
  await close(proxy)
  await close(server)
})

test('impit never applies the proxy variables itself: the proxy the core resolved is the only one', async t => {
  const proxy = forwardingProxy()
  const proxyUrl = 'http://127.0.0.1:' + await listen(proxy)
  const server = httpServer((req, res) => res.end('direct'))
  const port = await listen(server)
  const url = 'http://127.0.0.1:' + port + '/'
  const rows = [
    ['HTTP_PROXY and proxy: null', {HTTP_PROXY: proxyUrl}, {url, proxy: null}, 'direct'],
    ['HTTP_PROXY and proxy: false', {HTTP_PROXY: proxyUrl}, {url, proxy: false}, 'direct'],
    ['ALL_PROXY, which the core does not read', {ALL_PROXY: proxyUrl}, {url}, 'direct'],
    ['all_proxy', {all_proxy: proxyUrl}, {url}, 'direct'],
    ['HTTP_PROXY and a NO_PROXY entry with a port', {HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1:' + port}, {url}, 'direct'],
    ['HTTP_PROXY', {HTTP_PROXY: proxyUrl}, {url}, 'via proxy ' + url]
  ]
  const cleared = {HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: ''}
  for (const [name, env, options, body] of rows) {
    const outcomes = await inChildProcess('main', [options], Object.assign({}, cleared, env))
    t.deepEqual(outcomes[0].node, {body}, name + ': Node')
    t.deepEqual(outcomes[0].engine, {body}, name + ': the engine, in a process that starts with the variables')
  }
  await close(proxy)
  await close(server)
})

test('in a worker thread with its own environment the engine refuses a request without proxy while the process has a proxy variable', async t => {
  const proxy = forwardingProxy()
  const proxyUrl = 'http://127.0.0.1:' + await listen(proxy)
  const server = httpServer((req, res) => res.end('direct'))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const cleared = {HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '', https_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: ''}
  const withProxy = Object.assign({}, cleared, {HTTP_PROXY: proxyUrl})
  const refused = {error: 'OPTION_NOT_SUPPORTED', option: 'proxy'}
  const viaProxy = {body: 'via proxy ' + url}
  const direct = {body: 'direct'}
  const rows = [
    ['a copy of the environment, proxy: null', withProxy, null, {url, proxy: null}, direct, refused],
    ['a copy of the environment', withProxy, null, {url}, viaProxy, viaProxy],
    ['an environment without the variable', withProxy, {HTTP_PROXY: null}, {url}, direct, refused],
    ['an environment without the variable, proxy option', withProxy, {HTTP_PROXY: null}, {url, proxy: proxyUrl}, viaProxy, viaProxy],
    ['the variable only in the environment of the worker, proxy: null', cleared, {HTTP_PROXY: proxyUrl}, {url, proxy: null}, direct, direct],
    ['the variable only in the environment of the worker', cleared, {HTTP_PROXY: proxyUrl}, {url}, viaProxy, viaProxy],
    ['SHARE_ENV, proxy: null', withProxy, 'shared', {url, proxy: null}, direct, direct],
    ['SHARE_ENV', withProxy, 'shared', {url}, viaProxy, viaProxy],
    ['no variable', cleared, null, {url}, direct, direct]
  ]
  for (const [name, env, workerEnv, options, node, impit] of rows) {
    const outcomes = await inChildProcess('worker', [options], env, workerEnv)
    t.deepEqual(outcomes[0].node, node, name + ': Node')
    t.deepEqual(outcomes[0].engine, impit, name + ': the engine')
  }
  await close(proxy)
  await close(server)
})

test('an https target is tunnelled with CONNECT and the credentials of the proxy URL or of a Basic proxy-authorization header', async t => {
  const proxy = connectProxy()
  const proxyPort = await listen(proxy)
  const server = httpsServer()
  const url = 'https://localhost:' + await listen(server) + '/secure'
  const byUrl = await call(engine, {url, strictSSL: false, proxy: 'http://user:pass@127.0.0.1:' + proxyPort, headers: {'X-Own': '1'}})
  const byHeader = await call(engine, {url, strictSSL: false, proxy: 'http://127.0.0.1:' + proxyPort, headers: {'Proxy-Authorization': 'Basic ' + Buffer.from('other:secret').toString('base64')}})
  t.equal(byUrl.err, null)
  t.equal(byUrl.body, 'ok')
  t.equal(byHeader.err, null)
  t.equal(proxy.connects[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('user:pass').toString('base64'))
  t.equal(proxy.connects[1].headers['proxy-authorization'], 'Basic ' + Buffer.from('other:secret').toString('base64'))
  t.equal(server.seen[0].headers['x-own'], '1')
  t.equal(server.seen[0].headers['proxy-authorization'], undefined, 'the target never sees the proxy credentials')
  t.equal(server.seen[1].headers['proxy-authorization'], undefined)
  await close(proxy)
  await close(server)
})

test('a socks5 or socks5h proxy URL is spoken as SOCKS by impit for an https target; for an http target the core refuses the protocol', async t => {
  const socks = socks5Server()
  const socksPort = await listen(socks)
  const server = httpsServer()
  const port = await listen(server)
  const {err, body} = await call(engine, {url: 'https://127.0.0.1:' + port + '/', strictSSL: false, proxy: 'socks5://127.0.0.1:' + socksPort})
  t.equal(err, null)
  t.equal(body, 'ok')
  t.deepEqual(socks.seen, ['127.0.0.1:' + port])
  const plain = await call(engine, {url: 'http://127.0.0.1:' + port + '/', proxy: 'socks5://127.0.0.1:' + socksPort})
  t.equal(plain.err && plain.err.message, 'Invalid protocol: socks5:', 'the error of the core, raised in init before the transport is asked')
  const local = await call(engine, {url: 'https://localhost:' + port + '/', strictSSL: false, proxy: 'socks5://127.0.0.1:' + socksPort})
  const remote = await call(engine, {url: 'https://localhost:' + port + '/', strictSSL: false, proxy: 'socks5h://127.0.0.1:' + socksPort})
  t.equal(local.err, null)
  t.equal(remote.err, null)
  t.notEqual(socks.seen[1], 'localhost:' + port, 'socks5: impit resolves the name itself and hands the proxy an address: ' + socks.seen[1])
  t.equal(socks.seen[2], 'localhost:' + port, 'socks5h: the proxy resolves the name')
  await close(socks)
  await close(server)
})

test('proxy options the engine cannot honour are refused', async t => {
  const proxy = connectProxy()
  const proxyUrl = 'http://127.0.0.1:' + await listen(proxy)
  const cases = [
    ['tunnel', {url: 'http://target.test/', proxy: proxyUrl, tunnel: true}],
    ['tunnel', {url: 'https://target.test/', proxy: proxyUrl, tunnel: false}],
    ['proxyHeaderWhiteList', {url: 'https://target.test/', proxy: proxyUrl, proxyHeaderWhiteList: ['x-own']}],
    ['proxyHeaderExclusiveList', {url: 'https://target.test/', proxy: proxyUrl, proxyHeaderExclusiveList: ['x-own']}],
    ['headers.proxy-authorization', {url: 'https://target.test/', proxy: proxyUrl, headers: {'proxy-authorization': 'Bearer token'}}],
    ['proxy', {url: 'https://target.test/', proxy: 'ftp://127.0.0.1:9'}]
  ]
  for (const [option, options] of cases) {
    const {err} = await call(engine, options)
    t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', option)
    t.equal(err && err.option, option)
  }
  t.equal(proxy.connects.length, 0)
  const forwarded = await call(engine, {url: 'http://target.test/', proxy: proxyUrl, proxyHeaderWhiteList: ['x-own']})
  t.equal(forwarded.err, null, 'the lists are not used for a forwarded request, as in Node')
  await close(proxy)
})

function countingServer (delay) {
  const server = httpServer((req, res) => {
    server.running++
    server.most = Math.max(server.most, server.running)
    setTimeout(() => {
      server.running--
      res.end('ok')
    }, delay)
  })
  server.running = 0
  server.most = 0
  return server
}

test('pool.maxSockets and agentOptions.maxSockets limit the requests in flight per host, a queued request starts its timeout when it gets its turn', async t => {
  const server = countingServer(60)
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const pool = {maxSockets: 2}
  const pooled = await Promise.all([1, 2, 3, 4, 5].map(() => call(engine, {url, pool, timeout: 150})))
  t.deepEqual(pooled.map(result => result.err), [null, null, null, null, null], 'no request timed out while it waited')
  t.equal(server.most, 2, 'pool.maxSockets: 2')
  server.most = 0
  const byAgentOptions = await Promise.all([1, 2, 3].map(() => call(engine, {url, agentOptions: {maxSockets: 1}})))
  t.deepEqual(byAgentOptions.map(result => result.err), [null, null, null])
  t.equal(server.most, 1, 'agentOptions.maxSockets: 1')
  server.most = 0
  await Promise.all([1, 2, 3].map(() => call(engine, {url})))
  t.equal(server.most, 3, 'no limit without the option')
  await close(server)
})

test('abort() of a queued request frees its place and sends nothing', async t => {
  const server = countingServer(80)
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const pool = {maxSockets: 1}
  const first = call(engine, {url, pool})
  const queued = engine({url, pool})
  const third = call(engine, {url, pool})
  queued.abort()
  const results = await Promise.all([first, third])
  t.deepEqual(results.map(result => result.err), [null, null])
  t.equal(server.seen.length, 2)
  await close(server)
})

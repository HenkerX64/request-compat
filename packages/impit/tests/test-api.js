'use strict'

const http = require('http')
const https = require('https')
const nodeApi = require('request-compat')
const nodeRequest = require('request-compat/request')
const engine = require('../index')
const {nodeVersionError} = require('../lib/errors')
const {TLS_OPTIONS, REQUEST_ONLY_OPTIONS, CONNECTION_OPTIONS} = require('../lib/options')
const {test, listen, close, call, httpServer, httpsServer, ca} = require('./helpers')

const {AbortController} = global

test('a Node below 20 gets NODE_VERSION_NOT_SUPPORTED from the version check that index.js runs on require', async t => {
  ;['8.17.0', '18.20.4', '19.9.0'].forEach(version => {
    const err = nodeVersionError(version)
    t.ok(err instanceof Error, version)
    t.equal(err && err.code, 'NODE_VERSION_NOT_SUPPORTED', version)
    t.equal(err && err.message, 'request-compat-impit needs Node >= 20', version)
  })
  ;['20.0.0', '22.11.0', '24.11.1', '26.0.0', process.versions.node].forEach(version => {
    t.equal(nodeVersionError(version), null, version)
  })
})

test('the engine exports the same API as the core', async t => {
  t.deepEqual(Object.keys(engine), Object.keys(nodeApi))
  t.ok(engine.Request.prototype instanceof nodeRequest)
  ;['get', 'head', 'options', 'post', 'put', 'patch', 'del', 'delete', 'defaults', 'forever', 'jar', 'cookie'].forEach(name => {
    t.equal(typeof engine[name], 'function', name)
  })
})

const REFUSED = [
  ['agent', {agent: new http.Agent()}],
  ['agent', {agent: true}],
  ['agentClass', {agentClass: http.Agent}],
  ['httpModules', {httpModules: {'http:': http, 'https:': https}}],
  ['pool', {pool: {'http:': new http.Agent()}}],
  ['pool.maxSockets', {pool: {maxSockets: -1}}],
  ['agentOptions.maxSockets', {agentOptions: {maxSockets: 'none'}}],
  ['socketPath', {url: 'http://unix:/tmp/request-compat-none.sock:/path'}],
  ['agentOptions.foo', {agentOptions: {foo: 'bar'}}],
  ['family', {family: 4}],
  ['lookup', {lookup: () => undefined}],
  ['localPort', {localPort: 43999}],
  ['socket', {socket: {}}],
  ['signal', {signal: new AbortController().signal}],
  ['createConnection', {createConnection: () => undefined}],
  ['insecureHTTPParser', {insecureHTTPParser: true}],
  ['maxHeaderSize', {maxHeaderSize: 100}],
  ['session', {session: Buffer.from('session')}],
  ['ALPNProtocols', {ALPNProtocols: ['http/1.1']}],
  ['method', {method: 'PROPFIND'}],
  ['method', {method: 'CONNECT'}],
  ['body', {method: 'GET', body: 'data'}],
  ['body', {method: 'GET', json: {a: 1}}],
  ['headers.upgrade', {headers: {Upgrade: 'websocket'}}]
]

const REFUSED_WITH_TLS = [
  ['agentOptions.ca', {agentOptions: {ca}}],
  ['ca', {ca}],
  ['cert', {cert: 'cert'}],
  ['key', {key: 'key'}],
  ['pfx', {pfx: Buffer.from('pfx')}],
  ['passphrase', {passphrase: 'secret'}],
  ['servername', {servername: 'other.test'}],
  ['checkServerIdentity', {checkServerIdentity: () => undefined}],
  ['ciphers', {ciphers: 'AES256-SHA'}],
  ['secureProtocol', {secureProtocol: 'TLSv1_2_method'}],
  ['secureOptions', {secureOptions: 1}],
  ['minVersion', {minVersion: 'TLSv1.2'}],
  ['maxVersion', {maxVersion: 'TLSv1.2'}]
]

function assertRefused (t, result, option) {
  const {err, res} = result
  t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', option + ' code')
  t.equal(err && err.option, option, option + ' option')
  t.ok(err && err.message.indexOf('request-compat-impit does not support the option ' + option) === 0, option + ' message')
  t.equal(res, undefined, option + ' no response')
}

test('options the engine cannot honour are refused from send before anything is sent', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  for (const [option, options] of REFUSED) {
    assertRefused(t, await call(engine, Object.assign({url}, options)), option)
  }
  t.equal(server.seen.length, 0, 'nothing reached the server')
  await close(server)
})

test('TLS options are refused on a hop with TLS: an https target, or any target through an https proxy', async t => {
  const server = httpsServer()
  const port = await listen(server)
  const url = 'https://localhost:' + port + '/'
  for (const [option, options] of REFUSED_WITH_TLS) {
    assertRefused(t, await call(engine, Object.assign({url, strictSSL: false}, options)), option)
  }
  assertRefused(t, await call(engine, {url: 'http://target.test/', proxy: 'https://127.0.0.1:' + port, ca}), 'ca')
  assertRefused(t, await call(engine, {url, proxy: 'http://127.0.0.1:' + port, ca}), 'ca')
  t.equal(server.seen.length, 0, 'nothing reached the server')
  await close(server)
})

test('TLS options are ignored on a hop without TLS, as in Node, and refused on the https hop of a redirect', async t => {
  const secure = httpsServer()
  const securePort = await listen(secure)
  const server = httpServer((req, res) => {
    if (req.url === '/to-https') {
      res.writeHead(302, {location: 'https://localhost:' + securePort + '/'})
      return res.end()
    }
    res.end('ok')
  })
  const base = 'http://127.0.0.1:' + await listen(server)
  for (const [option, options] of REFUSED_WITH_TLS) {
    const node = await call(nodeApi, Object.assign({url: base + '/'}, options))
    const {err, body} = await call(engine, Object.assign({url: base + '/'}, options))
    t.equal(node.err, null, option + ' Node')
    t.equal(err, null, option)
    t.equal(body, 'ok', option)
  }
  assertRefused(t, await call(engine, {url: base + '/to-https', ca}), 'ca')
  t.equal(secure.seen.length, 0, 'nothing reached the https server')
  await close(server)
  await close(secure)
})

test('every option name of the refusal lists is refused under its own name', async t => {
  const server = httpServer()
  const port = await listen(server)
  const names = REQUEST_ONLY_OPTIONS.concat(CONNECTION_OPTIONS)
  t.equal(TLS_OPTIONS.length + names.length, 60, 'the number of names the README lists')
  for (const name of names) {
    assertRefused(t, await call(engine, {url: 'http://127.0.0.1:' + port + '/', [name]: 1}), name)
  }
  for (const name of TLS_OPTIONS) {
    assertRefused(t, await call(engine, {url: 'https://127.0.0.1:' + port + '/', [name]: 1}), name)
  }
  t.equal(server.seen.length, 0, 'nothing reached the server')
  await close(server)
})

test('a refusal is an error event, not a throw, also without a callback', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const r = engine({url, family: 4})
  const err = await new Promise(resolve => r.on('error', resolve))
  t.equal(err.code, 'OPTION_NOT_SUPPORTED')
  t.equal(err.option, 'family')
  t.equal(r.req, undefined, 'no exchange was created')
  await close(server)
})

test('a refusal on the hop after a redirect comes from send of that hop', async t => {
  const target = httpServer()
  const targetPort = await listen(target)
  const first = httpServer((req, res) => {
    res.writeHead(302, {location: 'http://127.0.0.1:' + targetPort + '/next'})
    res.end()
  })
  const url = 'http://127.0.0.1:' + await listen(first) + '/'
  const r = engine({url})
  r.on('redirect', () => {
    r.method = 'PROPFIND'
  })
  const err = await new Promise(resolve => r.on('error', resolve))
  t.equal(err.code, 'OPTION_NOT_SUPPORTED')
  t.equal(err.option, 'method')
  t.equal(first.seen.length, 1)
  t.equal(target.seen.length, 0)
  await close(first)
  await close(target)
})

test('options that have an equivalent are accepted', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const accepted = [
    {agent: false},
    {forever: true},
    {pool: {}},
    {pool: false},
    {agentOptions: {keepAlive: true, keepAliveMsecs: 1000, maxFreeSockets: 4, scheduling: 'fifo'}},
    {agentOptions: {keepAlive: false}},
    {strictSSL: true},
    {rejectUnauthorized: false},
    {time: true},
    {timeout: 5000},
    {gzip: true}
  ]
  for (const options of accepted) {
    const {err, res, body} = await call(engine, Object.assign({url}, options))
    t.equal(err, null, JSON.stringify(options))
    t.equal(res && res.statusCode, 200)
    t.equal(body, 'ok')
  }
  const forever = await call(engine.forever(), {url})
  t.equal(forever.err, null, 'request.forever()')
  await close(server)
})

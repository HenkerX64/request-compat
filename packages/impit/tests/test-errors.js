'use strict'

const childProcess = require('child_process')
const path = require('path')
const {Impit} = require('impit')
const nodeApi = require('request-compat')
const engine = require('../index')
const {toNodeError} = require('../lib/errors')
const {connectProxy} = require('./proxy-servers')
const {test, listen, close, call, httpsServer, rawServer, ssl} = require('./helpers')

async function unusedPort () {
  const server = rawServer(() => {})
  const port = await listen(server)
  await close(server)
  return port
}

test('a refused connection is ECONNREFUSED with the fields of Node and the error of impit as cause', async t => {
  const port = await unusedPort()
  const url = 'http://127.0.0.1:' + port + '/'
  const node = await call(nodeApi, {url})
  const {err} = await call(engine, {url})
  t.equal(err.code, node.err.code)
  t.equal(err.code, 'ECONNREFUSED')
  t.equal(err.message, node.err.message)
  t.equal(err.syscall, 'connect')
  t.equal(err.address, '127.0.0.1')
  t.equal(err.port, port)
  t.equal(err.errno, node.err.errno)
  t.equal(err.cause && err.cause.constructor.name, 'ConnectError')
})

test('an unknown host is ENOTFOUND', async t => {
  const {err} = await call(engine, {url: 'http://request-compat-nonexistent.invalid/'})
  t.equal(err.code, 'ENOTFOUND')
  t.equal(err.syscall, 'getaddrinfo')
  t.ok(err.cause)
})

test('an unknown host is ENOTFOUND with the host in the message and in hostname, as in Node', async t => {
  const url = 'http://request-compat-nonexistent.invalid/'
  const node = await call(nodeApi, {url})
  const {err} = await call(engine, {url})
  t.equal(node.err.code, 'ENOTFOUND')
  t.equal(err.message, node.err.message)
  t.equal(err.message, 'getaddrinfo ENOTFOUND request-compat-nonexistent.invalid')
  t.equal(err.hostname, node.err.hostname)
  t.equal(err.syscall, node.err.syscall)
})

test('a proxy host that does not resolve gives the proxy host in the error, forwarded and tunnelled, as in Node', async t => {
  const proxy = 'http://request-compat-proxy-nonexistent.invalid:3128'
  for (const url of ['http://localhost:1/', 'https://localhost:1/']) {
    const node = await call(nodeApi, {url, proxy})
    const {err} = await call(engine, {url, proxy})
    t.equal(err.message, node.err.message, url)
    t.equal(err.code, node.err.code, url)
    t.equal(err.hostname, node.err.hostname, url)
  }
})

test('through a socks proxy and with a caller\'s impit, ENOTFOUND has no host: the engine cannot tell which name impit looked up', async t => {
  const socks = await call(engine, {url: 'https://localhost:1/', proxy: 'socks5://request-compat-proxy-nonexistent.invalid:1080'})
  const own = await call(engine, {url: 'http://request-compat-nonexistent.invalid/', impit: new Impit({})})
  t.equal(socks.err.code, 'ENOTFOUND')
  t.equal(socks.err.message, 'getaddrinfo ENOTFOUND')
  t.equal(socks.err.hostname, undefined)
  t.equal(own.err.code, 'ENOTFOUND')
  t.equal(own.err.message, 'getaddrinfo ENOTFOUND')
  t.equal(own.err.hostname, undefined)
})

test('a connection closed before the response is ECONNRESET socket hang up, as in Node', async t => {
  const server = rawServer(socket => socket.destroy())
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const node = await call(nodeApi, {url})
  const {err} = await call(engine, {url})
  t.equal(node.err.code, 'ECONNRESET')
  t.equal(err.code, 'ECONNRESET')
  t.equal(err.message, 'socket hang up')
  await close(server)
})

test('a connection closed in the middle of the body is ECONNRESET aborted, as in Node', async t => {
  const server = rawServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial')
    setTimeout(() => socket.destroy(), 50)
  })
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const node = await call(nodeApi, {url})
  const {err} = await call(engine, {url})
  t.equal(node.err.code, 'ECONNRESET')
  t.equal(node.err.message, 'aborted')
  t.equal(err.code, 'ECONNRESET')
  t.equal(err.message, 'aborted')
  await close(server)
})

test('a proxy that refuses CONNECT and a proxy that is down give the errors of the tunnel agent', async t => {
  const refusing = connectProxy({status: 407})
  const refusingPort = await listen(refusing)
  const deadPort = await unusedPort()
  const url = 'https://localhost:1/'
  const nodeRefused = await call(nodeApi, {url, proxy: 'http://127.0.0.1:' + refusingPort})
  const refused = await call(engine, {url, proxy: 'http://127.0.0.1:' + refusingPort})
  const nodeDead = await call(nodeApi, {url, proxy: 'http://127.0.0.1:' + deadPort})
  const dead = await call(engine, {url, proxy: 'http://127.0.0.1:' + deadPort})
  t.equal(refused.err.message, nodeRefused.err.message)
  t.equal(refused.err.message, 'tunneling socket could not be established, statusCode=407')
  t.equal(refused.err.code, 'ECONNRESET')
  t.equal(dead.err.message, nodeDead.err.message)
  t.equal(dead.err.code, 'ECONNRESET')
  await close(refusing)
})

test('a certificate of an unknown issuer is the error of impit without a Node code', async t => {
  const server = httpsServer()
  const url = 'https://localhost:' + await listen(server) + '/'
  const {err} = await call(engine, {url})
  t.equal(err.constructor.name, 'ConnectError')
  t.equal(err.code, undefined)
  t.ok(/UnknownIssuer/.test(err.message))
  await close(server)
})

test('certificate errors that impit names are mapped to the codes of Node', async t => {
  const expired = toNodeError(new Error('Failed to connect to the server.\nReason: Custom { error: InvalidCertificate(\n Expired,\n ) }'), 'request', false)
  const name = toNodeError(new Error('Failed to connect to the server.\nReason: Custom { error: InvalidCertificate(\n NotValidForName,\n ) }'), 'request', false)
  const nameWithContext = toNodeError(new Error('Reason: Custom { error: InvalidCertificate(\n NotValidForNameContext {\n expected: DnsName("localhost"), presented: [] } ) }'), 'request', false)
  t.equal(expired.code, 'CERT_HAS_EXPIRED')
  t.equal(name.code, 'ERR_TLS_CERT_ALTNAME_INVALID')
  t.equal(nameWithContext.code, 'ERR_TLS_CERT_ALTNAME_INVALID')
  t.equal(nameWithContext.cause.message.indexOf('Reason:'), 0)
})

test('SSL_CERT_FILE set before the process starts gives impit its trust store; a certificate without subjectAltName is still refused', async t => {
  const script = [
    'const https = require("https"); const fs = require("fs"); const path = require("path")',
    'const ssl = ' + JSON.stringify(ssl),
    'const server = https.createServer({key: fs.readFileSync(path.join(ssl, "ca", "localhost.key")), cert: fs.readFileSync(path.join(ssl, "ca", "localhost.crt"))}, (req, res) => res.end("ok"))',
    'server.listen(0, "127.0.0.1", () => {',
    '  require(' + JSON.stringify(path.join(__dirname, '..', 'index.js')) + ')("https://localhost:" + server.address().port + "/", err => {',
    '    console.log(JSON.stringify({code: err && err.code, unknownIssuer: /UnknownIssuer/.test(String(err && err.message))}))',
    '    process.exit(0)',
    '  })',
    '})'
  ].join('\n')
  const run = env => {
    const result = childProcess.spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 20000})
    return JSON.parse(result.stdout.trim().split('\n').pop())
  }
  t.deepEqual(run({}), {unknownIssuer: true}, 'without the variable the issuer is unknown')
  t.deepEqual(run({SSL_CERT_FILE: path.join(ssl, 'ca', 'ca.crt')}), {code: 'ERR_TLS_CERT_ALTNAME_INVALID', unknownIssuer: false}, 'the ca is trusted, the name check fails on the test certificate')
})

test('an invalid header name or value is the error of Node, before anything is sent', async t => {
  const server = rawServer(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const badName = await call(engine, {url, headers: {'bad name': '1'}})
  const badValue = await call(engine, {url, headers: {'x-bad': 'a\r\nb: c'}})
  const nodeName = await call(nodeApi, {url, headers: {'bad name': '1'}})
  const nodeValue = await call(nodeApi, {url, headers: {'x-bad': 'a\r\nb: c'}})
  t.equal(badName.err.code, nodeName.err.code)
  t.equal(badName.err.code, 'ERR_INVALID_HTTP_TOKEN')
  t.equal(badValue.err.code, nodeValue.err.code)
  t.equal(badValue.err.code, 'ERR_INVALID_CHAR')
  t.equal(server.requests.length, 0)
  await close(server)
})

test('an error impit gives no detail for is passed on unchanged', async t => {
  const unknown = new Error('something else')
  t.equal(toNodeError(unknown, 'request', false), unknown)
  t.equal(toNodeError(unknown, 'response', false), unknown)
})

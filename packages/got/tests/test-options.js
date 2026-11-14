'use strict'

const dns = require('dns')
const http = require('http')
const net = require('net')
const {Readable} = require('stream')
const tape = require('tape')
const compare = require('./compare')
const nodeApi = require('request-compat')
const engine = require('../index')

const {AbortSignal} = global

function listen (handler, cb) {
  const server = http.createServer(handler)
  server.listen(0, () => cb(server))
}

function rawServer (response, cb) {
  const server = net.createServer(socket => {
    socket.once('data', () => socket.end(response))
  })
  server.listen(0, () => cb(server))
}

function toLoopback (hostname, options, cb) {
  if (options && options.all) {
    return cb(null, [{address: '127.0.0.1', family: 4}])
  }
  cb(null, '127.0.0.1', 4)
}

function sameOutcome (t, name, result) {
  t.deepEqual(result.engine.error, result.node.error, name + ': error')
  t.equal(result.engine.statusCode, result.node.statusCode, name + ': status')
  t.equal(result.engine.bytes, result.node.bytes, name + ': request bytes')
  t.deepEqual(result.engine.body, result.node.body, name + ': body')
  t.deepEqual(result.engine.events, result.node.events, name + ': events')
}

function chunkedSource () {
  return Readable.from(['one', 'two'], {objectMode: false})
}

const PASSED_TO_NODE = [
  ['lookup', () => ({url: port => 'http://request-compat-got.test:' + port + '/', lookup: toLoopback, pool: false})],
  ['family', () => ({family: 4, pool: false})],
  ['localAddress', () => ({localAddress: '127.0.0.1', pool: false})],
  ['createConnection', () => ({createConnection: options => net.createConnection(options), pool: false})],
  ['agent: false', () => ({agent: false})],
  ['pool: false', () => ({pool: false})],
  ['forever', () => ({forever: true})],
  ['agent', () => ({agent: new http.Agent({keepAlive: false})})],
  ['agentClass and agentOptions', () => ({agentClass: http.Agent, agentOptions: {keepAlive: true, maxSockets: 1}})],
  ['pool with maxSockets', () => ({pool: {maxSockets: 1}})],
  ['httpModules', () => ({httpModules: {'http:': {request: http.request, Agent: http.Agent, globalAgent: http.globalAgent}}})],
  ['httpModules with a custom protocol', () => ({url: port => 'custom://localhost:' + port + '/', httpModules: {'custom:': http}})],
  ['highWaterMark', () => ({highWaterMark: 1024, pool: false})],
  ['uniqueHeaders', () => ({uniqueHeaders: ['x-one'], headers: {'x-one': ['a', 'b']}, pool: false})],
  ['setDefaultHeaders: false', () => ({setDefaultHeaders: false, pool: false})],
  ['a header with the value null', () => ({headers: {'x-null': null}, pool: false})],
  ['an array header', () => ({headers: {'x-many': ['a', 'b']}, pool: false})],
  ['a PUT with a body', () => ({method: 'PUT', body: 'payload', pool: false})],
  ['a GET with a body', () => ({body: 'payload', pool: false})],
  ['a DELETE without a body', () => ({method: 'DELETE', headers: {'content-length': 5}, pool: false})],
  ['a chunked stream body', () => ({method: 'POST', source: chunkedSource, pool: false})]
]

tape('Node\'s request and agent options reach Node\'s http.request unchanged: same request bytes, events and outcome as Node\'s transport', t => {
  listen((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => res.end(req.method + ' ' + Buffer.concat(chunks).toString()))
  }, server => {
    const cases = PASSED_TO_NODE.slice()
    const next = () => {
      const item = cases.shift()
      if (!item) {
        return server.close(t.end)
      }
      compare(item[1](), server, (err, result) => {
        t.error(err)
        sameOutcome(t, item[0], result)
        next()
      })
    }
    next()
  })
})

tape('options that make Node fail give Node\'s error from the same place, as in Node', t => {
  const cases = [
    ['an invalid header value', {headers: {'x-bad': 'a\nb'}}],
    ['an invalid header name', {headers: {'x bad': 'a'}}],
    ['an invalid method', {method: 'GE T'}],
    ['an agent that is no agent', {agent: {}, pool: undefined}],
    ['an aborted signal', {signal: AbortSignal.abort()}],
    ['an invalid maxHeaderSize', {maxHeaderSize: -1}],
    ['an invalid insecureHTTPParser', {insecureHTTPParser: 'yes'}]
  ]
  listen((req, res) => res.end(), server => {
    const next = () => {
      const item = cases.shift()
      if (!item) {
        return server.close(t.end)
      }
      compare(Object.assign({pool: false}, item[1]), server, (err, result) => {
        t.error(err)
        t.ok(result.node.error, item[0] + ': Node fails')
        t.deepEqual(result.engine.error, result.node.error, item[0])
        t.deepEqual(result.engine.events, result.node.events, item[0] + ': events')
        next()
      })
    }
    next()
  })
})

tape('maxHeaderSize, insecureHTTPParser and joinDuplicateHeaders change how the response is parsed, as in Node', t => {
  const cases = [
    ['maxHeaderSize', 'HTTP/1.1 200 OK\r\nx-long: ' + 'a'.repeat(200) + '\r\ncontent-length: 2\r\n\r\nok', {maxHeaderSize: 100}],
    ['insecureHTTPParser', 'HTTP/1.1 200 OK\r\nx-bad: a\u0001b\r\ncontent-length: 2\r\n\r\nok', {insecureHTTPParser: true}],
    ['without insecureHTTPParser', 'HTTP/1.1 200 OK\r\nx-bad: a\u0001b\r\ncontent-length: 2\r\n\r\nok', {}],
    ['joinDuplicateHeaders', 'HTTP/1.1 200 OK\r\nx-twice: a\r\nx-twice: b\r\ncontent-length: 2\r\n\r\nok', {joinDuplicateHeaders: true}]
  ]
  const next = () => {
    const item = cases.shift()
    if (!item) {
      return t.end()
    }
    rawServer(item[1], server => {
      const url = 'http://localhost:' + server.address().port + '/'
      const options = Object.assign({url, pool: false}, item[2])
      nodeApi(options, (nodeErr, nodeRes) => {
        engine(options, (err, res) => {
          t.equal(err && err.code, nodeErr && nodeErr.code, item[0] + ': error')
          t.deepEqual(res && res.headers, nodeRes && nodeRes.headers, item[0] + ': headers')
          server.close(next)
        })
      })
    })
  }
  next()
})

tape('lookup of the request is used for every hop, as in Node', t => {
  const asked = []
  const lookup = (hostname, options, cb) => {
    asked.push(hostname)
    dns.lookup('127.0.0.1', options, cb)
  }
  listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, {location: '/end'})
      return res.end()
    }
    res.end('done')
  }, server => {
    engine({url: 'http://request-compat-got.test:' + server.address().port + '/start', lookup, pool: false}, (err, res, body) => {
      t.error(err)
      t.equal(body, 'done')
      t.deepEqual(asked, ['request-compat-got.test', 'request-compat-got.test'])
      server.close(t.end)
    })
  })
})

tape('TLS options, strictSSL and checkServerIdentity give the outcome of Node\'s transport', t => {
  const fs = require('fs')
  const https = require('https')
  const path = require('path')
  const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl', 'ca')
  const ca = fs.readFileSync(path.join(ssl, 'ca.crt'))
  const server = https.createServer({key: fs.readFileSync(path.join(ssl, 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'localhost.crt'))}, (req, res) => res.end('secure'))
  const refuse = () => new Error('identity refused')
  const cases = [
    ['ca', {ca}],
    ['ca with strictSSL', {ca, strictSSL: true}],
    ['no ca', {}],
    ['no ca, rejectUnauthorized false', {rejectUnauthorized: false}],
    ['no ca, strictSSL with rejectUnauthorized false', {strictSSL: true, rejectUnauthorized: false}],
    ['checkServerIdentity', {ca, checkServerIdentity: refuse}],
    ['agentOptions with ca', {agentOptions: {ca}}]
  ]
  server.listen(0, () => {
    const next = () => {
      const item = cases.shift()
      if (!item) {
        return server.close(t.end)
      }
      compare(Object.assign({pool: false}, item[1]), server, (err, result) => {
        t.error(err)
        sameOutcome(t, item[0], result)
        next()
      })
    }
    next()
  })
})

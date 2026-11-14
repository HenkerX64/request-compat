'use strict'

const http = require('http')
const net = require('net')
const path = require('path')
const tape = require('tape')
const nodeApi = require('request-compat')
const {createSandbox} = require('./sandbox')

const engineIndex = path.join(__dirname, '..', 'index.js')

function unusedPort (cb) {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => cb(port))
  })
}

function errorOf (api, url, cb) {
  api(url, err => cb(err))
}

tape('the sandboxed loader of these tests refuses require() of got, an ES module, as Jest does', t => {
  const sandbox = createSandbox()
  try {
    sandbox.require('got')
    t.fail('the sandboxed loader loaded got')
  } catch (err) {
    t.equal(err.name, 'SyntaxError')
  }
  t.end()
})

tape('the engine loads and sends through got under a sandboxed module loader that refuses require() of ESM, as Jest does', t => {
  const engine = createSandbox().require(engineIndex)
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(0, () => {
    engine('http://localhost:' + server.address().port + '/', (err, res, body) => {
      t.error(err)
      t.equal(res.statusCode, 200)
      t.equal(body, 'ok')
      t.ok(res instanceof http.IncomingMessage)
      server.close(t.end)
    })
  })
})

tape('connection errors before a response are Node\'s errors under a sandboxed module loader, as on Node\'s transport', t => {
  const engine = createSandbox().require(engineIndex)
  unusedPort(port => {
    const refused = 'http://127.0.0.1:' + port + '/'
    const unknown = 'http://this-host-does-not-exist.invalid/'
    errorOf(nodeApi, refused, nodeRefused => {
      errorOf(engine, refused, engineRefused => {
        errorOf(nodeApi, unknown, nodeUnknown => {
          errorOf(engine, unknown, engineUnknown => {
            t.equal(nodeRefused.code, 'ECONNREFUSED')
            t.equal(String(engineRefused), String(nodeRefused))
            t.equal(engineRefused.code, nodeRefused.code)
            t.equal(Object.getPrototypeOf(engineRefused), Object.getPrototypeOf(nodeRefused))
            t.equal(String(engineUnknown), String(nodeUnknown))
            t.equal(engineUnknown.code, nodeUnknown.code)
            t.equal(Object.getPrototypeOf(engineUnknown), Object.getPrototypeOf(nodeUnknown))
            t.end()
          })
        })
      })
    })
  })
})

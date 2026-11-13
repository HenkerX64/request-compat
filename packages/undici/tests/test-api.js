'use strict'

const http = require('http')
const tape = require('tape')
const nodeApi = require('request-compat')
const nodeRequest = require('request-compat/request')
const engine = require('../index')
const {closeAll} = require('../lib/dispatchers')
const {nodeVersionError} = require('../lib/errors')

tape('a Node below 22.19 gets NODE_VERSION_NOT_SUPPORTED from the version check that index.js runs on require', t => {
  ;['8.17.0', '20.19.5', '22.9.0', '22.18.1'].forEach(version => {
    const err = nodeVersionError(version)
    t.ok(err instanceof Error, version)
    t.equal(err && err.code, 'NODE_VERSION_NOT_SUPPORTED', version)
    t.equal(err && err.message, 'request-compat-undici needs Node >= 22.19', version)
  })
  ;['22.19.0', '22.20.1', '23.0.0', '24.11.1', '26.0.0', process.versions.node].forEach(version => {
    t.equal(nodeVersionError(version), null, version)
  })
  t.end()
})

tape('the engine exports the same API as the core', t => {
  t.deepEqual(Object.keys(engine), Object.keys(nodeApi))
  t.ok(engine.Request.prototype instanceof nodeRequest)
  ;['get', 'head', 'options', 'post', 'put', 'patch', 'del', 'delete', 'defaults', 'forever', 'jar', 'cookie'].forEach(name => {
    t.equal(typeof engine[name], 'function', name)
  })
  t.end()
})

tape('options the engine cannot honour are refused from send', t => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.end('ok')
  })
  const cases = [
    ['agent', {agent: new http.Agent()}],
    ['agentClass', {agentClass: http.Agent}],
    ['httpModules', {httpModules: {'http:': http}}]
  ]
  server.listen(0, () => {
    const next = () => {
      const entry = cases.shift()
      if (!entry) {
        t.equal(hits, 0)
        server.close()
        return t.end()
      }
      engine(Object.assign({url: 'http://localhost:' + server.address().port + '/'}, entry[1]), (err, res) => {
        t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', entry[0])
        t.equal(err && err.option, entry[0])
        t.equal(res, undefined)
        next()
      })
    }
    next()
  })
})

tape('close dispatchers', t => {
  closeAll().then(() => t.end())
})

'use strict'

const http = require('http')
const tape = require('tape')
const request = require('../index')
const nodeRequest = require('request-compat')

tape('the engine API has the shape of the core API', t => {
  Object.keys(nodeRequest).forEach(name => {
    t.equal(typeof request[name], typeof nodeRequest[name], name)
  })
  t.notEqual(request.Request, nodeRequest.Request)
  t.ok(request.Request.prototype instanceof nodeRequest.Request)
  t.end()
})

tape('a plain GET goes through got and gets a Node response', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(0, () => {
    request('http://localhost:' + server.address().port + '/', (err, res, body) => {
      t.error(err)
      t.equal(res.statusCode, 200)
      t.equal(body, 'ok')
      t.ok(res instanceof http.IncomingMessage)
      server.close(t.end)
    })
  })
})

tape('below Node 22.12 the package throws NODE_VERSION_NOT_SUPPORTED, from 22.12 on it loads', t => {
  const {nodeVersionError} = require('../lib/errors')
  const err = nodeVersionError('22.11.0')
  t.equal(err.code, 'NODE_VERSION_NOT_SUPPORTED')
  t.equal(err.message, 'request-compat-got needs Node >= 22.12')
  t.equal(nodeVersionError('20.19.0').code, 'NODE_VERSION_NOT_SUPPORTED')
  t.equal(nodeVersionError('22.12.0'), null)
  t.equal(nodeVersionError('24.0.0'), null)
  t.end()
})

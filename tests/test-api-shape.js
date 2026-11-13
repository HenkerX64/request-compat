'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var server = http.createServer(function (req, res) {
  res.end(req.headers['x-test'] || '')
})
destroyable(server)

function url () {
  return 'http://127.0.0.1:' + server.address().port + '/'
}

tape('setup', function (t) {
  server.listen(0, function () {
    t.end()
  })
})

tape('the exports keep their order', function (t) {
  t.deepEqual(Object.keys(request), ['get', 'head', 'options', 'post', 'put', 'patch', 'del', 'delete', 'jar', 'cookie', 'defaults', 'forever', 'Request', 'initParams', 'debug'])
  t.equal(request.Request, require('../request'))
  t.end()
})

tape('a call without arguments throws', function (t) {
  t.throws(function () { request() }, /^Error: undefined is not a valid uri or options object\.$/)
  t.end()
})

tape('forever with agent options and default options', function (t) {
  request.forever({maxSockets: 2}, {headers: {'x-test': 'a'}}).get(url(), function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'a')
    t.deepEqual(res.request.agentOptions, {maxSockets: 2, keepAlive: true})
    res.request.agent.destroy()
    t.end()
  })
})

tape('forever without arguments', function (t) {
  request.forever().get(url(), function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.deepEqual(res.request.agentOptions, {keepAlive: true})
    res.request.agent.destroy()
    t.end()
  })
})

tape('cleanup', function (t) {
  server.destroy(function () {
    t.end()
  })
})

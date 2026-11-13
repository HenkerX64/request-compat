'use strict'

var http = require('http')
var https = require('https')
var net = require('net')
var fs = require('fs')
var path = require('path')
var util = require('util')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var ca = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/ca.crt'))
var tlsOptions = {
  key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.key')),
  cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.crt'))
}

function answer (req, res) {
  res.end('ok')
}

var httpServer = http.createServer(answer)
var httpsServer = https.createServer(tlsOptions, answer)
var untrustedServer = https.createServer(tlsOptions, answer)
destroyable(httpServer)
destroyable(httpsServer)
destroyable(untrustedServer)

function httpUrl () {
  return 'http://127.0.0.1:' + httpServer.address().port + '/'
}

function httpsUrl () {
  return 'https://localhost:' + httpsServer.address().port + '/'
}

function untrustedUrl () {
  return 'https://localhost:' + untrustedServer.address().port + '/'
}

function counter () {
  function counting () {
    counting.calls++
    return undefined
  }
  counting.calls = 0
  return counting
}

tape('setup', function (t) {
  httpServer.listen(0, function () {
    httpsServer.listen(0, function () {
      untrustedServer.listen(0, function () {
        t.end()
      })
    })
  })
})

tape('no connect or upgrade listener', function (t) {
  var seen = {}
  var r = request(httpUrl(), function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.deepEqual(seen, {
      request: {connect: 0, upgrade: 0},
      socket: {connect: 0, upgrade: 0}
    })
    t.end()
  })
  r.on('request', function (req) {
    seen.request = {connect: req.listenerCount('connect'), upgrade: req.listenerCount('upgrade')}
    req.on('socket', function () {
      seen.socket = {connect: req.listenerCount('connect'), upgrade: req.listenerCount('upgrade')}
    })
  })
})

tape('timing listeners leave the socket after a connection error', function (t) {
  var closed = http.createServer(answer)
  closed.listen(0, function () {
    var port = closed.address().port
    closed.close(function () {
      var target = 'http://127.0.0.1:' + port + '/'
      var plain = request({url: target}, function (err) {
        t.equal(err.code, 'ECONNREFUSED')
        setImmediate(function () {
          var baseline = plain.req.socket.listenerCount('connect')
          var r = request({url: target, time: true}, function (err) {
            t.equal(err.code, 'ECONNREFUSED')
            t.equal(typeof r.timings.socket, 'number')
            t.equal(r.timings.connect, undefined)
            setImmediate(function () {
              t.equal(r.req.socket.listenerCount('lookup'), 0)
              t.equal(r.req.socket.listenerCount('connect'), baseline)
              t.end()
            })
          })
        })
      })
    })
  })
})

tape('headers set later stay off the CONNECT request', function (t) {
  var data = ''
  var proxy = net.createServer(function (sock) {
    sock.once('data', function (c) {
      data += c
      sock.write('HTTP/1.1 200 OK\r\n\r\n')
      sock.once('data', function (c) {
        data += c
        sock.write('HTTP/1.1 200 OK\r\n')
        sock.write('content-type: text/plain\r\n')
        sock.write('content-length: 5\r\n')
        sock.write('\r\n')
        sock.end('derp\n')
      })
    })
  })
  destroyable(proxy)
  proxy.listen(0, function () {
    request({
      tunnel: true,
      url: 'http://google.com',
      proxy: 'http://localhost:' + proxy.address().port,
      method: 'POST',
      gzip: true,
      json: {a: 1}
    }, function (err, res) {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      var split = data.indexOf('\r\n\r\n')
      var connectBlock = data.slice(0, split)
      var rest = data.slice(split + 4)
      t.ok(/^CONNECT /.test(connectBlock))
      t.notOk(/accept-encoding/i.test(connectBlock))
      t.notOk(/content-type/i.test(connectBlock))
      t.ok(/accept-encoding/i.test(rest))
      t.ok(/content-type/i.test(rest))
      proxy.destroy(function () {
        t.end()
      })
    })
  })
})

tape('strictSSL fails on an untrusted certificate when rejectUnauthorized is false', function (t) {
  request({url: untrustedUrl(), strictSSL: true, rejectUnauthorized: false}, function (err) {
    t.ok(err)
    t.ok(/^SSL Error: [A-Z_]+$/.test(err && err.message), err && err.message)
    t.end()
  })
})

tape('checkServerIdentity on an http URL keeps the pool agent', function (t) {
  var counting = counter()
  var r = request({url: httpUrl(), pool: {}, checkServerIdentity: counting}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.equal(counting.calls, 0)
    t.equal(r.req.agent, r.agent)
    t.end()
  })
})

tape('a pooled agent class that cannot be built twice keeps the shared agent', function (t) {
  var constructions = 0
  function OnceAgent (options) {
    constructions++
    if (constructions > 1) {
      throw new Error('OnceAgent cannot be built twice')
    }
    https.Agent.call(this, options)
  }
  util.inherits(OnceAgent, https.Agent)
  var counting = counter()
  var r = request({url: httpsUrl(), ca: ca, agentClass: OnceAgent, checkServerIdentity: counting}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(counting.calls >= 1)
    t.equal(r.req.agent, r.agent)
    t.ok(r.agent instanceof OnceAgent)
    t.equal(constructions, 2)
    r.agent.destroy()
    t.end()
  })
})

tape('checkServerIdentity without an agent', function (t) {
  var counting = counter()
  var r = request({url: httpsUrl(), ca: ca, pool: false, checkServerIdentity: counting}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(counting.calls >= 1)
    t.equal(r.agent, false)
    t.end()
  })
})

tape('strictSSL on a response without its own socket', function (t) {
  var original = https.request
  https.request = function () {
    var req = original.apply(https, arguments)
    req.on('response', function (response) {
      delete response.socket
    })
    return req
  }
  var r = request({url: httpsUrl(), ca: ca, strictSSL: true}, function (err) {
    https.request = original
    t.ok(err)
    t.equal(err && err.message, 'SSL Error: ' + r.uri.href + ' does not support SSL')
    httpsServer.destroy(function () {
      t.end()
    })
  })
})

tape('tunnel agent before an invalid protocol', function (t) {
  request({url: 'ftp://x/', proxy: 'http://127.0.0.1:1', tunnel: true}, function (err) {
    t.equal(err.message, 'Invalid protocol: ftp:')
    t.equal(Boolean(this.agent && this.agent.proxyOptions), true)
    t.equal(this.req, undefined)
    t.end()
  })
})

tape('cleanup', function (t) {
  httpServer.destroy(function () {
    untrustedServer.destroy(function () {
      t.end()
    })
  })
})

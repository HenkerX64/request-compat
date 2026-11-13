'use strict'

var http = require('http')
var https = require('https')
var events = require('events')
var stream = require('stream')
var util = require('util')
var tape = require('tape')
var createApi = require('../lib/api')
var Request = require('../request')

var realHttpRequest = http.request
var realHttpsRequest = https.request
var cfg
var calls

function reset (options) {
  cfg = options || {}
  calls = {prepare: 0, sends: [], tunnels: [], exchanges: []}
}

function fakeResponse (statusCode, headers, body) {
  var response = new stream.PassThrough()
  response.statusCode = statusCode
  response.headers = headers || {}
  response.rawHeaders = []
  Object.keys(response.headers).forEach(function (key) {
    response.rawHeaders.push(key, response.headers[key])
  })
  response.httpVersion = '1.1'
  response.end(body || '')
  return response
}

function fakeExchange () {
  var exchange = new events.EventEmitter()
  exchange.chunks = []
  exchange.finished = false
  exchange.aborted = false
  exchange.write = function (chunk) {
    exchange.chunks.push(String(chunk))
    return true
  }
  exchange.end = function (chunk) {
    if (chunk) {
      exchange.chunks.push(String(chunk))
    }
    exchange.finished = true
    if (cfg.respond === false) {
      return
    }
    process.nextTick(function () {
      var next = cfg.responses && cfg.responses.shift()
      exchange.emit('response', next ? fakeResponse(next.statusCode, next.headers) : fakeResponse(200, {}, 'hello'))
    })
  }
  exchange.abort = function () {
    exchange.aborted = true
  }
  exchange.setTimeout = function (ms, fn) {
    exchange.timeoutArgs = {ms: ms, fn: fn}
  }
  exchange.removeHeader = function () {}
  return exchange
}

var fake = {
  prepare: function () {
    calls.prepare++
  },
  tunnel: function (self, proxyHeaders) {
    calls.tunnels.push({proxyHeaders: proxyHeaders})
  },
  verifyResponse: function () {
    return cfg.verifyError || null
  },
  send: function (self, reqOptions) {
    calls.sends.push(reqOptions)
    if (cfg.throwOnSend && cfg.throwOnSend[calls.sends.length]) {
      throw cfg.throwOnSend[calls.sends.length]
    }
    var exchange = fakeExchange()
    calls.exchanges.push(exchange)
    if (cfg.connection) {
      process.nextTick(function () {
        exchange.emit('connecting', cfg.connection)
      })
    }
    return exchange
  }
}

var api = createApi(fake)
var url = 'http://example.test/a'

function paths () {
  return calls.sends.map(function (reqOptions) { return reqOptions.path })
}

tape('block the network', function (t) {
  var refuse = function () {
    throw new Error('network is blocked in test-transport')
  }
  http.request = refuse
  https.request = refuse
  t.end()
})

tape('sends through the transport', function (t) {
  reset()
  var r = api.get(url, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.equal(body, 'hello')
    t.equal(calls.prepare, 1)
    t.equal(calls.sends.length, 1)
    t.equal(calls.sends[0].method, 'GET')
    t.equal(calls.sends[0].path, '/a')
    t.equal(r.agent, undefined)
    t.end()
  })
})

tape('body', function (t) {
  reset()
  api.post({url: url, body: 'x=1'}, function (err) {
    t.equal(err, null)
    t.equal(calls.exchanges[0].chunks.join(''), 'x=1')
    t.end()
  })
})

tape('redirect', function (t) {
  reset({responses: [{statusCode: 302, headers: {location: 'http://example.test/b'}}]})
  api.get(url, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.equal(calls.prepare, 2)
    t.deepEqual(paths(), ['/a', '/b'])
    t.end()
  })
})

tape('connect timeout', function (t) {
  reset({respond: false, connection: new events.EventEmitter()})
  var sockets = 0
  var r = api.get({url: url, timeout: 50}, function (err) {
    t.ok(err)
    t.equal(err.code, 'ETIMEDOUT')
    t.equal(err.connect, true)
    t.equal(sockets, 0)
    t.end()
  })
  r.on('socket', function () {
    sockets++
  })
})

tape('idle timeout', function (t) {
  var connection = new events.EventEmitter()
  reset({respond: false, connection: connection})
  var r = api.get({url: url, timeout: 50}, function (err) {
    t.ok(err)
    t.equal(err.code, 'ESOCKETTIMEDOUT')
    t.equal(err.connect, false)
    t.end()
  })
  r.on('request', function () {
    process.nextTick(function () {
      process.nextTick(function () {
        connection.emit('connect')
        var args = calls.exchanges[0].timeoutArgs
        t.equal(args.ms, 50)
        args.fn()
      })
    })
  })
})

tape('tunnel goes to the transport', function (t) {
  reset()
  var r = api.get({url: url, proxy: 'http://proxy.test:3128', tunnel: true, headers: {accept: 'x'}}, function (err) {
    t.equal(err, null)
    t.equal(calls.tunnels.length, 1)
    t.deepEqual(calls.tunnels[0].proxyHeaders, {accept: 'x', host: 'example.test:80'})
    t.equal(r.agent, undefined)
    t.deepEqual(paths(), ['/a'])
    t.end()
  })
})

tape('reserved names follow the API class', function (t) {
  reset()
  api.Request.prototype.extraMethod = function () {}
  var r = api({url: url, extraMethod: 'x'}, function (err) {
    t.equal(err, null)
    delete api.Request.prototype.extraMethod
    t.end()
  })
  t.equal(typeof r.extraMethod, 'function')
})

tape('reserved names of a Node API subclass stay open', function (t) {
  function MyRequest (options) {
    Request.call(this, options)
  }
  util.inherits(MyRequest, Request)
  MyRequest.prototype.extraMethod = function () {}
  var r = new MyRequest({
    uri: url,
    extraMethod: 'x',
    callback: function (err) {
      t.ok(err)
      t.end()
    }
  })
  t.equal(r.extraMethod, 'x')
})

tape('verifyResponse', function (t) {
  reset({verifyError: new Error('tls: no')})
  api.get(url, function (err) {
    t.ok(err)
    t.equal(err.message, 'tls: no')
    t.end()
  })
})

tape('send that throws', function (t) {
  reset({throwOnSend: {1: new Error('boom')}})
  var returned = false
  api.get(url, function (err) {
    t.ok(returned)
    t.equal(err.message, 'boom')
    t.equal(calls.sends.length, 1)
    t.end()
  })
  returned = true
})

tape('send throws on a redirect hop', function (t) {
  reset({
    throwOnSend: {2: new Error('refused')},
    responses: [{statusCode: 302, headers: {location: 'http://example.test/b'}}]
  })
  api.get(url, function (err) {
    t.equal(err.message, 'refused')
    t.equal(calls.sends.length, 2)
    t.equal(calls.prepare, 2)
    t.end()
  })
})

tape('abort before a throwing send', function (t) {
  reset({throwOnSend: {1: new Error('boom')}})
  var r = api.get(url, function () { t.fail('callback') })
  r.abort()
  setTimeout(function () {
    t.equal(calls.sends.length, 0)
    t.end()
  }, 20)
})

tape('write after a throwing send', function (t) {
  reset({throwOnSend: {1: new Error('boom')}})
  var r = api.put(url, function (err) {
    t.equal(err.message, 'boom')
    t.equal(calls.sends.length, 1)
    t.end()
  })
  r.write('x')
  t.doesNotThrow(function () { r.end() })
})

tape('option cannot replace the transport', function (t) {
  reset()
  var other = {}
  ;['prepare', 'tunnel', 'verifyResponse', 'send'].forEach(function (name) {
    other[name] = function () {
      t.fail(name + ' of the option was called')
    }
  })
  api({url: url, transport: other}, function (err) {
    t.equal(err, null)
    t.equal(calls.sends.length, 1)
    t.end()
  })
})

tape('defaults keep the transport', function (t) {
  reset()
  api.defaults({headers: {'x-a': '1'}}).get(url, function (err) {
    t.equal(err, null)
    t.equal(calls.sends.length, 1)
    t.equal(calls.sends[0].headers['x-a'], '1')
    t.end()
  })
})

tape('class and debug', function (t) {
  t.equal(Object.getPrototypeOf(api.Request.prototype), Request.prototype)
  t.equal(api.Request.defaultProxyHeaderWhiteList, Request.defaultProxyHeaderWhiteList)
  api.debug = true
  t.equal(Request.debug, true)
  api.debug = false
  t.equal(Request.debug, false)
  t.end()
})

tape('restore the network', function (t) {
  http.request = realHttpRequest
  https.request = realHttpsRequest
  t.end()
})

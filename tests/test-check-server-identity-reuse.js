'use strict'

var https = require('https')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var ca = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/ca.crt'))
var s = https.createServer({
  key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.key')),
  cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.crt'))
}, function (req, res) {
  res.end('ok')
})
var connections = 0
s.on('connection', function () {
  connections++
})

destroyable(s)

function url () {
  return 'https://localhost:' + s.address().port + '/'
}

function pin (counter, result) {
  return function () {
    counter.calls++
    return result
  }
}

function later (fn) {
  setTimeout(fn, 50)
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('checkServerIdentity runs on a pooled agent whose TLS session an earlier request opened', function (t) {
  var pool = {}
  var counter = {calls: 0}
  request({url: url(), ca: ca, pool: pool}, function (err) {
    t.equal(err, null)
    request({url: url(), ca: ca, pool: pool, checkServerIdentity: pin(counter, new Error('pinned certificate mismatch'))}, function (err) {
      t.equal(counter.calls, 1)
      t.equal(err && err.message, 'pinned certificate mismatch')
      t.end()
    })
  })
})

tape('checkServerIdentity runs on a caller agent whose TLS session an earlier request opened', function (t) {
  var agent = new https.Agent({ca: ca})
  var counter = {calls: 0}
  request({url: url(), agent: agent}, function (err) {
    t.equal(err, null)
    request({url: url(), agent: agent, checkServerIdentity: pin(counter, new Error('pinned certificate mismatch'))}, function (err) {
      t.equal(counter.calls, 1)
      t.equal(err && err.message, 'pinned certificate mismatch')
      t.end()
    })
  })
})

tape('checkServerIdentity runs when an earlier request left a keep-alive socket in the pool', function (t) {
  var pool = {}
  var counter = {calls: 0}
  request({url: url(), ca: ca, pool: pool, forever: true}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: url(), ca: ca, pool: pool, forever: true, checkServerIdentity: pin(counter, new Error('pinned certificate mismatch'))}, function (err) {
        t.equal(counter.calls, 1)
        t.equal(err && err.message, 'pinned certificate mismatch')
        t.end()
      })
    })
  })
})

tape('checkServerIdentity runs when the global agent holds a socket or TLS session of an earlier request', function (t) {
  var counter = {calls: 0}
  https.globalAgent.options.ca = ca
  request({url: url()}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: url(), checkServerIdentity: pin(counter, new Error('pinned certificate mismatch'))}, function (err) {
        delete https.globalAgent.options.ca
        https.globalAgent.destroy()
        t.equal(counter.calls, 1)
        t.equal(err && err.message, 'pinned certificate mismatch')
        t.end()
      })
    })
  })
})

tape('a check set on the global agent stays for a request without its own check', function (t) {
  var counter = {calls: 0}
  https.globalAgent.options.ca = ca
  https.globalAgent.options.checkServerIdentity = pin(counter, new Error('global pin'))
  request({url: 'https://127.0.0.1:' + s.address().port + '/'}, function (err) {
    delete https.globalAgent.options.ca
    delete https.globalAgent.options.checkServerIdentity
    https.globalAgent.destroy()
    t.equal(counter.calls, 1)
    t.equal(err && err.message, 'global pin')
    t.end()
  })
})

tape('a request runs its own check although the pool holds an agent with the check of another request', function (t) {
  var pool = {}
  var first = {calls: 0}
  var second = {calls: 0}
  request({url: url(), pool: pool, forever: true, agentOptions: {ca: ca, checkServerIdentity: pin(first)}}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: url(), pool: pool, forever: true, agentOptions: {ca: ca}, checkServerIdentity: pin(second, new Error('pinned certificate mismatch'))}, function (err) {
        t.equal(first.calls, 1)
        t.equal(second.calls, 1)
        t.equal(err && err.message, 'pinned certificate mismatch')
        t.end()
      })
    })
  })
})

tape('a checkServerIdentity in agentOptions runs although the pool holds an agent without it', function (t) {
  var pool = {}
  var counter = {calls: 0}
  request({url: url(), pool: pool, forever: true, agentOptions: {ca: ca}}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: url(), pool: pool, forever: true, agentOptions: {ca: ca, checkServerIdentity: pin(counter, new Error('pinned certificate mismatch'))}}, function (err) {
        t.equal(counter.calls, 1)
        t.equal(err && err.message, 'pinned certificate mismatch')
        t.end()
      })
    })
  })
})

tape('a request without a check gets the default check although the pool holds an agent with a loose check', function (t) {
  var pool = {}
  var loose = {calls: 0}
  var ip = 'https://127.0.0.1:' + s.address().port + '/'
  request({url: ip, pool: pool, forever: true, agentOptions: {ca: ca, checkServerIdentity: pin(loose)}}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: ip, pool: pool, forever: true, agentOptions: {ca: ca}}, function (err) {
        t.equal(loose.calls, 1)
        t.ok(err && /altnames/i.test(err.message))
        t.end()
      })
    })
  })
})

tape('checkServerIdentity runs with an https module passed in httpModules', function (t) {
  var pool = {}
  var counter = {calls: 0}
  var httpsModule = {request: https.request.bind(https), Agent: https.Agent, globalAgent: https.globalAgent}
  request({url: url(), ca: ca, pool: pool, forever: true, httpModules: {'https:': httpsModule}}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: url(), ca: ca, pool: pool, forever: true, httpModules: {'https:': httpsModule}, checkServerIdentity: pin(counter, new Error('pinned certificate mismatch'))}, function (err) {
        t.equal(counter.calls, 1)
        t.equal(err && err.message, 'pinned certificate mismatch')
        t.end()
      })
    })
  })
})

tape('a global agent of another class stays in use for a request with checkServerIdentity', function (t) {
  var counter = {calls: 0}
  var original = https.globalAgent
  var created = 0
  function LibraryAgent (proxyUrl) {
    if (typeof proxyUrl !== 'string') {
      throw new Error('LibraryAgent needs a proxy URL')
    }
    created++
    https.Agent.call(this, {ca: ca})
  }
  require('util').inherits(LibraryAgent, https.Agent)
  https.globalAgent = new LibraryAgent('http://proxy.invalid')
  request({url: url(), checkServerIdentity: pin(counter)}, function (err) {
    https.globalAgent.destroy()
    https.globalAgent = original
    t.equal(err, null)
    t.equal(counter.calls, 1)
    t.equal(created, 1)
    t.end()
  })
})

tape('requests without checkServerIdentity keep reusing the pooled keep-alive socket', function (t) {
  var pool = {}
  var counter = {calls: 0}
  connections = 0
  request({url: url(), ca: ca, pool: pool, forever: true}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: url(), ca: ca, pool: pool, forever: true, checkServerIdentity: pin(counter)}, function (err) {
        t.equal(err, null)
        later(function () {
          request({url: url(), ca: ca, pool: pool, forever: true}, function (err) {
            t.equal(err, null)
            t.equal(counter.calls, 1)
            t.equal(connections, 2)
            t.end()
          })
        })
      })
    })
  })
})

tape('a checkServerIdentity set on the agent keeps reusing the keep-alive socket', function (t) {
  var pool = {}
  var counter = {calls: 0}
  var agentOptions = {ca: ca, checkServerIdentity: pin(counter)}
  connections = 0
  request({url: url(), pool: pool, forever: true, agentOptions: agentOptions}, function (err) {
    t.equal(err, null)
    later(function () {
      request({url: url(), pool: pool, forever: true, agentOptions: agentOptions}, function (err) {
        t.equal(err, null)
        t.equal(counter.calls, 1)
        t.equal(connections, 1)
        t.end()
      })
    })
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

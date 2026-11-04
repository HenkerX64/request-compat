'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  res.writeHead(200, {'content-length': 100})
  res.write('part of the body')
  setTimeout(function () {
    req.socket.destroy()
  }, 10)
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a response aborted by the server does not throw when nobody listens for error', function (t) {
  var uncaught = []
  var onUncaught = function (err) {
    uncaught.push(err.message)
  }
  process.on('uncaughtException', onUncaught)
  var r = request('http://localhost:' + s.address().port + '/')
  r.on('response', function (res) {
    res.on('data', function () {})
  })
  setTimeout(function () {
    process.removeListener('uncaughtException', onUncaught)
    t.deepEqual(uncaught, [])
    r.abort()
    t.end()
  }, 300)
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

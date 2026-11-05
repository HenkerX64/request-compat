'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  res.writeHead(200)
  res.write('part of the body')
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('abort() after the response headers calls back nothing and emits no error', function (t) {
  var events = []
  var r = request('http://localhost:' + s.address().port + '/', function (err) {
    events.push('callback ' + (err && err.code))
  })
  r.on('error', function (err) {
    events.push('error ' + err.code)
  })
  r.on('response', function () {
    setTimeout(function () {
      r.abort()
    }, 20)
  })
  setTimeout(function () {
    t.deepEqual(events, [])
    t.end()
  }, 300)
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

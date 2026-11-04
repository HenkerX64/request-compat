'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  res.end('hello')
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a close event that leads to another close emits end only once', function (t) {
  var r = request('http://localhost:' + s.address().port + '/')
  r.on('response', function (res) {
    var ends = 0
    res.prependListener('end', function () {
      ends++
      if (ends < 10) {
        res.emit('close')
      }
    })
    res.emit('close')
    t.equal(ends, 1)
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

'use strict'

var http = require('http')
var zlib = require('zlib')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var decoded = 16 * 1024 * 1024
var bodies = {
  '/deflate': ['deflate', zlib.deflateSync(Buffer.alloc(decoded))],
  '/raw': ['deflate', zlib.deflateRawSync(Buffer.alloc(decoded))]
}

var s = http.createServer(function (req, res) {
  res.writeHead(200, {'content-encoding': bodies[req.url][0]})
  res.end(bodies[req.url][1])
})

destroyable(s)

function buffered (t, path) {
  var r = request({url: 'http://localhost:' + s.address().port + path, gzip: true})
  r.on('response', function () {
    r.pause()
    setTimeout(function () {
      var state = r.responseContent._readableState
      t.ok(state.length < 1024 * 1024, 'a paused response buffers ' + state.length + ' decoded bytes')
      r.abort()
      t.end()
    }, 300)
  })
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a paused zlib deflate response does not buffer the whole decoded body', function (t) {
  buffered(t, '/deflate')
})

tape('a paused raw deflate response does not buffer the whole decoded body', function (t) {
  buffered(t, '/raw')
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

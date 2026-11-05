'use strict'

var http = require('http')
var zlib = require('zlib')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var text = 'raw deflate body'
var bodies = {
  '/raw': ['deflate', zlib.deflateRawSync(text)],
  '/zlib': ['deflate', zlib.deflateSync(text)],
  '/gzip': ['gzip', zlib.gzipSync(text)]
}

var s = http.createServer(function (req, res) {
  res.writeHead(200, {'content-encoding': bodies[req.url][0]})
  res.end(bodies[req.url][1])
})

destroyable(s)

function events (path, done) {
  var seen = []
  var r = request({url: 'http://localhost:' + s.address().port + path, gzip: true}, function (err, res, body) {
    seen.push(err ? 'error ' + err.message : 'body ' + body)
  })
  ;['end', 'complete', 'close'].forEach(function (name) {
    r.on(name, function () {
      seen.push(name)
    })
  })
  setTimeout(function () {
    done(seen)
  }, 300)
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a raw deflate response is decoded with the events of a gzip response', function (t) {
  events('/gzip', function (gzip) {
    events('/raw', function (raw) {
      t.equal(raw.indexOf('body ' + text) !== -1, true)
      t.deepEqual(raw, gzip)
      t.end()
    })
  })
})

tape('a zlib deflate response is decoded with the events of a gzip response', function (t) {
  events('/gzip', function (gzip) {
    events('/zlib', function (deflate) {
      t.deepEqual(deflate, gzip)
      t.end()
    })
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

'use strict'

var http = require('http')
var https = require('https')
var net = require('net')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var ca = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/ca.crt'))
var target = https.createServer({
  key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.key')),
  cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.crt'))
}, function (req, res) {
  res.end('target')
})
var connects = 0
var proxy = http.createServer()
proxy.on('connect', function (req, socket, head) {
  connects++
  var hostPort = req.url.split(':')
  var upstream = net.connect(+hostPort[1], hostPort[0], function () {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', function () { socket.destroy() })
  socket.on('error', function () { upstream.destroy() })
})

destroyable(target)
destroyable(proxy)

function options (checkServerIdentity) {
  return {
    url: 'https://localhost:' + target.address().port + '/',
    proxy: 'http://127.0.0.1:' + proxy.address().port,
    ca: ca,
    checkServerIdentity: checkServerIdentity
  }
}

tape('setup', function (t) {
  target.listen(0, function () {
    proxy.listen(0, function () {
      t.end()
    })
  })
})

tape('checkServerIdentity runs through a proxy tunnel and can reject the certificate', function (t) {
  var calls = 0
  var before = connects
  request(options(function () {
    calls++
    return new Error('pinned certificate mismatch')
  }), function (err, res) {
    t.equal(connects - before, 1, 'the request went through the proxy')
    t.equal(calls, 1)
    t.equal(err && err.message, 'pinned certificate mismatch')
    t.equal(res, undefined)
    t.end()
  })
})

tape('checkServerIdentity runs through a proxy tunnel and can accept the certificate', function (t) {
  var hosts = []
  request(options(function (host) {
    hosts.push(host)
  }), function (err, res, body) {
    t.equal(err, null)
    t.deepEqual(hosts, ['localhost'])
    t.equal(body, 'target')
    t.end()
  })
})

tape('cleanup', function (t) {
  target.destroy(function () {
    proxy.destroy(function () {
      t.end()
    })
  })
})

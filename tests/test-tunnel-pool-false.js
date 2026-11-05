'use strict'

var http = require('http')
var https = require('https')
var net = require('net')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var target = https.createServer({
  key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.key')),
  cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.crt'))
}, function (req, res) {
  res.end('target')
})
var connects = []
var proxy = http.createServer()
proxy.on('connect', function (req, socket, head) {
  connects.push(req.url)
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

tape('setup', function (t) {
  target.listen(0, function () {
    proxy.listen(0, function () {
      t.end()
    })
  })
})

tape('pool: false keeps an https request on its proxy tunnel', function (t) {
  request({
    url: 'https://localhost:' + target.address().port + '/',
    proxy: 'http://127.0.0.1:' + proxy.address().port,
    ca: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/ca.crt')),
    pool: false
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'target')
    t.deepEqual(connects, ['localhost:' + target.address().port])
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

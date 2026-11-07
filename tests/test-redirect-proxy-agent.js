'use strict'

var http = require('http')
var https = require('https')
var net = require('net')
var fs = require('fs')
var path = require('path')
var url = require('url')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var ca = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/ca.crt'))
var plain = http.createServer(function (req, res) {
  res.end('plain')
})
var secure = https.createServer({
  key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.key')),
  cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.crt'))
}, function (req, res) {
  res.writeHead(302, {location: 'http://localhost:' + plain.address().port + '/landing'})
  res.end()
})
var forwarded = []
var proxy = http.createServer(function (req, res) {
  forwarded.push(req.url)
  var target = url.parse(req.url)
  var upstream = http.request({host: target.hostname, port: target.port, path: target.path, method: req.method, headers: req.headers}, function (upstreamRes) {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  req.pipe(upstream)
})
proxy.on('connect', function (req, socket, head) {
  var hostPort = req.url.split(':')
  var upstream = net.connect(Number(hostPort[1]), hostPort[0], function () {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', function () {
    socket.destroy()
  })
  socket.on('error', function () {
    upstream.destroy()
  })
})

destroyable(plain)
destroyable(secure)
destroyable(proxy)

tape('setup', function (t) {
  plain.listen(0, function () {
    secure.listen(0, function () {
      proxy.listen(0, function () {
        t.end()
      })
    })
  })
})

tape('https to http redirect through a proxy with a caller agent is followed through the proxy', function (t) {
  var agent = new https.Agent({keepAlive: true})
  forwarded = []
  request({
    url: 'https://localhost:' + secure.address().port + '/',
    proxy: 'http://127.0.0.1:' + proxy.address().port,
    ca: ca,
    agent: agent
  }, function (err, res, body) {
    agent.destroy()
    t.equal(err, null)
    t.equal(res && res.statusCode, 200)
    t.equal(body, 'plain')
    t.deepEqual(forwarded, ['http://localhost:' + plain.address().port + '/landing'])
    t.end()
  })
})

tape('https to http redirect without a proxy keeps a caller agent and fails', function (t) {
  var agent = new https.Agent({ca: ca})
  request({
    url: 'https://localhost:' + secure.address().port + '/',
    agent: agent
  }, function (err) {
    agent.destroy()
    t.ok(err && /^Protocol "http:" not supported/.test(err.message))
    t.end()
  })
})

tape('cleanup', function (t) {
  plain.destroy(function () {
    secure.destroy(function () {
      proxy.destroy(function () {
        t.end()
      })
    })
  })
})

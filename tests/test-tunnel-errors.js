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
var proxy = http.createServer()
proxy.on('connect', function (req, socket, head) {
  var hostPort = req.url.split(':')
  var upstream = net.connect(+hostPort[1], hostPort[0], function () {
    socket.write('HTTP/1.1 200 Connection established\r\n\r\nbytes after the 200')
    upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', function () { socket.destroy() })
  socket.on('error', function () { upstream.destroy() })
})

destroyable(target)
destroyable(proxy)

function tunnel (t, options, check) {
  var uncaught = []
  var results = []
  var onUncaught = function (err) {
    uncaught.push(err.message)
  }
  process.on('uncaughtException', onUncaught)
  options.url = 'https://localhost:' + target.address().port + '/'
  options.proxy = 'http://127.0.0.1:' + proxy.address().port
  options.ca = ca
  options.timeout = 1000
  request(options, function (err, res, body) {
    results.push(err ? 'error' : body)
  })
  setTimeout(function () {
    process.removeListener('uncaughtException', onUncaught)
    t.deepEqual(uncaught, [], 'nothing is thrown')
    check(results)
    t.end()
  }, 1500)
}

tape('setup', function (t) {
  target.listen(0, function () {
    proxy.listen(0, function () {
      t.end()
    })
  })
})

tape('bytes a proxy sends after its 200 are dropped and the request succeeds', function (t) {
  tunnel(t, {}, function (results) {
    t.deepEqual(results, ['target'])
  })
})

tape('a wrong passphrase through a proxy calls back with an error', function (t) {
  tunnel(t, {
    key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/client-enc.key')),
    cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/client.crt')),
    passphrase: 'wrong password'
  }, function (results) {
    t.deepEqual(results, ['error'])
  })
})

tape('cleanup', function (t) {
  target.destroy(function () {
    proxy.destroy(function () {
      t.end()
    })
  })
})

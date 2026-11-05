'use strict'

var net = require('net')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var extraBytes = false
var proxy = net.createServer(function (socket) {
  socket.once('data', function () {
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n' + (extraBytes ? 'bytes after the 200' : ''))
    setTimeout(function () {
      socket.end()
    }, 50)
  })
  socket.on('error', function () {})
})

destroyable(proxy)

function tunnelFails (t, options) {
  var uncaught = []
  var errors = []
  var onUncaught = function (err) {
    uncaught.push(err.message)
  }
  process.on('uncaughtException', onUncaught)
  options.url = 'https://localhost:' + proxy.address().port + '/'
  options.proxy = 'http://127.0.0.1:' + proxy.address().port
  options.timeout = 1000
  request(options, function (err) {
    errors.push(err instanceof Error)
  })
  setTimeout(function () {
    process.removeListener('uncaughtException', onUncaught)
    t.deepEqual(uncaught, [], 'nothing is thrown')
    t.deepEqual(errors, [true], 'callback gets one error')
    t.end()
  }, 1500)
}

tape('setup', function (t) {
  proxy.listen(0, function () {
    t.end()
  })
})

tape('a proxy that sends bytes after its 200 calls back with an error', function (t) {
  extraBytes = true
  tunnelFails(t, {})
})

tape('a wrong passphrase through a proxy calls back with an error', function (t) {
  extraBytes = false
  tunnelFails(t, {
    key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/client-enc.key')),
    cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/client.crt')),
    passphrase: 'wrong password'
  })
})

tape('cleanup', function (t) {
  proxy.destroy(function () {
    t.end()
  })
})

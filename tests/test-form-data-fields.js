'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var received = ''
var s = http.createServer(function (req, res) {
  received = ''
  req.setEncoding('latin1')
  req.on('data', function (d) {
    received += d
  })
  req.on('end', function () {
    res.end('done')
  })
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('formData with a null value throws a TypeError', function (t) {
  t.throws(function () {
    request.post({url: 'http://localhost:' + s.address().port + '/', formData: {a: null}})
  }, TypeError)
  t.end()
})

tape('formData with an undefined value throws a TypeError', function (t) {
  t.throws(function () {
    request.post({url: 'http://localhost:' + s.address().port + '/', formData: {a: undefined}})
  }, TypeError)
  t.end()
})

tape('formData with a null value in an array throws a TypeError', function (t) {
  t.throws(function () {
    request.post({url: 'http://localhost:' + s.address().port + '/', formData: {a: ['x', null]}})
  }, TypeError)
  t.end()
})

tape('formData with a null value and options throws a TypeError', function (t) {
  t.throws(function () {
    request.post({url: 'http://localhost:' + s.address().port + '/', formData: {a: {value: null, options: {filename: 'x.txt', contentType: 'text/plain'}}}})
  }, TypeError)
  t.end()
})

tape('formData escapes quotes and line breaks in field names and filenames', function (t) {
  request.post({
    url: 'http://localhost:' + s.address().port + '/',
    formData: {
      'a"b\r\nX-Injected: 1': 'v',
      file: {value: Buffer.from('x'), options: {filename: 'c"d\r\n.txt'}}
    }
  }, function (err, res, body) {
    t.equal(err, null)
    t.ok(received.indexOf('name="a%22b%0D%0AX-Injected: 1"') !== -1)
    t.ok(received.indexOf('filename="c%22d%0D%0A.txt"') !== -1)
    t.equal(received.indexOf('\r\nX-Injected: 1'), -1)
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

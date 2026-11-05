'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  res.setHeader('x-content-length', String(req.headers['content-length']))
  res.end()
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

function sends (method, expected) {
  tape(method + ' without a body sends content-length ' + expected, function (t) {
    request({method: method, url: 'http://localhost:' + s.address().port + '/'}, function (err, res) {
      t.equal(err, null)
      t.equal(res.headers['x-content-length'], expected)
      t.end()
    })
  })
}

sends('GET', 'undefined')
sends('HEAD', 'undefined')
sends('DELETE', 'undefined')
sends('OPTIONS', 'undefined')
sends('POST', '0')
sends('PUT', '0')
sends('PATCH', '0')

function overwrites (method) {
  tape(method + ' without a body sends 0 for a content-length of the caller, as in 2.88.2', function (t) {
    request({
      method: method,
      url: 'http://localhost:' + s.address().port + '/',
      headers: {'content-length': 4},
      timeout: 1000
    }, function (err, res) {
      t.equal(err, null)
      t.equal(res && res.headers['x-content-length'], '0')
      t.end()
    })
  })
}

overwrites('DELETE')
overwrites('OPTIONS')
overwrites('POST')

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

'use strict'

var http = require('http')
var vm = require('vm')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var body = ''
  req.setEncoding('latin1')
  req.on('data', function (chunk) { body += chunk })
  req.on('end', function () {
    res.end(String(body.split('name="field"').length - 1))
  })
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a formData array from another realm sends one part per value', function (t) {
  var values = vm.runInNewContext('["a", "b"]')
  t.equal(values instanceof Array, false, 'the array comes from another realm')
  request.post({url: 'http://localhost:' + s.address().port + '/', formData: {field: values}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '2')
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

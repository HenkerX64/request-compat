'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  res.end(req.headers.cookie)
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a Cookie header given as an array is joined with "; " when a jar adds cookies', function (t) {
  var url = 'http://localhost:' + s.address().port + '/'
  var jar = request.jar()
  jar.setCookie('c=3', url)
  request({url: url, jar: jar, headers: {cookie: ['a=1', 'b=2']}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'a=1; b=2; c=3')
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

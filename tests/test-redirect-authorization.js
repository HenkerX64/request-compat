'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var other = 'http://127.0.0.1:' + s.address().port + '/landing'
  if (req.url === '/307-to-other') {
    res.writeHead(307, {location: other})
    return res.end()
  }
  if (req.url === '/302-to-other') {
    res.writeHead(302, {location: other})
    return res.end()
  }
  if (req.url === '/307-to-same') {
    res.writeHead(307, {location: '/landing'})
    return res.end()
  }
  res.end(req.headers.authorization || '(none)')
})

destroyable(s)

function local (path) {
  return 'http://localhost:' + s.address().port + path
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('307 redirect to another host drops the Authorization header', function (t) {
  request({url: local('/307-to-other'), headers: {authorization: 'Bearer secret'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.end()
  })
})

tape('307 redirect to another host drops basic auth', function (t) {
  request({url: local('/307-to-other'), auth: {user: 'user', pass: 'pass'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.end()
  })
})

tape('307 redirect to the same host keeps the Authorization header', function (t) {
  request({url: local('/307-to-same'), headers: {authorization: 'Bearer secret'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'Bearer secret')
    t.end()
  })
})

tape('302 redirect to another host drops the Authorization header', function (t) {
  request({url: local('/302-to-other'), headers: {authorization: 'Bearer secret'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

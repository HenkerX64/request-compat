'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var other = 'http://127.0.0.1:' + s.address().port + '/landing'
  if (req.url === '/to-other') {
    res.writeHead(302, {location: other})
    return res.end()
  }
  if (req.url === '/307-to-other') {
    res.writeHead(307, {location: other})
    return res.end()
  }
  if (req.url === '/to-same') {
    res.writeHead(302, {location: '/landing'})
    return res.end()
  }
  res.end(req.headers.cookie || '(none)')
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

tape('redirect to another host does not send the jar cookies of the previous host', function (t) {
  var jar = request.jar()
  jar.setCookie('session=localhost', local('/'))
  request({url: local('/to-other'), jar: jar}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.end()
  })
})

tape('redirect to another host sends the jar cookies of the new host', function (t) {
  var jar = request.jar()
  jar.setCookie('session=localhost', local('/'))
  jar.setCookie('session=other', 'http://127.0.0.1:' + s.address().port + '/')
  request({url: local('/to-other'), jar: jar}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'session=other')
    t.end()
  })
})

tape('redirect to another host drops a Cookie header passed by the caller', function (t) {
  request({url: local('/to-other'), headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.end()
  })
})

tape('307 redirect to another host drops the cookies', function (t) {
  var jar = request.jar()
  jar.setCookie('session=localhost', local('/'))
  request({url: local('/307-to-other'), jar: jar, headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.end()
  })
})

tape('redirect to the same host keeps the Cookie header passed by the caller and the jar cookies', function (t) {
  var jar = request.jar()
  jar.setCookie('session=localhost', local('/'))
  request({url: local('/to-same'), jar: jar, headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'manual=1; session=localhost')
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

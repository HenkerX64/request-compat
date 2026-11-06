'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var hops = []
var s = http.createServer(function (req, res) {
  var other = 'http://127.0.0.1:' + s.address().port + '/landing'
  hops.push(req.headers.host.split(':')[0] + ' ' + (req.headers.cookie || '(none)'))
  if (req.url === '/to-other-and-back') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/back'})
    return res.end()
  }
  if (req.url === '/back') {
    res.writeHead(302, {location: local('/landing')})
    return res.end()
  }
  if (req.url === '/to-x') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/x'})
    return res.end()
  }
  if (req.url === '/x') {
    res.writeHead(302, {location: '/y'})
    return res.end()
  }
  if (req.url === '/chain-1') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/chain-1b'})
    return res.end()
  }
  if (req.url === '/chain-1b') {
    res.writeHead(302, {location: 'http://localhost:' + s2.address().port + '/chain-1c'})
    return res.end()
  }
  if (req.url === '/chain-2') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/chain-2b'})
    return res.end()
  }
  if (req.url === '/chain-2b') {
    res.writeHead(302, {location: local('/chain-2c')})
    return res.end()
  }
  if (req.url === '/chain-2c') {
    res.writeHead(302, {location: 'http://localhost:' + s2.address().port + '/landing'})
    return res.end()
  }
  if (req.url === '/to-other-and-other-port') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/back-other-port'})
    return res.end()
  }
  if (req.url === '/back-other-port') {
    res.writeHead(302, {location: 'http://localhost:' + s2.address().port + '/landing'})
    return res.end()
  }
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

var s2 = http.createServer(function (req, res) {
  hops.push(req.headers.host.split(':')[0] + ':other-port ' + (req.headers.cookie || '(none)'))
  if (req.url === '/chain-1c') {
    res.writeHead(302, {location: local('/landing')})
  }
  res.end()
})

destroyable(s)
destroyable(s2)

function local (path) {
  return 'http://localhost:' + s.address().port + path
}

tape('setup', function (t) {
  s.listen(0, function () {
    s2.listen(0, function () {
      t.end()
    })
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

tape('redirect back to the first host sends the Cookie header passed by the caller again', function (t) {
  hops = []
  request({url: local('/to-other-and-back'), headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.deepEqual(hops, ['localhost manual=1', '127.0.0.1 (none)', 'localhost manual=1'])
    t.end()
  })
})

tape('redirect back to the first host sends the caller Cookie header with the jar cookies of that host', function (t) {
  var jar = request.jar()
  jar.setCookie('session=localhost', local('/'))
  jar.setCookie('session=other', 'http://127.0.0.1:' + s.address().port + '/')
  hops = []
  request({url: local('/to-other-and-back'), jar: jar, headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.deepEqual(hops, ['localhost manual=1; session=localhost', '127.0.0.1 session=other', 'localhost manual=1; session=localhost'])
    t.end()
  })
})

tape('redirect back to the first host on another port does not send the Cookie header passed by the caller', function (t) {
  hops = []
  request({url: local('/to-other-and-other-port'), headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.deepEqual(hops, ['localhost manual=1', '127.0.0.1 (none)', 'localhost:other-port (none)'])
    t.end()
  })
})

tape('back on the first host from its other port after another host the caller Cookie header is sent again', function (t) {
  hops = []
  request({url: local('/chain-1'), headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.deepEqual(hops, ['localhost manual=1', '127.0.0.1 (none)', 'localhost:other-port (none)', 'localhost manual=1'])
    t.end()
  })
})

tape('after another host the first host on another port does not get the restored Cookie header', function (t) {
  hops = []
  request({url: local('/chain-2'), headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.deepEqual(hops, ['localhost manual=1', '127.0.0.1 (none)', 'localhost manual=1', 'localhost:other-port (none)'])
    t.end()
  })
})

tape('after another host a redirect on that host keeps the Cookie header of the previous hop, as in 2.88.2', function (t) {
  var jar = request.jar()
  jar.setCookie('scoped=x; Path=/x', 'http://127.0.0.1:' + s.address().port + '/x')
  hops = []
  request({url: local('/to-x'), jar: jar, headers: {cookie: 'manual=1'}}, function (err, res, body) {
    t.equal(err, null)
    t.deepEqual(hops, ['localhost manual=1', '127.0.0.1 scoped=x', '127.0.0.1 scoped=x'])
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    s2.destroy(function () {
      t.end()
    })
  })
})

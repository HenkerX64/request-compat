'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var tokens = []
var s = http.createServer(function (req, res) {
  if (req.headers['x-amz-security-token']) {
    tokens.push(req.headers.host.split(':')[0] + ' ' + req.headers['x-amz-security-token'])
  }
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
  if (req.url === '/to-other-challenge') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/challenge'})
    return res.end()
  }
  if (req.url === '/to-same-challenge') {
    res.writeHead(302, {location: '/challenge'})
    return res.end()
  }
  if (req.url === '/bounce') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/back'})
    return res.end()
  }
  if (req.url === '/back') {
    res.writeHead(302, {location: 'http://localhost:' + s.address().port + '/challenge'})
    return res.end()
  }
  if (req.url === '/bounce-other-port') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/back-other-port'})
    return res.end()
  }
  if (req.url === '/back-other-port') {
    res.writeHead(302, {location: 'http://localhost:' + s2.address().port + '/challenge'})
    return res.end()
  }
  if (req.url === '/to-userinfo') {
    res.writeHead(302, {location: 'http://other:secret@127.0.0.1:' + s.address().port + '/userinfo-start'})
    return res.end()
  }
  if (req.url === '/userinfo-start') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/userinfo-next'})
    return res.end()
  }
  if (req.url === '/userinfo-next') {
    challenges.push(req.headers.host.split(':')[0] + ' ' + (req.headers.authorization || '-'))
    return res.end()
  }
  if (req.url === '/leave') {
    res.writeHead(302, {location: 'http://127.0.0.1:' + s.address().port + '/return'})
    return res.end()
  }
  if (req.url === '/return') {
    res.writeHead(302, {location: local('/challenge-then-away')})
    return res.end()
  }
  if (req.url === '/challenge-then-away') {
    if (!req.headers.authorization) {
      res.writeHead(401, {'www-authenticate': 'Basic realm="test"'})
      return res.end()
    }
    res.writeHead(302, {location: 'http://localhost:' + s2.address().port + '/plain'})
    return res.end()
  }
  if (req.url === '/challenge') {
    challenges.push(req.headers.host.split(':')[0] + ' ' + (req.headers.authorization || '-'))
    if (!req.headers.authorization) {
      res.writeHead(401, {'www-authenticate': 'Basic realm="test"'})
      return res.end()
    }
  }
  res.end(req.headers.authorization || '(none)')
})

var s2 = http.createServer(function (req, res) {
  challenges.push(req.headers.host.split(':')[0] + ':other-port ' + (req.headers.authorization || '-'))
  if (!req.headers.authorization) {
    res.writeHead(401, {'www-authenticate': 'Basic realm="test"'})
    return res.end()
  }
  res.end(req.headers.authorization)
})

var challenges = []
var credentials = {user: 'user', pass: 'pass', sendImmediately: false}

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

tape('a 401 challenge after a redirect to another host does not get the credentials', function (t) {
  challenges = []
  request({url: local('/to-other-challenge'), auth: credentials}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 401)
    t.deepEqual(challenges, ['127.0.0.1 -'])
    t.end()
  })
})

tape('a 401 challenge after a redirect to the same host gets the credentials', function (t) {
  challenges = []
  request({url: local('/to-same-challenge'), auth: credentials}, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.deepEqual(challenges, ['localhost -', 'localhost Basic dXNlcjpwYXNz'])
    t.end()
  })
})

tape('a 401 challenge back on the first host gets the credentials again', function (t) {
  challenges = []
  request({url: local('/bounce'), auth: credentials}, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.deepEqual(challenges, ['localhost -', 'localhost Basic dXNlcjpwYXNz'])
    t.end()
  })
})

tape('a 401 challenge back on the first host but on another port does not get the credentials', function (t) {
  challenges = []
  request({url: local('/bounce-other-port'), auth: credentials}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 401)
    t.deepEqual(challenges, ['localhost:other-port -'])
    t.end()
  })
})

tape('basic auth sent immediately does not reach the first host on another port after another host', function (t) {
  challenges = []
  request({url: local('/bounce-other-port'), auth: {user: 'user', pass: 'pass'}}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 401)
    t.deepEqual(challenges, ['localhost:other-port -'])
    t.end()
  })
})

tape('a redirect to another host does not get an aws signature', function (t) {
  request({url: local('/302-to-other'), aws: {key: 'AKIDEXAMPLE', secret: 'secret'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.end()
  })
})

tape('an aws signature is made again back on the first host', function (t) {
  challenges = []
  request({url: local('/bounce'), aws: {key: 'AKIDEXAMPLE', secret: 'secret'}}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.equal(challenges.length, 1)
    t.ok(/^localhost AWS AKIDEXAMPLE:/.test(challenges[0]))
    t.end()
  })
})

tape('a redirect to another host does not get the aws session token', function (t) {
  tokens = []
  request({url: local('/302-to-other'), aws: {key: 'AKIDEXAMPLE', secret: 'secret', session: 'SESSIONTOKEN', sign_version: 4, service: 's3'}}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '(none)')
    t.deepEqual(tokens, ['localhost SESSIONTOKEN'])
    t.end()
  })
})

tape('after another host the Authorization header of the first host does not reach its other port', function (t) {
  challenges = []
  request({url: local('/leave'), auth: credentials}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 401)
    t.deepEqual(challenges, ['localhost:other-port -'])
    t.end()
  })
})

tape('after another host the aws signature of the first host does not reach its other port', function (t) {
  challenges = []
  request({url: local('/leave'), aws: {key: 'AKIDEXAMPLE', secret: 'secret'}}, function (err, res) {
    t.equal(err, null)
    t.equal(res.statusCode, 401)
    t.deepEqual(challenges, ['localhost:other-port -'])
    t.end()
  })
})

tape('credentials from the userinfo of a Location stay on later redirects within that host, as in 2.88.2', function (t) {
  challenges = []
  request({url: local('/to-userinfo')}, function (err, res) {
    t.equal(err, null)
    t.deepEqual(challenges, ['127.0.0.1 Basic b3RoZXI6c2VjcmV0'])
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

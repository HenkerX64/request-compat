'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var port = s.address().port
  if (req.url === '/308') {
    res.writeHead(308, {location: '/landing'})
    req.resume()
    return res.end()
  }
  if (req.url === '/308-to-other') {
    res.writeHead(308, {location: 'http://localhost:' + port + '/landing'})
    req.resume()
    return res.end()
  }
  var body = ''
  req.on('data', function (chunk) { body += chunk })
  req.on('end', function () {
    res.end(JSON.stringify({
      method: req.method,
      body: body,
      host: req.headers.host,
      authorization: req.headers.authorization || null
    }))
  })
})

destroyable(s)

function base () {
  return 'http://127.0.0.1:' + s.address().port
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a 308 keeps the method and the body with followAllRedirects', function (t) {
  request.post({url: base() + '/308', body: 'abc', followAllRedirects: true}, function (err, res, body) {
    t.equal(err, null)
    var seen = JSON.parse(body)
    t.equal(seen.method, 'POST')
    t.equal(seen.body, 'abc')
    t.end()
  })
})

tape('a 308 to another host drops Authorization and sends the new Host', function (t) {
  request.post({
    url: base() + '/308-to-other',
    body: 'abc',
    followAllRedirects: true,
    headers: {authorization: 'Bearer secret', host: 'caller.example'}
  }, function (err, res, body) {
    t.equal(err, null)
    var seen = JSON.parse(body)
    t.equal(seen.method, 'POST')
    t.equal(seen.authorization, null)
    t.equal(seen.host, 'localhost:' + s.address().port)
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

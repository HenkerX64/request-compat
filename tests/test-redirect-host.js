'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var port = s.address().port
  if (req.url === '/307-to-other') {
    res.writeHead(307, {location: 'http://localhost:' + port + '/landing'})
    return res.end()
  }
  if (req.url === '/307-to-same') {
    res.writeHead(307, {location: '/landing'})
    return res.end()
  }
  res.end(req.headers.host)
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a 307 to another host sends the Host of the new host', function (t) {
  request({
    url: 'http://127.0.0.1:' + s.address().port + '/307-to-other',
    headers: {host: 'caller.example'}
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'localhost:' + s.address().port)
    t.end()
  })
})

tape('a 307 to the same host keeps the Host of the caller', function (t) {
  request({
    url: 'http://127.0.0.1:' + s.address().port + '/307-to-same',
    headers: {host: 'caller.example'}
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'caller.example')
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

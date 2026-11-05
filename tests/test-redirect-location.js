'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var port = s.address().port
  var locations = {
    '/userinfo': 'http://a%zz@127.0.0.1:' + port + '/landing',
    '/relative-userinfo': '//a%zz@127.0.0.1:' + port + '/landing',
    '/host': 'http://[::1/landing'
  }
  if (locations[req.url]) {
    res.writeHead(302, {location: locations[req.url]})
    return res.end()
  }
  res.end('landing')
})

destroyable(s)

function redirectFails (t, path) {
  var uncaught = []
  var errors = []
  var onUncaught = function (err) {
    uncaught.push(err.message)
  }
  process.on('uncaughtException', onUncaught)
  request('http://127.0.0.1:' + s.address().port + path, function (err) {
    errors.push(err instanceof Error)
  })
  setTimeout(function () {
    process.removeListener('uncaughtException', onUncaught)
    t.deepEqual(errors, [true], 'callback gets one error')
    t.deepEqual(uncaught, [], 'nothing is thrown')
    t.end()
  }, 300)
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a Location with malformed percent-encoding in the userinfo calls back with an error', function (t) {
  redirectFails(t, '/userinfo')
})

tape('a relative Location with malformed percent-encoding calls back with an error', function (t) {
  redirectFails(t, '/relative-userinfo')
})

tape('a Location with an invalid host calls back with an error', function (t) {
  redirectFails(t, '/host')
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

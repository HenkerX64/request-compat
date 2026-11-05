'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var body = ''
  req.setEncoding('utf8')
  req.on('data', function (chunk) { body += chunk })
  req.on('end', function () {
    if (req.url === '/302') {
      res.writeHead(302, {location: '/landing'})
      return res.end()
    }
    res.end(req.method + ' ' + (body.indexOf('new part') !== -1))
  })
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('multipart() in a redirect listener sets the body of the next hop, as in 2.88.2', function (t) {
  var uncaught = []
  var onUncaught = function (err) {
    uncaught.push(err.message)
  }
  process.on('uncaughtException', onUncaught)
  var result = null
  var r = request.post({
    url: 'http://localhost:' + s.address().port + '/302',
    followAllRedirects: true,
    multipart: [{body: 'first part'}]
  }, function (err, res, body) {
    result = err ? 'error ' + err.message : body
  })
  r.on('redirect', function () {
    this.multipart([{body: 'new part'}])
  })
  setTimeout(function () {
    process.removeListener('uncaughtException', onUncaught)
    t.deepEqual(uncaught, [])
    t.equal(result, 'GET true')
    t.end()
  }, 500)
})

tape('a chunked multipart body is dropped on a 302 with followAllRedirects', function (t) {
  var result = null
  request.post({
    url: 'http://localhost:' + s.address().port + '/302',
    followAllRedirects: true,
    multipart: {chunked: true, data: [{body: 'first part'}]}
  }, function (err, res, body) {
    result = err ? 'error ' + err.message : body
  })
  setTimeout(function () {
    t.equal(result, 'GET false')
    t.end()
  }, 500)
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

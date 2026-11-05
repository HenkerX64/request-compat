'use strict'

var http = require('http')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var file = path.resolve(__dirname, 'unicycle.jpg')

var s = http.createServer(function (req, res) {
  var length = 0
  req.on('data', function (chunk) { length += chunk.length })
  req.on('end', function () {
    if (req.url === '/308' || req.url === '/302') {
      res.writeHead(+req.url.slice(1), {location: '/landing'})
      return res.end()
    }
    res.end(req.method + ' ' + length)
  })
})

destroyable(s)

function redirect (t, status, options, prepare, expected) {
  var finished = false
  var timer = setTimeout(function () {
    finished = true
    t.fail('no callback within 2 s')
    t.end()
  }, 2000)
  options.url = 'http://localhost:' + s.address().port + '/' + status
  options.method = 'POST'
  options.followAllRedirects = true
  var r = request(options, function (err, res, body) {
    if (finished) {
      return
    }
    finished = true
    clearTimeout(timer)
    t.equal(err, null)
    t.equal(body, expected)
    t.end()
  })
  if (prepare) {
    prepare(r)
  }
}

function appendForm (r) {
  r.form().append('foo', 'bar')
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a 308 with a form of r.form() is followed with GET, as in 2.88.2', function (t) {
  redirect(t, 308, {}, appendForm, 'GET 0')
})

tape('a 308 with a stream body and a content-length is followed with GET, as in 2.88.2', function (t) {
  redirect(t, 308, {
    body: fs.createReadStream(file),
    headers: {'content-length': fs.statSync(file).size}
  }, null, 'GET 0')
})

tape('a 302 with followOriginalHttpMethod and r.form() sends POST without a body, as in 2.88.2', function (t) {
  redirect(t, 302, {followOriginalHttpMethod: true}, appendForm, 'POST 0')
})

tape('a 308 keeps POST and a string body', function (t) {
  redirect(t, 308, {body: 'abc'}, null, 'POST 3')
})

tape('a 302 with followOriginalHttpMethod keeps POST and a string body', function (t) {
  redirect(t, 302, {body: 'abc', followOriginalHttpMethod: true}, null, 'POST 3')
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

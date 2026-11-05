'use strict'

var http = require('http')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var file = path.resolve(__dirname, 'unicycle.jpg')

var s = http.createServer(function (req, res) {
  var body = []
  req.on('data', function (chunk) { body.push(chunk) })
  req.on('end', function () {
    if (req.url === '/307' || req.url === '/308') {
      res.writeHead(+req.url.slice(1), {location: '/landing'})
      return res.end()
    }
    body = Buffer.concat(body).toString('latin1')
    res.end(JSON.stringify({
      method: req.method,
      fooField: body.indexOf('name="foo"\r\n\r\nbar\r\n') !== -1,
      fileField: body.indexOf('name="file"; filename="unicycle.jpg"') !== -1,
      length: body.length
    }))
  })
})

destroyable(s)

function redirected (t, status) {
  var called = false
  var timer = setTimeout(function () {
    t.fail('no callback within 2 s')
    t.end()
  }, 2000)
  request.post({
    url: 'http://127.0.0.1:' + s.address().port + '/' + status,
    formData: {foo: 'bar', file: fs.createReadStream(file)},
    followAllRedirects: true,
    timeout: 1000
  }, function (err, res, body) {
    if (called) {
      return
    }
    called = true
    clearTimeout(timer)
    t.equal(err, null)
    var seen = JSON.parse(body)
    t.equal(seen.method, 'POST')
    t.equal(seen.fooField, true)
    t.equal(seen.fileField, true)
    t.ok(seen.length > fs.statSync(file).size, 'the file is sent again')
    t.end()
  })
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('formData with a file stream is sent again after a 307', function (t) {
  redirected(t, 307)
})

tape('formData with a file stream is sent again after a 308', function (t) {
  redirected(t, 308)
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

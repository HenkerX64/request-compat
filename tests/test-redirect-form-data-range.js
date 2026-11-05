'use strict'

var http = require('http')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  var body = ''
  req.setEncoding('latin1')
  req.on('data', function (chunk) { body += chunk })
  req.on('end', function () {
    if (req.url === '/307') {
      res.writeHead(307, {location: '/landing'})
      return res.end()
    }
    res.end(String(body.indexOf('\r\n\r\nHello\r\n--') !== -1))
  })
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a file stream with start and end is sent again with the same range after a 307', function (t) {
  var result = null
  request.post({
    url: 'http://localhost:' + s.address().port + '/307',
    followAllRedirects: true,
    formData: {file: fs.createReadStream(path.resolve(__dirname, 'raw.file'), {start: 0, end: 4})}
  }, function (err, res, body) {
    result = err ? 'error ' + err.message : body
  })
  setTimeout(function () {
    t.equal(result, 'true')
    t.end()
  }, 1000)
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

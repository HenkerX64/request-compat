'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  res.end(req.method + ' ' + req.url)
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('an invalid har object is applied without an unhandled promise rejection', function (t) {
  var rejections = []
  var onRejection = function (reason) {
    rejections.push(String(reason))
  }
  process.on('unhandledRejection', onRejection)
  request({
    url: 'http://localhost:' + s.address().port + '/fallback',
    har: {url: 'http://localhost:' + s.address().port + '/har', method: 'POST', queryString: [{name: 'a'}]}
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'POST /har')
    setTimeout(function () {
      process.removeListener('unhandledRejection', onRejection)
      t.deepEqual(rejections, [])
      t.end()
    }, 50)
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

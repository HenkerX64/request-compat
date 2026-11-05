'use strict'

var https = require('https')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var ca = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/ca.crt'))
var s = https.createServer({
  key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.key')),
  cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.crt'))
}, function (req, res) {
  res.end('ok')
})

destroyable(s)

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('requests with an inline checkServerIdentity share one pooled agent', function (t) {
  var pool = {}
  var left = 5
  function next () {
    request({
      url: 'https://localhost:' + s.address().port + '/',
      pool: pool,
      agentOptions: {
        ca: ca,
        checkServerIdentity: function () {}
      }
    }, function (err) {
      t.equal(err, null)
      left -= 1
      if (left) {
        return next()
      }
      t.equal(Object.keys(pool).length, 1)
      t.end()
    })
  }
  next()
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

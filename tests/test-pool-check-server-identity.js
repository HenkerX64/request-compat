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

function url () {
  return 'https://localhost:' + s.address().port + '/'
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a pooled agent without checkServerIdentity does not serve a request that sets it', function (t) {
  var pool = {}
  request({url: url(), pool: pool, agentOptions: {ca: ca}}, function (err) {
    t.equal(err, null)
    request({
      url: url(),
      pool: pool,
      agentOptions: {
        ca: ca,
        checkServerIdentity: function () {
          return new Error('pinned certificate mismatch')
        }
      }
    }, function (err) {
      t.equal(err && err.message, 'pinned certificate mismatch')
      t.end()
    })
  })
})

tape('requests with different checkServerIdentity functions each run their own', function (t) {
  var pool = {}
  var calls = []
  function check (name) {
    return function () {
      calls.push(name)
    }
  }
  var first = check('first')
  request({url: url(), pool: pool, agentOptions: {ca: ca, checkServerIdentity: first}}, function (err) {
    t.equal(err, null)
    request({url: url(), pool: pool, agentOptions: {ca: ca, checkServerIdentity: check('second')}}, function (err) {
      t.equal(err, null)
      request({url: url(), pool: pool, agentOptions: {ca: ca, checkServerIdentity: first}}, function (err) {
        t.equal(err, null)
        t.deepEqual(calls, ['first', 'second'])
        t.equal(Object.keys(pool).length, 2, 'the same function shares one agent')
        t.end()
      })
    })
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

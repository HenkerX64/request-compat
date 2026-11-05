'use strict'

var https = require('https')
var fs = require('fs')
var path = require('path')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var ca = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/ca.crt'))
var key = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/client-enc.key'))
var cert = fs.readFileSync(path.resolve(__dirname, 'ssl/ca/client.crt'))
var s = https.createServer({
  key: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.key')),
  cert: fs.readFileSync(path.resolve(__dirname, 'ssl/ca/localhost.crt'))
}, function (req, res) {
  res.end('ok')
})

destroyable(s)

function options (pool, passphrase) {
  return {
    url: 'https://localhost:' + s.address().port + '/',
    pool: pool,
    ca: ca,
    key: key,
    cert: cert,
    passphrase: passphrase
  }
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a pooled agent is not reused for a request with another passphrase', function (t) {
  var pool = {}
  request(options(pool, 'password'), function (err) {
    t.equal(err, null)
    request(options(pool, 'wrong password'), function (err) {
      t.ok(err instanceof Error, 'the wrong passphrase fails')
      t.equal(Object.keys(pool).length, 2)
      t.end()
    })
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

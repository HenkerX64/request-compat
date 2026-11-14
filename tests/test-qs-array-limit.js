'use strict'

var oauth = require('oauth-sign')
var request = require('../index')
var tape = require('tape')

function repeat (pair, count) {
  var parts = []
  for (var i = 0; i < count; i++) {
    parts.push(pair)
  }
  return parts.join('&')
}

function indexed (name, value, count) {
  var parts = []
  for (var i = 0; i < count; i++) {
    parts.push(name + '%5B' + i + '%5D=' + value)
  }
  return parts.join('&')
}

function pathTest (name, options, expected) {
  tape(name, function (t) {
    var r = request.get(options)
    process.nextTick(function () {
      t.equal(r.path, expected)
      r.abort()
      t.end()
    })
  })
}

function getSignature (r) {
  var match = /oauth_signature="([^"]*)"/.exec(r.getHeader('authorization'))
  return match && decodeURIComponent(match[1])
}

function oauthTest (name, query, params) {
  tape(name, function (t) {
    var r = request.get({
      uri: 'http://localhost/?' + query,
      oauth: {
        consumer_key: 'key',
        consumer_secret: 'secret',
        token: 'token',
        token_secret: 'tokensecret',
        nonce: 'nonce',
        timestamp: '1700000000'
      }
    })
    var expected = oauth.hmacsign('GET', 'http://localhost/', Object.assign({
      oauth_consumer_key: 'key',
      oauth_nonce: 'nonce',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1700000000',
      oauth_token: 'token',
      oauth_version: '1.0'
    }, params), 'secret', 'tokensecret')
    process.nextTick(function () {
      t.equal(getSignature(r), expected)
      r.abort()
      t.end()
    })
  })
}

var brackets = {arrayFormat: 'brackets'}

pathTest('a[] values up to arrayLimit stay an array', {
  uri: 'http://localhost/?a[]=1&a[]=2',
  qs: {b: 'c'},
  qsParseOptions: {arrayLimit: 2},
  qsStringifyOptions: brackets
}, '/?a%5B%5D=1&a%5B%5D=2&b=c')

pathTest('more a[] values than arrayLimit become an object (GHSA-6rw7-vpxm-498p)', {
  uri: 'http://localhost/?a[]=1&a[]=2&a[]=3&a[]=4&a[]=5&a[]=6',
  qs: {b: 'c'},
  qsParseOptions: {arrayLimit: 5},
  qsStringifyOptions: brackets
}, '/?a%5B0%5D=1&a%5B1%5D=2&a%5B2%5D=3&a%5B3%5D=4&a%5B4%5D=5&a%5B5%5D=6&b=c')

pathTest('more a[] values than arrayLimit go out with dots under allowDots (GHSA-6rw7-vpxm-498p)', {
  uri: 'http://localhost/?a[]=1&a[]=2&a[]=3',
  qs: {b: 'c'},
  qsParseOptions: {arrayLimit: 2},
  qsStringifyOptions: {allowDots: true}
}, '/?a.0=1&a.1=2&a.2=3&b=c')

pathTest('20 a[] values stay an array with the default arrayLimit', {
  uri: 'http://localhost/?' + repeat('a[]=x', 20),
  qs: {b: 'c'},
  qsStringifyOptions: brackets
}, '/?' + repeat('a%5B%5D=x', 20) + '&b=c')

pathTest('21 a[] values become an object with the default arrayLimit (GHSA-6rw7-vpxm-498p)', {
  uri: 'http://localhost/?' + repeat('a[]=x', 21),
  qs: {b: 'c'},
  qsStringifyOptions: brackets
}, '/?' + indexed('a', 'x', 21) + '&b=c')

pathTest('21 a[] values give the same path as before with the default stringify options', {
  uri: 'http://localhost/?' + repeat('a[]=x', 21),
  qs: {b: 'c'}
}, '/?' + indexed('a', 'x', 21) + '&b=c')

pathTest('an index under [] below arrayLimit is compacted as before', {
  uri: 'http://localhost/?a[][19]=x',
  qs: {b: 'c'}
}, '/?a%5B0%5D=x&b=c')

pathTest('an index under [] that reaches arrayLimit keeps its number (GHSA-6rw7-vpxm-498p)', {
  uri: 'http://localhost/?a[][20]=x',
  qs: {b: 'c'}
}, '/?a%5B20%5D=x&b=c')

pathTest('a plain value after more a[] values than arrayLimit is appended to the object', {
  uri: 'http://localhost/?a[]=1&a[]=2&a[]=3&a=4',
  qs: {b: 'c'},
  qsParseOptions: {arrayLimit: 2},
  qsStringifyOptions: brackets
}, '/?a%5B0%5D=1&a%5B1%5D=2&a%5B2%5D=3&a%5B3%5D=4&b=c')

pathTest('repeated plain keys stay an array above arrayLimit, as in 2.88.2', {
  uri: 'http://localhost/?a=1&a=2&a=3',
  qs: {b: 'c'},
  qsParseOptions: {arrayLimit: 2},
  qsStringifyOptions: brackets
}, '/?a%5B%5D=1&a%5B%5D=2&a%5B%5D=3&b=c')

oauthTest('OAuth signs 21 repeated plain keys as before', repeat('a=x', 21), {
  a: repeat('x', 21).split('&')
})

oauthTest('OAuth signs 21 a[] values as indexed keys (GHSA-6rw7-vpxm-498p)', repeat('a[]=x', 21), {
  a: Object.assign({}, repeat('x', 21).split('&'))
})

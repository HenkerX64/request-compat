'use strict'

var request = require('../index')
var tape = require('tape')
var Buffer = require('safe-buffer').Buffer

function build (t, method, options) {
  var r = null
  t.doesNotThrow(function () {
    r = request[method](options)
  })
  return r
}

function pathTest (name, options, expected) {
  tape(name, function (t) {
    var r = build(t, 'get', options)
    if (r) {
      t.equal(r.path, expected)
      r.abort()
    }
    t.end()
  })
}

pathTest('a qs value with a non-callable constructor.isBuffer is stringified (GHSA-4mjr-xmp4-gh2g)', {
  uri: 'http://localhost/',
  qs: {a: {constructor: {isBuffer: 'x'}}}
}, '/?a%5Bconstructor%5D%5BisBuffer%5D=x')

pathTest('a query parsed with plainObjects and stringified again keeps a constructor[isBuffer] key (GHSA-4mjr-xmp4-gh2g)', {
  uri: 'http://localhost/?x[constructor][isBuffer]=y',
  qs: {b: 'c'},
  qsParseOptions: {plainObjects: true}
}, '/?x%5Bconstructor%5D%5BisBuffer%5D=y&b=c')

pathTest('a query parsed with allowPrototypes and stringified again keeps a constructor[isBuffer] key (GHSA-4mjr-xmp4-gh2g)', {
  uri: 'http://localhost/?x[constructor][isBuffer]=y',
  qs: {b: 'c'},
  qsParseOptions: {allowPrototypes: true}
}, '/?x%5Bconstructor%5D%5BisBuffer%5D=y&b=c')

pathTest('a query parsed with the default options drops the constructor key, as in 2.88.2', {
  uri: 'http://localhost/?x[constructor][isBuffer]=y',
  qs: {b: 'c'}
}, '/?b=c')

pathTest('a Buffer qs value is stringified as before', {
  uri: 'http://localhost/',
  qs: {a: Buffer.from('xyz')}
}, '/?a=xyz')

pathTest('a value with a callable constructor.isBuffer is still treated as a buffer', {
  uri: 'http://localhost/',
  qs: {
    a: {
      constructor: {isBuffer: function () { return true }},
      toString: function () { return 'duck' }
    }
  }
}, '/?a=duck')

tape('a form value with a non-callable constructor.isBuffer is stringified (GHSA-4mjr-xmp4-gh2g)', function (t) {
  var r = build(t, 'post', {
    uri: 'http://localhost/',
    form: {a: {constructor: {isBuffer: 'x'}}}
  })
  if (r) {
    t.equal(String(r.body), 'a%5Bconstructor%5D%5BisBuffer%5D=x')
    r.abort()
  }
  t.end()
})

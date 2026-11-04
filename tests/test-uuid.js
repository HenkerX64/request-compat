'use strict'

var uuid = require('../lib/helpers').uuid
var tape = require('tape')

var v4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

tape('uuid returns RFC 4122 version 4 identifiers', function (t) {
  for (var i = 0; i < 1000; i++) {
    var id = uuid()
    if (!v4Pattern.test(id)) {
      t.fail('not a version 4 uuid: ' + id)
      return t.end()
    }
  }
  t.pass('1000 identifiers match the version 4 layout')
  t.end()
})

tape('uuid does not repeat identifiers', function (t) {
  var seen = {}
  for (var i = 0; i < 1000; i++) {
    seen[uuid()] = true
  }
  t.equal(Object.keys(seen).length, 1000)
  t.end()
})

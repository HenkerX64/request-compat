'use strict'

var http = require('http')
var tape = require('tape')
var tough = require('tough-cookie')
var toughPackage = require('tough-cookie/package.json')
var request = require('../index')
var destroyable = require('server-destroy')

var s = http.createServer(function (req, res) {
  res.end(req.headers.cookie)
})

destroyable(s)

function setCookie (t, jar, cookie, url) {
  var stored = null
  t.doesNotThrow(function () {
    stored = jar.setCookie(cookie, url)
  })
  return stored
}

tape('setup', function (t) {
  t.equal(toughPackage.version, '2.5.0')
  s.listen(0, function () {
    s.url = 'http://localhost:' + this.address().port
    t.end()
  })
})

tape('jar.setCookie takes a Cookie of the caller\'s tough-cookie 2.5', function (t) {
  var url = 'https://api.mydomain.com'
  var cookie = new tough.Cookie({key: 'some_key', value: 'some_value', domain: 'api.mydomain.com', httpOnly: true, maxAge: 31536000})
  var jar = request.jar()
  setCookie(t, jar, cookie, url)
  t.equal(jar.getCookieString(url), 'some_key=some_value')
  var stored = jar.getCookies(url)[0] || {}
  t.equal(stored.domain, 'api.mydomain.com')
  t.equal(stored.hostOnly, false)
  t.equal(stored.httpOnly, true)
  t.equal(stored.maxAge, 31536000)
  t.equal(stored.path, '/')
  t.equal(stored.pathIsDefault, true)
  t.end()
})

tape('a request sends a Cookie of the caller\'s tough-cookie 2.5', function (t) {
  var jar = request.jar()
  setCookie(t, jar, new tough.Cookie({key: 'a', value: 'b'}), s.url)
  request({url: s.url, jar: jar}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, 'a=b')
    t.end()
  })
})

tape('jar.setCookie stores a copy of a Cookie of the caller\'s tough-cookie', function (t) {
  var url = 'http://localhost/'
  var cookie = new tough.Cookie({key: 'a', value: 'b'})
  var jar = request.jar()
  var stored = setCookie(t, jar, cookie, url)
  cookie.value = 'changed'
  t.notEqual(stored, cookie)
  t.equal(cookie.hostOnly, null)
  t.equal(jar.getCookieString(url), 'a=b')
  t.end()
})

tape('a Cookie of request is no Cookie of the caller\'s tough-cookie', function (t) {
  var url = 'http://localhost/'
  var cookie = request.cookie('a=b')
  var callerJar = new tough.CookieJar()
  t.equal(cookie instanceof tough.Cookie, false)
  t.throws(function () {
    callerJar.setCookieSync(cookie, url)
  }, TypeError)
  t.end()
})

tape('the caller\'s tough-cookie takes the string of a Cookie of request', function (t) {
  var url = 'http://localhost/'
  var jar = request.jar()
  jar.setCookie('a=b; Max-Age=60', url)
  var callerJar = new tough.CookieJar()
  callerJar.setCookieSync(jar.getCookies(url)[0].toString(), url)
  t.equal(callerJar.getCookieStringSync(url), 'a=b')
  t.end()
})

tape('a Cookie of the caller\'s tough-cookie goes as it is into a CookieJar of that tough-cookie set as _jar', function (t) {
  var url = 'http://localhost/'
  var cookie = new tough.Cookie({key: 'a', value: 'b'})
  var jar = request.jar()
  jar._jar = new tough.CookieJar()
  var stored = setCookie(t, jar, cookie, url)
  t.equal(stored, cookie)
  t.equal(jar.getCookieString(url), 'a=b')
  t.end()
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

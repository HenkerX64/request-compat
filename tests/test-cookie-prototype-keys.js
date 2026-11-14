'use strict'

var http = require('http')
var tape = require('tape')
var request = require('../index')
var destroyable = require('server-destroy')

var has = Object.prototype.hasOwnProperty

var s = http.createServer(function (req, res) {
  if (req.url === '/set') {
    res.setHeader('set-cookie', ['__proto__=x', 'a=1'])
    res.statusCode = 302
    res.setHeader('location', '/end')
    res.end()
    return
  }
  res.end(req.headers.cookie)
})

destroyable(s)

function getCookieString (t, jar, url) {
  var cookies = null
  t.doesNotThrow(function () {
    cookies = jar.getCookieString(url)
  })
  return cookies
}

tape('setup', function (t) {
  s.listen(0, function () {
    t.end()
  })
})

tape('a cookie for the host __proto__ leaves Object.prototype alone (GHSA-72xf-g2v4-qvf3)', function (t) {
  var jar = request.jar()
  jar.setCookie('a=b', 'http://__proto__/')
  var polluted = has.call(Object.prototype, '/')
  delete Object.prototype['/']
  t.equal(polluted, false)
  t.equal(getCookieString(t, jar, 'http://__proto__/'), 'a=b')
  t.equal(getCookieString(t, jar, 'http://localhost/'), '')
  t.end()
})

tape('a cookie for the host constructor leaves Object alone (GHSA-72xf-g2v4-qvf3)', function (t) {
  var jar = request.jar()
  jar.setCookie('a=b', 'http://constructor/')
  var polluted = has.call(Object, '/')
  delete Object['/']
  t.equal(polluted, false)
  t.equal(getCookieString(t, jar, 'http://constructor/'), 'a=b')
  t.end()
})

tape('a cookie named __proto__ is stored and sent like any other cookie (GHSA-72xf-g2v4-qvf3)', function (t) {
  var url = 'http://localhost/'
  var jar = request.jar()
  jar.setCookie('__proto__=x', url)
  jar.setCookie('a=1', url)
  t.equal(getCookieString(t, jar, url), '__proto__=x; a=1')
  t.end()
})

tape('cookies named after Object.prototype members keep their creation order (GHSA-72xf-g2v4-qvf3)', function (t) {
  var url = 'http://localhost/'
  var jar = request.jar()
  jar.setCookie('a=1', url)
  jar.setCookie('toString=2', url)
  jar.setCookie('b=3', url)
  jar.setCookie('constructor=4', url)
  jar.setCookie('c=5', url)
  t.equal(getCookieString(t, jar, url), 'a=1; toString=2; b=3; constructor=4; c=5')
  t.end()
})

tape('a Max-Age cookie named after an Object.prototype member expires (GHSA-72xf-g2v4-qvf3)', function (t) {
  var url = 'http://localhost/'
  var jar = request.jar()
  var past = new Date(Date.now() - 5000)
  jar.setCookie('a=1', url)
  jar.setCookie('valueOf=2; Max-Age=1', url, {now: past})
  jar.setCookie('b=3; Max-Age=1', url, {now: past})
  t.equal(getCookieString(t, jar, url), 'a=1')
  t.end()
})

tape('a Set-Cookie named __proto__ before a redirect is sent on the next hop (GHSA-72xf-g2v4-qvf3)', function (t) {
  var url = 'http://localhost:' + s.address().port
  request({url: url + '/set', jar: request.jar()}, function (err, res, body) {
    t.equal(err, null)
    t.equal(body, '__proto__=x; a=1')
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    t.end()
  })
})

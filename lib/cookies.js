'use strict'

var tough = require('./vendor/tough-cookie/cookie')

var Cookie = tough.Cookie
var CookieJar = tough.CookieJar

exports.parse = function (str) {
  if (str && str.uri) {
    str = str.uri
  }
  if (typeof str !== 'string') {
    throw new Error('The cookie function only accepts STRING as param')
  }
  return Cookie.parse(str, {loose: true})
}

function isCookieOfAnotherToughCookie (cookieOrStr) {
  return cookieOrStr !== null && typeof cookieOrStr === 'object' &&
    !(cookieOrStr instanceof Cookie) && typeof cookieOrStr.cookieString === 'function'
}

// Adapt the sometimes-Async api of tough.CookieJar to our requirements
function RequestJar (store) {
  var self = this
  self._jar = new CookieJar(store, {looseMode: true})
}
RequestJar.prototype.setCookie = function (cookieOrStr, uri, options) {
  var self = this
  if (self._jar instanceof CookieJar && isCookieOfAnotherToughCookie(cookieOrStr)) {
    cookieOrStr = Cookie.fromJSON(cookieOrStr)
  }
  return self._jar.setCookieSync(cookieOrStr, uri, options || {})
}
RequestJar.prototype.getCookieString = function (uri) {
  var self = this
  return self._jar.getCookieStringSync(uri)
}
RequestJar.prototype.getCookies = function (uri) {
  var self = this
  return self._jar.getCookiesSync(uri)
}

exports.jar = function (store) {
  return new RequestJar(store)
}

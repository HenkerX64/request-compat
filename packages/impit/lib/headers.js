'use strict'

const http = require('http')
const {notSupported} = require('./errors')

const validateHeaderName = http.validateHeaderName
const validateHeaderValue = http.validateHeaderValue
const DECODED_BY_IMPIT = ['gzip', 'br', 'deflate', 'zstd']
const REFUSED = ['upgrade']

function joined (lower, value) {
  if (!Array.isArray(value)) {
    return String(value)
  }
  return value.map(String).join(lower === 'cookie' ? '; ' : ', ')
}

function outgoing (headers) {
  const pairs = []
  Object.keys(headers || {}).forEach(name => {
    const value = headers[name]
    const lower = name.toLowerCase()
    if (value === undefined) {
      return
    }
    validateHeaderName(name)
    validateHeaderValue(name, value)
    if (REFUSED.indexOf(lower) !== -1) {
      throw notSupported('headers.' + lower)
    }
    pairs.push([name, joined(lower, value)])
  })
  return pairs
}

function withoutHeader (pairs, name) {
  const lower = String(name).toLowerCase()
  return pairs.filter(pair => pair[0].toLowerCase() !== lower)
}

function valueOf (pairs, name) {
  const found = pairs.find(pair => pair[0].toLowerCase() === name)
  return found ? found[1] : undefined
}

function hasBody (method, statusCode) {
  return method !== 'HEAD' && statusCode >= 200 && statusCode !== 204 && statusCode !== 304
}

function incoming (response, method) {
  const headers = {}
  const rawHeaders = []
  const decoded = hasBody(method, response.status) && DECODED_BY_IMPIT.indexOf(response.headers.get('content-encoding')) !== -1
  response.headers.forEach((value, name) => {
    if (name === 'set-cookie' || (decoded && (name === 'content-encoding' || name === 'content-length'))) {
      return
    }
    headers[name] = value
    rawHeaders.push(name, value)
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length) {
    headers['set-cookie'] = cookies
    cookies.forEach(cookie => rawHeaders.push('set-cookie', cookie))
  }
  return {headers, rawHeaders}
}

module.exports = {outgoing, withoutHeader, valueOf, incoming}

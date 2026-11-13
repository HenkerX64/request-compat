'use strict'

const {validateHeaderName, validateHeaderValue} = require('http')
const {notSupported} = require('./errors')

const FIRST_WINS = new Set([
  'content-type', 'content-length', 'user-agent', 'referer', 'host', 'authorization',
  'proxy-authorization', 'if-modified-since', 'if-unmodified-since', 'from', 'location',
  'max-forwards', 'retry-after', 'etag', 'last-modified', 'server', 'age', 'expires'
])
const REFUSED = ['expect', 'upgrade']

function flatten (raw) {
  if (Array.isArray(raw)) {
    return raw.map(item => Buffer.isBuffer(item) ? item.toString('latin1') : String(item))
  }
  const flat = []
  Object.keys(raw || {}).forEach(name => {
    [].concat(raw[name]).forEach(value => flat.push(name, String(value)))
  })
  return flat
}

function toNodeHeaders (rawHeaders) {
  const flat = flatten(rawHeaders)
  const headers = {}
  for (let i = 0; i < flat.length; i += 2) {
    const name = flat[i].toLowerCase()
    const value = flat[i + 1]
    if (name === 'set-cookie') {
      if (Array.isArray(headers[name])) {
        headers[name].push(value)
      } else {
        headers[name] = [value]
      }
    } else if (headers[name] === undefined) {
      headers[name] = value
    } else if (name === 'cookie') {
      headers[name] += '; ' + value
    } else if (!FIRST_WINS.has(name)) {
      headers[name] += ', ' + value
    }
  }
  return {headers, rawHeaders: flat}
}

function outgoing (self) {
  const headers = {}
  let reset = false
  Object.keys(self.headers || {}).forEach(name => {
    const value = self.headers[name]
    const lower = name.toLowerCase()
    if (value === undefined) {
      return
    }
    validateHeaderName(name)
    validateHeaderValue(name, value)
    if (REFUSED.indexOf(lower) !== -1) {
      throw notSupported('headers.' + lower)
    }
    if (lower === 'keep-alive') {
      return
    }
    if (lower === 'transfer-encoding') {
      if (String(value).trim().toLowerCase() !== 'chunked') {
        throw notSupported('headers.transfer-encoding', 'only chunked is accepted, and it is set by streaming the body')
      }
      return
    }
    if (lower === 'connection') {
      if (String(value).toLowerCase().split(',').map(token => token.trim()).indexOf('close') !== -1) {
        reset = true
      }
      return
    }
    headers[name] = Array.isArray(value) ? value.map(String) : String(value)
  })
  return {headers, reset}
}

module.exports = {toNodeHeaders, outgoing}

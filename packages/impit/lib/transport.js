'use strict'

const {Exchange} = require('./exchange')
const {outgoing, valueOf, withoutHeader} = require('./headers')
const {instanceFor} = require('./instances')
const {slotFor} = require('./limits')
const {checkOptions, configOf, hasInstance, isTunnel, methodOf, PROXY_HEADERS, CALLER_POOL, FOREVER} = require('./options')

function tunnel (self, proxyHeaders) {
  self[PROXY_HEADERS] = proxyHeaders
}

function prepare (self, options) {
  if (options && options.pool) {
    self[CALLER_POOL] = true
  }
  if (options && options.forever && !isTunnel(self)) {
    self[FOREVER] = true
  }
}

const DEFAULT_PORTS = {'http:': '80', 'https:': '443'}
const NAMED_PROXY_PROTOCOLS = ['http:', 'https:']

function targetOf (self) {
  const uri = self.uri
  const hostname = String(uri.hostname)
  const name = hostname.indexOf(':') !== -1 && hostname[0] !== '[' ? '[' + hostname + ']' : hostname
  const port = uri.port && String(uri.port) !== DEFAULT_PORTS[uri.protocol] ? ':' + uri.port : ''
  const path = uri.path || ((uri.pathname || '/') + (uri.search || ''))
  return uri.protocol + '//' + name + port + path
}

function lookupHostOf (self, caller) {
  if (caller) {
    return null
  }
  if (!self.proxy) {
    return String(self.uri.hostname)
  }
  return NAMED_PROXY_PROTOCOLS.indexOf(self.proxy.protocol) !== -1 ? String(self.proxy.hostname) : null
}

function derivedHost (uri) {
  return uri.port === DEFAULT_PORTS[uri.protocol] ? uri.hostname : uri.host
}

function withoutDerivedHost (self, headers) {
  const derived = self.setHost && valueOf(headers, 'host') === derivedHost(self.uri)
  return derived ? withoutHeader(headers, 'host') : headers
}

function send (self) {
  checkOptions(self)
  const caller = hasInstance(self)
  const config = caller ? null : configOf(self)
  const headers = withoutDerivedHost(self, outgoing(self.headers))
  if (config && config.oneOff && valueOf(headers, 'connection') === undefined) {
    headers.push(['connection', 'close'])
  }
  const slot = caller ? null : slotFor(self)
  const impit = caller ? self.impit : instanceFor(config)
  return new Exchange(impit, targetOf(self), methodOf(self), headers, isTunnel(self), slot, lookupHostOf(self, caller))
}

function verifyResponse () {
  return null
}

module.exports = {tunnel, prepare, send, verifyResponse}

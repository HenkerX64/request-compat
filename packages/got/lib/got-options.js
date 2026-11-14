'use strict'

const https = require('https')
const {URL} = require('url')
const {isDeepStrictEqual, types} = require('util')
const {notSupported, invalidGotInstance} = require('./errors')

const nodeModule = process.getBuiltinModule('node:module')
const nativeRequire = nodeModule.createRequire(__filename)
const gotModule = nativeRequire('got')
const defaultGot = gotModule.default
const {Options, RequestError} = gotModule
const defaultOptions = defaultGot.defaults.options

const TIMEOUT_PHASES = ['lookup', 'connect', 'secureConnect', 'socket', 'send', 'response', 'read', 'request']
const NOT_PASSED_TO_NODE = ['agent', 'https', 'http2', 'h2session', 'localAddress', 'createConnection', 'maxHeaderSize', 'setHost', 'signal']
const REFUSED = NOT_PASSED_TO_NODE.concat(['request', 'headers', 'encoding'])
const INSTANCE_DNS_OPTIONS = ['dnsLookup', 'dnsCache', 'dnsLookupIpVersion']
const REFUSAL_REASONS = {
  agent: 'pass agent, pool or agentOptions as request options',
  https: 'pass the TLS options as request options',
  http2: 'the engine sends HTTP/1.1 through the agent the core selects',
  h2session: 'the engine sends HTTP/1.1 through the agent the core selects',
  localAddress: 'pass localAddress as a request option',
  createConnection: 'pass createConnection as a request option',
  maxHeaderSize: 'pass maxHeaderSize as a request option',
  setHost: 'pass setHost as a request option',
  signal: 'call abort() on the request',
  request: 'the engine hands got the http.ClientRequest of every hop',
  headers: 'pass headers as request options or set them in a beforeRequest hook',
  encoding: 'pass encoding as a request option'
}
const HOP_REASONS = {
  forced: 'a got handler or hook changed what the engine sets on every hop',
  notPassed: 'a got handler or hook set an option that the engine does not pass to Node',
  dns: 'a got handler or hook changed it after the engine created the request; set it on the got instance',
  request: 'a got handler or hook replaced the stream or the function that hands got the http.ClientRequest of the hop',
  hooks: 'a got hook changed the list of beforeRequest hooks, which ends with the check of the engine'
}
const GOT_PROTOCOLS = ['http:', 'https:']
const SINGLE_VALUE_HEADERS = ['authorization', 'content-length', 'host', 'proxy-authorization', 'transfer-encoding']

function noTimeouts () {
  const timeout = {}
  TIMEOUT_PHASES.forEach(phase => {
    timeout[phase] = undefined
  })
  return timeout
}

function isGotInstance (value) {
  return typeof value === 'function' && typeof value.stream === 'function' && Boolean(value.defaults) &&
    value.defaults.options instanceof Options
}

function instanceOf (self) {
  if (self.got === undefined || self.got === null) {
    return defaultGot
  }
  if (!isGotInstance(self.got)) {
    throw invalidGotInstance()
  }
  const options = self.got.defaults.options
  REFUSED.forEach(name => {
    if (!isDeepStrictEqual(options[name], defaultOptions[name])) {
      throw notSupported('got.' + name, REFUSAL_REASONS[name])
    }
  })
  return self.got
}

function forcedOptions (method, headers) {
  return {
    method,
    headers,
    prefixUrl: '',
    searchParams: undefined,
    followRedirect: false,
    decompress: false,
    cookieJar: undefined,
    throwHttpErrors: false,
    retry: {limit: 0},
    timeout: noTimeouts(),
    cache: false,
    allowGetBody: true,
    allowAbsoluteUrls: true,
    strictContentLength: false,
    enableUnixSockets: true,
    username: '',
    password: '',
    responseType: 'text',
    encoding: undefined
  }
}

function forcedOptionChanged (options, method, url) {
  const checks = [
    ['url', () => options.url instanceof URL && options.url.href === url.href],
    ['method', () => options.method === method],
    ['followRedirect', () => options.followRedirect === false],
    ['decompress', () => options.decompress === false],
    ['cookieJar', () => options.cookieJar === undefined],
    ['throwHttpErrors', () => options.throwHttpErrors === false],
    ['retry', () => options.retry.limit === 0],
    ['timeout', () => TIMEOUT_PHASES.every(phase => options.timeout[phase] === undefined)],
    ['cache', () => !options.cache],
    ['allowGetBody', () => options.allowGetBody === true],
    ['strictContentLength', () => options.strictContentLength === false],
    ['enableUnixSockets', () => options.enableUnixSockets === true],
    ['encoding', () => options.encoding === undefined],
    ['username', () => options.username === '' && options.password === ''],
    ['body', () => options.body === undefined && options.json === undefined && options.form === undefined]
  ]
  const failed = checks.filter(check => !check[1]())[0]
  return failed ? failed[0] : null
}

function hopOptionRefusal (options, expected) {
  const forced = forcedOptionChanged(options, expected.method, expected.url)
  if (forced) {
    return notSupported('got.' + forced, HOP_REASONS.forced)
  }
  const notPassed = NOT_PASSED_TO_NODE.filter(name => !isDeepStrictEqual(options[name], defaultOptions[name]))[0]
  if (notPassed) {
    return notSupported('got.' + notPassed, HOP_REASONS.notPassed)
  }
  const dns = INSTANCE_DNS_OPTIONS.filter(name => options[name] !== expected.instanceOptions[name])[0]
  if (dns) {
    return notSupported('got.' + dns, HOP_REASONS.dns)
  }
  if (options.request !== expected.request) {
    return requestFunctionRefusal()
  }
  return null
}

function requestFunctionRefusal () {
  return notSupported('got.request', HOP_REASONS.request)
}

function hookListRefusal () {
  return notSupported('got.hooks.beforeRequest', HOP_REASONS.hooks)
}

function parsedUrl (uri) {
  try {
    return new URL(uri.href)
  } catch (err) {
    return new URL(uri.protocol + '//' + (uri.host || 'localhost') + '/')
  }
}

function protocolOfModule (httpModule) {
  const agent = httpModule && httpModule.globalAgent
  return (agent && agent.protocol === 'https:') || httpModule === https ? 'https:' : 'http:'
}

function gotUrl (self) {
  const parsed = parsedUrl(self.uri)
  const url = GOT_PROTOCOLS.indexOf(parsed.protocol) === -1
    ? new URL(protocolOfModule(self.httpModule) + parsed.href.slice(parsed.protocol.length))
    : parsed
  url.username = ''
  url.password = ''
  return url
}

function gotHeaderValue (name, value) {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    const values = value.map(String)
    return SINGLE_VALUE_HEADERS.indexOf(name) !== -1 ? values.join(', ') : values
  }
  return String(value)
}

function gotHeaders (headers) {
  const lowered = {}
  Object.keys(headers || {}).forEach(name => {
    const value = headers[name]
    if (value !== undefined) {
      const lower = name.toLowerCase()
      lowered[lower] = lowered[lower] === undefined ? gotHeaderValue(lower, value) : lowered[lower]
    }
  })
  if (lowered['user-agent'] === undefined) {
    lowered['user-agent'] = undefined
  }
  return lowered
}

function headerChanges (given, final) {
  const changes = []
  const names = new Set(Object.keys(given).concat(Object.keys(final)))
  names.forEach(name => {
    if (final[name] === undefined) {
      if (given[name] !== undefined) {
        changes.push({name, remove: true})
      }
    } else if (!isDeepStrictEqual(final[name], given[name])) {
      changes.push({name, value: final[name]})
    }
  })
  return changes
}

function connectionOptions (instance, url) {
  const options = instance.defaults.options
  if (options.dnsCache === undefined && options.dnsLookup === undefined && options.dnsLookupIpVersion === undefined) {
    return {}
  }
  const built = new Options(url, {enableUnixSockets: true, prefixUrl: ''}, options)
  const native = built.createNativeRequestOptions()
  const picked = {}
  if (native.lookup !== undefined) {
    picked.lookup = native.lookup
  }
  if (native.family !== undefined) {
    picked.family = native.family
  }
  return picked
}

function isErrorOfAnyRealm (value) {
  return value instanceof Error || types.isNativeError(value)
}

function unwrap (err) {
  let current = err
  while (current instanceof RequestError && isErrorOfAnyRealm(current.cause)) {
    current = current.cause
  }
  return current
}

module.exports = {
  instanceOf,
  forcedOptions,
  hopOptionRefusal,
  hookListRefusal,
  requestFunctionRefusal,
  gotUrl,
  gotHeaders,
  headerChanges,
  connectionOptions,
  unwrap
}

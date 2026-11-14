'use strict'

const http = require('http')
const https = require('https')
const {notSupported, invalidImpit} = require('./errors')

const PROXY_HEADERS = Symbol('request-compat-impit.proxyHeaders')
const CALLER_POOL = Symbol('request-compat-impit.callerPool')
const FOREVER = Symbol('request-compat-impit.forever')

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']
const BODILESS_METHODS = ['GET', 'HEAD']
const PROXY_PROTOCOLS = ['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:']
const TLS_OPTIONS = [
  'ca', 'cert', 'key', 'pfx', 'passphrase', 'servername', 'checkServerIdentity', 'ciphers', 'secureProtocol', 'secureOptions',
  'minVersion', 'maxVersion', 'crl', 'dhparam', 'ecdhCurve', 'honorCipherOrder', 'sigalgs', 'sessionIdContext', 'secureContext'
]
const REQUEST_ONLY_OPTIONS = [
  'createConnection', 'insecureHTTPParser', 'joinDuplicateHeaders', 'setDefaultHeaders', 'uniqueHeaders', 'httpValidation',
  '_defaultAgent', 'keepAlive', 'maxHeaderSize', 'defaultPort'
]
const CONNECTION_OPTIONS = [
  'lookup', 'hints', 'family', 'signal', 'socket', 'localPort', 'blockList', 'autoSelectFamily', 'autoSelectFamilyAttemptTimeout',
  'keepAliveInitialDelay', 'noDelay', 'onread', 'fd', 'handle', 'objectMode', 'readableObjectMode', 'writableObjectMode', 'typeOfService',
  'session', 'ALPNProtocols', 'minDHSize', 'pskCallback', 'requestOCSP', 'enableTrace', 'allowPartialTrustChain',
  'clientCertEngine', 'privateKeyEngine', 'privateKeyIdentifier', 'certificateCompression', 'sessionTimeout', 'ticketKeys'
]
const NODE_OPTIONS = REQUEST_ONLY_OPTIONS.concat(CONNECTION_OPTIONS)
const AGENT_OPTIONS_ACCEPTED = ['rejectUnauthorized', 'keepAlive', 'keepAliveMsecs', 'maxSockets', 'maxFreeSockets', 'scheduling']
const AGENT_SETTINGS_OF_REQUEST = ['ca', 'ciphers', 'secureProtocol', 'secureOptions', 'pfx', 'passphrase']
const GLOBAL_AGENT_ARGUMENTS = {keepAlive: true, scheduling: 'lifo', timeout: 5000}
const GLOBAL_AGENT_MIRRORED = {'http:': [], 'https:': ['rejectUnauthorized']}
const ENV_PROXY = 'NODE_USE_ENV_PROXY routes Node\'s global agent through a proxy; pass proxy or unset it'
const ENV_PROXY_VARIABLES = {'http:': ['http_proxy', 'HTTP_PROXY'], 'https:': ['https_proxy', 'HTTPS_PROXY']}
const INSTANCE_CONFLICTS = ['browser', 'strictSSL', 'rejectUnauthorized', 'localAddress']
const WITH_INSTANCE = 'not together with impit, whose instance decides proxy, TLS and connections'
const BASIC = /^Basic ([A-Za-z0-9+/=]+)$/

function given (value) {
  return value !== undefined
}

function hasKeys (object) {
  for (const key in object) {
    if (given(object[key])) {
      return true
    }
  }
  return false
}

function hasInstance (self) {
  return self.impit !== undefined && self.impit !== null
}

function holdsAgent (pool) {
  for (const key in pool) {
    const value = pool[key]
    if (value && typeof value.addRequest === 'function') {
      return true
    }
  }
  return false
}

function isTunnel (self) {
  return Boolean(self.proxy && self.tunnel)
}

function usesTls (self) {
  return self.uri.protocol === 'https:' || Boolean(self.proxy && self.proxy.protocol === 'https:')
}

function hopProtocol (self) {
  return self.proxy && !self.tunnel ? self.proxy.protocol : self.uri.protocol
}

function usesGlobalAgent (self) {
  return !hasInstance(self) && !isTunnel(self) && !self.agent && self.pool !== false && !self[CALLER_POOL] && !self[FOREVER] &&
    !self.agentClass && !(self.agentOptions && hasKeys(self.agentOptions)) && self.rejectUnauthorized === undefined &&
    !AGENT_SETTINGS_OF_REQUEST.some(name => self[name]) && !(self.cert && self.key)
}

function globalAgentOf (self) {
  if (!usesGlobalAgent(self)) {
    return null
  }
  const protocol = hopProtocol(self) === 'https:' ? 'https:' : 'http:'
  const module = protocol === 'https:' ? https : http
  if (!module.globalAgent) {
    return null
  }
  return {agent: module.globalAgent, module, protocol, name: protocol === 'https:' ? 'https.globalAgent' : 'http.globalAgent'}
}

const globalAgentDefaults = new Map()

function defaultsOf (module) {
  if (!globalAgentDefaults.has(module.Agent)) {
    const untouched = new module.Agent(GLOBAL_AGENT_ARGUMENTS)
    globalAgentDefaults.set(module.Agent, untouched.options)
  }
  return globalAgentDefaults.get(module.Agent)
}

function envProxyOf (proxyEnv, protocol) {
  const names = ENV_PROXY_VARIABLES[protocol]
  if (!proxyEnv || typeof proxyEnv !== 'object') {
    return null
  }
  const url = proxyEnv[names[0]] || proxyEnv[names[1]]
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://')) ? url : null
}

function checkGlobalAgent (self) {
  const global = globalAgentOf(self)
  const options = global && global.agent.options
  if (!options) {
    return
  }
  const defaults = defaultsOf(global.module)
  const mirrored = GLOBAL_AGENT_MIRRORED[global.protocol]
  for (const key in options) {
    if (key !== 'proxyEnv' && mirrored.indexOf(key) === -1 && given(options[key]) && options[key] !== defaults[key]) {
      throw notSupported(global.name + '.options.' + key)
    }
  }
  if (!self.proxy && envProxyOf(options.proxyEnv, global.protocol)) {
    throw notSupported(global.name + '.options.proxyEnv', ENV_PROXY)
  }
}

function globalAgentSetting (self, name) {
  const global = globalAgentOf(self)
  const options = global && global.agent.options
  return options && GLOBAL_AGENT_MIRRORED[global.protocol].indexOf(name) !== -1 ? options[name] : undefined
}

function methodOf (self) {
  return String(self.method || 'GET').toUpperCase()
}

function sendsBody (self) {
  return Boolean(self.body || self._form || self.requestBodyStream || (self._multipart && self._multipart.chunked))
}

function checkInstance (self) {
  if (!self.impit || typeof self.impit.fetch !== 'function') {
    throw invalidImpit()
  }
  if (self.proxy) {
    throw notSupported('proxy', 'pass proxy: null; the impit instance decides the proxy')
  }
  if (self[CALLER_POOL] || self.pool === false) {
    throw notSupported('pool', WITH_INSTANCE)
  }
  if (self.agentOptions && hasKeys(self.agentOptions)) {
    throw notSupported('agentOptions', WITH_INSTANCE)
  }
  INSTANCE_CONFLICTS.forEach(name => {
    if (given(self[name])) {
      throw notSupported(name, WITH_INSTANCE)
    }
  })
}

function checkAgentOptions (agentOptions, tls) {
  for (const key in agentOptions) {
    const ignoredByNode = !tls && TLS_OPTIONS.indexOf(key) !== -1
    if (given(agentOptions[key]) && AGENT_OPTIONS_ACCEPTED.indexOf(key) === -1 && !ignoredByNode) {
      throw notSupported('agentOptions.' + key)
    }
  }
}

function checkPool (self) {
  if (!self[CALLER_POOL]) {
    return
  }
  if (holdsAgent(self.pool)) {
    throw notSupported('pool', 'Node agents in the pool object have no equivalent in impit')
  }
}

function basicCredentials (header) {
  const basic = BASIC.exec(String(header))
  return basic ? Buffer.from(basic[1], 'base64').toString() : null
}

function tunnelCredentials (self) {
  const proxyHeaders = self[PROXY_HEADERS] || {}
  const names = Object.keys(proxyHeaders).filter(name => name.toLowerCase() === 'proxy-authorization')
  if (!names.length) {
    return null
  }
  const credentials = basicCredentials(proxyHeaders[names[0]])
  if (credentials === null) {
    throw notSupported('headers.proxy-authorization', 'impit sends only Basic credentials with CONNECT')
  }
  return credentials
}

function checkProxy (self) {
  const proxy = self.proxy
  if (!proxy) {
    return
  }
  if (PROXY_PROTOCOLS.indexOf(proxy.protocol) === -1) {
    throw notSupported('proxy', 'impit takes http, https, socks4, socks5 and socks5h proxies')
  }
  const secure = self.uri.protocol === 'https:'
  if (Boolean(self.tunnel) !== secure) {
    throw notSupported('tunnel', 'impit tunnels https targets and forwards http targets')
  }
  if (!self.tunnel) {
    return
  }
  if (given(self.proxyHeaderWhiteList)) {
    throw notSupported('proxyHeaderWhiteList', 'impit sends only host and proxy-authorization with CONNECT')
  }
  if (given(self.proxyHeaderExclusiveList)) {
    throw notSupported('proxyHeaderExclusiveList', 'impit sends only host and proxy-authorization with CONNECT')
  }
}

function checkOptions (self) {
  const caller = hasInstance(self)
  if (caller) {
    checkInstance(self)
  }
  if (self.agent) {
    throw notSupported('agent', 'Node agent instances have no equivalent in impit')
  }
  if (self.agentClass) {
    throw notSupported('agentClass')
  }
  if (self.httpModules && hasKeys(self.httpModules)) {
    throw notSupported('httpModules')
  }
  checkPool(self)
  const tls = usesTls(self)
  const refused = tls ? TLS_OPTIONS.concat(NODE_OPTIONS) : NODE_OPTIONS
  refused.forEach(name => {
    if (given(self[name])) {
      throw notSupported(name)
    }
  })
  if (self.agentOptions) {
    checkAgentOptions(self.agentOptions, tls)
  }
  checkGlobalAgent(self)
  if (self.socketPath) {
    throw notSupported('socketPath', 'impit does not connect to unix sockets')
  }
  const method = methodOf(self)
  if (METHODS.indexOf(method) === -1) {
    throw notSupported('method', 'impit sends ' + METHODS.join(', '))
  }
  if (BODILESS_METHODS.indexOf(method) !== -1 && sendsBody(self)) {
    throw notSupported('body', 'impit sends no body with ' + method)
  }
  checkProxy(self)
}

function encodedCredentials (credentials) {
  const separator = credentials.indexOf(':')
  const user = separator === -1 ? credentials : credentials.slice(0, separator)
  const password = separator === -1 ? null : credentials.slice(separator + 1)
  return encodeURIComponent(user) + (password === null ? '' : ':' + encodeURIComponent(password)) + '@'
}

function proxyUrlOf (self) {
  const proxy = self.proxy
  if (!proxy) {
    return undefined
  }
  const credentials = proxy.auth || (self.tunnel ? tunnelCredentials(self) : null)
  return proxy.protocol + '//' + (credentials ? encodedCredentials(credentials) : '') + proxy.host
}

function ignoresTlsErrors (self) {
  const ofGlobalAgent = globalAgentSetting(self, 'rejectUnauthorized')
  if (self.rejectUnauthorized === false || (self.agentOptions && self.agentOptions.rejectUnauthorized === false) || ofGlobalAgent === false) {
    return true
  }
  const decided = self.rejectUnauthorized === true || (self.agentOptions && self.agentOptions.rejectUnauthorized === true) || ofGlobalAgent === true
  return !decided && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
}

function closesAfterEachRequest (agentOptions) {
  return Boolean(agentOptions) && given(agentOptions.keepAlive) && !agentOptions.keepAlive
}

function opensOwnConnection (self) {
  if (isTunnel(self)) {
    return false
  }
  return self.pool === false || (closesAfterEachRequest(self.agentOptions) && !self.forever)
}

function configOf (self) {
  return {
    browser: self.browser,
    proxyUrl: proxyUrlOf(self),
    ignoreTlsErrors: ignoresTlsErrors(self),
    localAddress: self.localAddress,
    oneOff: opensOwnConnection(self)
  }
}

module.exports = {
  checkOptions,
  configOf,
  hasInstance,
  isTunnel,
  methodOf,
  globalAgentOf,
  BODILESS_METHODS,
  PROXY_HEADERS,
  CALLER_POOL,
  FOREVER,
  TLS_OPTIONS,
  REQUEST_ONLY_OPTIONS,
  CONNECTION_OPTIONS
}

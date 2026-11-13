'use strict'

const http = require('http')
const {
  dispatcherFor, release, acquire, hasKeys, CALLER_POOL, FOREVER, CONTEXT_FIELDS, hopProtocol, globalAgentOf, maxSocketsOf, socketLimit, isTunnel
} = require('./dispatchers')
const {createExchange} = require('./exchange')
const {outgoing} = require('./headers')
const {notSupported} = require('./errors')

const PROXY_HEADERS = Symbol('request-compat-undici.proxyHeaders')

const REQUEST_ONLY_OPTIONS = [
  'createConnection', 'insecureHTTPParser', 'joinDuplicateHeaders', 'setDefaultHeaders', 'uniqueHeaders', 'httpValidation',
  '_defaultAgent', 'keepAlive'
]
const CONNECTION_OPTIONS = [
  'lookup', 'hints', 'signal', 'socket', 'localPort', 'blockList', 'autoSelectFamily', 'autoSelectFamilyAttemptTimeout',
  'keepAliveInitialDelay', 'onread', 'fd', 'handle', 'objectMode', 'readableObjectMode', 'writableObjectMode', 'typeOfService',
  'session', 'ALPNProtocols', 'minDHSize', 'pskCallback', 'requestOCSP', 'enableTrace', 'allowPartialTrustChain',
  'clientCertEngine', 'privateKeyEngine', 'privateKeyIdentifier', 'certificateCompression', 'sessionTimeout', 'ticketKeys'
]
const COMPUTED_BY_THE_CORE = {
  hostname: self => self.host,
  protocol: self => hopProtocol(self)
}
const GLOBAL_AGENT_ARGUMENTS = {keepAlive: true, scheduling: 'lifo', timeout: 5000}
const ENV_PROXY = 'NODE_USE_ENV_PROXY routes Node\'s global agent through a proxy; pass proxy or unset it'
const ENV_PROXY_VARIABLES = {'http:': ['http_proxy', 'HTTP_PROXY'], 'https:': ['https_proxy', 'HTTPS_PROXY']}
const AGENT_OPTIONS_ACCEPTED = CONTEXT_FIELDS.concat([
  'rejectUnauthorized', 'checkServerIdentity', 'maxSockets', 'keepAlive', 'keepAliveMsecs', 'maxFreeSockets', 'scheduling'
])
const DISPATCHER_CONFLICTS = ['strictSSL', 'rejectUnauthorized', 'checkServerIdentity', 'maxHeaderSize'].concat(CONTEXT_FIELDS)
const WITH_DISPATCHER = 'not together with dispatcher, which decides connections and TLS'

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

function given (value) {
  return value !== undefined
}

function hasDispatcher (self) {
  return self.dispatcher !== undefined && self.dispatcher !== null
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

function checkDispatcher (self) {
  if (!self.dispatcher || typeof self.dispatcher.dispatch !== 'function') {
    const err = new TypeError('request-compat-undici: the option dispatcher needs an undici Dispatcher, an object with a dispatch function')
    err.code = 'INVALID_DISPATCHER'
    throw err
  }
  if (self.proxy) {
    throw notSupported('proxy', 'pass proxy: null; the dispatcher decides the proxy')
  }
  if (self[CALLER_POOL] || self.pool === false) {
    throw notSupported('pool', WITH_DISPATCHER)
  }
  if (self.agent === false) {
    throw notSupported('agent', WITH_DISPATCHER)
  }
  if (self.forever) {
    throw notSupported('forever', WITH_DISPATCHER)
  }
  if (self.agentOptions && hasKeys(self.agentOptions)) {
    throw notSupported('agentOptions', WITH_DISPATCHER)
  }
  DISPATCHER_CONFLICTS.forEach(name => {
    if (given(self[name])) {
      throw notSupported(name, WITH_DISPATCHER)
    }
  })
}

function checkAgentOptions (agentOptions) {
  for (const key in agentOptions) {
    if (given(agentOptions[key]) && AGENT_OPTIONS_ACCEPTED.indexOf(key) === -1) {
      throw notSupported('agentOptions.' + key)
    }
  }
}

const globalAgentDefaults = new Map()

function defaultsOf (module) {
  if (!globalAgentDefaults.has(module.Agent)) {
    globalAgentDefaults.set(module.Agent, new module.Agent(GLOBAL_AGENT_ARGUMENTS).options)
  }
  return globalAgentDefaults.get(module.Agent)
}

function envProxyOf (proxyEnv, protocol) {
  const names = ENV_PROXY_VARIABLES[protocol]
  if (!proxyEnv || typeof proxyEnv !== 'object' || !names) {
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
  for (const key in options) {
    if (key !== 'proxyEnv' && global.mirrored.indexOf(key) === -1 && given(options[key]) && options[key] !== defaults[key]) {
      throw notSupported(global.name + '.options.' + key)
    }
  }
  if (!self.proxy && !self.socketPath && envProxyOf(options.proxyEnv, global.agent.protocol)) {
    throw notSupported(global.name + '.options.proxyEnv', ENV_PROXY)
  }
}

function checkSocketLimit (self) {
  const sockets = maxSocketsOf(self)
  if (sockets && socketLimit(sockets.value).invalid) {
    throw notSupported(sockets.option, 'Node opens no connection with this limit')
  }
}

function throwNodeValidationError (maxHeaderSize) {
  http.createServer({maxHeaderSize})
}

function checkMaxHeaderSize (maxHeaderSize) {
  if (given(maxHeaderSize) && !(Number.isSafeInteger(maxHeaderSize) && maxHeaderSize >= 0)) {
    throwNodeValidationError(maxHeaderSize)
    throw notSupported('maxHeaderSize')
  }
}

function checkOptions (self) {
  const caller = hasDispatcher(self)
  if (caller) {
    checkDispatcher(self)
  }
  if (self.agent) {
    throw notSupported('agent', 'Node agent instances have no equivalent in undici')
  }
  if (self.agentClass) {
    throw notSupported('agentClass')
  }
  if (self.httpModules) {
    throw notSupported('httpModules')
  }
  if (self[CALLER_POOL] && holdsAgent(self.pool)) {
    throw notSupported('pool', 'Node agents in the pool object have no equivalent in undici')
  }
  REQUEST_ONLY_OPTIONS.concat(CONNECTION_OPTIONS).forEach(name => {
    if (given(self[name])) {
      throw notSupported(name)
    }
  })
  Object.keys(COMPUTED_BY_THE_CORE).forEach(name => {
    if (given(self[name]) && self[name] !== COMPUTED_BY_THE_CORE[name](self)) {
      throw notSupported(name, 'only the value the core computes for the hop is accepted')
    }
  })
  if (self.agentOptions) {
    checkAgentOptions(self.agentOptions)
  }
  if (!caller) {
    checkGlobalAgent(self)
    checkSocketLimit(self)
  }
  checkMaxHeaderSize(self.maxHeaderSize)
  if (self.proxy && self.tunnel && self.socketPath) {
    throw notSupported('socketPath', 'a unix socket cannot be tunnelled through a proxy')
  }
}

function send (self, reqOptions) {
  checkOptions(self)
  const {headers, reset} = outgoing(self)
  const {dispatcher, oneOff, counted, servername, tunnelled, caller} = dispatcherFor(self, self[PROXY_HEADERS])
  try {
    const exchange = createExchange(self, reqOptions, dispatcher, {headers, reset, oneOff, counted, servername, tunnelled, caller})
    acquire(dispatcher)
    return exchange
  } catch (err) {
    if (oneOff) {
      release(dispatcher)
    }
    throw err
  }
}

function verifyResponse () {
  return null
}

module.exports = {tunnel, prepare, send, verifyResponse, PROXY_HEADERS}

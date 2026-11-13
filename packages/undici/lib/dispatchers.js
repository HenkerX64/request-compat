'use strict'

const http = require('http')
const https = require('https')
const tls = require('tls')
const {EventEmitter} = require('events')
const net = require('net')
const {Agent, Pool, Client, ProxyAgent, buildConnector} = require('undici')
const {PROXY_HOP} = require('./errors')

const {FinalizationRegistry, WeakRef} = global

const CONTEXT_FIELDS = [
  'ca', 'cert', 'key', 'pfx', 'passphrase', 'ciphers', 'secureProtocol', 'secureOptions', 'servername',
  'minVersion', 'maxVersion', 'crl', 'ecdhCurve', 'sigalgs', 'dhparam', 'honorCipherOrder',
  'sessionIdContext', 'family', 'socketPath', 'localAddress', 'secureContext'
]

const cache = new Map()
let identityCaches = new WeakMap()
const identityDispatchers = new Set()
const forgetDispatcher = new FinalizationRegistry(ref => identityDispatchers.delete(ref))
const oneOffs = new Set()
const IDLE_IDENTITY_DISPATCHERS = 32
const identityUse = new Map()
const functionIds = new WeakMap()
let nextFunctionId = 1

const exchanges = new WeakMap()
const hooks = {
  track (handler, exchange) {
    exchanges.set(handler, exchange)
  },
  exchangeOf (handler) {
    return exchanges.get(handler)
  }
}

class Connection extends EventEmitter {
  constructor () {
    super()
    this.lookedUp = false
    this.connected = false
  }

  addListener (name, listener) {
    if ((name === 'connect' && this.connected) || (name === 'lookup' && this.lookedUp)) {
      process.nextTick(() => listener.call(this))
      return this
    }
    return super.addListener(name, listener)
  }

  on (name, listener) {
    return this.addListener(name, listener)
  }
}

function connectAborted () {
  const err = new Error('aborted')
  err.code = 'ECONNRESET'
  return err
}

function hostHeader (headers) {
  const name = headers && Object.keys(headers).filter(key => key.toLowerCase() === 'host')[0]
  return name === undefined ? undefined : headers[name]
}

function serverNameOf (dispatchOptions) {
  if (dispatchOptions.servername) {
    return dispatchOptions.servername
  }
  const host = hostHeader(dispatchOptions.headers)
  if (typeof host !== 'string' || !host) {
    return null
  }
  const name = host[0] === '[' ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return net.isIP(name) || !name ? null : name
}

function lifecycleClient (origin, options) {
  const state = {connection: new Connection(), used: false, socket: null, connectedSocket: null, waiting: [], abortNext: false, servername: undefined}
  const connector = options.connect
  const client = new Client(origin, Object.assign({}, options, {
    connect (connectOptions, callback) {
      if (state.used) {
        state.connection = new Connection()
      }
      state.used = true
      state.servername = connectOptions.servername
      const connection = state.connection
      const waiting = state.waiting.splice(0)
      let socket
      try {
        socket = connector(connectOptions, (err, connected) => {
          state.socket = null
          state.connectedSocket = err ? null : connected
          if (err && socket && !socket.destroyed && socket.writable) {
            socket.destroy()
          }
          callback(err, connected)
        })
      } finally {
        waiting.forEach(exchange => exchange.emitLater('connecting', connection, socket))
      }
      if (socket && typeof socket.once === 'function') {
        if (state.abortNext) {
          state.abortNext = false
          socket.destroy(connectAborted())
          return socket
        }
        state.socket = socket
        socket.once('lookup', () => {
          connection.lookedUp = true
          connection.emit('lookup')
        })
        socket.once('connect', () => {
          connection.connected = true
          connection.emit('connect')
        })
      }
      return socket
    }
  }))
  const dispatch = client.dispatch
  client.dispatch = function (dispatchOptions, handler) {
    const exchange = exchanges.get(handler)
    const reused = client.stats.connected && !(origin.protocol === 'https:' && state.servername !== serverNameOf(dispatchOptions))
    state.abortNext = false
    if (!reused && state.used && !state.socket) {
      state.connection = new Connection()
      state.used = false
    }
    const accepted = dispatch.call(client, dispatchOptions, handler)
    if (exchange) {
      if (reused) {
        exchange.emitLater('reused', state.connectedSocket)
      } else {
        exchange.abortConnecting = () => {
          if (client.stats.size > 1) {
            return
          }
          if (state.socket) {
            state.socket.destroy(connectAborted())
          } else {
            state.abortNext = true
          }
        }
        if (state.socket) {
          exchange.emitLater('connecting', state.connection, state.socket)
        } else if (!exchange.settled) {
          state.waiting.push(exchange)
        }
      }
    }
    return accepted
  }
  return client
}

function lifecyclePool (origin, options) {
  return new Pool(origin, Object.assign({}, options, {factory: lifecycleClient}))
}

const SELF_FIRST_TRUTHY = ['ca', 'ciphers', 'secureProtocol', 'secureOptions', 'pfx', 'passphrase']
const GLOBAL_AGENT_FIELDS = CONTEXT_FIELDS.concat(['key', 'cert', 'rejectUnauthorized', 'checkServerIdentity'])
const CALLER_POOL = Symbol('request-compat-undici.callerPool')
const FOREVER = Symbol('request-compat-undici.forever')

function hasEnumerable (object, name) {
  for (const key in object) {
    if (key === name) {
      return true
    }
  }
  return false
}

function hasKeys (object) {
  for (const key in object) {
    return true
  }
  return false
}

const TUNNEL_FIELDS = ['ca', 'cert', 'key', 'passphrase', 'pfx', 'ciphers', 'secureOptions', 'secureProtocol']
const TUNNEL_HEADERS_REFUSED = ['connection', 'keep-alive', 'upgrade', 'expect', 'transfer-encoding', 'content-length', 'host', 'proxy-authorization']

function isTunnel (self) {
  return Boolean(self.proxy && self.tunnel)
}

function hopProtocol (self) {
  return self.proxy && !self.tunnel ? self.proxy.protocol : self.uri && self.uri.protocol
}

function usesGlobalAgent (self) {
  return !self.agent && self.pool !== false && !self[CALLER_POOL] && !self[FOREVER] && !self.agentClass &&
    !(self.agentOptions && hasKeys(self.agentOptions)) &&
    !self.ca && !self.ciphers && !self.secureProtocol && !self.secureOptions && !self.pfx && !self.passphrase &&
    self.rejectUnauthorized === undefined && !(self.cert && self.key)
}

function globalAgentOf (self) {
  if (isTunnel(self) || !usesGlobalAgent(self)) {
    return null
  }
  const secure = hopProtocol(self) === 'https:'
  const module = secure ? https : http
  if (!module.globalAgent) {
    return null
  }
  return {agent: module.globalAgent, module, name: secure ? 'https.globalAgent' : 'http.globalAgent', mirrored: secure ? GLOBAL_AGENT_FIELDS : []}
}

function maxSocketsOf (self) {
  if (self.pool === false || isTunnel(self)) {
    return null
  }
  const global = globalAgentOf(self)
  if (global) {
    return {option: global.name + '.maxSockets', value: global.agent.maxSockets}
  }
  if (self.pool && self.pool.maxSockets) {
    return {option: 'pool.maxSockets', value: self.pool.maxSockets}
  }
  if (self.agentOptions && self.agentOptions.maxSockets !== undefined) {
    return {option: 'agentOptions.maxSockets', value: self.agentOptions.maxSockets}
  }
  return null
}

function socketLimit (value) {
  if (!value) {
    return {limit: undefined}
  }
  const limit = Number(value)
  if (!(limit > 0)) {
    return {invalid: true}
  }
  return {limit: limit === Infinity ? undefined : Math.ceil(limit)}
}

function globalAgentOptions (self) {
  const options = hopProtocol(self) === 'https:' && usesGlobalAgent(self) && https.globalAgent && https.globalAgent.options
  const picked = {}
  if (options) {
    GLOBAL_AGENT_FIELDS.forEach(name => {
      if (options[name] !== undefined && options[name] !== null) {
        picked[name] = options[name]
      }
    })
    if (Object.prototype.propertyIsEnumerable.call(options, 'rejectUnauthorized')) {
      picked.rejectUnauthorized = options.rejectUnauthorized
    }
  }
  return picked
}

function customCheckServerIdentity (check) {
  return typeof check === 'function' && check !== tls.checkServerIdentity ? check : undefined
}

function tlsContext (self) {
  const context = {}
  const assign = (name, value) => {
    if (value !== undefined) {
      context[name] = value
    }
  }
  let rejectUnauthorized
  let explicit = false
  let agentCheck
  let check
  if (self.pool === false) {
    rejectUnauthorized = self.rejectUnauthorized
    CONTEXT_FIELDS.concat(['key', 'cert']).forEach(name => assign(name, self[name]))
    check = self.checkServerIdentity
  } else if (usesGlobalAgent(self)) {
    const global = globalAgentOptions(self)
    explicit = Object.prototype.hasOwnProperty.call(global, 'rejectUnauthorized')
    rejectUnauthorized = global.rejectUnauthorized !== undefined ? global.rejectUnauthorized : self.rejectUnauthorized
    CONTEXT_FIELDS.concat(['key', 'cert']).forEach(name => assign(name, global[name] !== undefined ? global[name] : self[name]))
    agentCheck = customCheckServerIdentity(global.checkServerIdentity)
    check = agentCheck || self.checkServerIdentity
  } else {
    const base = self.agentOptions || {}
    explicit = hasEnumerable(base, 'rejectUnauthorized')
    rejectUnauthorized = self.rejectUnauthorized !== undefined ? self.rejectUnauthorized : base.rejectUnauthorized
    CONTEXT_FIELDS.filter(name => name !== 'key' && name !== 'cert').forEach(name => {
      if (SELF_FIRST_TRUTHY.indexOf(name) !== -1) {
        assign(name, self[name] ? self[name] : base[name])
      } else {
        assign(name, base[name] !== undefined ? base[name] : self[name])
      }
    })
    if (self.cert && self.key) {
      assign('key', self.key)
      assign('cert', self.cert)
    } else {
      assign('key', base.key)
      assign('cert', base.cert)
    }
    agentCheck = customCheckServerIdentity(base.checkServerIdentity)
    check = base.checkServerIdentity || self.checkServerIdentity
  }
  const secure = hopProtocol(self) === 'https:'
  const custom = secure ? customCheckServerIdentity(check) : undefined
  if (rejectUnauthorized !== undefined || (explicit && !(custom && !agentCheck))) {
    context.rejectUnauthorized = rejectUnauthorized !== false
  }
  if (secure && self.strictSSL) {
    context.strictSSL = true
  }
  if (custom) {
    context.checkServerIdentity = custom
  }
  return context
}

function isPlain (value) {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function keyOf (value, anchors) {
  if (ArrayBuffer.isView(value)) {
    return 'buffer:' + Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
  }
  if (typeof value === 'function' || (value && typeof value === 'object' && !Array.isArray(value) && !isPlain(value))) {
    if (!functionIds.has(value)) {
      functionIds.set(value, nextFunctionId++)
    }
    if (anchors) {
      anchors.push(value)
    }
    return 'identity:' + functionIds.get(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => keyOf(item, anchors)).join(',') + ']'
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(name => JSON.stringify(name) + ':' + keyOf(value[name], anchors)).join(',') + '}'
  }
  return typeof value + ':' + JSON.stringify(String(value))
}

function nodeConnector (context, connectOptions) {
  const connector = buildConnector(Object.assign({allowH2: false}, connectOptions, {maxCachedSessions: 0}))
  const noServername = context.servername === ''
  return (options, callback) => connector(noServername ? Object.assign({}, options, {servername: null, host: null}) : options, (err, socket) => {
    if (!err && context.strictSSL && options.protocol === 'https:' && !socket.authorized) {
      socket.destroySoon()
      return callback(new Error('SSL Error: ' + socket.authorizationError))
    }
    callback(err, socket)
  })
}

function agentOptions (context, extra) {
  let connect = Object.assign({timeout: 0}, context)
  delete connect.localAddress
  delete connect.strictSSL
  if (context.strictSSL || context.servername === '') {
    connect = nodeConnector(context, connect)
  }
  const options = Object.assign({
    allowH2: false,
    factory: lifecyclePool,
    headersTimeout: 0,
    bodyTimeout: 0,
    strictContentLength: false,
    connect
  }, extra)
  if (context.localAddress !== undefined) {
    options.localAddress = context.localAddress
  }
  return options
}

function tunnelContext (self) {
  const context = {}
  if (!self.uri || self.uri.protocol !== 'https:') {
    return context
  }
  TUNNEL_FIELDS.forEach(name => {
    if (self[name] !== undefined) {
      context[name] = self[name]
    }
  })
  if (self.rejectUnauthorized !== undefined) {
    context.rejectUnauthorized = self.rejectUnauthorized !== false
  }
  const check = customCheckServerIdentity((self.agentOptions && self.agentOptions.checkServerIdentity) || self.checkServerIdentity)
  if (check) {
    context.checkServerIdentity = check
  }
  if (self.strictSSL) {
    context.strictSSL = true
  }
  return context
}

function proxyOriginOf (proxy) {
  const host = proxy.hostname.indexOf(':') !== -1 && proxy.hostname[0] !== '[' ? '[' + proxy.hostname + ']' : proxy.hostname
  return (proxy.protocol === 'https:' ? 'https:' : 'http:') + '//' + host + (proxy.port ? ':' + proxy.port : '')
}

function connectHeaders (proxy, proxyHeaders) {
  const headers = {}
  let authorization
  Object.keys(proxyHeaders || {}).forEach(name => {
    const value = proxyHeaders[name]
    const lower = name.toLowerCase()
    if (value === undefined) {
      return
    }
    http.validateHeaderName(name)
    http.validateHeaderValue(name, value)
    if (lower === 'proxy-authorization') {
      authorization = String(value)
    } else if (TUNNEL_HEADERS_REFUSED.indexOf(lower) === -1) {
      headers[name] = Array.isArray(value) ? value.map(String) : String(value)
    }
  })
  if (proxy.auth) {
    authorization = 'Basic ' + Buffer.from(proxy.auth).toString('base64')
  }
  if (authorization !== undefined) {
    headers['proxy-authorization'] = authorization
  }
  return headers
}

function proxyServername (proxyHeaders) {
  const host = hostHeader(proxyHeaders)
  if (typeof host !== 'string' || !host) {
    return undefined
  }
  const name = host[0] === '[' ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return net.isIP(name) || !name ? undefined : name
}

const tunnelling = {exchange: null, stage: null, secure: false}

function taggedConnector (connector) {
  return (options, callback) => {
    const stage = tunnelling.stage
    const socket = connector(net.isIP(options.servername) ? Object.assign({}, options, {servername: null}) : options, (err, connected) => {
      if (err && typeof err === 'object') {
        err[PROXY_HOP] = true
      }
      callback(err, connected)
    })
    if (stage && socket) {
      stage.sockets.push(socket)
    }
    return socket
  }
}

function proxyClient (origin, options) {
  const client = new Pool(origin, Object.assign({}, options, {connect: taggedConnector(options.connect), headersTimeout: 0, bodyTimeout: 0}))
  const connect = client.connect
  client.connect = function (connectOptions) {
    const exchange = tunnelling.exchange
    const secure = tunnelling.secure
    const stage = {sockets: []}
    if (exchange) {
      exchange.abortConnecting = () => {
        stage.sockets.forEach(socket => socket.destroy(connectAborted()))
      }
    }
    tunnelling.stage = stage
    let pending
    try {
      pending = connect.call(client, connectOptions)
    } finally {
      tunnelling.stage = null
    }
    return pending.then(result => {
      if (result.socket && result.socket.readableLength) {
        result.socket.read()
      }
      stage.sockets = result.socket ? [result.socket] : []
      if (exchange && result.statusCode === 200) {
        exchange.tunnelReported = true
        exchange.emitLater('reused', secure ? undefined : result.socket)
      }
      return result
    })
  }
  return client
}

function tunnelClient (strict) {
  return (origin, options) => {
    const state = {exchange: null}
    const connect = options.connect
    const client = new Client(origin, Object.assign({}, options, {
      connect (connectOptions, callback) {
        tunnelling.exchange = state.exchange
        tunnelling.secure = connectOptions.protocol === 'https:'
        try {
          return connect(connectOptions, (err, socket) => {
            if (!err && strict && connectOptions.protocol === 'https:' && !socket.authorized) {
              socket.destroySoon()
              return callback(new Error('SSL Error: ' + socket.authorizationError))
            }
            callback(err, socket)
          })
        } finally {
          tunnelling.exchange = null
          tunnelling.secure = false
        }
      }
    }))
    const dispatch = client.dispatch
    client.dispatch = function (dispatchOptions, handler) {
      state.exchange = exchanges.get(handler) || null
      return dispatch.call(client, dispatchOptions, handler)
    }
    return client
  }
}

function tunnelPool (strict) {
  return (origin, options) => new Pool(origin, Object.assign({}, options, {factory: tunnelClient(strict)}))
}

function tunnelAgent (self, context, proxyHeaders, extra) {
  const requestTls = Object.assign({allowH2: false, maxCachedSessions: 0}, context)
  delete requestTls.strictSSL
  const proxyTls = {allowH2: false, maxCachedSessions: 0}
  const servername = self.proxy.protocol === 'https:' ? proxyServername(proxyHeaders) : undefined
  if (servername) {
    proxyTls.servername = servername
  }
  const options = Object.assign({
    uri: proxyOriginOf(self.proxy),
    proxyTunnel: true,
    headers: connectHeaders(self.proxy, proxyHeaders),
    requestTls,
    proxyTls,
    clientFactory: proxyClient,
    factory: tunnelPool(Boolean(context.strictSSL)),
    allowH2: false,
    connectTimeout: 0,
    headersTimeout: 0,
    bodyTimeout: 0,
    strictContentLength: false
  }, extra)
  return new ProxyAgent(options)
}

function connectionOptions (self) {
  const extra = {}
  const agentOptions = self.agentOptions || {}
  const sockets = maxSocketsOf(self)
  const limit = sockets ? socketLimit(sockets.value).limit : undefined
  if (limit !== undefined) {
    extra.connections = limit
  }
  if (agentOptions.keepAlive !== undefined && !agentOptions.keepAlive && !self[FOREVER]) {
    extra.pipelining = 0
  }
  if (self.maxHeaderSize !== undefined && self.maxHeaderSize !== 0) {
    extra.maxHeaderSize = self.maxHeaderSize
  }
  return extra
}

function callerConnection () {
  return new Connection()
}

function dispatcherFor (self, proxyHeaders) {
  if (self.dispatcher !== undefined && self.dispatcher !== null) {
    return {dispatcher: self.dispatcher, oneOff: false, counted: false, servername: undefined, tunnelled: false, caller: true}
  }
  const tunnelled = isTunnel(self)
  const context = tunnelled ? tunnelContext(self) : tlsContext(self)
  const servername = tunnelled ? undefined : context.servername
  const extra = connectionOptions(self)
  const build = () => tunnelled ? tunnelAgent(self, context, proxyHeaders, extra) : new Agent(agentOptions(context, extra))
  if (self.pool === false || context.checkServerIdentity) {
    extra.pipelining = 0
    const dispatcher = build()
    oneOffs.add(dispatcher)
    return {dispatcher, oneOff: true, servername, tunnelled}
  }
  const anchors = []
  let key = Object.keys(context).sort().map(name => name + '=' + keyOf(context[name], anchors)).join('|') +
    '||' + keyOf(extra, anchors)
  if (tunnelled) {
    const headers = connectHeaders(self.proxy, proxyHeaders)
    key = 'tunnel' + JSON.stringify([proxyOriginOf(self.proxy), keyOf(headers), self.proxy.protocol === 'https:' ? proxyServername(proxyHeaders) : null, key])
  } else if (hopProtocol(self) === 'https:' && context.rejectUnauthorized === undefined) {
    key += '||defaultRejectUnauthorized=' + (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0')
  }
  const dispatchers = anchors.length ? identityCache(anchors[0]) : cache
  let dispatcher = dispatchers.get(key)
  if (!dispatcher) {
    dispatcher = build()
    dispatchers.set(key, dispatcher)
    if (dispatchers !== cache) {
      const ref = new WeakRef(dispatcher)
      identityDispatchers.add(ref)
      forgetDispatcher.register(dispatcher, ref)
    }
  }
  const counted = dispatchers !== cache || tunnelled
  if (counted) {
    const use = identityUse.get(dispatcher) || {active: 0, dispatchers, key}
    identityUse.delete(dispatcher)
    identityUse.set(dispatcher, use)
    retireIdleIdentityDispatchers(dispatcher)
  }
  return {dispatcher, oneOff: false, counted, servername, tunnelled}
}

function acquire (dispatcher) {
  const use = identityUse.get(dispatcher)
  if (use) {
    use.active++
  }
}

function retireIdleIdentityDispatchers (current) {
  for (const [dispatcher, use] of identityUse) {
    if (identityUse.size <= IDLE_IDENTITY_DISPATCHERS) {
      return
    }
    if (use.active === 0 && dispatcher !== current) {
      identityUse.delete(dispatcher)
      use.dispatchers.delete(use.key)
      dispatcher.close().catch(() => {})
    }
  }
}

function identityCache (anchor) {
  let dispatchers = identityCaches.get(anchor)
  if (!dispatchers) {
    dispatchers = new Map()
    identityCaches.set(anchor, dispatchers)
  }
  return dispatchers
}

function liveIdentityDispatchers () {
  return Array.from(identityDispatchers).map(ref => ref.deref()).filter(Boolean)
}

function release (dispatcher) {
  const use = identityUse.get(dispatcher)
  if (use) {
    use.active--
    retireIdleIdentityDispatchers()
  } else if (oneOffs.delete(dispatcher)) {
    dispatcher.destroy().catch(() => {})
  }
}

function cacheSize () {
  return cache.size + identityDispatchers.size
}

function oneOffCount () {
  return oneOffs.size
}

function closeAll () {
  const all = Array.from(cache.values()).concat(Array.from(oneOffs), liveIdentityDispatchers())
  cache.clear()
  oneOffs.clear()
  identityDispatchers.clear()
  identityUse.clear()
  identityCaches = new WeakMap()
  return Promise.all(all.map(dispatcher => dispatcher.destroy())).then(() => undefined)
}

module.exports = {
  CALLER_POOL,
  FOREVER,
  CONTEXT_FIELDS,
  GLOBAL_AGENT_FIELDS,
  keyOf,
  dispatcherFor,
  tlsContext,
  agentOptions,
  cacheSize,
  oneOffCount,
  closeAll,
  release,
  acquire,
  hooks,
  hasKeys,
  callerConnection,
  isTunnel,
  hopProtocol,
  usesGlobalAgent,
  globalAgentOf,
  maxSocketsOf,
  socketLimit
}

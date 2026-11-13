'use strict'

var https = require('https')
var tls = require('tls')
var extend = require('extend')
var tunnel = require('@postman/tunnel-agent')
var ForeverAgent = require('forever-agent')
var helpers = require('../helpers')

var version = helpers.version

function customCheckServerIdentity (check) {
  return typeof check === 'function' && check !== tls.checkServerIdentity ? check : undefined
}

function ownCheckServerIdentity (request) {
  return customCheckServerIdentity((request.agentOptions && request.agentOptions.checkServerIdentity) || request.checkServerIdentity)
}

function agentCheckServerIdentity (agent) {
  return customCheckServerIdentity(agent && agent.options && agent.options.checkServerIdentity)
}

function isPlainAgent (agent, Agent) {
  return Boolean(Agent) && Object.getPrototypeOf(agent) === Agent.prototype &&
    !Object.prototype.hasOwnProperty.call(agent, 'createConnection') &&
    !Object.prototype.hasOwnProperty.call(agent, 'addRequest')
}

function sharedTlsAgent (request) {
  var agent = request.agent
  var httpModule = request.httpModule
  var httpsModule = (request.httpModules && request.httpModules['https:']) || https
  if (!agent || !agent.options || httpModule !== httpsModule) {
    return null
  }
  if (agent === httpModule.globalAgent) {
    return isPlainAgent(agent, httpModule.Agent) && !agentCheckServerIdentity(agent) ? agent : null
  }
  for (var key in request.pool) {
    if (request.pool[key] === agent) {
      return agent
    }
  }
  return null
}

function constructTunnelOptions (request, proxyHeaders) {
  var proxy = request.proxy

  var tunnelOptions = {
    proxy: {
      host: proxy.hostname,
      port: +proxy.port,
      proxyAuth: proxy.auth,
      headers: proxyHeaders
    },
    headers: request.headers,
    ca: request.ca,
    cert: request.cert,
    key: request.key,
    passphrase: request.passphrase,
    pfx: request.pfx,
    ciphers: request.ciphers,
    rejectUnauthorized: request.rejectUnauthorized,
    secureOptions: request.secureOptions,
    secureProtocol: request.secureProtocol,
    checkServerIdentity: (request.agentOptions && request.agentOptions.checkServerIdentity) || request.checkServerIdentity
  }

  return tunnelOptions
}

function constructTunnelFnName (uri, proxy) {
  var uriProtocol = (uri.protocol === 'https:' ? 'https' : 'http')
  var proxyProtocol = (proxy.protocol === 'https:' ? 'Https' : 'Http')
  return [uriProtocol, proxyProtocol].join('Over')
}

function getTunnelFn (request) {
  var uri = request.uri
  var proxy = request.proxy
  var tunnelFnName = constructTunnelFnName(uri, proxy)
  return tunnel[tunnelFnName]
}

function isolatedAgent (agent, check) {
  var options = extend({}, agent.options, {keepAlive: false, checkServerIdentity: check})
  if (!check) {
    delete options.checkServerIdentity
  }
  try {
    return new agent.constructor(options)
  } catch (err) {
    return null
  }
}

function send (self, reqOptions) {
  var check = ownCheckServerIdentity(self)
  var agentCheck = agentCheckServerIdentity(self.agent)
  if (check !== agentCheck) {
    var shared = sharedTlsAgent(self)
    var isolated = shared && isolatedAgent(shared, check)
    if (isolated) {
      reqOptions.agent = isolated
    }
    if (check && !('session' in reqOptions) && (shared || !agentCheck)) {
      reqOptions.session = undefined
    }
  }

  var req = self.httpModule.request(reqOptions)

  req.on('socket', function (socket) {
    // `._connecting` was the old property which was made public in node v6.1.0
    if (socket._connecting || socket.connecting) {
      req.emit('connecting', socket, socket)
    } else {
      req.emit('reused', socket)
    }
  })

  return req
}

function createTunnelAgent (self, proxyHeaders) {
  // Set Agent from Tunnel Data
  self.agent = getTunnelFn(self)(constructTunnelOptions(self, proxyHeaders))
}

function prepare (self, options) {
  var protocol = self.proxy && !self.tunnel ? self.proxy.protocol : self.uri.protocol

  if (!self.agent) {
    if (options.agentOptions) {
      self.agentOptions = options.agentOptions
    }

    if (options.agentClass) {
      self.agentClass = options.agentClass
    } else if (options.forever) {
      var v = version()
      // use ForeverAgent in node 0.10- only
      if (v.major === 0 && v.minor <= 10) {
        self.agentClass = protocol === 'http:' ? ForeverAgent : ForeverAgent.SSL
      } else {
        self.agentClass = self.httpModule.Agent
        self.agentOptions = self.agentOptions || {}
        self.agentOptions.keepAlive = true
      }
    } else {
      self.agentClass = self.httpModule.Agent
    }
  }

  if (self.pool === false) {
    if (!self.tunnel || !self.proxy) {
      self.agent = false
    }
  } else {
    self.agent = self.agent || self.getNewAgent()
  }
}

function verifyResponse (self, response) {
  // XXX This is different on 0.10, because SSL is strict by default
  if (self.httpModule === https &&
    self.strictSSL && (!response.hasOwnProperty('socket') ||
    !response.socket.authorized)) {
    var sslErr = response.hasOwnProperty('socket') ? response.socket.authorizationError : self.uri.href + ' does not support SSL'
    return new Error('SSL Error: ' + sslErr)
  }
  return null
}

module.exports = {send: send, tunnel: createTunnelAgent, prepare: prepare, verifyResponse: verifyResponse}

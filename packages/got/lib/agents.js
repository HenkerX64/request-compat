'use strict'

const https = require('https')
const tls = require('tls')
const {createRequire} = require('module')

const corePackage = require.resolve('request-compat/package.json')
const requireFromCore = createRequire(corePackage)
const tunnelAgent = requireFromCore('@postman/tunnel-agent')
const extend = requireFromCore('extend')

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
  const agent = request.agent
  const httpModule = request.httpModule
  const httpsModule = (request.httpModules && request.httpModules['https:']) || https
  if (!agent || !agent.options || httpModule !== httpsModule) {
    return null
  }
  if (agent === httpModule.globalAgent) {
    return isPlainAgent(agent, httpModule.Agent) && !agentCheckServerIdentity(agent) ? agent : null
  }
  for (const key in request.pool) {
    if (request.pool[key] === agent) {
      return agent
    }
  }
  return null
}

function isolatedAgent (agent, check) {
  const options = extend({}, agent.options, {keepAlive: false, checkServerIdentity: check})
  if (!check) {
    delete options.checkServerIdentity
  }
  try {
    return new agent.constructor(options)
  } catch (err) {
    return null
  }
}

function isolateTlsSession (self, reqOptions) {
  const check = ownCheckServerIdentity(self)
  const agentCheck = agentCheckServerIdentity(self.agent)
  if (check === agentCheck) {
    return
  }
  const shared = sharedTlsAgent(self)
  const isolated = shared && isolatedAgent(shared, check)
  if (isolated) {
    reqOptions.agent = isolated
  }
  if (check && !('session' in reqOptions) && (shared || !agentCheck)) {
    reqOptions.session = undefined
  }
}

function tunnelOptions (request, proxyHeaders) {
  const proxy = request.proxy
  return {
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
}

function tunnelFunctionName (uri, proxy) {
  const uriProtocol = uri.protocol === 'https:' ? 'https' : 'http'
  const proxyProtocol = proxy.protocol === 'https:' ? 'Https' : 'Http'
  return [uriProtocol, proxyProtocol].join('Over')
}

function tunnel (self, proxyHeaders) {
  const createTunnel = tunnelAgent[tunnelFunctionName(self.uri, self.proxy)]
  self.agent = createTunnel(tunnelOptions(self, proxyHeaders))
}

function prepare (self, options) {
  if (!self.agent) {
    if (options.agentOptions) {
      self.agentOptions = options.agentOptions
    }
    if (options.agentClass) {
      self.agentClass = options.agentClass
    } else if (options.forever) {
      self.agentClass = self.httpModule.Agent
      self.agentOptions = self.agentOptions || {}
      self.agentOptions.keepAlive = true
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
  if (self.httpModule === https && self.strictSSL &&
    (!Object.prototype.hasOwnProperty.call(response, 'socket') || !response.socket || !response.socket.authorized)) {
    const reason = Object.prototype.hasOwnProperty.call(response, 'socket') && response.socket
      ? response.socket.authorizationError
      : self.uri.href + ' does not support SSL'
    return new Error('SSL Error: ' + reason)
  }
  return null
}

module.exports = {tunnel, prepare, verifyResponse, isolateTlsSession}

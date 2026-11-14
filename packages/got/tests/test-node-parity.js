'use strict'

const {EventEmitter} = require('events')
const http = require('http')
const https = require('https')
const tls = require('tls')
const tape = require('tape')
const nodeTransport = require('request-compat/lib/transport/node')
const agents = require('../lib/agents')

class CustomAgent extends http.Agent {}

function ownCheck () {}
function agentCheck () {}

function preparedSelf (state) {
  return Object.assign({
    uri: {protocol: 'http:'},
    httpModule: http,
    pool: {},
    getNewAgent () {
      return {agentClass: this.agentClass, agentOptions: this.agentOptions}
    }
  }, state)
}

function prepareOutcome (prepare, options, state) {
  const self = preparedSelf(state())
  prepare(self, options())
  return {agent: self.agent, agentClass: self.agentClass, agentOptions: self.agentOptions}
}

tape('prepare selects the agent as lib/transport/node.js does', t => {
  const existing = new http.Agent()
  const optionSets = [
    () => ({}),
    () => ({agentOptions: {maxSockets: 2}}),
    () => ({agentClass: CustomAgent}),
    () => ({forever: true}),
    () => ({forever: true, agentOptions: {maxSockets: 3}}),
    () => ({agentClass: CustomAgent, forever: true, agentOptions: {keepAlive: false}})
  ]
  const states = [
    () => ({}),
    () => ({pool: false}),
    () => ({pool: false, tunnel: true, proxy: {protocol: 'http:'}}),
    () => ({agent: existing}),
    () => ({uri: {protocol: 'https:'}, httpModule: https})
  ]
  optionSets.forEach((options, optionIndex) => {
    states.forEach((state, stateIndex) => {
      t.deepEqual(prepareOutcome(agents.prepare, options, state), prepareOutcome(nodeTransport.prepare, options, state), 'options ' + optionIndex + ', state ' + stateIndex)
    })
  })
  t.end()
})

function tunnelSelf (uriProtocol, proxyProtocol) {
  return {
    uri: {protocol: uriProtocol},
    proxy: {hostname: 'proxy.test', port: '8080', auth: 'user:pass', protocol: proxyProtocol},
    headers: {host: 'target.test'},
    ca: 'ca',
    cert: 'cert',
    key: 'key',
    passphrase: 'secret',
    pfx: 'pfx',
    ciphers: 'HIGH',
    rejectUnauthorized: false,
    secureOptions: 1,
    secureProtocol: 'TLS_method',
    agentOptions: {checkServerIdentity: ownCheck}
  }
}

function tunnelOutcome (tunnel, uriProtocol, proxyProtocol) {
  const self = tunnelSelf(uriProtocol, proxyProtocol)
  tunnel(self, {'proxy-authorization': 'Basic x'})
  const agent = self.agent
  return {options: agent.options, request: agent.request, createSocket: agent.createSocket, defaultPort: agent.defaultPort}
}

tape('tunnel builds the tunnel agent as lib/transport/node.js does', t => {
  ;['http:', 'https:'].forEach(uriProtocol => {
    ;['http:', 'https:'].forEach(proxyProtocol => {
      t.deepEqual(tunnelOutcome(agents.tunnel, uriProtocol, proxyProtocol), tunnelOutcome(nodeTransport.tunnel, uriProtocol, proxyProtocol), uriProtocol + ' over ' + proxyProtocol)
    })
  })
  t.end()
})

function capturingModule (captured) {
  return {
    Agent: https.Agent,
    globalAgent: https.globalAgent,
    request (options) {
      captured.push(options)
      return new EventEmitter()
    }
  }
}

function sessionSelf (module, state) {
  return Object.assign({httpModule: module, httpModules: {'https:': module}, pool: {}}, state(module))
}

function agentSummary (agent) {
  return agent && {constructor: agent.constructor, options: agent.options}
}

function sessionOutcome (useNode, state, reqOptions) {
  const captured = []
  const module = capturingModule(captured)
  const self = sessionSelf(module, state)
  const options = reqOptions()
  if (useNode) {
    nodeTransport.send(self, options)
  } else {
    agents.isolateTlsSession(self, options)
    captured.push(options)
  }
  const sent = captured[0]
  return {agent: agentSummary(sent.agent), hasSession: 'session' in sent, session: sent.session}
}

tape('the TLS session rule for checkServerIdentity isolates as lib/transport/node.js does', t => {
  const pooled = new https.Agent({keepAlive: true})
  const states = [
    () => ({}),
    module => ({agent: module.globalAgent}),
    module => ({agent: module.globalAgent, checkServerIdentity: ownCheck}),
    module => ({agent: module.globalAgent, checkServerIdentity: tls.checkServerIdentity}),
    module => ({agent: module.globalAgent, agentOptions: {checkServerIdentity: ownCheck}}),
    () => ({agent: pooled, pool: {pooled}, checkServerIdentity: ownCheck}),
    () => ({agent: new https.Agent({checkServerIdentity: agentCheck}), checkServerIdentity: ownCheck}),
    () => ({agent: new https.Agent({checkServerIdentity: agentCheck})}),
    () => ({agent: new https.Agent(), checkServerIdentity: ownCheck}),
    () => ({agent: false, checkServerIdentity: ownCheck})
  ]
  const requestOptions = [
    () => ({}),
    () => ({session: Buffer.from('session')})
  ]
  states.forEach((state, stateIndex) => {
    requestOptions.forEach((reqOptions, optionIndex) => {
      t.deepEqual(sessionOutcome(false, state, reqOptions), sessionOutcome(true, state, reqOptions), 'state ' + stateIndex + ', request options ' + optionIndex)
    })
  })
  pooled.destroy()
  t.end()
})

tape('verifyResponse checks strictSSL as lib/transport/node.js does', t => {
  const responses = [
    () => ({socket: {authorized: true}}),
    () => ({socket: {authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN'}}),
    () => ({})
  ]
  const selves = [
    {httpModule: https, strictSSL: true, uri: {href: 'https://localhost/'}},
    {httpModule: https, strictSSL: false, uri: {href: 'https://localhost/'}},
    {httpModule: http, strictSSL: true, uri: {href: 'http://localhost/'}}
  ]
  selves.forEach((self, selfIndex) => {
    responses.forEach((response, responseIndex) => {
      const engineError = agents.verifyResponse(self, response())
      const nodeError = nodeTransport.verifyResponse(self, response())
      t.equal(engineError && engineError.message, nodeError && nodeError.message, 'self ' + selfIndex + ', response ' + responseIndex)
    })
  })
  t.end()
})

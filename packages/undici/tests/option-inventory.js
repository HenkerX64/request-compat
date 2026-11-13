'use strict'

const dns = require('dns')
const http = require('http')
const https = require('https')
const net = require('net')
const {AbortSignal} = global

const blocked = new net.BlockList()
blocked.addAddress('127.0.0.1')

const CONNECTION_OPTIONS = {
  lookup: dns.lookup,
  hints: dns.ADDRCONFIG,
  signal: AbortSignal.abort(),
  socket: new net.Socket(),
  localPort: 43999,
  blockList: blocked,
  autoSelectFamily: false,
  autoSelectFamilyAttemptTimeout: 500,
  keepAliveInitialDelay: 1000,
  onread: {buffer: Buffer.alloc(16), callback: () => true},
  fd: 99999,
  handle: {fd: 99999},
  objectMode: true,
  readableObjectMode: true,
  writableObjectMode: true,
  typeOfService: 16,
  session: Buffer.from('session'),
  ALPNProtocols: ['http/1.1'],
  minDHSize: 2048,
  pskCallback: () => null,
  requestOCSP: true,
  enableTrace: true,
  allowPartialTrustChain: true,
  clientCertEngine: 'dynamic',
  privateKeyEngine: 'dynamic',
  privateKeyIdentifier: 'key',
  certificateCompression: ['zlib'],
  sessionTimeout: 300,
  ticketKeys: Buffer.alloc(48)
}

const REQUEST_ONLY_OPTIONS = {
  createConnection: net.createConnection,
  insecureHTTPParser: true,
  joinDuplicateHeaders: true,
  setDefaultHeaders: false,
  uniqueHeaders: ['x-probe'],
  httpValidation: 'strict',
  _defaultAgent: new http.Agent()
}

const AGENT_OPTIONS_REFUSED_ON_THE_REQUEST = {
  keepAlive: false
}

const COMPUTED_OPTIONS = {
  hostname: 'request-compat-nonexistent.invalid',
  protocol: 'ftp:'
}

const AGENT_ONLY_OPTIONS = {
  maxTotalSockets: 4,
  timeout: 1000,
  maxHeaderSize: 100,
  strictSSL: true,
  noDelay: true,
  foo: 'bar'
}

const GLOBAL_ONLY_OPTIONS = {
  host: 'request-compat-nonexistent.invalid',
  port: 1,
  path: '/tmp/request-compat-none.sock',
  noDelay: false,
  timeout: 1000,
  scheduling: 'fifo',
  readable: false,
  writable: false,
  maxSockets: 5,
  defaultPort: 8443
}

const HTTP_GLOBAL_ONLY_OPTIONS = {
  family: 6,
  localAddress: '127.0.0.9',
  socketPath: '/tmp/request-compat-none.sock',
  ca: Buffer.from('ca')
}

const NODE_AGENT_OPTIONS = [
  ['agent', () => new http.Agent()],
  ['agent', () => true],
  ['agentClass', () => http.Agent],
  ['httpModules', () => ({'http:': http, 'https:': https})],
  ['pool', () => ({'http:': new http.Agent(), 'https:': new https.Agent()})]
]

module.exports = {
  CONNECTION_OPTIONS,
  REQUEST_ONLY_OPTIONS,
  AGENT_OPTIONS_REFUSED_ON_THE_REQUEST,
  COMPUTED_OPTIONS,
  AGENT_ONLY_OPTIONS,
  GLOBAL_ONLY_OPTIONS,
  HTTP_GLOBAL_ONLY_OPTIONS,
  NODE_AGENT_OPTIONS
}

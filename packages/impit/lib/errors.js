'use strict'

const util = require('util')

const MINIMUM_NODE_MAJOR = 20
const OS_ERROR = /Os \{\s*code: (\d+),\s*kind: (\w+)/
const CONNECT_TARGET = /"tcp connect error",\s*(\S+):(\d+),/
const KIND_CODES = {
  ConnectionRefused: 'ECONNREFUSED',
  ConnectionReset: 'ECONNRESET',
  ConnectionAborted: 'ECONNABORTED',
  HostUnreachable: 'EHOSTUNREACH',
  NetworkUnreachable: 'ENETUNREACH',
  AddrNotAvailable: 'EADDRNOTAVAIL',
  AddrInUse: 'EADDRINUSE',
  BrokenPipe: 'EPIPE',
  TimedOut: 'ETIMEDOUT',
  PermissionDenied: 'EACCES'
}
const CERTIFICATE_CODES = {
  Expired: 'CERT_HAS_EXPIRED',
  NotValidYet: 'CERT_NOT_YET_VALID',
  NotValidForName: 'ERR_TLS_CERT_ALTNAME_INVALID',
  Revoked: 'CERT_REVOKED'
}
const INVALID_CERTIFICATE = /InvalidCertificate\(\s*(\w+?)(?:Context)?\b/
const TRUNCATED = /UnexpectedEof|IncompleteBody|IncompleteMessage|ConnectionReset|BrokenPipe|ChannelClosed|connection closed/

function nodeVersionError (version) {
  const major = Number(version.split('.')[0])
  if (major >= MINIMUM_NODE_MAJOR) {
    return null
  }
  const err = new Error('request-compat-impit needs Node >= 20')
  err.code = 'NODE_VERSION_NOT_SUPPORTED'
  return err
}

function notSupported (option, reason) {
  const err = new Error('request-compat-impit does not support the option ' + option + (reason ? ': ' + reason : ''))
  err.code = 'OPTION_NOT_SUPPORTED'
  err.option = option
  return err
}

function invalidImpit () {
  const err = new TypeError('request-compat-impit: the option impit needs an Impit instance, an object with a fetch function')
  err.code = 'INVALID_IMPIT'
  return err
}

function messageOf (err) {
  return err && typeof err.message === 'string' ? err.message : ''
}

function systemErrorName (errno, kind) {
  try {
    return util.getSystemErrorName(-errno)
  } catch (invalidErrno) {
    return KIND_CODES[kind] || null
  }
}

function withCause (mapped, cause) {
  mapped.cause = cause
  return mapped
}

function connectFailure (err, lookupHost) {
  const message = messageOf(err)
  const os = OS_ERROR.exec(message)
  if (os) {
    const code = systemErrorName(Number(os[1]), os[2])
    if (!code) {
      return null
    }
    const target = CONNECT_TARGET.exec(message)
    const syscall = message.indexOf('tcp bind local error') === -1 ? 'connect' : 'bind'
    const mapped = new Error(syscall + ' ' + code + (target ? ' ' + target[1] + ':' + target[2] : ''))
    mapped.code = code
    mapped.errno = -Number(os[1])
    mapped.syscall = syscall
    if (target) {
      mapped.address = target[1].replace(/^\[|\]$/g, '')
      mapped.port = Number(target[2])
    }
    return mapped
  }
  if (message.indexOf('dns error') !== -1) {
    const mapped = new Error('getaddrinfo ENOTFOUND' + (lookupHost ? ' ' + lookupHost : ''))
    mapped.code = 'ENOTFOUND'
    mapped.syscall = 'getaddrinfo'
    if (lookupHost) {
      mapped.hostname = lookupHost
    }
    return mapped
  }
  const certificate = INVALID_CERTIFICATE.exec(message)
  if (certificate && CERTIFICATE_CODES[certificate[1]]) {
    const mapped = new Error(CERTIFICATE_CODES[certificate[1]])
    mapped.code = CERTIFICATE_CODES[certificate[1]]
    return mapped
  }
  return null
}

function hangUp () {
  const mapped = new Error('socket hang up')
  mapped.code = 'ECONNRESET'
  return mapped
}

function tunnelFailure (err, connect) {
  const name = err && err.constructor ? err.constructor.name : ''
  let reason = null
  if (name === 'ProxyTunnelError' && err.status) {
    reason = 'statusCode=' + err.status
  } else if (name === 'ProxyAuthRequired') {
    reason = 'statusCode=407'
  } else if (name === 'ProxyTunnelError' || name === 'ProxyError') {
    reason = 'cause=' + messageOf(err)
  } else if (connect && messageOf(err).indexOf('ConnectFailed(') !== -1) {
    reason = 'cause=' + connect.message
  }
  if (!reason) {
    return null
  }
  const mapped = new Error('tunneling socket could not be established, ' + reason)
  mapped.code = 'ECONNRESET'
  return mapped
}

function requestFailure (err, tunnelled, lookupHost) {
  const connect = connectFailure(err, lookupHost)
  const tunnel = tunnelled ? tunnelFailure(err, connect) : null
  if (tunnel) {
    return tunnel
  }
  if (connect) {
    return connect
  }
  const name = err && err.constructor ? err.constructor.name : ''
  if (name === 'RemoteProtocolError' || name === 'ReadError' || name === 'WriteError' || name === 'CloseError') {
    return hangUp()
  }
  if (name === 'ConnectTimeout' || name === 'ReadTimeout' || name === 'WriteTimeout' || name === 'PoolTimeout' || name === 'TimeoutError') {
    const mapped = new Error('ETIMEDOUT')
    mapped.code = 'ETIMEDOUT'
    return mapped
  }
  if (name !== 'ConnectError' && TRUNCATED.test(messageOf(err))) {
    return hangUp()
  }
  return null
}

function decodingFailure (message) {
  if (message.indexOf('kind: Decode') === -1 || message.indexOf('hyper::Error') !== -1) {
    return null
  }
  const truncated = message.indexOf('UnexpectedEof') !== -1
  const mapped = new Error(truncated ? 'unexpected end of file' : 'impit could not decode the response body')
  mapped.code = truncated ? 'Z_BUF_ERROR' : 'Z_DATA_ERROR'
  return mapped
}

function responseFailure (err) {
  const decoding = decodingFailure(messageOf(err))
  if (decoding) {
    return decoding
  }
  if (!TRUNCATED.test(messageOf(err))) {
    return null
  }
  const mapped = new Error('aborted')
  mapped.code = 'ECONNRESET'
  return mapped
}

function toNodeError (err, phase, tunnelled, lookupHost) {
  if (!err || typeof err !== 'object' || err.code === 'OPTION_NOT_SUPPORTED') {
    return err
  }
  const mapped = phase === 'response' ? responseFailure(err) : requestFailure(err, tunnelled, lookupHost)
  return mapped ? withCause(mapped, err) : err
}

module.exports = {notSupported, invalidImpit, toNodeError, nodeVersionError}

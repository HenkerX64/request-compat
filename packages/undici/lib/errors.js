'use strict'

const PROXY_HOP = Symbol('request-compat-undici.proxyHop')
const PROXY_ERROR_CODES = ['UND_ERR_PRX_CONN', 'UND_ERR_PRX_TLS']
const CONNECT_REFUSED = /^Proxy response \((\d+)\) !== 200 when HTTP Tunneling$/
const MINIMUM_NODE = [22, 19]

function nodeVersionError (version) {
  const [major, minor] = version.split('.').map(Number)
  if (major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1])) {
    return null
  }
  const err = new Error('request-compat-undici needs Node >= 22.19')
  err.code = 'NODE_VERSION_NOT_SUPPORTED'
  return err
}

function notSupported (option, reason) {
  const err = new Error('request-compat-undici does not support the option ' + option + (reason ? ': ' + reason : ''))
  err.code = 'OPTION_NOT_SUPPORTED'
  err.option = option
  return err
}

function tunnelFailure (err) {
  const refused = err.code === 'UND_ERR_ABORTED' && CONNECT_REFUSED.exec(err.message)
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : err
  const viaProxy = err[PROXY_HOP] || (err.cause && err.cause[PROXY_HOP]) || PROXY_ERROR_CODES.indexOf(err.code) !== -1
  if (!refused && !viaProxy) {
    return null
  }
  const reason = cause.code === 'UND_ERR_SOCKET' ? 'socket hang up' : cause.message
  const mapped = new Error('tunneling socket could not be established, ' + (refused ? 'statusCode=' + refused[1] : 'cause=' + reason))
  mapped.code = 'ECONNRESET'
  return mapped
}

function toNodeError (err, phase) {
  const tunnel = phase === 'request' && err && typeof err === 'object' ? tunnelFailure(err) : null
  if (tunnel) {
    return tunnel
  }
  const reset = err && (err.code === 'UND_ERR_SOCKET' || (phase === 'response' && err.code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'))
  if (!reset) {
    return err
  }
  const mapped = new Error(phase === 'response' ? 'aborted' : 'socket hang up')
  mapped.code = 'ECONNRESET'
  return mapped
}

module.exports = {notSupported, toNodeError, nodeVersionError, PROXY_HOP}

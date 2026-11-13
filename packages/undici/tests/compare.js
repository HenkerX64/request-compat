'use strict'

const tls = require('tls')
const nodeApi = require('request-compat')
const engineApi = require('../index')

const OBSERVED = ['request', 'response', 'end', 'complete', 'error']
const LOWER_CASE_NAMES = ['host', 'connection']

function baseUrl (server) {
  const port = server.address().port
  return (server instanceof tls.Server ? 'https' : 'http') + '://localhost:' + port
}

const RECORDER = Symbol('compare.recorder')

function recorder (server) {
  if (!server[RECORDER]) {
    const state = {chunks: null}
    server[RECORDER] = state
    server.on(server instanceof tls.Server ? 'secureConnection' : 'connection', socket => {
      socket.on('data', chunk => {
        if (state.chunks) {
          state.chunks.push(Buffer.from(chunk))
        }
      })
    })
  }
  return server[RECORDER]
}

function exercise (api, options, server, cb) {
  const chunks = []
  const state = recorder(server)
  state.chunks = chunks

  const request = Object.assign({}, options)
  const source = request.source
  delete request.source
  const onRequest = request.onRequest
  delete request.onRequest
  request.url = typeof request.url === 'function' ? request.url(server.address().port) : baseUrl(server) + (request.url || '/')

  const events = []
  const r = api(request, (error, response, body) => {
    setTimeout(() => {
      state.chunks = null
      cb({
        bytes: Buffer.concat(chunks),
        statusCode: response && response.statusCode,
        statusMessage: response && response.statusMessage,
        httpVersion: response && response.httpVersion,
        headers: response && response.headers,
        rawHeaders: response && response.rawHeaders,
        body: body,
        events: events,
        error: error
      })
    }, 20)
  })
  OBSERVED.forEach(name => r.on(name, () => events.push(name)))
  if (onRequest) {
    r.on('request', onRequest)
  }
  if (source) {
    source().pipe(r)
  }
}

function compare (options, server, cb) {
  exercise(nodeApi, options, server, node => {
    exercise(engineApi, options, server, engine => {
      cb(null, {node: node, engine: engine})
    })
  })
}

function normalizeRequest (bytes, sorted) {
  const text = bytes.toString('latin1')
  const split = text.indexOf('\r\n\r\n')
  const lines = text.slice(0, split === -1 ? text.length : split).split('\r\n')
  const requestLine = lines.shift()
  const headers = lines.map(line => {
    const colon = line.indexOf(':')
    const name = line.slice(0, colon)
    return (LOWER_CASE_NAMES.indexOf(name.toLowerCase()) !== -1 ? name.toLowerCase() : name) + line.slice(colon)
  })
  if (sorted) {
    headers.sort()
  }
  return [requestLine].concat(headers).join('\r\n') + (split === -1 ? '' : '\r\n\r\n' + text.slice(split + 4))
}

module.exports = compare
module.exports.normalizeRequest = normalizeRequest

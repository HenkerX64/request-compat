'use strict'

const tls = require('tls')
const nodeApi = require('request-compat')
const engineApi = require('../index')

const OBSERVED = ['request', 'socket', 'response', 'end', 'complete', 'error']
const RECORDER = Symbol('compare.recorder')

function baseUrl (server) {
  return (server instanceof tls.Server ? 'https' : 'http') + '://localhost:' + server.address().port
}

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
  request.url = typeof request.url === 'function' ? request.url(server.address().port) : baseUrl(server) + (request.url || '/')
  const events = []
  const r = api(request, (error, response, body) => {
    setTimeout(() => {
      state.chunks = null
      cb({
        bytes: Buffer.concat(chunks).toString('latin1'),
        statusCode: response && response.statusCode,
        statusMessage: response && response.statusMessage,
        httpVersion: response && response.httpVersion,
        headers: response && response.headers,
        rawHeaders: response && response.rawHeaders,
        body,
        events,
        error: error && {code: error.code, message: error.message}
      })
    }, 20)
  })
  OBSERVED.forEach(name => r.on(name, () => events.push(name)))
  if (source) {
    source().pipe(r)
  }
}

function compare (options, server, cb) {
  exercise(nodeApi, options, server, node => {
    exercise(engineApi, options, server, engine => {
      cb(null, {node, engine})
    })
  })
}

module.exports = compare

'use strict'

const {EventEmitter} = require('events')
const {PassThrough, Readable} = require('stream')
const {toNodeHeaders} = require('./headers')
const {toNodeError} = require('./errors')
const {hooks, release, callerConnection} = require('./dispatchers')

function abortError () {
  const err = new Error('aborted')
  err.code = 'ECONNRESET'
  return err
}

function toBuffer (chunk, encoding) {
  return typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk
}

const DEFAULT_PORTS = {'http:': '80', 'https:': '443'}

function originOf (protocol, host, port) {
  const name = host.indexOf(':') !== -1 && host[0] !== '[' ? '[' + host + ']' : host
  return protocol + '//' + name + (port && String(port) !== DEFAULT_PORTS[protocol] ? ':' + port : '')
}

class Exchange extends EventEmitter {
  constructor (dispatcher, dispatchOptions, oneOff, counted, tunnelled, caller) {
    super()
    this.tunnelled = Boolean(tunnelled)
    this.caller = Boolean(caller)
    this.connection = null
    this.socket = null
    this.tunnelReported = false
    this.dispatcher = dispatcher
    this.dispatchOptions = dispatchOptions
    this.oneOff = oneOff
    this.counted = counted
    this.body = new PassThrough({objectMode: true})
    this.body.on('error', () => {})
    this.body.on('drain', () => this.emitLater('drain'))
    this.controller = null
    this.response = null
    this.dispatched = false
    this.aborted = false
    this.ended = false
    this.settled = false
    this.errorEmitted = false
    this.responseEmitted = false
    this.responseEnded = false
    this.endPending = false
    this.idleMs = 0
    this.idleCallback = null
    this.idleTimer = null
    this.abortConnecting = null
    this.handler = this.createHandler()
  }

  get finished () {
    return this.ended
  }

  get writableFinished () {
    return this.body.writableFinished
  }

  emitLater (name, ...args) {
    process.nextTick(() => {
      if (this.aborted) {
        return
      }
      if (name === 'error') {
        if (this.errorEmitted) {
          return
        }
        this.errorEmitted = true
      } else if (name === 'response') {
        if (this.responseEmitted || this.errorEmitted) {
          return
        }
        this.responseEmitted = true
      } else if (this.errorEmitted) {
        return
      }
      const socket = name === 'connecting' ? args[1] : name === 'reused' ? args[0] : null
      if (socket) {
        this.socket = socket
      }
      if (name !== 'response') {
        this.emit(name, ...args)
        return
      }
      try {
        this.emit(name, ...args)
      } finally {
        this.pushPendingEnd()
      }
    })
  }

  pushEnd () {
    if (this.responseEmitted) {
      this.response.push(null)
    } else {
      this.endPending = true
    }
  }

  pushPendingEnd () {
    if (this.endPending && !this.response.destroyed) {
      this.endPending = false
      this.response.push(null)
    }
  }

  settle () {
    if (this.settled) {
      return
    }
    this.settled = true
    this.clearIdle()
    if (this.oneOff || this.counted) {
      const dispatcher = this.dispatcher
      setImmediate(() => release(dispatcher))
    }
  }

  clearIdle () {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  touch () {
    if (!this.idleMs || this.settled) {
      return
    }
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.idleCallback && !this.settled) {
        this.idleCallback()
      }
    }, this.idleMs)
  }

  setTimeout (ms, callback) {
    this.idleMs = ms > 0 ? ms : 0
    if (callback) {
      this.idleCallback = callback
    }
    if (this.idleMs) {
      this.touch()
    } else {
      this.clearIdle()
    }
    return this
  }

  removeHeader (name) {
    const lower = String(name).toLowerCase()
    const headers = this.dispatchOptions.headers
    Object.keys(headers).forEach(key => {
      if (key.toLowerCase() === lower) {
        delete headers[key]
      }
    })
  }

  dispatch () {
    if (this.dispatched || this.aborted || this.settled) {
      return
    }
    this.dispatched = true
    const options = Object.assign({}, this.dispatchOptions, {body: this.body, headersTimeout: 0, bodyTimeout: 0})
    hooks.track(this.handler, this)
    try {
      this.dispatcher.dispatch(options, this.handler)
    } catch (err) {
      return this.fail(err)
    }
    if (this.caller && !this.settled) {
      this.connection = callerConnection()
      this.emitLater('connecting', this.connection, undefined)
    }
  }

  connected () {
    const connection = this.connection
    if (connection && !connection.connected && !this.aborted) {
      connection.lookedUp = true
      connection.connected = true
      connection.emit('lookup')
      connection.emit('connect')
    }
  }

  write (chunk, encoding, callback) {
    if (this.aborted || this.ended) {
      return false
    }
    this.dispatch()
    this.touch()
    return this.body.write(toBuffer(chunk, encoding), callback)
  }

  end (chunk, encoding, callback) {
    if (this.aborted || this.ended) {
      return this
    }
    this.dispatch()
    this.ended = true
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      this.body.end(toBuffer(chunk, encoding), typeof encoding === 'function' ? encoding : callback)
    } else {
      this.body.end(typeof chunk === 'function' ? chunk : callback)
    }
    return this
  }

  abort () {
    if (this.aborted) {
      return
    }
    this.aborted = true
    const connecting = !this.settled && !this.response
    this.settle()
    if (this.controller) {
      this.controller.abort(abortError())
    } else if (this.dispatched) {
      this.body.destroy(abortError())
    }
    if (this.response && !this.responseEnded) {
      this.response.destroy()
    }
    this.body.destroy()
    if (connecting && this.abortConnecting) {
      this.abortConnecting()
    }
  }

  fail (err) {
    if (this.aborted || this.settled) {
      return
    }
    this.settle()
    if (this.response) {
      this.failResponse(err)
    } else {
      this.emitLater('error', toNodeError(err, 'request'))
    }
  }

  failResponse (err) {
    const response = this.response
    if (!this.responseEnded) {
      this.responseEnded = true
      process.nextTick(() => {
        response.aborted = true
        response.emit('aborted')
        response.destroy(toNodeError(err, 'response'))
      })
    }
  }

  createHandler () {
    const exchange = this
    const guarded = fn => function () {
      try {
        fn.apply(undefined, arguments)
      } catch (err) {
        exchange.fail(err)
      }
    }
    return {
      onRequestStart: guarded(controller => {
        exchange.controller = controller || null
        exchange.connected()
        if (exchange.tunnelled && !exchange.tunnelReported) {
          exchange.emitLater('reused', undefined)
        }
        if (exchange.aborted && controller) {
          controller.abort(abortError())
        }
      }),
      onResponseStart: guarded((controller, statusCode, headers, statusText) => {
        if (statusCode < 200 || exchange.aborted || exchange.settled) {
          return
        }
        exchange.touch()
        const parsed = toNodeHeaders(controller.rawHeaders)
        const response = new Readable({
          read () {
            if (controller.paused) {
              controller.resume()
            }
          },
          destroy (err, callback) {
            if (!exchange.responseEnded && !exchange.settled) {
              exchange.settle()
              controller.abort(abortError())
            }
            callback(err)
          }
        })
        response.statusCode = statusCode
        response.statusMessage = statusText || ''
        response.httpVersion = Array.isArray(controller.rawHeaders) ? '1.1' : '2.0'
        response.headers = parsed.headers
        response.rawHeaders = parsed.rawHeaders
        response.trailers = {}
        response.rawTrailers = []
        exchange.response = response
        exchange.emitLater('response', response)
      }),
      onResponseData: guarded((controller, chunk) => {
        if (exchange.settled) {
          return
        }
        exchange.touch()
        if (exchange.response && !exchange.response.push(chunk)) {
          controller.pause()
        }
      }),
      onResponseEnd: guarded(() => {
        if (exchange.response && !exchange.aborted && !exchange.settled) {
          exchange.responseEnded = true
          exchange.response.complete = true
          exchange.pushEnd()
        }
        exchange.settle()
      }),
      onResponseError: guarded((controller, err) => {
        exchange.fail(err)
      })
    }
  }
}

function createExchange (self, reqOptions, dispatcher, opts) {
  const protocol = self.proxy && !self.tunnel ? self.proxy.protocol : self.uri.protocol
  const dispatchOptions = {
    origin: self.socketPath ? protocol + '//localhost' : originOf(protocol, reqOptions.host, reqOptions.port),
    path: reqOptions.path,
    method: String(reqOptions.method || 'GET').toUpperCase(),
    headers: opts.headers
  }
  if (opts.reset || opts.tunnelled) {
    dispatchOptions.reset = true
  }
  if (opts.servername && protocol === 'https:') {
    dispatchOptions.servername = opts.servername
  }
  return new Exchange(dispatcher, dispatchOptions, opts.oneOff, opts.counted, opts.tunnelled, opts.caller)
}

module.exports = {createExchange}

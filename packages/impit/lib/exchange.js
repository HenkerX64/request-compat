'use strict'

const {EventEmitter} = require('events')
const {Readable} = require('stream')
const {incoming, withoutHeader} = require('./headers')
const {toNodeError, notSupported} = require('./errors')
const {BODILESS_METHODS} = require('./options')
const {acquire, forget, release} = require('./limits')

const {AbortController, ByteLengthQueuingStrategy, ReadableStream} = global

const UPLOAD_HIGH_WATER_MARK = 16384
const READ_AHEAD_PATIENCE = 50
const READ_AHEAD_LIMIT = 65536

function abortError () {
  const err = new Error('aborted')
  err.code = 'ECONNRESET'
  return err
}

function toBytes (chunk, encoding) {
  return typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk
}

function toChunk (bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function isDiscardedByTheCore (statusCode) {
  return (statusCode >= 300 && statusCode < 400) || statusCode === 401 || statusCode === 407
}

function ignore () {}

class Exchange extends EventEmitter {
  constructor (impit, url, method, headers, tunnelled, slot, lookupHost) {
    super()
    this.slot = slot
    this.granted = false
    this.grant = () => this.onGranted()
    this.waitingBody = undefined
    this.impit = impit
    this.url = url
    this.method = method
    this.headers = headers
    this.tunnelled = tunnelled
    this.lookupHost = lookupHost
    this.connection = new EventEmitter()
    this.controller = new AbortController()
    this.upload = null
    this.uploadWaits = false
    this.reader = null
    this.readAheadChunks = []
    this.readAheadEnded = false
    this.readingAhead = false
    this.pumping = false
    this.response = null
    this.started = false
    this.aborted = false
    this.ended = false
    this.settled = false
    this.errorEmitted = false
    this.responseEmitted = false
    this.responseEnded = false
    this.idleMs = 0
    this.idleCallback = null
    this.idleTimer = null
    if (slot) {
      acquire(slot, this.grant)
    } else {
      this.onGranted()
    }
  }

  onGranted () {
    this.granted = true
    process.nextTick(() => this.announce())
    if (this.started) {
      this.fetch(this.waitingBody)
    }
  }

  leaveSlot () {
    if (!this.slot) {
      return
    }
    if (this.granted) {
      release(this.slot)
    } else {
      forget(this.slot, this.grant)
    }
    this.slot = null
  }

  get finished () {
    return this.ended
  }

  get writableFinished () {
    return this.ended
  }

  announce () {
    if (this.aborted || this.errorEmitted) {
      return
    }
    this.emit('connecting', this.connection, undefined)
    this.connection.emit('lookup')
    this.connection.emit('connect')
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
      this.emit(name, ...args)
    })
  }

  settle () {
    this.settled = true
    this.clearIdle()
    this.leaveSlot()
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
    this.headers = withoutHeader(this.headers, name)
  }

  createUpload () {
    const exchange = this
    const strategy = new ByteLengthQueuingStrategy({highWaterMark: UPLOAD_HIGH_WATER_MARK})
    let controller = null
    const stream = new ReadableStream({
      start (streamController) {
        controller = streamController
      },
      pull () {
        if (exchange.uploadWaits) {
          exchange.uploadWaits = false
          exchange.emitLater('drain')
        }
      },
      cancel () {
        exchange.upload = null
      }
    }, strategy)
    this.upload = controller
    return stream
  }

  start (body) {
    this.started = true
    if (this.granted) {
      this.fetch(body)
    } else {
      this.waitingBody = body
    }
  }

  fetch (body) {
    if (this.aborted || this.settled) {
      return
    }
    const init = {method: this.method, headers: this.headers, redirect: 'manual', timeout: null, signal: this.controller.signal}
    if (body !== undefined) {
      init.body = body
    }
    let pending
    try {
      pending = this.impit.fetch(this.url, init)
    } catch (err) {
      return this.fail(err)
    }
    Promise.resolve(pending).then(response => this.onResponse(response), err => this.fail(err))
  }

  refusesBody (bytes) {
    if (BODILESS_METHODS.indexOf(this.method) === -1) {
      return false
    }
    if (bytes.length) {
      this.fail(notSupported('body', 'impit sends no body with ' + this.method))
    }
    return true
  }

  enqueue (bytes) {
    if (!this.upload) {
      return false
    }
    try {
      this.upload.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    } catch (closed) {
      return false
    }
    if (this.upload.desiredSize > 0) {
      return true
    }
    this.uploadWaits = true
    return false
  }

  write (chunk, encoding, callback) {
    if (this.aborted || this.ended || this.settled) {
      return false
    }
    const bytes = toBytes(chunk, encoding)
    if (this.refusesBody(bytes)) {
      return bytes.length === 0
    }
    if (!this.started) {
      this.start(this.createUpload())
    }
    this.touch()
    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') {
      process.nextTick(done)
    }
    return this.enqueue(bytes)
  }

  end (chunk, encoding, callback) {
    if (this.aborted || this.ended) {
      return this
    }
    const given = chunk !== undefined && chunk !== null && typeof chunk !== 'function' ? toBytes(chunk, encoding) : undefined
    const last = given !== undefined && this.refusesBody(given) ? undefined : given
    if (this.settled) {
      return this
    }
    this.ended = true
    if (!this.started) {
      this.start(last)
    } else {
      if (last !== undefined) {
        this.enqueue(last)
      }
      this.closeUpload()
    }
    this.touch()
    const done = [chunk, encoding, callback].find(argument => typeof argument === 'function')
    if (done) {
      process.nextTick(done)
    }
    return this
  }

  closeUpload () {
    if (this.upload) {
      try {
        this.upload.close()
      } catch (closed) {}
      this.upload = null
    }
  }

  failUpload (err) {
    if (this.upload) {
      try {
        this.upload.error(err)
      } catch (closed) {}
      this.upload = null
    }
  }

  abort () {
    if (this.aborted) {
      return
    }
    this.aborted = true
    this.settle()
    this.failUpload(abortError())
    this.controller.abort()
    if (this.reader) {
      this.reader.cancel().catch(ignore)
    }
    if (this.response && !this.responseEnded) {
      this.response.destroy()
    }
  }

  fail (err) {
    if (this.aborted || this.settled) {
      return
    }
    this.settle()
    this.failUpload(err)
    this.emitLater('error', toNodeError(err, 'request', this.tunnelled, this.lookupHost))
  }

  failResponse (err) {
    if (this.aborted || this.responseEnded) {
      return
    }
    this.responseEnded = true
    this.settle()
    const response = this.response
    process.nextTick(() => {
      response.aborted = true
      response.emit('aborted')
      response.destroy(toNodeError(err, 'response', this.tunnelled))
    })
  }

  finishResponse () {
    this.responseEnded = true
    this.settle()
    this.response.complete = true
    this.response.push(null)
  }

  readAhead (response) {
    const announce = () => {
      clearTimeout(patience)
      this.emitLater('response', response)
    }
    const patience = setTimeout(announce, READ_AHEAD_PATIENCE)
    let buffered = 0
    const readOn = () => {
      this.readingAhead = true
      this.reader.read().then(result => {
        this.readingAhead = false
        if (this.aborted || this.responseEnded) {
          return clearTimeout(patience)
        }
        this.touch()
        if (result.done) {
          this.readAheadEnded = true
        } else {
          this.readAheadChunks.push(toChunk(result.value))
          buffered += result.value.byteLength
        }
        if (this.responseEmitted) {
          return this.pump()
        }
        if (result.done || buffered >= READ_AHEAD_LIMIT) {
          return announce()
        }
        readOn()
      }, err => {
        this.readingAhead = false
        announce()
        this.failResponse(err)
      })
    }
    readOn()
  }

  pump () {
    if (this.pumping || this.readingAhead || this.responseEnded || this.aborted) {
      return
    }
    while (this.readAheadChunks.length) {
      if (!this.response.push(this.readAheadChunks.shift())) {
        return
      }
    }
    if (this.readAheadEnded) {
      return this.finishResponse()
    }
    this.pumping = true
    this.reader.read().then(result => {
      this.pumping = false
      if (this.aborted || this.responseEnded) {
        return
      }
      this.touch()
      if (result.done) {
        return this.finishResponse()
      }
      if (this.response.push(toChunk(result.value))) {
        this.pump()
      }
    }, err => {
      this.pumping = false
      this.failResponse(err)
    })
  }

  onResponse (fetched) {
    if (this.aborted || this.settled) {
      if (fetched && fetched.body) {
        fetched.body.cancel().catch(ignore)
      }
      return
    }
    this.touch()
    const exchange = this
    const parsed = incoming(fetched, this.method)
    this.reader = fetched.body.getReader()
    const response = new Readable({
      read () {
        exchange.pump()
      },
      destroy (err, callback) {
        if (!exchange.responseEnded && !exchange.aborted) {
          exchange.responseEnded = true
          exchange.settle()
          exchange.controller.abort()
          exchange.reader.cancel().catch(ignore)
        }
        callback(err)
      }
    })
    response.statusCode = fetched.status
    response.statusMessage = fetched.statusText || ''
    response.httpVersion = '1.1'
    response.httpVersionMajor = 1
    response.httpVersionMinor = 1
    response.headers = parsed.headers
    response.rawHeaders = parsed.rawHeaders
    response.trailers = {}
    response.rawTrailers = []
    response.aborted = false
    response.complete = false
    this.response = response
    if (isDiscardedByTheCore(fetched.status)) {
      this.readAhead(response)
    } else {
      this.emitLater('response', response)
    }
  }
}

module.exports = {Exchange}

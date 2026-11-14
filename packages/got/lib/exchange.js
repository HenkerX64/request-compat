'use strict'

const {EventEmitter} = require('events')
const {Readable} = require('stream')
const {forcedOptions, hopOptionRefusal, hookListRefusal, requestFunctionRefusal, gotHeaders, headerChanges, unwrap} = require('./got-options')
const {notSupported} = require('./errors')

const GOT_RESPONSE_FIELDS = ['timings']
const SOCKET_HANDOVER_EVENTS = ['upgrade', 'connect']
const HELD_RESPONSE_EVENTS = ['aborted', 'error', 'close']

function responseForGot (response) {
  const copy = new Readable({read () {}})
  copy.statusCode = response.statusCode
  copy.statusMessage = response.statusMessage
  copy.httpVersion = response.httpVersion
  copy.headers = Object.assign({}, response.headers)
  copy.rawHeaders = response.rawHeaders.slice()
  Object.defineProperty(copy, 'complete', {get: () => response.complete})
  return copy
}

function discardBuffered (response) {
  let chunk = response.read()
  while (chunk !== null) {
    chunk = response.read()
  }
}

function endWith (response, copy) {
  response.once('end', () => {
    copy.push(null)
    copy.read(0)
  })
  response.once('aborted', () => copy.emit('aborted'))
}

class Exchange extends EventEmitter {
  constructor (instance, native, method, url, headers) {
    super()
    this.native = native
    this.method = method
    this.url = url
    this.given = gotHeaders(headers)
    this.hookHeaders = null
    this.socket = null
    this.aborted = false
    this.ended = false
    this.errored = false
    this.nativeError = null
    this.nativeResponse = null
    this.heldResponse = null
    this.gotResponseListeners = null
    this.gotResponse = null
    this.responded = false
    this.errorsAfterResponse = []
    this.handedOver = false
    this.nativeResponseListener = response => this.receiveResponse(response)
    this.listenToNative()
    const handOver = () => this.handOver()
    this.expected = {method, url, request: handOver, instanceOptions: instance.defaults.options}
    this.lastHook = options => this.checkHooks(options)
    const options = Object.assign(forcedOptions(method, Object.assign({}, this.given)), {request: handOver, hooks: {beforeRequest: [this.lastHook]}})
    this.stream = instance.stream(url, options)
    this.stream.on('error', err => this.onStreamError(err))
    this.stream.on('response', response => this.onStreamResponse(response))
    this.stream.on('drain', () => this.emit('drain'))
    this.stream.on('request', () => this.dropSocketHandovers())
    if (this.stream.options && this.stream.options.request !== handOver) {
      process.nextTick(() => this.onStreamError(requestFunctionRefusal()))
    }
  }

  dropSocketHandovers () {
    SOCKET_HANDOVER_EVENTS.forEach(name => this.native.removeAllListeners(name))
  }

  get finished () {
    return this.ended
  }

  get writableFinished () {
    return this.native.writableFinished
  }

  listenToNative () {
    const native = this.native
    native.on('socket', socket => {
      this.socket = socket
      if (socket._connecting || socket.connecting) {
        this.emit('connecting', socket, socket)
      } else {
        this.emit('reused', socket)
      }
    })
    native.on('error', err => this.onNativeError(err))
    native.on('response', this.nativeResponseListener)
  }

  checkHooks (options) {
    const refusal = hopOptionRefusal(options, this.expected)
    if (refusal) {
      throw refusal
    }
    this.hookHeaders = Object.assign({}, options.getInternalHeaders())
  }

  onNativeError (err) {
    if (!this.nativeError) {
      this.nativeError = err
    }
    if (this.nativeResponse) {
      this.errorsAfterResponse.push(err)
      process.nextTick(() => this.emitErrorsAfterResponse())
    }
  }

  emitErrorsAfterResponse () {
    if (!this.responded) {
      return
    }
    this.errorsAfterResponse.splice(0).forEach(err => {
      if (!this.aborted && !this.errored) {
        this.emit('error', err)
      }
    })
  }

  handOver () {
    if (this.nativeError && !this.nativeResponse) {
      throw this.nativeError
    }
    const hooks = this.stream.options.hooks.beforeRequest
    if (!this.hookHeaders || hooks[hooks.length - 1] !== this.lastHook) {
      throw hookListRefusal()
    }
    this.applyHeaderChanges(headerChanges(this.given, this.hookHeaders))
    this.handedOver = true
    process.nextTick(() => this.takeGotResponseListeners())
    return this.native
  }

  takeGotResponseListeners () {
    const native = this.native
    const listeners = native.listeners('response')
    this.gotResponseListeners = listeners.slice(listeners.indexOf(this.nativeResponseListener) + 1)
    this.gotResponseListeners.forEach(listener => native.removeListener('response', listener))
    if (this.nativeResponse) {
      this.deliverResponse()
    }
  }

  applyHeaderChanges (changes) {
    const native = this.native
    const names = native.getRawHeaderNames()
    changes.forEach(change => {
      const existing = names.filter(name => name.toLowerCase() === change.name)[0]
      if (change.remove) {
        native.removeHeader(change.name)
      } else {
        native.setHeader(existing || change.name, change.value)
      }
    })
  }

  receiveResponse (response) {
    if (this.nativeResponse) {
      return
    }
    this.nativeResponse = response
    if (this.gotResponseListeners) {
      this.deliverResponse()
    } else {
      this.holdResponse(response)
    }
  }

  holdResponse (response) {
    const held = {events: [], listeners: {}}
    HELD_RESPONSE_EVENTS.forEach(name => {
      held.listeners[name] = value => held.events.push({name, value})
      response.on(name, held.listeners[name])
    })
    this.heldResponse = held
  }

  releaseResponse (response) {
    const held = this.heldResponse
    if (!held) {
      return null
    }
    this.heldResponse = null
    HELD_RESPONSE_EVENTS.forEach(name => response.removeListener(name, held.listeners[name]))
    return held.events
  }

  deliverResponse () {
    if (this.aborted || this.errored || this.responded) {
      return
    }
    const response = this.nativeResponse
    const missed = this.releaseResponse(response)
    GOT_RESPONSE_FIELDS.forEach(name => {
      delete response[name]
    })
    this.responded = true
    if (missed) {
      this.emitHeldResponse(response)
      process.nextTick(() => this.replayMissed(response, missed))
    } else {
      this.emit('response', response)
    }
    this.notifyGot(response, missed || [])
    this.emitErrorsAfterResponse()
  }

  emitHeldResponse (response) {
    const dropBufferedBody = () => discardBuffered(response)
    response.once('aborted', dropBufferedBody)
    this.emit('response', response)
    response.removeListener('aborted', dropBufferedBody)
  }

  replayMissed (response, missed) {
    if (this.aborted) {
      return
    }
    missed.forEach(event => {
      if (event.name !== 'error') {
        response.emit(event.name)
      } else if (response.listenerCount('error') > 0) {
        response.emit('error', event.value)
      }
    })
  }

  notifyGot (response, missed) {
    const listeners = this.gotResponseListeners
    if (!listeners.length || this.aborted || this.stream.destroyed) {
      return
    }
    const copy = responseForGot(response)
    this.gotResponse = copy
    listeners.forEach(listener => listener.call(this.native, copy))
    if (missed.some(event => event.name === 'aborted')) {
      copy.emit('aborted')
    } else {
      endWith(response, copy)
    }
  }

  onStreamResponse (response) {
    if (response === this.gotResponse || this.aborted || this.errored || this.responded) {
      return
    }
    this.onStreamError(notSupported('got.hooks.beforeRequest', 'a hook returned a response'))
  }

  onStreamError (err) {
    if (this.aborted || this.responded || this.errored) {
      return
    }
    this.errored = true
    if (!this.native.destroyed) {
      this.native.destroy()
    }
    if (!this.stream.destroyed) {
      this.stream.destroy()
    }
    this.emit('error', unwrap(err))
  }

  setTimeout (ms, callback) {
    this.native.setTimeout(ms, callback)
    return this
  }

  removeHeader (name) {
    const lower = String(name).toLowerCase()
    this.native.removeHeader(name)
    delete this.given[lower]
    if (this.hookHeaders) {
      delete this.hookHeaders[lower]
    }
    if (this.stream.options && !this.handedOver) {
      this.stream.options.deleteInternalHeader(lower)
    }
  }

  write (chunk, encoding, callback) {
    if (this.aborted || this.ended || this.stream.destroyed) {
      return false
    }
    return this.stream.write(chunk, encoding, callback)
  }

  end (chunk, encoding, callback) {
    if (this.aborted || this.ended) {
      return this
    }
    this.ended = true
    if (!this.stream.destroyed && !this.stream.writableEnded) {
      this.stream.end(chunk, encoding, callback)
    }
    return this
  }

  abort () {
    if (this.aborted) {
      return
    }
    this.aborted = true
    this.native.abort()
    if (this.responded) {
      discardBuffered(this.nativeResponse)
    }
    if (!this.stream.destroyed) {
      this.stream.destroy()
    }
  }
}

function createExchange (instance, native, method, url, headers) {
  return new Exchange(instance, native, method, url, headers)
}

module.exports = {createExchange}

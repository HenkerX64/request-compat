'use strict'

const {notSupported} = require('./errors')
const {isTunnel, globalAgentOf, CALLER_POOL} = require('./options')

const callerPools = new WeakMap()
const sharedBuckets = new Map()

function given (value) {
  return value !== undefined
}

function configuredLimit (self) {
  if (self.pool === false || isTunnel(self)) {
    return null
  }
  const global = globalAgentOf(self)
  if (global) {
    return {option: global.name + '.maxSockets', value: global.agent.maxSockets}
  }
  if (self[CALLER_POOL] && self.pool.maxSockets) {
    return {option: 'pool.maxSockets', value: self.pool.maxSockets}
  }
  if (self.agentOptions && given(self.agentOptions.maxSockets)) {
    return {option: 'agentOptions.maxSockets', value: self.agentOptions.maxSockets}
  }
  return null
}

function limitOf (self) {
  const configured = configuredLimit(self)
  if (!configured || !configured.value || configured.value === Infinity) {
    return null
  }
  const limit = Number(configured.value)
  if (!(limit >= 1)) {
    throw notSupported(configured.option, 'Node opens no connection with this limit')
  }
  return Math.floor(limit)
}

function bucketsOf (self) {
  if (!self[CALLER_POOL]) {
    return sharedBuckets
  }
  if (!callerPools.has(self.pool)) {
    callerPools.set(self.pool, new Map())
  }
  return callerPools.get(self.pool)
}

function slotFor (self) {
  const limit = limitOf(self)
  if (limit === null) {
    return null
  }
  const buckets = bucketsOf(self)
  const key = self.uri.protocol + '//' + self.uri.hostname + ':' + self.uri.port + '|' + limit
  if (!buckets.has(key)) {
    buckets.set(key, {limit, active: 0, waiting: [], key, buckets})
  }
  return buckets.get(key)
}

function acquire (bucket, granted) {
  if (bucket.active < bucket.limit) {
    bucket.active++
    granted()
  } else {
    bucket.waiting.push(granted)
  }
}

function forget (bucket, granted) {
  const position = bucket.waiting.indexOf(granted)
  if (position !== -1) {
    bucket.waiting.splice(position, 1)
  }
}

function release (bucket) {
  const next = bucket.waiting.shift()
  if (next) {
    next()
    return
  }
  bucket.active--
  if (bucket.active === 0) {
    bucket.buckets.delete(bucket.key)
  }
}

module.exports = {slotFor, acquire, forget, release}

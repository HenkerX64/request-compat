'use strict'

const fs = require('fs')
const http = require('http')
const https = require('https')
const Module = require('module')
const path = require('path')

const repo = path.resolve(__dirname, '..', '..', '..')
const coreIndex = path.join(repo, 'index.js')
const coreRequest = path.join(repo, 'request.js')
const engineIndex = path.join(repo, 'packages', 'impit', 'index.js')
const coreTests = path.join(repo, 'tests') + path.sep
const testName = process.argv[1] ? path.basename(process.argv[1]) : 'unknown'
const message = 'request-compat-impit: the core reached the Node transport'

function reachedNode () {
  if (process.env.IMPIT_FALLBACK_LOG) {
    fs.appendFileSync(process.env.IMPIT_FALLBACK_LOG, testName + '\n')
  }
  throw new Error(message)
}

const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, parent) {
  const resolved = resolveFilename.apply(this, arguments)
  if (resolved === coreIndex && parent && typeof parent.filename === 'string' && parent.filename.indexOf(coreTests) === 0) {
    return engineIndex
  }
  return resolved
}

const nodeTransport = require(path.join(repo, 'lib', 'transport')).node
Object.keys(nodeTransport).forEach(name => {
  nodeTransport[name] = reachedNode
})

;[http, https].forEach(module => {
  ;['request', 'get'].forEach(name => {
    const original = module[name]
    module[name] = function () {
      if (new Error().stack.indexOf(coreRequest) !== -1) {
        reachedNode()
      }
      return original.apply(this, arguments)
    }
  })
})

const tapePath = require.resolve('tape', {paths: [path.join(repo, 'tests')]})
const tape = require(tapePath)
const skipped = (process.env.IMPIT_SKIP_TESTS || '').split('\n').filter(Boolean)
function wrappedTape (name) {
  if (typeof name === 'string' && skipped.indexOf(name) !== -1) {
    return tape.skip.apply(tape, arguments)
  }
  return tape.apply(this, arguments)
}
Object.keys(tape).forEach(key => { wrappedTape[key] = tape[key] })
require.cache[tapePath].exports = wrappedTape

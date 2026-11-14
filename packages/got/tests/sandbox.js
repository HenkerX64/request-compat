'use strict'

const fs = require('fs')
const Module = require('module')
const path = require('path')
const {fileURLToPath} = require('url')
const vm = require('vm')

const SHARED_GLOBALS = [
  'process', 'Buffer', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'clearImmediate', 'queueMicrotask', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
  'AbortSignal', 'EventTarget', 'Event', 'structuredClone'
]
const WRAPPER_PARAMETERS = ['exports', 'require', 'module', '__filename', '__dirname']

function createSandbox () {
  const sandbox = {}
  SHARED_GLOBALS.forEach(name => {
    sandbox[name] = global[name]
  })
  const context = vm.createContext(sandbox)
  sandbox.global = vm.runInContext('this', context)
  const cache = new Map()
  const sandboxModule = {
    builtinModules: Module.builtinModules,
    isBuiltin: Module.isBuiltin,
    createRequire: from => requireFrom(String(from).indexOf('file:') === 0 ? fileURLToPath(from) : String(from))
  }

  function load (filename) {
    if (cache.has(filename)) {
      return cache.get(filename).exports
    }
    const module = {id: filename, filename, exports: {}, loaded: false}
    cache.set(filename, module)
    const source = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')
    if (path.extname(filename) === '.json') {
      module.exports = JSON.parse(source)
    } else {
      const compiled = vm.compileFunction(source, WRAPPER_PARAMETERS, {filename, parsingContext: context})
      compiled.call(module.exports, module.exports, requireFrom(filename), module, filename, path.dirname(filename))
    }
    module.loaded = true
    return module.exports
  }

  function requireFrom (filename) {
    const nativeRequire = Module.createRequire(filename)
    const sandboxRequire = id => {
      if (Module.isBuiltin(id)) {
        return id === 'module' || id === 'node:module' ? sandboxModule : nativeRequire(id)
      }
      return load(nativeRequire.resolve(id))
    }
    sandboxRequire.resolve = (id, options) => nativeRequire.resolve(id, options)
    return sandboxRequire
  }

  return {require: requireFrom(__filename)}
}

module.exports = {createSandbox}

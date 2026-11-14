'use strict'

const workerThreads = require('worker_threads')
const {notSupported} = require('./errors')

const MAXIMUM_INSTANCES = 64
const PROXY_VARIABLES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const PROXY_SWITCHES = ['NO_PROXY', 'no_proxy']
const instances = new Map()

function libraryOptions (config) {
  const options = {followRedirects: false, timeout: null}
  if (config.browser !== undefined && config.browser !== null) {
    options.browser = config.browser
  }
  if (config.proxyUrl) {
    options.proxyUrl = config.proxyUrl
  }
  if (config.ignoreTlsErrors) {
    options.ignoreTlsErrors = true
  }
  if (config.localAddress) {
    options.localAddress = config.localAddress
  }
  return options
}

function withoutProxyEnvironment (create) {
  const hidden = {}
  PROXY_VARIABLES.forEach(name => {
    if (process.env[name] !== undefined) {
      hidden[name] = process.env[name]
      delete process.env[name]
    }
  })
  try {
    return create()
  } finally {
    Object.keys(hidden).forEach(name => {
      process.env[name] = hidden[name]
    })
  }
}

function proxyVariableOf (environment) {
  const names = PROXY_VARIABLES.filter(name => PROXY_SWITCHES.indexOf(name) === -1)
  return names.find(name => environment[name]) || null
}

function withReportSetting (name, value, read) {
  const report = process.report
  if (!(name in report)) {
    return read()
  }
  const previous = report[name]
  report[name] = value
  try {
    return read()
  } finally {
    report[name] = previous
  }
}

function environmentOfTheProcess () {
  try {
    const withEnvironment = () => withReportSetting('excludeEnv', false, () => process.report.getReport())
    const report = withReportSetting('excludeNetwork', true, withEnvironment)
    return report.environmentVariables || null
  } catch (err) {
    return null
  }
}

function refuseProxyOfTheProcess () {
  const environment = environmentOfTheProcess()
  if (!environment) {
    throw notSupported('proxy', 'a worker thread cannot tell whether the process has a proxy variable, which impit would apply itself; pass proxy, or impit with your own instance')
  }
  const name = proxyVariableOf(environment)
  if (name) {
    throw notSupported('proxy', 'impit applies ' + name + ' of the process itself and a worker thread with its own environment cannot hide it; pass proxy, start the worker with env: SHARE_ENV, or pass impit with your own instance')
  }
}

function createInstance (config) {
  const library = require('impit')
  const Impit = library.Impit
  return withoutProxyEnvironment(() => {
    if (!workerThreads.isMainThread && !config.proxyUrl) {
      refuseProxyOfTheProcess()
    }
    return new Impit(libraryOptions(config))
  })
}

function keyOf (config) {
  return JSON.stringify([config.browser, config.proxyUrl, Boolean(config.ignoreTlsErrors), config.localAddress])
}

function forgetOldest () {
  const oldest = instances.keys().next().value
  instances.delete(oldest)
}

function instanceFor (config) {
  if (config.oneOff) {
    return createInstance(config)
  }
  const key = keyOf(config)
  const known = instances.get(key)
  if (known) {
    instances.delete(key)
    instances.set(key, known)
    return known
  }
  const created = createInstance(config)
  if (instances.size >= MAXIMUM_INSTANCES) {
    forgetOldest()
  }
  instances.set(key, created)
  return created
}

function instanceCount () {
  return instances.size
}

module.exports = {instanceFor, instanceCount, keyOf, libraryOptions}

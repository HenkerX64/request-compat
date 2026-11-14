'use strict'

const {tunnel, prepare, verifyResponse, isolateTlsSession} = require('./agents')
const {instanceOf, gotUrl, connectionOptions} = require('./got-options')
const {createExchange} = require('./exchange')

function withConnectionOptions (reqOptions, picked) {
  Object.keys(picked).forEach(name => {
    if (reqOptions[name] === undefined) {
      reqOptions[name] = picked[name]
    }
  })
}

function send (self, reqOptions) {
  const instance = instanceOf(self)
  const url = gotUrl(self)
  withConnectionOptions(reqOptions, connectionOptions(instance, url))
  isolateTlsSession(self, reqOptions)
  const native = self.httpModule.request(reqOptions)
  return createExchange(instance, native, String(reqOptions.method || 'GET').toUpperCase(), url, reqOptions.headers)
}

module.exports = {tunnel, prepare, send, verifyResponse}

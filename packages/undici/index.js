'use strict'

const {nodeVersionError} = require('./lib/errors')

const unsupported = nodeVersionError(process.versions.node)
if (unsupported) {
  throw unsupported
}

const createApi = require('request-compat/lib/api')
const transport = require('./lib/transport')

module.exports = createApi(transport)

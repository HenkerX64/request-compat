'use strict'

const target = process.env.PARITY_TARGET
if (!target) {
  throw new Error('PARITY_TARGET is not set: run the suite through tests/parity/run.js')
}

const candidate = require.resolve('request-promise-native', {paths: [target]})
const candidateErrors = require.resolve('request-promise-native/errors', {paths: [target]})

const clients = [
  {
    name: 'request-promise-native',
    rp: require('request-promise-native'),
    errors: require('request-promise-native/errors')
  },
  {
    name: 'request-got-adapter',
    rp: require(candidate),
    errors: require(candidateErrors)
  }
]

module.exports = {clients}

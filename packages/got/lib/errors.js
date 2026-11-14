'use strict'

const MINIMUM_NODE = [22, 12]

function nodeVersionError (version) {
  const [major, minor] = version.split('.').map(Number)
  if (major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1])) {
    return null
  }
  const err = new Error('request-compat-got needs Node >= ' + MINIMUM_NODE.join('.'))
  err.code = 'NODE_VERSION_NOT_SUPPORTED'
  return err
}

function notSupported (option, reason) {
  const err = new Error('request-compat-got does not support the option ' + option + (reason ? ': ' + reason : ''))
  err.code = 'OPTION_NOT_SUPPORTED'
  err.option = option
  return err
}

function invalidGotInstance () {
  const err = new TypeError('request-compat-got: the option got needs a got instance, such as got.extend(...) of got 16')
  err.code = 'INVALID_GOT_INSTANCE'
  return err
}

module.exports = {nodeVersionError, notSupported, invalidGotInstance}

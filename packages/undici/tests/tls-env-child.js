'use strict'

const fs = require('fs')
const https = require('https')
const path = require('path')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {closeAll} = require('../lib/dispatchers')

const SELF_SIGNED = 'DEPTH_ZERO_SELF_SIGNED_CERT'

const CASES = [
  {name: 'no TLS option', options: () => ({}), expect: 200},
  {name: 'pool false', options: () => ({pool: false}), expect: 200},
  {name: 'agentOptions without rejectUnauthorized', options: () => ({agentOptions: {keepAlive: true}}), expect: 200},
  {name: 'strictSSL true', options: () => ({strictSSL: true}), expect: 'SSL Error: ' + SELF_SIGNED},
  {name: 'rejectUnauthorized true', options: () => ({rejectUnauthorized: true}), expect: SELF_SIGNED},
  {name: 'strictSSL 1', options: () => ({strictSSL: 1}), expect: 'SSL Error: ' + SELF_SIGNED},
  {name: 'agentOptions with rejectUnauthorized undefined', options: () => ({pool: {}, agentOptions: {rejectUnauthorized: undefined}}), expect: SELF_SIGNED},
  {
    name: 'agentOptions with rejectUnauthorized undefined and a checkServerIdentity',
    options: () => ({pool: {}, agentOptions: {rejectUnauthorized: undefined, checkServerIdentity: () => undefined}}),
    expect: SELF_SIGNED
  },
  {
    name: 'own check and agentOptions with rejectUnauthorized undefined',
    options: () => ({pool: {}, checkServerIdentity: () => undefined, agentOptions: {rejectUnauthorized: undefined}}),
    expect: 200
  },
  {name: 'global rejectUnauthorized undefined', options: () => ({}), global: {rejectUnauthorized: undefined}, expect: SELF_SIGNED},
  {name: 'global rejectUnauthorized null', options: () => ({}), global: {rejectUnauthorized: null}, expect: SELF_SIGNED}
]

module.exports = CASES

function withGlobalOptions (values, fn, cb) {
  const options = https.globalAgent.options
  const names = Object.keys(values || {})
  names.forEach(name => {
    options[name] = values[name]
  })
  fn(() => {
    names.forEach(name => {
      delete options[name]
    })
    https.globalAgent.destroy()
    closeAll().then(cb)
  })
}

function run (server, api, options, cb) {
  api(Object.assign({url: 'https://localhost:' + server.address().port + '/'}, options), (error, response) => {
    cb({error: error ? error.code || error.message : null, status: response && response.statusCode})
  })
}

if (require.main === module) {
  const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
  const server = https.createServer({key: fs.readFileSync(path.join(ssl, 'self-signed.key')), cert: fs.readFileSync(path.join(ssl, 'self-signed.crt'))}, (req, res) => res.end('ok'))
  server.listen(0, () => {
    const results = []
    const next = () => {
      const entry = CASES[results.length]
      if (!entry) {
        process.stdout.write(JSON.stringify(results))
        return process.exit(0)
      }
      let node
      withGlobalOptions(entry.global, done => run(server, nodeApi, entry.options(), result => {
        node = result
        done()
      }), () => withGlobalOptions(entry.global, done => run(server, engineApi, entry.options(), engine => {
        results.push({node, engine})
        done()
      }), next))
    }
    next()
  })
}

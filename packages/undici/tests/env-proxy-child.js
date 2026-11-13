'use strict'

const http = require('http')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {closeAll} = require('../lib/dispatchers')

const url = process.argv[2]
const socketPath = process.argv[3]

const CASES = [
  {name: 'proxy: null', api: engineApi, options: {proxy: null}},
  {name: 'proxy: false', api: engineApi, options: {proxy: false}},
  {name: 'no proxy option', api: engineApi, options: {}},
  {name: 'pool: false, proxy: null', api: engineApi, options: {pool: false, proxy: null}},
  {name: 'Node transport, proxy: null', api: nodeApi, options: {proxy: null}},
  {name: 'unix socket, proxy: null', api: engineApi, options: {url: 'http://unix:' + socketPath + ':/unix', proxy: null}},
  {name: 'Node transport, unix socket, proxy: null', api: nodeApi, options: {url: 'http://unix:' + socketPath + ':/unix', proxy: null}}
]

function run (cases, results, cb) {
  const entry = cases.shift()
  if (!entry) {
    return cb(results)
  }
  entry.api(Object.assign({url}, entry.options), (err, res, body) => {
    results.push({name: entry.name, code: err ? err.code : null, option: err ? err.option : null, message: err ? err.message : null, body: body || null})
    run(cases, results, cb)
  })
}

const proxyEnv = http.globalAgent.options.proxyEnv
run(CASES.slice(), [], results => {
  process.stdout.write(JSON.stringify({proxyEnv: Boolean(proxyEnv) && typeof proxyEnv === 'object', results}))
  closeAll().then(() => process.exit(0))
})

'use strict'

const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {closeAll} = require('../lib/dispatchers')
const {connectProxy} = require('./proxy-servers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const read = (...parts) => fs.readFileSync(path.join(ssl, ...parts))
const trusted = {key: read('ca', 'localhost.key'), cert: read('ca', 'localhost.crt')}
const selfSigned = {key: read('self-signed.key'), cert: read('self-signed.crt')}
const PINNED = 'pinned by the global agent'
const SELF_SIGNED = 'DEPTH_ZERO_SELF_SIGNED_CERT'
const pin = () => ({checkServerIdentity: () => new Error(PINNED)})
const strict = () => ({rejectUnauthorized: true})

const CASES = [
  {name: 'forever, tunnelled first hop, https.globalAgent pins the proxy', forever: true, proxy: 'trusted', global: pin, expect: PINNED},
  {name: 'tunnelled first hop, https.globalAgent pins the proxy', proxy: 'trusted', global: pin, expect: PINNED},
  {
    name: 'forever, tunnelled first hop, NODE_TLS_REJECT_UNAUTHORIZED=0, https.globalAgent rejectUnauthorized true, self-signed proxy',
    forever: true,
    proxy: 'selfSigned',
    rejectUnauthorized: '0',
    global: strict,
    expect: SELF_SIGNED
  },
  {
    name: 'tunnelled first hop, NODE_TLS_REJECT_UNAUTHORIZED=0, https.globalAgent rejectUnauthorized true, self-signed proxy',
    proxy: 'selfSigned',
    rejectUnauthorized: '0',
    global: strict,
    expect: SELF_SIGNED
  },
  {name: 'forever, direct first hop, https.globalAgent pins', forever: true, global: pin, expect: 200},
  {name: 'direct first hop, https.globalAgent pins', global: pin, expect: PINNED}
]

function withGlobalOptions (values, fn) {
  const options = https.globalAgent.options
  Object.keys(values).forEach(name => {
    options[name] = values[name]
  })
  fn(() => Object.keys(values).forEach(name => {
    delete options[name]
  }))
}

function run (api, entry, servers, cb) {
  const options = {url: 'https://localhost:' + servers.first.address().port + '/'}
  if (entry.proxy) {
    options.proxy = 'https://user:secret@localhost:' + servers[entry.proxy].address().port
  }
  if (entry.forever) {
    options.forever = true
  }
  const proxy = servers[entry.proxy]
  const forwarded = proxy ? proxy.forwarded.length : 0
  if (entry.rejectUnauthorized) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = entry.rejectUnauthorized
  }
  withGlobalOptions(entry.global(), restore => {
    api(options, (error, response, body) => {
      restore()
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      https.globalAgent.destroy()
      http.globalAgent.destroy()
      closeAll().then(() => cb({
        error: error ? error.code || error.message : null,
        status: response && response.statusCode,
        body,
        forwarded: proxy ? proxy.forwarded.length - forwarded : 0
      }))
    })
  })
}

const target = http.createServer((req, res) => res.end('target'))
const first = https.createServer(trusted, (req, res) => {
  res.writeHead(302, {location: 'http://localhost:' + target.address().port + '/'})
  res.end()
})
const proxies = {
  trusted: connectProxy({}, handler => https.createServer(trusted, handler)),
  selfSigned: connectProxy({}, handler => https.createServer(selfSigned, handler))
}
Object.keys(proxies).forEach(name => {
  const proxy = proxies[name]
  proxy.forwarded = []
  proxy.on('request', req => proxy.forwarded.push(req.url))
})
const servers = Object.assign({first}, proxies)
target.listen(0, () => first.listen(0, () => proxies.trusted.listen(0, () => proxies.selfSigned.listen(0, () => {
  const results = []
  const next = () => {
    const entry = CASES[results.length]
    if (!entry) {
      process.stdout.write(JSON.stringify(results))
      return process.exit(0)
    }
    run(nodeApi, entry, servers, node => run(engineApi, entry, servers, engine => {
      results.push({name: entry.name, expect: entry.expect, node, engine})
      next()
    }))
  }
  next()
}))))

'use strict'

const fs = require('fs')
const https = require('https')
const http = require('http')
const path = require('path')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {closeAll} = require('../lib/dispatchers')
const {connectProxy} = require('./proxy-servers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const trusted = {key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}
const ipCert = {key: fs.readFileSync(path.join(__dirname, 'fixtures', 'ip.key')), cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'ip.crt'))}

const CASES = [
  {name: 'https target through an https proxy', url: port => 'https://localhost:' + port.https + '/', options: {}},
  {name: 'http target through an https proxy', url: port => 'http://localhost:' + port.http + '/', options: {}},
  {name: 'https proxy by IP address, target by name', url: port => 'https://localhost:' + port.https + '/', proxy: port => 'https://127.0.0.1:' + port.proxy, options: {}},
  {name: 'https target through an https proxy, pool false', url: port => 'https://localhost:' + port.https + '/', options: {pool: false}},
  {name: 'https proxy by IP address, target by IP address', url: port => 'http://127.0.0.1:' + port.http + '/', proxy: port => 'https://127.0.0.1:' + port.ipProxy, options: {}},
  {
    name: 'https proxy whose certificate names another host, after NODE_TLS_REJECT_UNAUTHORIZED=0 is unset',
    url: port => 'http://localhost:' + port.http + '/',
    proxy: port => 'https://localhost:' + port.ipProxy,
    options: {},
    rejectUnauthorized: ['0', undefined, undefined],
    expect: [200, 'rejected', 'rejected']
  }
]

const sni = []

function setRejectUnauthorized (value) {
  if (value === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = value
  }
}

function run (api, entry, ports, cb) {
  const options = Object.assign({url: entry.url(ports), proxy: entry.proxy ? entry.proxy(ports) : 'https://localhost:' + ports.proxy, tunnel: true}, entry.options)
  sni.length = 0
  api(options, (error, response, body) => cb({
    error: error ? error.code || error.message : null,
    message: error ? error.message : null,
    status: response && response.statusCode,
    body,
    sni: sni.slice()
  }))
}

function sequence (api, entry, ports, cb) {
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const values = entry.rejectUnauthorized || [saved]
  const outcomes = []
  const next = () => {
    if (outcomes.length === values.length) {
      setRejectUnauthorized(saved)
      return cb(outcomes)
    }
    setRejectUnauthorized(values[outcomes.length])
    run(api, entry, ports, outcome => {
      outcomes.push(outcome)
      setTimeout(next, 20)
    })
  }
  next()
}

const secure = https.createServer(trusted, (req, res) => res.end('secure'))
const plain = http.createServer((req, res) => res.end('plain'))
const proxy = connectProxy({}, handler => https.createServer(trusted, handler))
const ipProxy = connectProxy({}, handler => https.createServer(ipCert, handler))
;[proxy, ipProxy].forEach(server => server.on('secureConnection', socket => sni.push(socket.servername)))
secure.listen(0, () => plain.listen(0, () => proxy.listen(0, () => ipProxy.listen(0, () => {
  const ports = {https: secure.address().port, http: plain.address().port, proxy: proxy.address().port, ipProxy: ipProxy.address().port}
  const results = []
  const next = () => {
    const entry = CASES[results.length]
    if (!entry) {
      process.stdout.write(JSON.stringify(results))
      return process.exit(0)
    }
    sequence(nodeApi, entry, ports, node => {
      https.globalAgent.destroy()
      sequence(engineApi, entry, ports, engine => {
        results.push({name: entry.name, expect: entry.expect || [200], node, engine})
        closeAll().then(next)
      })
    })
  }
  next()
}))))

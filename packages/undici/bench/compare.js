'use strict'

const http = require('http')
const os = require('os')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {closeAll} = require('../lib/dispatchers')

const BODY = Buffer.alloc(1024, 'x')
const WARM_UP = 1000
const REQUESTS = 20000
const CONCURRENCY = [1, 10, 50]
const TRANSPORTS = [['Node', nodeApi], ['undici', engineApi]]

function run (api, url, total, concurrency, cb) {
  const latencies = []
  let started = 0
  let finished = 0
  let failure = null
  const begin = process.hrtime.bigint()
  const next = () => {
    if (started === total) {
      return
    }
    started++
    const start = process.hrtime.bigint()
    api(url, (err, res, body) => {
      latencies.push(Number(process.hrtime.bigint() - start) / 1e6)
      if (!failure && (err || res.statusCode !== 200 || body.length !== BODY.length)) {
        failure = err || new Error('unexpected response ' + res.statusCode + ' with ' + body.length + ' bytes')
      }
      finished++
      if (finished === total) {
        return cb(failure, {seconds: Number(process.hrtime.bigint() - begin) / 1e9, latencies})
      }
      next()
    })
  }
  for (let i = 0; i < concurrency; i++) {
    next()
  }
}

function percentile (sorted, share) {
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]
}

function summary (result) {
  const sorted = result.latencies.slice().sort((a, b) => a - b)
  return {rate: result.latencies.length / result.seconds, p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99)}
}

function pad (text, width) {
  return (String(text) + ' '.repeat(width)).slice(0, width)
}

function main (server) {
  const url = 'http://localhost:' + server.address().port + '/'
  const rows = []
  const steps = []
  TRANSPORTS.forEach(([name, api]) => steps.push(cb => run(api, url, WARM_UP, 10, cb)))
  CONCURRENCY.forEach(concurrency => TRANSPORTS.forEach(([name, api]) => steps.push(cb => run(api, url, REQUESTS, concurrency, (err, result) => {
    if (!err) {
      rows.push(Object.assign({name, concurrency}, summary(result)))
    }
    cb(err)
  }))))
  const next = err => {
    if (err) {
      throw err
    }
    const step = steps.shift()
    if (step) {
      return step(next)
    }
    report(rows)
    server.close()
    http.globalAgent.destroy()
    closeAll()
  }
  next()
}

function report (rows) {
  console.log('Node ' + process.version + ', undici ' + require('undici/package.json').version + ', ' + os.cpus().length + ' CPUs (' + os.cpus()[0].model + '), ' + os.platform() + ' ' + os.release())
  console.log(REQUESTS + ' requests of a ' + BODY.length + ' byte body after ' + WARM_UP + ' warm-up requests per transport')
  console.log('')
  console.log(pad('concurrency', 13) + pad('transport', 11) + pad('req/s', 10) + pad('p50 ms', 9) + pad('p99 ms', 9) + 'undici / Node')
  rows.forEach(row => {
    const node = rows.filter(other => other.concurrency === row.concurrency && other.name === 'Node')[0]
    const ratio = row.name === 'Node' ? '' : (row.rate / node.rate).toFixed(2) + 'x req/s'
    console.log(pad(row.concurrency, 13) + pad(row.name, 11) + pad(Math.round(row.rate), 10) + pad(row.p50.toFixed(2), 9) + pad(row.p99.toFixed(2), 9) + ratio)
  })
}

const server = http.createServer((req, res) => {
  res.setHeader('content-length', BODY.length)
  res.end(BODY)
})
server.listen(0, () => main(server))

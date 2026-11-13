'use strict'

const fs = require('fs')
const https = require('https')
const path = require('path')
const tls = require('tls')
const engineApi = require('../index')
const {cacheSize, closeAll, dispatcherFor} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))
const requests = Number(process.argv[2])
const parallel = Number(process.argv[3] || 1)
const server = https.createServer({key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}, (req, res) => res.end('ok'))

let connections = 0
let open = 0
let peak = 0
server.on('secureConnection', socket => {
  connections++
  open++
  peak = Math.max(peak, open)
  socket.on('close', () => open--)
})

function whenClosed (cb) {
  const start = Date.now()
  const poll = () => {
    if (open === 0 || Date.now() - start > 20000) {
      return cb()
    }
    setTimeout(poll, 50)
  }
  poll()
}

function collected (cb) {
  global.gc()
  setImmediate(() => {
    global.gc()
    setTimeout(() => cb(cacheSize()), 100)
  })
}

function report (nested) {
  collected(cached => {
    process.stdout.write(JSON.stringify({nested, connections, peak, open, cached}))
    closeAll().then(() => process.exit(0))
  })
}

for (let i = 0; i < 100; i++) {
  dispatcherFor({uri: {protocol: 'https:', hostname: 'localhost'}, ca: [new Map()]})
}

collected(nested => server.listen(0, () => {
  let started = 0
  let done = 0
  const next = () => {
    if (started === requests) {
      return
    }
    started++
    engineApi({url: 'https://localhost:' + server.address().port + '/', secureContext: tls.createSecureContext({ca: ca})}, (error, response) => {
      if (error || response.statusCode !== 200) {
        process.stdout.write(JSON.stringify({error: error ? error.code || error.message : response.statusCode}))
        return process.exit(1)
      }
      done++
      if (done === requests) {
        return whenClosed(() => setTimeout(report, 1000, nested))
      }
      next()
    })
  }
  for (let lane = 0; lane < parallel; lane++) {
    next()
  }
}))

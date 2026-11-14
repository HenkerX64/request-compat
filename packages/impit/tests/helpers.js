'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const tape = require('tape')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const trusted = {
  key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')),
  cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))
}
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))

function test (name, body) {
  tape(name, t => {
    body(t).then(() => t.end(), err => {
      t.fail(err && err.stack ? err.stack : String(err))
      t.end()
    })
  })
}

const connections = new WeakMap()

function listen (server, host) {
  const open = new Set()
  connections.set(server, open)
  server.on('connection', socket => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })
  return new Promise(resolve => server.listen(0, host || '127.0.0.1', () => resolve(server.address().port)))
}

function close (server) {
  return new Promise(resolve => {
    server.close(() => resolve())
    connections.get(server).forEach(socket => socket.destroy())
  })
}

function call (api, options) {
  return new Promise(resolve => {
    const created = {}
    created.request = api(options, (err, res, body) => setImmediate(() => resolve({err, res, body, request: created.request})))
  })
}

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function record (server, req, body) {
  server.seen.push({method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body, port: req.socket.remotePort})
}

function echoHandler (server, respond) {
  return (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      record(server, req, Buffer.concat(chunks))
      if (respond) {
        respond(req, res)
      } else {
        res.end('ok')
      }
    })
  }
}

function httpServer (respond) {
  const server = http.createServer()
  server.seen = []
  server.on('request', echoHandler(server, respond))
  return server
}

function httpsServer (respond) {
  const server = https.createServer(trusted)
  server.seen = []
  server.on('request', echoHandler(server, respond))
  return server
}

function rawServer (onData) {
  const server = net.createServer(socket => {
    socket.on('error', () => {})
    let received = ''
    socket.on('data', chunk => {
      received += chunk.toString('latin1')
      if (received.indexOf('\r\n\r\n') !== -1 && !socket.answered) {
        socket.answered = true
        server.requests.push(received)
        onData(socket, received)
      }
    })
  })
  server.requests = []
  return server
}

function inChildProcess (thread, cases, env, workerEnv) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'child-request.js')
    const options = {env: Object.assign({}, process.env, env), encoding: 'utf8', timeout: 30000}
    childProcess.execFile(process.execPath, [script, thread, JSON.stringify(cases), JSON.stringify(workerEnv || null)], options, (err, stdout) => {
      if (err) {
        return reject(err)
      }
      resolve(JSON.parse(stdout.trim().split('\n').pop()))
    })
  })
}

function headerLines (rawRequest) {
  return rawRequest.split('\r\n\r\n')[0].split('\r\n').slice(1)
}

module.exports = {test, listen, close, call, wait, httpServer, httpsServer, rawServer, headerLines, inChildProcess, trusted, ca, ssl}

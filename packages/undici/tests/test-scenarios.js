'use strict'

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')
const tape = require('tape')
const request = require('../index')
const {connectProxy} = require('./proxy-servers')
const {closeAll} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))
const trusted = {key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}

function listen (server, cb) {
  server.listen(0, () => cb(server.address().port))
}

function finish (t, servers) {
  servers.forEach(server => server.close())
  closeAll().then(() => t.end())
}

tape('POST with a json body', t => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({method: req.method, type: req.headers['content-type'], got: JSON.parse(body)}))
    })
  })
  listen(server, port => {
    request.post({url: 'http://localhost:' + port + '/x', json: {a: 1, b: ['x']}}, (err, res, body) => {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      t.deepEqual(body, {method: 'POST', type: 'application/json', got: {a: 1, b: ['x']}})
      finish(t, [server])
    })
  })
})

tape('a 5 MB file piped into a PUT arrives unchanged', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undici-scenario-'))
  const file = path.join(dir, 'upload.bin')
  const content = crypto.randomBytes(5 * 1024 * 1024)
  fs.writeFileSync(file, content)
  const server = http.createServer((req, res) => {
    const hash = crypto.createHash('sha1')
    let size = 0
    req.on('data', chunk => {
      hash.update(chunk)
      size += chunk.length
    })
    req.on('end', () => res.end(JSON.stringify({sha1: hash.digest('hex'), size, encoding: req.headers['transfer-encoding']})))
  })
  listen(server, port => {
    fs.createReadStream(file).pipe(request.put('http://localhost:' + port + '/upload', (err, res, body) => {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      t.deepEqual(JSON.parse(body), {sha1: crypto.createHash('sha1').update(content).digest('hex'), size: content.length, encoding: 'chunked'})
      fs.unlinkSync(file)
      fs.rmdirSync(dir)
      finish(t, [server])
    }))
  })
})

tape('https through a CONNECT proxy with credentials and a ca, and without the ca the certificate is refused', t => {
  const target = https.createServer(trusted, (req, res) => res.end('from the target, host ' + req.headers.host))
  const proxy = connectProxy()
  listen(target, port => listen(proxy, proxyPort => {
    const url = 'https://localhost:' + port + '/'
    request({url, ca, proxy: 'http://user:p%40ss@localhost:' + proxyPort}, (err, res, body) => {
      t.equal(err, null)
      t.equal(body, 'from the target, host localhost:' + port)
      t.equal(proxy.connects.length, 1)
      t.equal(proxy.connects[0].url, 'localhost:' + port)
      t.equal(proxy.connects[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('user:p@ss').toString('base64'))
      request({url, proxy: 'http://localhost:' + proxyPort}, (err, res) => {
        t.equal(err && err.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
        t.equal(res, undefined)
        finish(t, [target, proxy])
      })
    })
  }))
})

tape('a redirect to another host drops Cookie and Authorization and keeps other headers', t => {
  const seen = {}
  const second = http.createServer((req, res) => {
    seen.second = {cookie: req.headers.cookie, authorization: req.headers.authorization, keep: req.headers['x-keep']}
    res.end('landed')
  })
  const first = http.createServer((req, res) => {
    seen.first = {cookie: req.headers.cookie, authorization: req.headers.authorization}
    res.writeHead(302, {location: 'http://127.0.0.1:' + second.address().port + '/landing'})
    res.end()
  })
  listen(second, () => listen(first, port => {
    request({url: 'http://localhost:' + port + '/start', headers: {cookie: 'caller=1', authorization: 'Bearer SECRET', 'x-keep': 'k'}, followAllRedirects: true}, (err, res, body) => {
      t.equal(err, null)
      t.equal(body, 'landed')
      t.deepEqual(seen.first, {cookie: 'caller=1', authorization: 'Bearer SECRET'})
      t.deepEqual(seen.second, {cookie: undefined, authorization: undefined, keep: 'k'})
      finish(t, [first, second])
    })
  }))
})

tape('every request runs its own checkServerIdentity', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  const calls = {first: 0, second: 0}
  listen(server, port => {
    const url = 'https://localhost:' + port + '/'
    const pin = () => {
      calls.first++
      return new Error('pinned mismatch')
    }
    request({url, ca, checkServerIdentity: pin}, err => {
      t.equal(err && err.message, 'pinned mismatch')
      request({url, ca, checkServerIdentity: () => { calls.second++ }}, (err, res, body) => {
        t.equal(err, null)
        t.equal(body, 'ok')
        request({url, ca}, (err, res) => {
          t.equal(err, null)
          t.equal(res.statusCode, 200)
          t.deepEqual(calls, {first: 1, second: 1})
          finish(t, [server])
        })
      })
    })
  })
})

tape('timeout without response headers and in the middle of the body is ESOCKETTIMEDOUT', t => {
  const timers = []
  const slow = http.createServer((req, res) => timers.push(setTimeout(() => res.end('late'), 1500)))
  const midBody = http.createServer((req, res) => {
    res.write('a')
    timers.push(setTimeout(() => res.end('b'), 1500))
  })
  listen(slow, slowPort => listen(midBody, midBodyPort => {
    request({url: 'http://localhost:' + slowPort + '/', timeout: 300}, err => {
      t.deepEqual(err && {code: err.code, connect: err.connect}, {code: 'ESOCKETTIMEDOUT', connect: false}, 'no headers')
      request({url: 'http://localhost:' + midBodyPort + '/', timeout: 300}, err => {
        t.deepEqual(err && {code: err.code, connect: err.connect}, {code: 'ESOCKETTIMEDOUT', connect: false}, 'in the body')
        timers.forEach(clearTimeout)
        slow.closeAllConnections()
        midBody.closeAllConnections()
        finish(t, [slow, midBody])
      })
    })
  }))
})

tape('abort() after the response closes the connection and calls back nothing', t => {
  let closed = false
  const server = http.createServer((req, res) => {
    req.socket.on('close', () => { closed = true })
    res.write('x')
  })
  listen(server, port => {
    const counts = {callbacks: 0, responses: 0, aborts: 0, errors: 0}
    const r = request('http://localhost:' + port + '/', () => counts.callbacks++)
    r.on('response', () => {
      counts.responses++
      setTimeout(() => r.abort(), 50)
    })
    r.on('abort', () => counts.aborts++)
    r.on('error', () => counts.errors++)
    setTimeout(() => {
      t.deepEqual(counts, {callbacks: 0, responses: 1, aborts: 1, errors: 0})
      t.equal(closed, true, 'the server saw the connection close')
      finish(t, [server])
    }, 300)
  })
})

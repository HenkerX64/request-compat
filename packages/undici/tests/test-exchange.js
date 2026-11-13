'use strict'

const fs = require('fs')
const http = require('http')
const http2 = require('http2')
const https = require('https')
const net = require('net')
const os = require('os')
const path = require('path')
const tls = require('tls')
const tape = require('tape')
const {Agent} = require('undici')
const request = require('../index')
const nodeApi = require('request-compat')
const compare = require('./compare')
const {connectProxy} = require('./proxy-servers')
const {cacheSize, oneOffCount, agentOptions, tlsContext, closeAll} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))
const trusted = {key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}
const selfSigned = {key: fs.readFileSync(path.join(ssl, 'self-signed.key')), cert: fs.readFileSync(path.join(ssl, 'self-signed.crt'))}
const fixture = path.join(__dirname, '..', '..', '..', 'tests', 'googledoodle.jpg')

function listen (server, cb) {
  server.listen(0, () => cb(server.address().port))
}

function finish (t, servers) {
  [].concat(servers).forEach(server => server.close())
  t.end()
}

function sendDateOff (handler) {
  return (req, res) => {
    res.sendDate = false
    handler(req, res)
  }
}

function waitFor (condition, limit, cb) {
  const start = Date.now()
  const poll = () => {
    if (condition()) {
      return cb(true)
    }
    if (Date.now() - start > limit) {
      return cb(false)
    }
    setTimeout(poll, 5)
  }
  poll()
}

tape('GET and POST with a body', t => {
  const server = http.createServer(sendDateOff((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, {'Content-Type': 'text/plain', 'X-Mixed-Case': 'Value'})
      res.end('echo ' + Buffer.concat(chunks))
    })
  }))
  listen(server, () => {
    compare({url: '/get?a=1', headers: {'X-Custom': 'a', 'user-agent': 'compare'}}, server, (err, get) => {
      t.equal(err, null)
      t.equal(get.node.error, null)
      t.equal(get.engine.error, null)
      t.equal(get.engine.statusCode, 200)
      t.equal(get.engine.statusMessage, 'OK')
      t.equal(get.engine.httpVersion, '1.1')
      t.equal(get.engine.statusMessage, get.node.statusMessage)
      t.equal(get.engine.httpVersion, get.node.httpVersion)
      t.deepEqual(get.engine.rawHeaders, get.node.rawHeaders)
      t.deepEqual(get.engine.headers, get.node.headers)
      t.equal(get.engine.body, get.node.body)
      t.equal(compare.normalizeRequest(get.engine.bytes, true), compare.normalizeRequest(get.node.bytes, true))
      t.ok(/^GET \/get\?a=1 HTTP\/1\.1\r\n/.test(get.engine.bytes.toString()))
      t.ok(/\r\nX-Custom: a\r\n/.test(get.engine.bytes.toString()), JSON.stringify(get.engine.bytes.toString()))
      t.deepEqual(get.engine.events, get.node.events)

      compare({method: 'POST', url: '/post', body: 'abc=def', headers: {'content-type': 'text/plain'}}, server, (err, post) => {
        t.equal(err, null)
        t.equal(post.engine.error, null)
        t.equal(post.node.error, null)
        t.equal(post.engine.body, 'echo abc=def')
        t.equal(post.engine.body, post.node.body)
        t.deepEqual(post.engine.rawHeaders, post.node.rawHeaders)
        t.equal(compare.normalizeRequest(post.engine.bytes, true), compare.normalizeRequest(post.node.bytes, true))
        t.ok(/\r\ncontent-length: 7\r\n/.test(post.engine.bytes.toString()))
        finish(t, server)
      })
    })
  })
})

tape('response headers follow Node', t => {
  const response = 'HTTP/1.1 200 OK\r\nContent-Type: a/b\r\nContent-Type: c/d\r\nLocation: /x\r\nLocation: /y\r\n' +
    'X-A: 1\r\nX-A: 2\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nCookie: c=3\r\nCookie: d=4\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
  const server = net.createServer(socket => socket.once('data', () => socket.end(response)))
  listen(server, () => {
    compare({url: '/dup'}, server, (err, result) => {
      t.equal(err, null)
      t.equal(result.engine.error, null)
      t.equal(result.node.error, null)
      t.deepEqual(result.engine.headers, result.node.headers)
      t.deepEqual(result.engine.headers, {
        'content-type': 'a/b',
        location: '/x',
        'x-a': '1, 2',
        'set-cookie': ['a=1', 'b=2'],
        cookie: 'c=3; d=4',
        'content-length': '0',
        connection: 'close'
      })
      t.deepEqual(result.engine.rawHeaders, result.node.rawHeaders)
      finish(t, server)
    })
  })
})

tape('a body that ends before the response event keeps its last bytes with a string encoding, as in Node', t => {
  const server = http.createServer((req, res) => res.end(req.url.slice(1)))
  const texts = ['a', 'ab', 'abcd', 'hello-world']
  const bodyOf = (api, url) => new Promise(resolve => api({url, encoding: 'base64'}, (err, res, body) => resolve(err ? String(err) : body)))
  listen(server, async port => {
    const base = 'http://localhost:' + port + '/'
    const seen = []
    for (const text of texts) {
      seen.push({text, node: await bodyOf(nodeApi, base + text), engine: await bodyOf(request, base + text)})
    }
    seen.forEach(entry => t.equal(entry.engine, entry.node, entry.text))
    t.deepEqual(seen.map(entry => entry.node), texts.map(text => Buffer.from(text).toString('base64')))
    finish(t, server)
  })
})

tape('no HTTP/2 by default', t => {
  const server = http2.createSecureServer(Object.assign({allowHTTP1: true}, trusted), (req, res) => {
    res.setHeader('X-Mixed-Case', 'kept')
    res.end('version ' + req.httpVersion)
  })
  listen(server, port => {
    request({url: 'https://localhost:' + port + '/', ca: ca}, (err, res, body) => {
      t.equal(err, null)
      t.equal(res.httpVersion, '1.1')
      t.equal(res.statusMessage, 'OK')
      t.equal(body, 'version 1.1')
      t.ok(res.rawHeaders.indexOf('X-Mixed-Case') !== -1, 'header case is kept')
      finish(t, server)
    })
  })
})

tape('no HTTP/2 through the own connector', t => {
  const server = http2.createSecureServer(Object.assign({allowHTTP1: true}, trusted), (req, res) => res.end('version ' + req.httpVersion))
  listen(server, port => {
    const url = 'https://localhost:' + port + '/'
    request({url: url, ca: ca, strictSSL: true}, (strictErr, strictRes, strictBody) => {
      t.equal(strictErr, null)
      t.equal(strictBody, 'version 1.1', 'strictSSL')
      request({url: url, ca: ca, servername: ''}, (emptyErr, emptyRes, emptyBody) => {
        t.equal(emptyErr, null)
        t.equal(emptyBody, 'version 1.1', 'servername empty')
        finish(t, server)
      })
    })
  })
})

tape('strictSSL true wins over rejectUnauthorized false', t => {
  let hits = 0
  const server = https.createServer(selfSigned, (req, res) => {
    hits++
    res.end('should not be read')
  })
  listen(server, port => {
    request({url: 'https://localhost:' + port + '/', strictSSL: true, rejectUnauthorized: false}, (err, res, body) => {
      t.ok(err, 'error')
      t.equal(err && err.message, 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT')
      t.equal(err && err.code, undefined)
      t.equal(res, undefined)
      t.equal(hits, 0)
      finish(t, server)
    })
  })
})

tape('strictSSL without handshake verification resumes no TLS session', t => {
  let connections = 0
  let resumed = 0
  const server = https.createServer(Object.assign({maxVersion: 'TLSv1.2'}, trusted), (req, res) => res.end('should not be read'))
  server.on('secureConnection', socket => {
    connections++
    if (socket.isSessionReused()) {
      resumed++
    }
  })
  listen(server, port => {
    const results = []
    const next = () => request({url: 'https://localhost:' + port + '/', ca: ca, servername: 'other.example', rejectUnauthorized: false, strictSSL: true}, (err, res) => {
      results.push(err ? err.message : res.statusCode)
      if (results.length < 3) {
        return next()
      }
      setTimeout(() => {
        t.deepEqual(results, ['SSL Error: ERR_TLS_CERT_ALTNAME_INVALID', 'SSL Error: ERR_TLS_CERT_ALTNAME_INVALID', 'SSL Error: ERR_TLS_CERT_ALTNAME_INVALID'])
        t.equal(connections, 3)
        t.equal(resumed, 0, 'no session resumed')
        finish(t, server)
      }, 20)
    })
    next()
  })
})

tape('strictSSL resumes no TLS session after NODE_TLS_REJECT_UNAUTHORIZED is set at runtime', t => {
  let resumed = 0
  const server = https.createServer(Object.assign({maxVersion: 'TLSv1.2'}, trusted), (req, res) => res.end('should not be read'))
  server.on('secureConnection', socket => {
    if (socket.isSessionReused()) {
      resumed++
    }
  })
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  listen(server, port => {
    const results = []
    const next = () => request({url: 'https://localhost:' + port + '/', ca: ca, servername: 'other.example', strictSSL: true}, (err, res) => {
      results.push(err ? err.message : res.statusCode)
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
      if (results.length < 4) {
        return next()
      }
      if (before === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = before
      }
      setTimeout(() => {
        t.deepEqual(results.slice(1), ['SSL Error: ERR_TLS_CERT_ALTNAME_INVALID', 'SSL Error: ERR_TLS_CERT_ALTNAME_INVALID', 'SSL Error: ERR_TLS_CERT_ALTNAME_INVALID'])
        t.equal(resumed, 0, 'no session resumed')
        finish(t, server)
      }, 20)
    })
    next()
  })
})

tape('chunked body from a stream', t => {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.push({headers: req.headers, body: Buffer.concat(chunks)})
      res.end('done')
    })
  })
  const put = (api, cb) => {
    fs.createReadStream(fixture).pipe(api.put({url: 'http://localhost:' + server.address().port + '/', headers: {'transfer-encoding': 'chunked'}}, cb))
  }
  listen(server, () => {
    put(nodeApi, (nodeErr, nodeRes) => {
      t.equal(nodeErr, null)
      put(request, (engineErr, engineRes, body) => {
        t.equal(engineErr, null)
        t.equal(engineRes.statusCode, 200)
        t.equal(body, 'done')
        t.equal(seen.length, 2)
        t.equal(seen[1].headers['transfer-encoding'], 'chunked')
        t.equal(seen[1].headers['content-length'], undefined)
        t.equal(seen[1].headers['transfer-encoding'], seen[0].headers['transfer-encoding'])
        t.equal(seen[1].body.length, fs.statSync(fixture).size)
        t.ok(seen[1].body.equals(seen[0].body))
        finish(t, server)
      })
    })
  })
})

tape('refused request headers', t => {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.headers)
    res.end('ok')
  })
  const refused = [['expect', '100-continue'], ['upgrade', 'websocket'], ['transfer-encoding', 'gzip']]
  const next = () => {
    const entry = refused.shift()
    if (!entry) {
      t.equal(hits.length, 0, 'no request reached the server')
      return request({url: 'http://localhost:' + server.address().port + '/', headers: {connection: 'close'}}, (err, res) => {
        t.equal(err, null)
        t.equal(res.statusCode, 200)
        t.equal(hits.length, 1)
        t.equal(hits[0].connection, 'close')
        finish(t, server)
      })
    }
    let calls = 0
    request({url: 'http://localhost:' + server.address().port + '/', headers: {[entry[0]]: entry[1]}}, err => {
      calls++
      t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', entry[0])
      t.equal(err && err.option, 'headers.' + entry[0])
      t.equal(err && err.message.indexOf('request-compat-undici does not support the option headers.' + entry[0]), 0)
      setTimeout(() => {
        t.equal(calls, 1, 'callback once')
        next()
      }, 20)
    })
  }
  listen(server, next)
})

tape('an invalid header name or value gives Node\'s error from send, as in Node', t => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.end('ok')
  })
  server.on('connection', () => hits++)
  const rows = [
    {headers: {test: 'אבגד'}},
    {method: 'POST', body: 'beep', headers: {test: 'a\r\nb'}},
    {headers: {'bad name': 'x'}},
    {tunnel: true, headers: {'proxy-authorization': 'a\nb'}},
    {tunnel: true, headers: {'x-excl': 'a\nb'}, proxyHeaderExclusiveList: ['x-excl']}
  ]
  const outcome = (api, row, cb) => {
    const events = []
    const url = 'http://localhost:' + server.address().port
    const r = api(Object.assign({url: url + '/'}, row, row.tunnel ? {proxy: url} : {}), err => {
      setTimeout(() => cb({message: err && err.message, code: err && err.code, type: err && err.constructor.name, events}), 20)
    })
    ;['request', 'error', 'response'].forEach(name => r.on(name, () => events.push(name)))
  }
  const next = () => {
    const row = rows.shift()
    if (!row) {
      t.equal(hits, 0, 'nothing reached the server')
      return finish(t, server)
    }
    outcome(nodeApi, row, node => outcome(request, row, engine => {
      t.ok(node.code === 'ERR_INVALID_CHAR' || node.code === 'ERR_INVALID_HTTP_TOKEN', 'Node: ' + node.message)
      t.deepEqual(engine, node, JSON.stringify(row.headers))
      next()
    }))
  }
  listen(server, next)
})

tape('a header with the value null is sent as null, as in Node, also in the CONNECT request', t => {
  const server = http.createServer(sendDateOff((req, res) => res.end('ok')))
  const proxy = connectProxy()
  const lines = connect => connect.rawHeaders.map((item, index) => index % 2 ? '' : item.toLowerCase() + ': ' + connect.rawHeaders[index + 1]).filter(Boolean)
  listen(server, port => listen(proxy, proxyPort => {
    compare({url: '/', headers: {'x-null': null, 'x-list': ['a', 'b']}}, server, (err, result) => {
      t.equal(err, null)
      t.equal(result.engine.error, null)
      t.ok(/\r\nx-null: null\r\n/.test(result.node.bytes.toString()), 'Node sends null')
      t.equal(compare.normalizeRequest(result.engine.bytes, true), compare.normalizeRequest(result.node.bytes, true))
      const tunnelled = {
        url: 'http://localhost:' + port + '/',
        proxy: 'http://localhost:' + proxyPort,
        tunnel: true,
        headers: {accept: null, 'proxy-authorization': null, 'x-excl': null},
        proxyHeaderExclusiveList: ['x-excl']
      }
      nodeApi(Object.assign({}, tunnelled), err => {
        t.equal(err, null)
        request(Object.assign({}, tunnelled), err => {
          t.equal(err, null)
          ;['accept: null', 'proxy-authorization: null', 'x-excl: null'].forEach(line => {
            t.ok(lines(proxy.connects[0]).indexOf(line) !== -1, 'Node CONNECT: ' + line)
            t.ok(lines(proxy.connects[1]).indexOf(line) !== -1, 'engine CONNECT: ' + line)
          })
          finish(t, [server, proxy])
        })
      })
    })
  }))
})

tape('removeHeader before dispatch', t => {
  const hops = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      hops.push({headers: req.headers, body: Buffer.concat(chunks).toString()})
      if (!req.headers.authorization) {
        res.writeHead(401, {'WWW-Authenticate': 'Basic realm="test"'})
        return res.end()
      }
      res.end('ok')
    })
  })
  const run = (api, cb) => {
    api.post({
      url: 'http://localhost:' + server.address().port + '/',
      formData: {field: 'a value that makes the form longer than a few bytes'},
      auth: {user: 'user', pass: 'pass', sendImmediately: false}
    }, cb)
  }
  const warnings = []
  const onWarning = warning => warnings.push(warning.code || warning.name)
  process.on('warning', onWarning)
  listen(server, () => {
    run(nodeApi, (nodeErr, nodeRes) => {
      t.equal(nodeErr, null)
      t.equal(nodeRes.statusCode, 200)
      run(request, (err, res, body) => {
        t.equal(err, null)
        t.equal(res.statusCode, 200)
        t.equal(body, 'ok')
        t.equal(hops.length, 4)
        t.equal(hops[0].headers['content-length'], undefined, 'Node: first hop has no content-length')
        t.equal(hops[0].headers['transfer-encoding'], 'chunked', 'Node: first hop is chunked')
        t.equal(hops[2].headers['content-length'], '0', 'engine: undici sends the real length of the empty body, not the form length')
        t.equal(hops[2].body, '')
        t.ok(hops[3].headers.authorization, 'second hop is authorized')
        t.ok(hops[3].body.indexOf('a value that makes') !== -1, 'second hop carries the form')
        setImmediate(() => {
          process.removeListener('warning', onWarning)
          t.equal(warnings.indexOf('UND_ERR_REQ_CONTENT_LENGTH_MISMATCH'), -1, 'no content-length mismatch warning')
          finish(t, server)
        })
      })
    })
  })
})

tape('abort before start', t => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.end('no')
  })
  listen(server, port => {
    const url = 'http://localhost:' + port + '/'
    const events = []
    const first = request(url, () => events.push('callback first'))
    first.on('error', () => events.push('error first'))
    first.on('response', () => events.push('response first'))
    first.abort()
    const second = request(url, () => events.push('callback second'))
    second.on('error', () => events.push('error second'))
    second.on('response', () => events.push('response second'))
    second.on('request', req => {
      t.equal(req.dispatched, false)
      second.abort()
    })
    setTimeout(() => {
      t.equal(hits, 0)
      t.deepEqual(events, [])
      finish(t, server)
    }, 150)
  })
})

tape('abort after response headers', t => {
  let closedAt = 0
  const server = http.createServer((req, res) => {
    req.socket.on('close', () => { closedAt = Date.now() })
    res.writeHead(200)
    res.write('x')
  })
  listen(server, port => {
    const events = []
    const r = request('http://localhost:' + port + '/')
    r.on('error', err => events.push('error ' + err.message))
    r.on('response', () => {
      events.push('response')
      setTimeout(() => {
        r.abort()
        const abortedAt = Date.now()
        waitFor(() => closedAt, 100, closed => {
          t.ok(closed, 'the server sees the socket closed')
          t.ok(closedAt - abortedAt < 100)
          setTimeout(() => {
            t.deepEqual(events, ['response'])
            finish(t, server)
          }, 50)
        })
      }, 30)
    })
  })
})

tape('abort during the body', t => {
  let closedAt = 0
  const server = http.createServer((req, res) => {
    req.socket.on('close', () => { closedAt = Date.now() })
    res.writeHead(200)
    const timer = setInterval(() => res.write('chunk'), 10)
    req.socket.on('close', () => clearInterval(timer))
  })
  listen(server, port => {
    const events = []
    let aborted = 0
    const r = request('http://localhost:' + port + '/')
    r.on('error', err => events.push('error ' + err.message))
    r.on('response', () => events.push('response'))
    r.on('data', () => {
      if (!aborted) {
        aborted = Date.now()
        r.abort()
        waitFor(() => closedAt, 100, closed => {
          t.ok(closed, 'the server sees the socket closed')
          t.ok(closedAt - aborted < 100)
          setTimeout(() => {
            t.deepEqual(events, ['response'])
            finish(t, server)
          }, 50)
        })
      }
    })
  })
})

tape('idle timer set on the exchange ends with it', t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.flushHeaders()
  })
  listen(server, port => {
    const fired = []
    const r = request('http://localhost:' + port + '/')
    r.on('error', err => t.fail(err.message))
    r.on('request', req => {
      req.setTimeout(80, () => {
        fired.push(Date.now())
        r.abort()
      })
    })
    setTimeout(() => {
      t.equal(fired.length, 1)
      finish(t, server)
    }, 400)
  })
})

tape('backpressure', t => {
  const total = 20 * 1024 * 1024
  const chunk = Buffer.alloc(64 * 1024, 'x')
  const server = http.createServer((req, res) => {
    let sent = 0
    const pump = () => {
      while (sent < total) {
        sent += chunk.length
        if (!res.write(chunk)) {
          return res.once('drain', pump)
        }
      }
      res.end()
    }
    res.writeHead(200, {'Content-Length': total})
    pump()
  })
  const original = Agent.prototype.dispatch
  let pauses = 0
  Agent.prototype.dispatch = function (options, handler) {
    const onRequestStart = handler.onRequestStart
    handler.onRequestStart = function (controller) {
      const pause = controller.pause
      controller.pause = function () {
        pauses++
        return pause.apply(this, arguments)
      }
      return onRequestStart.apply(this, arguments)
    }
    return original.apply(this, arguments)
  }
  listen(server, port => {
    let received = 0
    const r = request('http://localhost:' + port + '/')
    r.on('error', err => t.fail(err.message))
    r.on('response', () => {
      r.pause()
      setTimeout(() => r.resume(), 200)
    })
    r.on('data', data => { received += data.length })
    r.on('end', () => {
      Agent.prototype.dispatch = original
      t.ok(pauses > 0, 'the handler paused the controller')
      t.equal(received, total)
      finish(t, server)
    })
  })
})

tape('TLS contexts are not shared', t => {
  let connections = 0
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  server.on('connection', () => connections++)
  listen(server, port => {
    const url = 'https://localhost:' + port + '/'
    request({url: url, ca: ca}, (errA, resA) => {
      t.equal(errA, null)
      t.equal(resA.statusCode, 200)
      request({url: url, strictSSL: false}, (errB, resB) => {
        t.equal(errB, null)
        t.equal(resB.statusCode, 200)
        t.equal(connections, 2)
        finish(t, server)
      })
    })
  })
})

tape('checkServerIdentity closures do not pile up', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  listen(server, port => {
    const url = 'https://localhost:' + port + '/'
    let before
    let count = 0
    const next = () => {
      if (count === 200) {
        t.equal(cacheSize(), before)
        return setImmediate(() => {
          t.equal(oneOffCount(), 0, 'one-off dispatchers are released')
          finish(t, server)
        })
      }
      request({url: url, ca: ca, checkServerIdentity: (host, cert) => tls.checkServerIdentity(host, cert)}, (err, res) => {
        if (err || res.statusCode !== 200) {
          t.equal(err, null)
          return finish(t, server)
        }
        if (count === 0) {
          before = cacheSize()
        }
        count++
        next()
      })
    }
    next()
  })
})

tape('http to https redirect', t => {
  const secure = https.createServer(trusted, (req, res) => res.end('secure ' + req.url))
  const plain = http.createServer()
  listen(secure, securePort => {
    plain.on('request', (req, res) => {
      res.writeHead(302, {Location: 'https://localhost:' + securePort + '/landed'})
      res.end()
    })
    listen(plain, plainPort => {
      const r = request({url: 'http://localhost:' + plainPort + '/', ca: ca}, (err, res, body) => {
        t.equal(err, null)
        t.equal(res.statusCode, 200)
        t.equal(body, 'secure /landed')
        t.equal(r.uri.protocol, 'https:')
        finish(t, [secure, plain])
      })
    })
  })
})

tape('server closes the connection before the response', t => {
  const server = net.createServer(socket => socket.once('data', () => socket.destroy()))
  listen(server, () => {
    compare({url: '/'}, server, (err, result) => {
      t.equal(err, null)
      t.equal(result.node.error && result.node.error.code, 'ECONNRESET')
      t.equal(result.engine.error && result.engine.error.code, 'ECONNRESET')
      t.equal(result.engine.error && result.engine.error.message, 'socket hang up')
      t.equal(result.engine.error && result.engine.error.message, result.node.error && result.node.error.message)
      t.deepEqual(result.engine.events, result.node.events)
      finish(t, server)
    })
  })
})

tape('server closes the connection mid-body', t => {
  const server = net.createServer(socket => socket.once('data', () => {
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc')
  }))
  listen(server, () => {
    compare({url: '/'}, server, (err, result) => {
      t.equal(err, null)
      t.equal(result.node.error && result.node.error.code, 'ECONNRESET')
      t.equal(result.engine.error && result.engine.error.code, 'ECONNRESET')
      t.equal(result.engine.error && result.engine.error.message, 'aborted')
      t.equal(result.engine.error && result.engine.error.message, result.node.error && result.node.error.message)
      t.equal(result.engine.statusCode, result.node.statusCode)
      t.equal(result.engine.body, result.node.body)
      t.deepEqual(result.engine.events, result.node.events)
      finish(t, server)
    })
  })
})

tape('no undici timeouts', t => {
  const secure = https.createServer(trusted, (req, res) => res.end('late but whole'))
  const slow = net.createServer(socket => setTimeout(() => secure.emit('connection', socket), 11000))
  listen(slow, port => {
    request({url: 'https://localhost:' + port + '/', ca: ca}, (err, res, body) => {
      t.equal(err, null)
      t.equal(res && res.statusCode, 200)
      t.equal(body, 'late but whole')
      finish(t, [slow, secure])
    })
  })
})

tape('localAddress', t => {
  const server = http.createServer((req, res) => res.end(req.socket.remoteAddress))
  server.listen(0, '0.0.0.0', () => {
    request({url: 'http://127.0.0.1:' + server.address().port + '/', localAddress: '127.0.0.2'}, (err, res, body) => {
      t.equal(err, null)
      t.equal(body, '127.0.0.2')
      finish(t, server)
    })
  })
})

tape('removeHeader takes effect before dispatch', t => {
  const server = http.createServer(sendDateOff((req, res) => res.end('ok')))
  listen(server, () => {
    compare({url: '/', headers: {'x-drop': '1', 'x-keep': '2'}, onRequest: req => req.removeHeader('x-drop')}, server, (err, result) => {
      t.equal(err, null)
      t.equal(result.node.error, null)
      t.equal(result.engine.error, null)
      t.notOk(/x-drop/i.test(result.node.bytes.toString()), 'Node: header removed')
      t.notOk(/x-drop/i.test(result.engine.bytes.toString()), 'engine: header removed')
      t.ok(/x-keep: 2/i.test(result.engine.bytes.toString()))
      finish(t, server)
    })
  })
})

tape('header order is a documented difference', t => {
  const server = http.createServer(sendDateOff((req, res) => res.end('ok')))
  const names = bytes => bytes.toString().split('\r\n\r\n')[0].split('\r\n').slice(1).map(line => line.split(':')[0].toLowerCase())
  listen(server, () => {
    compare({url: '/', headers: {'X-First': '1', Accept: 'a/b'}}, server, (err, result) => {
      t.equal(err, null)
      t.deepEqual(names(result.node.bytes), ['x-first', 'accept', 'host', 'connection'], 'Node: caller headers first')
      t.deepEqual(names(result.engine.bytes), ['host', 'connection', 'x-first', 'accept'], 'engine: host and connection first')
      finish(t, server)
    })
  })
})

tape('res.destroy() by the consumer closes the connection', t => {
  const run = (api, cb) => {
    let closedAt = 0
    const server = http.createServer((req, res) => {
      req.socket.on('close', () => { closedAt = Date.now() })
      res.writeHead(200)
      const timer = setInterval(() => res.write('chunk'), 5)
      req.socket.on('close', () => clearInterval(timer))
    })
    listen(server, port => {
      const events = []
      const r = api('http://localhost:' + port + '/')
      r.on('error', err => events.push('error ' + err.message))
      r.on('response', res => {
        const destroyedAt = Date.now()
        res.destroy()
        waitFor(() => closedAt, 300, closed => {
          setTimeout(() => {
            server.close()
            cb({closed, delay: closedAt - destroyedAt, events})
          }, 50)
        })
      })
    })
  }
  run(nodeApi, node => {
    t.ok(node.closed, 'Node: socket closed')
    run(request, engine => {
      t.ok(engine.closed, 'engine: socket closed')
      t.ok(engine.delay < 100, 'within 100 ms: ' + engine.delay)
      t.deepEqual(engine.events, [])
      t.end()
    })
  })
})

tape('request headers: keep-alive from a piped response is dropped', t => {
  const a = net.createServer(socket => socket.once('data', () => {
    socket.end('HTTP/1.1 200 OK\r\nKeep-Alive: timeout=5\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody')
  }))
  const seen = []
  const b = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      seen.push({headers: req.headers, body: Buffer.concat(chunks).toString()})
      res.end('stored')
    })
  })
  listen(a, portA => listen(b, portB => {
    request('http://localhost:' + portA + '/').pipe(request.put('http://localhost:' + portB + '/', (err, res, body) => {
      t.equal(err, null)
      t.equal(res && res.statusCode, 200)
      t.equal(body, 'stored')
      t.equal(seen.length, 1)
      t.equal(seen[0].body, 'body')
      t.equal(seen[0].headers['keep-alive'], undefined)
      finish(t, [a, b])
    }))
  }))
})

tape('TLS options of the request win over agentOptions, as in Node', t => {
  const selfSignedServer = https.createServer(selfSigned, (req, res) => res.end('ok'))
  const trustedServer = https.createServer(trusted, (req, res) => res.end('ok'))
  listen(selfSignedServer, () => listen(trustedServer, () => {
    compare({url: '/', rejectUnauthorized: true, agentOptions: {rejectUnauthorized: false}}, selfSignedServer, (err, rows) => {
      t.equal(err, null)
      t.equal(rows.node.error && rows.node.error.code, 'DEPTH_ZERO_SELF_SIGNED_CERT', 'Node rejects')
      t.equal(rows.engine.error && rows.engine.error.code, rows.node.error && rows.node.error.code, 'row 1: engine rejects')
      t.equal(rows.engine.statusCode, undefined)
      compare({url: '/', ca: fs.readFileSync(path.join(ssl, 'self-signed.crt')), agentOptions: {ca: ca}}, trustedServer, (err, rows) => {
        t.equal(err, null)
        t.equal(rows.node.error && rows.node.error.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'Node rejects')
        t.equal(rows.engine.error && rows.engine.error.code, rows.node.error && rows.node.error.code, 'row 2: engine rejects')
        compare({url: '/', strictSSL: false, agentOptions: {rejectUnauthorized: true}}, trustedServer, (err, rows) => {
          t.equal(err, null)
          t.equal(rows.node.error, null)
          t.equal(rows.engine.error, null, 'row 3: engine accepts')
          t.equal(rows.engine.statusCode, 200)
          finish(t, [selfSignedServer, trustedServer])
        })
      })
    })
  }))
})

tape('https.globalAgent options reach the TLS context', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  const otherServer = https.createServer(trusted, (req, res) => res.end('ok'))
  const options = https.globalAgent.options
  const saved = {ca: options.ca, checkServerIdentity: options.checkServerIdentity}
  const restore = () => {
    ;['ca', 'checkServerIdentity'].forEach(name => {
      if (saved[name] === undefined) {
        delete options[name]
      } else {
        options[name] = saved[name]
      }
    })
  }
  listen(otherServer, () => listen(server, () => {
    options.ca = ca
    compare({url: '/'}, server, (err, accepted) => {
      t.equal(err, null)
      t.equal(accepted.node.error, null, 'Node: ca of the global agent is used')
      t.equal(accepted.engine.error, null, 'engine: ca of the global agent is used')
      t.equal(accepted.engine.statusCode, 200)
      options.checkServerIdentity = () => new Error('global pin mismatch')
      compare({url: '/'}, otherServer, (err, rejected) => {
        t.equal(err, null)
        t.equal(rejected.node.error && rejected.node.error.message, 'global pin mismatch')
        t.equal(rejected.engine.error && rejected.engine.error.message, 'global pin mismatch', 'engine: the pin of the global agent runs')
        t.equal(rejected.engine.statusCode, undefined)
        restore()
        finish(t, [server, otherServer])
      })
    })
  }))
})

tape('events are deferred and a throwing listener does not fail the request', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  const original = process.listeners('uncaughtException')
  original.forEach(listener => process.removeListener('uncaughtException', listener))
  const thrown = []
  process.on('uncaughtException', err => thrown.push(err.message))
  listen(server, port => {
    const r = request('http://localhost:' + port + '/', (err, res, body) => {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      t.equal(body, 'ok')
      setTimeout(() => {
        process.removeAllListeners('uncaughtException')
        original.forEach(listener => process.on('uncaughtException', listener))
        t.deepEqual(thrown, ['listener threw'])
        finish(t, server)
      }, 20)
    })
    r.on('request', req => req.on('response', () => { throw new Error('listener threw') }))
  })
})

tape('abort between dispatch and onRequestStart sends nothing', t => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.end('no')
  })
  listen(server, port => {
    const events = []
    const r = request.post('http://localhost:' + port + '/')
    r.on('error', err => events.push('error ' + err.message))
    r.on('response', () => events.push('response'))
    r.on('request', req => {
      req.write('x')
      t.equal(req.dispatched, true)
      req.abort()
    })
    setTimeout(() => {
      t.equal(hits, 0)
      t.deepEqual(events, [])
      finish(t, server)
    }, 150)
  })
})

tape('dispatcher and dispatch options', t => {
  const options = agentOptions(tlsContext({}))
  t.equal(options.allowH2, false)
  t.equal(options.headersTimeout, 0)
  t.equal(options.bodyTimeout, 0)
  t.equal(options.strictContentLength, false)
  t.equal(options.connect.timeout, 0)
  const server = http.createServer((req, res) => res.end('ok'))
  const original = Agent.prototype.dispatch
  const seen = []
  Agent.prototype.dispatch = function (dispatchOptions) {
    seen.push(dispatchOptions)
    return original.apply(this, arguments)
  }
  listen(server, port => {
    request.post({url: 'http://localhost:' + port + '/', body: 'x'}, err => {
      Agent.prototype.dispatch = original
      t.equal(err, null)
      t.equal(seen.length, 1)
      t.equal(seen[0].headersTimeout, 0)
      t.equal(seen[0].bodyTimeout, 0)
      t.deepEqual(Object.keys(seen[0]).sort(), ['bodyTimeout', 'headers', 'headersTimeout', 'method', 'origin', 'path', 'body'].sort())
      finish(t, server)
    })
  })
})

tape('unix socket', t => {
  const socketPath = path.join(os.tmpdir(), 'undici-engine-' + process.pid + '.sock')
  const server = http.createServer((req, res) => res.end('unix ' + req.url))
  server.listen(socketPath, () => {
    request({url: 'http://unix:' + socketPath + ':/some/path?a=1'}, (err, res, body) => {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      t.equal(body, 'unix /some/path?a=1')
      finish(t, server)
    })
  })
})

tape('close dispatchers', t => {
  closeAll().then(() => {
    t.equal(cacheSize(), 0)
    t.end()
  })
})

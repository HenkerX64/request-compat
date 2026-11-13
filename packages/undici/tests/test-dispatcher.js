'use strict'

const fs = require('fs')
const http = require('http')
const http2 = require('http2')
const https = require('https')
const path = require('path')
const tls = require('tls')
const zlib = require('zlib')
const tape = require('tape')
const {Agent, MockAgent, Socks5ProxyAgent} = require('undici')
const nodeApi = require('request-compat')
const request = require('../index')
const socks5Server = require('./socks5-server')
const {forwardingProxy} = require('./proxy-servers')
const inventory = require('./option-inventory')
const {cacheSize, oneOffCount, closeAll} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))
const trusted = {key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}

const WITH_DISPATCHER = 'not together with dispatcher, which decides connections and TLS'
const CONFLICTS = {
  strictSSL: [true, false],
  rejectUnauthorized: [false, true],
  checkServerIdentity: [() => undefined],
  maxHeaderSize: [100],
  ca: [ca],
  cert: [trusted.cert],
  key: [trusted.key],
  pfx: [Buffer.from('pfx')],
  passphrase: ['secret'],
  ciphers: ['DEFAULT'],
  secureProtocol: ['TLS_method'],
  secureOptions: [4],
  servername: ['', 'other.example'],
  minVersion: ['TLSv1.2'],
  maxVersion: ['TLSv1.3'],
  crl: [Buffer.from('crl')],
  ecdhCurve: ['auto'],
  sigalgs: ['RSA-PSS+SHA256'],
  dhparam: [Buffer.from('dh')],
  honorCipherOrder: [true],
  sessionIdContext: ['context'],
  family: [4],
  socketPath: ['/tmp/none.sock'],
  localAddress: ['127.0.0.1'],
  secureContext: [tls.createSecureContext({})]
}
const CONNECTION_CONFLICTS = [
  ['pool', {pool: {}}],
  ['pool', {pool: {maxSockets: 2}}],
  ['pool', {pool: false}],
  ['agent', {agent: false}],
  ['forever', {forever: true}],
  ['agentOptions', {agentOptions: {keepAlive: true}}]
]

function listen (server, cb) {
  server.listen(0, () => cb(server.address().port))
}

function counting (dispatcher, hops) {
  return dispatcher.compose(dispatch => (options, handler) => {
    hops.push(options.method + ' ' + options.origin + options.path)
    return dispatch(options, handler)
  })
}

function setEnvironment (values) {
  const saved = {}
  Object.keys(values).forEach(name => {
    saved[name] = process.env[name]
    if (values[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = values[name]
    }
  })
  return () => setEnvironment(saved)
}

function conflicts () {
  const cases = []
  Object.keys(CONFLICTS).forEach(name => {
    CONFLICTS[name].forEach(value => {
      cases.push({option: name, options: {[name]: value}, reason: WITH_DISPATCHER})
    })
  })
  CONNECTION_CONFLICTS.forEach(entry => cases.push({option: entry[0], options: entry[1], reason: WITH_DISPATCHER}))
  cases.push({option: 'socketPath', url: () => 'http://unix:/tmp/none.sock:/path', reason: WITH_DISPATCHER})
  cases.push({option: 'agent', options: {agent: new http.Agent()}})
  ;[inventory.CONNECTION_OPTIONS, inventory.REQUEST_ONLY_OPTIONS, inventory.AGENT_OPTIONS_REFUSED_ON_THE_REQUEST, inventory.COMPUTED_OPTIONS].forEach(group => {
    Object.keys(group).forEach(name => cases.push({option: name, options: {[name]: group[name]}}))
  })
  const all = []
  cases.forEach(entry => {
    all.push(Object.assign({source: 'options'}, entry))
    all.push(Object.assign({source: 'defaults'}, entry))
  })
  return all
}

tape('request.defaults({dispatcher}) sends every hop of a redirect through the dispatcher', t => {
  const other = http.createServer((req, res) => res.end('done ' + req.url))
  listen(other, otherPort => {
    const server = http.createServer((req, res) => {
      res.writeHead(302, {location: 'http://localhost:' + otherPort + '/end'})
      res.end()
    })
    listen(server, port => {
      const agent = new Agent()
      const hops = []
      const api = request.defaults({dispatcher: counting(agent, hops)})
      const dispatchers = cacheSize()
      const oneOffs = oneOffCount()
      api('http://localhost:' + port + '/start', (err, res, body) => {
        t.equal(err, null)
        t.equal(res.statusCode, 200)
        t.equal(body, 'done /end')
        t.deepEqual(hops, ['GET http://localhost:' + port + '/start', 'GET http://localhost:' + otherPort + '/end'])
        t.equal(cacheSize(), dispatchers, 'the engine opened no dispatcher of its own')
        t.equal(oneOffCount(), oneOffs)
        agent.close().then(() => {
          server.close()
          other.close()
          t.end()
        })
      })
    })
  })
})

tape('options the dispatcher would drop are refused before anything is sent', t => {
  let connections = 0
  const plain = http.createServer((req, res) => res.end('ok'))
  const secure = https.createServer(trusted, (req, res) => res.end('ok'))
  ;[plain, secure].forEach(server => server.on('connection', () => connections++))
  const agent = new Agent()
  const hops = []
  const dispatcher = counting(agent, hops)
  const cases = []
  conflicts().forEach(entry => {
    cases.push(Object.assign({target: 'http'}, entry))
    cases.push(Object.assign({target: 'https'}, entry))
  })
  listen(plain, plainPort => listen(secure, securePort => {
    const next = () => {
      const entry = cases.shift()
      if (!entry) {
        return setTimeout(() => {
          t.equal(connections, 0, 'no connection reached a server')
          t.deepEqual(hops, [], 'nothing was dispatched')
          plain.close()
          secure.close()
          agent.close().then(() => t.end())
        }, 50)
      }
      const url = entry.url ? entry.url() : entry.target === 'http' ? 'http://localhost:' + plainPort + '/' : 'https://localhost:' + securePort + '/'
      const api = entry.source === 'defaults' ? request.defaults(Object.assign({dispatcher}, entry.options)) : request
      const options = entry.source === 'defaults' ? {url} : Object.assign({url, dispatcher}, entry.options)
      api(options, (err, res) => {
        const label = entry.target + ' ' + entry.source + ' ' + JSON.stringify(Object.keys(entry.options || {url: 1})) + ' ' + entry.option
        t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', label + ': code')
        t.equal(err && err.option, entry.option, label + ': option')
        if (entry.reason) {
          t.equal(err && err.message, 'request-compat-undici does not support the option ' + entry.option + ': ' + entry.reason, label + ': message')
        }
        t.equal(res, undefined)
        next()
      })
    }
    next()
  }))
})

tape('a proxy is refused with a dispatcher whatever its source, proxy: null is accepted', t => {
  const target = http.createServer((req, res) => res.end('direct ' + req.url))
  const proxy = forwardingProxy()
  const agent = new Agent()
  const hops = []
  const dispatcher = counting(agent, hops)
  listen(target, targetPort => listen(proxy, proxyPort => {
    const url = 'http://localhost:' + targetPort + '/path'
    const proxyUrl = 'http://localhost:' + proxyPort
    const restore = setEnvironment({HTTP_PROXY: proxyUrl, http_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined})
    const reason = 'pass proxy: null; the dispatcher decides the proxy'
    const rows = [
      {label: 'explicit proxy', options: {url, dispatcher, proxy: proxyUrl}, refused: true},
      {label: 'HTTP_PROXY', options: {url, dispatcher}, refused: true},
      {label: 'HTTP_PROXY through request.defaults', api: request.defaults({dispatcher}), options: {url}, refused: true},
      {label: 'proxy: null', options: {url, dispatcher, proxy: null}},
      {label: 'proxy: false', options: {url, dispatcher, proxy: false}},
      {label: 'proxy: null through request.defaults', api: request.defaults({dispatcher, proxy: null}), options: {url}},
      {label: 'NO_PROXY', env: {NO_PROXY: 'localhost'}, options: {url, dispatcher}}
    ]
    const next = () => {
      const row = rows.shift()
      if (!row) {
        restore()
        t.equal(proxy.seen.length, 0, 'the proxy saw nothing')
        target.close()
        proxy.close()
        return agent.close().then(() => t.end())
      }
      const undo = setEnvironment(row.env || {})
      const before = hops.length
      ;(row.api || request)(row.options, (err, res, body) => {
        undo()
        if (row.refused) {
          t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', row.label)
          t.equal(err && err.option, 'proxy')
          t.equal(err && err.message, 'request-compat-undici does not support the option proxy: ' + reason)
          t.equal(hops.length, before, row.label + ': nothing dispatched')
        } else {
          t.equal(err, null, row.label)
          t.equal(body, 'direct /path')
          t.equal(hops.length, before + 1, row.label + ': through the dispatcher')
        }
        next()
      })
    }
    next()
  }))
})

tape('with a dispatcher, https.globalAgent options neither apply nor are refused, as with a caller agent in Node', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  const options = https.globalAgent.options
  const names = ['checkServerIdentity', 'lookup']
  const saved = {}
  names.forEach(name => {
    saved[name] = Object.prototype.hasOwnProperty.call(options, name) ? {value: options[name]} : null
  })
  const restore = () => names.forEach(name => {
    if (saved[name]) {
      options[name] = saved[name].value
    } else {
      delete options[name]
    }
  })
  listen(server, port => {
    options.checkServerIdentity = () => new Error('global pin')
    options.lookup = (host, lookupOptions, cb) => cb(new Error('global lookup'))
    const url = 'https://localhost:' + port + '/'
    const nodeAgent = new https.Agent({ca})
    nodeApi({url, agent: nodeAgent}, (err, res) => {
      t.equal(err, null, 'Node: a caller agent ignores the global agent options')
      t.equal(res && res.statusCode, 200)
      const agent = new Agent({connect: {ca}})
      request({url, dispatcher: agent}, (err, res) => {
        restore()
        t.equal(err, null, 'engine: the dispatcher ignores them as well')
        t.equal(res && res.statusCode, 200)
        nodeAgent.destroy()
        agent.close().then(() => {
          server.close()
          t.end()
        })
      })
    })
  })
})

tape('a dispatcher without a dispatch function is a TypeError', t => {
  let connections = 0
  const server = http.createServer((req, res) => res.end('ok'))
  server.on('connection', () => connections++)
  const values = [{}, 'agent', false, 1, {dispatch: 'no'}]
  listen(server, port => {
    const next = () => {
      if (!values.length) {
        return request({url: 'http://localhost:' + port + '/', dispatcher: null}, (err, res) => {
          t.equal(err, null)
          t.equal(res.statusCode, 200, 'dispatcher: null is no dispatcher')
          server.close()
          closeAll().then(() => t.end())
        })
      }
      const value = values.shift()
      request({url: 'http://localhost:' + port + '/', dispatcher: value}, (err, res) => {
        t.ok(err instanceof TypeError, JSON.stringify(value) + ': TypeError')
        t.equal(err && err.code, 'INVALID_DISPATCHER')
        t.equal(res, undefined)
        t.equal(connections, 0)
        next()
      })
    }
    next()
  })
})

tape('the origin leaves out the default port, so MockAgent interceptors match', t => {
  const mock = new MockAgent()
  mock.disableNetConnect()
  mock.get('http://mock.example').intercept({path: '/x'}).reply(200, 'mocked http')
  mock.get('https://mock.example').intercept({path: '/y'}).reply(200, 'mocked https')
  mock.get('http://mock.example:8080').intercept({path: '/z'}).reply(200, 'mocked 8080')
  const api = request.defaults({dispatcher: mock})
  api('http://mock.example/x', (err, res, body) => {
    t.equal(err, null)
    t.equal(body, 'mocked http')
    api('https://mock.example/y', (err, res, body) => {
      t.equal(err, null)
      t.equal(body, 'mocked https')
      api('http://mock.example:8080/z', (err, res, body) => {
        t.equal(err, null)
        t.equal(body, 'mocked 8080', 'another port stays in the origin')
        mock.close().then(() => t.end())
      })
    })
  })
})

tape('an Agent with allowH2 speaks HTTP/2 and the core decodes the gzip body', t => {
  const server = http2.createSecureServer(Object.assign({allowHTTP1: false}, trusted), (req, res) => {
    res.setHeader('content-encoding', 'gzip')
    res.end(zlib.gzipSync('h2 ' + req.httpVersion + ' ' + req.headers[':authority']))
  })
  listen(server, port => {
    const agent = new Agent({allowH2: true, connect: {ca}})
    request({url: 'https://localhost:' + port + '/', dispatcher: agent, gzip: true}, (err, res, body) => {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      t.equal(res.httpVersion, '2.0')
      t.equal(res.headers['content-encoding'], 'gzip')
      t.equal(body, 'h2 2.0 localhost:' + port)
      agent.close().then(() => server.close(() => t.end()))
    })
  })
})

tape('a Socks5ProxyAgent sends the request through the SOCKS server', t => {
  const target = http.createServer((req, res) => res.end('via socks ' + req.url))
  const socks = socks5Server()
  listen(target, targetPort => listen(socks, socksPort => {
    const agent = new Socks5ProxyAgent('socks5://127.0.0.1:' + socksPort)
    request({url: 'http://localhost:' + targetPort + '/s', dispatcher: agent}, (err, res, body) => {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      t.equal(body, 'via socks /s')
      t.deepEqual(socks.seen, ['localhost:' + targetPort], 'the SOCKS server saw the target')
      agent.close().then(() => {
        target.close()
        socks.close()
        t.end()
      })
    })
  }))
})

tape('with a dispatcher, connecting follows the dispatch and connect the start of the request', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    const agent = new Agent()
    const run = cb => {
      const events = []
      const r = request({url: 'http://localhost:' + port + '/', dispatcher: agent, time: true}, (err, res) => {
        t.equal(err, null)
        cb(events, res)
      })
      r.on('request', req => {
        req.on('connecting', (connection, socket) => {
          events.push('connecting ' + typeof socket)
          connection.once('lookup', () => events.push('lookup'))
          connection.once('connect', () => events.push('connect'))
        })
        req.on('reused', () => events.push('reused'))
      })
      r.on('socket', () => events.push('socket'))
    }
    run((first, res) => {
      t.deepEqual(first, ['connecting undefined', 'lookup', 'connect'])
      t.ok(res.timings.connect - res.timings.lookup < 1, 'lookup and connect are the same moment')
      t.ok(res.timings.socket <= res.timings.lookup)
      t.ok(res.timings.connect <= res.timings.response)
      run(second => {
        t.deepEqual(second, ['connecting undefined', 'lookup', 'connect'], 'a reused connection of the dispatcher reports the same events')
        agent.close().then(() => {
          server.close()
          t.end()
        })
      })
    })
  })
})

tape('with a dispatcher, the connect timeout covers the wait for the start of the request', t => {
  const held = []
  const holding = {dispatch (options, handler) {
    held.push(handler)
    return true
  }}
  const aborted = []
  const starting = {dispatch (options, handler) {
    setTimeout(() => handler.onRequestStart({abort: reason => aborted.push(reason && reason.code), pause () {}, resume () {}}, {}), 10)
    return true
  }}
  request({url: 'http://localhost:9/', dispatcher: holding, timeout: 50}, err => {
    t.equal(err && err.code, 'ETIMEDOUT', 'no start: connect timeout')
    t.equal(err && err.connect, true)
    t.equal(held.length, 1)
    request({url: 'http://localhost:9/', dispatcher: starting, timeout: 50}, err => {
      t.equal(err && err.code, 'ESOCKETTIMEDOUT', 'started, no response: read timeout')
      t.equal(err && err.connect, false)
      t.deepEqual(aborted, ['ECONNRESET'], 'the dispatcher hears the abort')
      t.end()
    })
  })
})

tape('abort before the start of the request sends nothing through a dispatcher', t => {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.end('no')
  })
  listen(server, port => {
    const agent = new Agent()
    const events = []
    const r = request.post({url: 'http://localhost:' + port + '/', dispatcher: agent})
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
      agent.close().then(() => {
        server.close()
        t.end()
      })
    }, 150)
  })
})

tape('closing the engine dispatchers leaves the caller dispatcher open', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    const agent = new Agent()
    request({url: 'http://localhost:' + port + '/', dispatcher: agent}, err => {
      t.equal(err, null)
      closeAll().then(() => {
        t.equal(agent.closed, false)
        request({url: 'http://localhost:' + port + '/', dispatcher: agent}, (err, res) => {
          t.equal(err, null)
          t.equal(res.statusCode, 200)
          agent.close().then(() => {
            server.close()
            t.end()
          })
        })
      })
    })
  })
})

'use strict'

const childProcess = require('child_process')
const dns = require('dns')
const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const os = require('os')
const path = require('path')
const tape = require('tape')
const request = require('../index')
const compare = require('./compare')
const {connectProxy, forwardingProxy} = require('./proxy-servers')
const inventory = require('./option-inventory')
const {closeAll} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))
const trusted = {key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}
const {normalizeRequest} = compare

const SOURCES = {
  options: (name, value) => ({options: {[name]: value}, option: name}),
  defaults: (name, value) => ({defaults: {[name]: value}, option: name}),
  agentOptions: (name, value) => ({options: {agentOptions: {[name]: value}}, option: 'agentOptions.' + name}),
  'defaults agentOptions': (name, value) => ({defaults: {agentOptions: {[name]: value}}, option: 'agentOptions.' + name}),
  'https.globalAgent.options': (name, value) => ({global: {https: {[name]: value}}, option: 'https.globalAgent.options.' + name, targets: ['https']}),
  'http.globalAgent.options': (name, value) => ({global: {http: {[name]: value}}, option: 'http.globalAgent.options.' + name, targets: ['http']})
}
const REQUEST_SOURCES = ['options', 'defaults', 'agentOptions', 'defaults agentOptions']
const GLOBAL_SOURCES = ['https.globalAgent.options', 'http.globalAgent.options']

function refusals () {
  const cases = []
  const add = (option, value, sources) => sources.forEach(source => {
    const built = SOURCES[source](option, value)
    built.label = source + ' ' + option
    cases.push(built)
  })
  const addAll = (group, sources) => Object.keys(group).forEach(name => add(name, group[name], sources))
  addAll(inventory.CONNECTION_OPTIONS, REQUEST_SOURCES.concat(GLOBAL_SOURCES))
  addAll(inventory.REQUEST_ONLY_OPTIONS, REQUEST_SOURCES.concat(GLOBAL_SOURCES))
  addAll(inventory.AGENT_OPTIONS_REFUSED_ON_THE_REQUEST, ['options', 'defaults'].concat(GLOBAL_SOURCES))
  addAll(inventory.COMPUTED_OPTIONS, REQUEST_SOURCES.concat(GLOBAL_SOURCES))
  addAll(inventory.AGENT_ONLY_OPTIONS, ['agentOptions', 'defaults agentOptions'])
  addAll(inventory.GLOBAL_ONLY_OPTIONS, GLOBAL_SOURCES)
  addAll(inventory.HTTP_GLOBAL_ONLY_OPTIONS, ['http.globalAgent.options'])
  inventory.NODE_AGENT_OPTIONS.forEach(entry => add(entry[0], entry[1](), ['options', 'defaults']))
  return cases
}

function listen (server, cb) {
  server.listen(0, () => cb(server.address().port))
}

function withGlobalAgentOptions (values, run) {
  const saved = []
  const modules = {http, https}
  Object.keys(values || {}).forEach(protocol => {
    const options = modules[protocol].globalAgent.options
    Object.keys(values[protocol]).forEach(name => {
      saved.push({options, name, had: Object.prototype.hasOwnProperty.call(options, name), value: options[name]})
      options[name] = values[protocol][name]
    })
  })
  run(() => {
    saved.forEach(entry => {
      if (entry.had) {
        entry.options[entry.name] = entry.value
      } else {
        delete entry.options[entry.name]
      }
    })
  })
}

function copyOptions (options, base) {
  return Object.defineProperties(base || {}, Object.getOwnPropertyDescriptors(options))
}

function fresh (options, name, make) {
  return Object.defineProperty(copyOptions(options), name, {enumerable: true, get: make})
}

function freshPool (options) {
  return fresh(options, 'pool', () => ({}))
}

function waitFor (condition, limit, cb) {
  const start = Date.now()
  const poll = () => {
    if (condition() || Date.now() - start > limit) {
      return cb(condition())
    }
    setTimeout(poll, 5)
  }
  poll()
}

function counted (server) {
  server.connections = 0
  server.requests = 0
  server.on('connection', () => server.connections++)
  server.on('request', () => server.requests++)
  return server
}

tape('options the engine cannot honour are refused from send, from every source, before anything is sent', t => {
  const plain = counted(http.createServer((req, res) => res.end('ok')))
  const secure = counted(https.createServer(trusted, (req, res) => res.end('ok')))
  const cases = []
  refusals().forEach(entry => {
    ;(entry.targets || ['http', 'https']).forEach(target => cases.push(Object.assign({target}, entry)))
  })
  listen(plain, plainPort => listen(secure, securePort => {
    const next = () => {
      const entry = cases.shift()
      if (!entry) {
        return setTimeout(() => {
          t.equal(plain.connections + secure.connections, 0, 'no connection reached a server')
          t.equal(plain.requests + secure.requests, 0, 'no request reached a server')
          plain.close()
          secure.close()
          closeAll().then(() => t.end())
        }, 50)
      }
      const url = entry.target === 'http' ? 'http://localhost:' + plainPort + '/' : 'https://localhost:' + securePort + '/'
      const api = entry.defaults ? request.defaults(entry.defaults) : request
      withGlobalAgentOptions(entry.global, restore => {
        api(Object.assign({url}, entry.options), (err, res) => {
          restore()
          const label = entry.target + ' ' + entry.label
          t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', label + ': code')
          t.equal(err && err.option, entry.option, label + ': option')
          t.equal(err && err.message.indexOf('request-compat-undici does not support the option ' + entry.option), 0, label + ': message')
          t.equal(res, undefined, label + ': no response')
          next()
        })
      })
    }
    next()
  }))
})

tape('setHost is overwritten by the core on every hop, so it acts as in Node', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, () => {
    compare({url: '/', setHost: true}, server, (err, rows) => {
      t.equal(err, null)
      t.equal(rows.node.error, null)
      t.equal(rows.engine.error, null)
      t.equal(normalizeRequest(rows.engine.bytes, true), normalizeRequest(rows.node.bytes, true))
      server.close()
      t.end()
    })
  })
})

tape('agent: false leaves the request on the shared keep-alive connections, as in Node', t => {
  const server = counted(http.createServer((req, res) => res.end('ok')))
  listen(server, port => {
    compare({url: '/', agent: false}, server, (err, rows) => {
      t.equal(err, null)
      t.equal(rows.node.error, null)
      t.equal(rows.engine.error, null)
      t.equal(normalizeRequest(rows.engine.bytes, true), normalizeRequest(rows.node.bytes, true))
      t.ok(/\r\nconnection: keep-alive\r\n/.test(normalizeRequest(rows.engine.bytes)), 'connection: keep-alive')
      closeAll().then(() => {
        const before = server.connections
        request({url: 'http://localhost:' + port + '/', agent: false}, err => {
          t.equal(err, null)
          request({url: 'http://localhost:' + port + '/', agent: false}, err => {
            t.equal(err, null)
            t.equal(server.connections - before, 1, 'the second request reuses the connection of the first')
            server.close()
            closeAll().then(() => t.end())
          })
        })
      })
    })
  })
})

tape('pool: false and a falsy agentOptions keepAlive open a connection per request with connection: close, as in Node', t => {
  const server = counted(http.createServer((req, res) => res.end('ok')))
  const variants = [
    {pool: false},
    freshPool({agentOptions: {keepAlive: false}}),
    freshPool({agentOptions: {keepAlive: 0}}),
    freshPool({agentOptions: {keepAlive: null}}),
    freshPool({agentOptions: {keepAlive: ''}})
  ]
  listen(server, port => {
    const next = () => {
      const options = variants.shift()
      if (!options) {
        server.close()
        return closeAll().then(() => t.end())
      }
      const label = JSON.stringify(options)
      compare(copyOptions(options, {url: '/'}), server, (err, rows) => {
        t.equal(err, null)
        t.equal(rows.node.error, null, label + ': Node')
        t.equal(rows.engine.error, null, label + ': engine')
        t.equal(normalizeRequest(rows.engine.bytes, true), normalizeRequest(rows.node.bytes, true), label + ': same request')
        t.ok(/\r\nconnection: close\r\n/.test(normalizeRequest(rows.engine.bytes)), label + ': connection: close')
        const before = server.connections
        request(Object.assign({url: 'http://localhost:' + port + '/'}, options), err => {
          t.equal(err, null)
          request(Object.assign({url: 'http://localhost:' + port + '/'}, options), err => {
            t.equal(err, null)
            t.equal(server.connections - before, 2, label + ': a new connection per request')
            next()
          })
        })
      })
    }
    next()
  })
})

tape('pool.maxSockets, agentOptions.maxSockets and the global agent maxSockets limit the connections, also as strings, as in Node', t => {
  let open = 0
  let most = 0
  const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), 30))
  server.on('connection', socket => {
    open++
    most = Math.max(most, open)
    socket.on('close', () => open--)
  })
  const globalLimit = value => () => {
    const saved = http.globalAgent.maxSockets
    http.globalAgent.maxSockets = value
    return () => {
      http.globalAgent.maxSockets = saved
    }
  }
  const variants = [
    {options: {pool: {maxSockets: 1}}},
    {options: {agentOptions: {maxSockets: 1}}},
    {options: {pool: {maxSockets: '1'}}},
    {options: {agentOptions: {maxSockets: '1'}}},
    {options: {pool: {maxSockets: 1}, agentOptions: {maxSockets: 5}}},
    {label: 'http.globalAgent.maxSockets 1', options: {}, setup: globalLimit(1)},
    {label: 'http.globalAgent.maxSockets \'1\'', options: {}, setup: globalLimit('1')}
  ]
  listen(server, port => {
    const next = () => {
      const variant = variants.shift()
      if (!variant) {
        server.close()
        return closeAll().then(() => t.end())
      }
      const label = variant.label || JSON.stringify(variant.options)
      const restore = variant.setup ? variant.setup() : () => {}
      most = 0
      let pending = 2
      const done = (err, res) => {
        t.equal(err, null)
        t.equal(res && res.statusCode, 200)
        if (--pending === 0) {
          restore()
          t.equal(most, 1, label + ': one connection at a time')
          closeAll().then(() => waitFor(() => open === 0, 1000, closed => {
            t.ok(closed, 'the connection is closed before the next variant')
            next()
          }))
        }
      }
      request(Object.assign({url: 'http://localhost:' + port + '/a'}, variant.options), done)
      request(Object.assign({url: 'http://localhost:' + port + '/b'}, variant.options), done)
    }
    next()
  })
})

tape('a maxSockets with which Node never opens a connection is refused', t => {
  const server = counted(http.createServer((req, res) => res.end('ok')))
  const rows = [
    {option: 'pool.maxSockets', options: {pool: {maxSockets: -1}}},
    {option: 'pool.maxSockets', options: {pool: {maxSockets: '0'}}},
    {option: 'agentOptions.maxSockets', options: {agentOptions: {maxSockets: 'none'}}},
    {option: 'http.globalAgent.maxSockets', options: {}, global: -1}
  ]
  listen(server, port => {
    const next = () => {
      const row = rows.shift()
      if (!row) {
        t.equal(server.connections, 0, 'nothing reached the server')
        return request({url: 'http://localhost:' + port + '/', pool: {maxSockets: 0}}, (err, res) => {
          t.equal(err, null)
          t.equal(res && res.statusCode, 200, 'maxSockets 0 is no limit, as in Node')
          server.close()
          closeAll().then(() => t.end())
        })
      }
      const saved = http.globalAgent.maxSockets
      if (row.global !== undefined) {
        http.globalAgent.maxSockets = row.global
      }
      request(Object.assign({url: 'http://localhost:' + port + '/'}, row.options), (err, res) => {
        http.globalAgent.maxSockets = saved
        t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', row.option)
        t.equal(err && err.option, row.option)
        t.equal(res, undefined)
        next()
      })
    }
    next()
  })
})

tape('pool.maxSockets Infinity is no limit, as in Node', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    let pending = 2
    const done = (err, res) => {
      t.equal(err, null)
      t.equal(res && res.statusCode, 200)
      if (--pending === 0) {
        server.close()
        closeAll().then(() => t.end())
      }
    }
    request({url: 'http://localhost:' + port + '/', pool: {maxSockets: Infinity}}, done)
    request({url: 'http://localhost:' + port + '/', pool: {maxSockets: Infinity}}, done)
  })
})

tape('forever and the agent options without an effect on undici are accepted', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  const variants = [
    {forever: true},
    {agentOptions: {keepAlive: true}},
    {agentOptions: {keepAliveMsecs: 1000}},
    {agentOptions: {maxFreeSockets: 1}},
    {agentOptions: {scheduling: 'fifo'}}
  ]
  listen(server, port => {
    const next = () => {
      const options = variants.shift()
      if (!options) {
        return request.forever().get('http://localhost:' + port + '/', (err, res) => {
          t.equal(err, null)
          t.equal(res && res.statusCode, 200, 'request.forever()')
          server.close()
          closeAll().then(() => t.end())
        })
      }
      request(Object.assign({url: 'http://localhost:' + port + '/'}, options), (err, res) => {
        t.equal(err, null)
        t.equal(res && res.statusCode, 200, JSON.stringify(options))
        next()
      })
    }
    next()
  })
})

tape('forever wins over agentOptions keepAlive: false, as in Node', t => {
  const server = counted(http.createServer((req, res) => res.end('ok')))
  const options = fresh(freshPool({forever: true}), 'agentOptions', () => ({keepAlive: false}))
  listen(server, port => {
    compare(copyOptions(options, {url: '/'}), server, (err, rows) => {
      t.equal(err, null)
      t.equal(rows.node.error, null)
      t.equal(rows.engine.error, null)
      t.equal(normalizeRequest(rows.engine.bytes, true), normalizeRequest(rows.node.bytes, true), 'same request')
      t.ok(/\r\nconnection: keep-alive\r\n/.test(normalizeRequest(rows.engine.bytes)), 'connection: keep-alive')
      closeAll().then(() => {
        const before = server.connections
        const url = 'http://localhost:' + port + '/'
        request(Object.assign({url}, options), err => {
          t.equal(err, null)
          request(Object.assign({url}, options), err => {
            t.equal(err, null)
            t.equal(server.connections - before, 1, 'the second request reuses the connection of the first')
            server.close()
            closeAll().then(() => t.end())
          })
        })
      })
    })
  })
})

tape('https.globalAgent.options are not checked for a tunnel, which does not use them in Node', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  const proxy = connectProxy()
  listen(server, () => listen(proxy, proxyPort => {
    withGlobalAgentOptions({https: {lookup: dns.lookup}}, restore => {
      compare({url: '/', proxy: 'http://localhost:' + proxyPort}, server, (err, rows) => {
        restore()
        t.equal(err, null)
        t.equal(rows.node.error && rows.node.error.code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'Node: the global agent options do not apply')
        t.equal(rows.engine.error && rows.engine.error.code, rows.node.error && rows.node.error.code, 'engine: no refusal, the same TLS error')
        t.equal(proxy.connects.length, 2)
        server.close()
        proxy.close()
        closeAll().then(() => t.end())
      })
    })
  }))
})

tape('NODE_USE_ENV_PROXY: refused only where Node\'s global agent has a proxy for the protocol, and also when NO_PROXY matches (skipped on a Node without proxyEnv)', t => {
  const handler = (req, res) => res.end('direct ' + req.url)
  const target = http.createServer(handler)
  const secureTarget = https.createServer(trusted, handler)
  const viaTunnel = https.createServer(trusted, (req, res) => res.end('via proxy ' + req.url))
  const unix = http.createServer(handler)
  const socketPath = path.join(os.tmpdir(), 'undici-env-proxy-' + process.pid + '.sock')
  const proxy = forwardingProxy()
  proxy.on('connect', (req, socket, head) => {
    const upstream = net.connect(viaTunnel.address().port, 'localhost', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const reason = 'NODE_USE_ENV_PROXY routes Node\'s global agent through a proxy; pass proxy or unset it'
  const servers = [target, secureTarget, viaTunnel, proxy]
  listen(target, targetPort => listen(secureTarget, securePort => listen(viaTunnel, () => listen(proxy, proxyPort => unix.listen(socketPath, () => {
    const httpUrl = 'http://localhost:' + targetPort + '/path'
    const httpsUrl = 'https://localhost:' + securePort + '/path'
    const proxyUrl = 'http://127.0.0.1:' + proxyPort
    const runs = [
      {label: 'HTTP_PROXY, http request', env: {HTTP_PROXY: proxyUrl}, url: httpUrl, engine: 'refused', node: 'via', core: 'via'},
      {label: 'no proxy variable', env: {}, url: httpUrl, engine: 'direct', node: 'direct', core: 'direct'},
      {label: 'HTTPS_PROXY only, http request', env: {HTTPS_PROXY: proxyUrl}, url: httpUrl, engine: 'direct', node: 'direct', core: 'direct'},
      {label: 'HTTP_PROXY and a matching NO_PROXY, http request', env: {HTTP_PROXY: proxyUrl, NO_PROXY: 'localhost'}, url: httpUrl, engine: 'refused', node: 'direct', core: 'refused'},
      {label: 'HTTPS_PROXY, https request', env: {HTTPS_PROXY: proxyUrl}, url: httpsUrl, engine: 'refused', node: 'via', core: 'via'},
      {label: 'HTTP_PROXY only, https request', env: {HTTP_PROXY: proxyUrl}, url: httpsUrl, engine: 'direct', node: 'direct', core: 'via'},
      {label: 'https_proxy wins over HTTPS_PROXY, https request', env: {https_proxy: proxyUrl, HTTPS_PROXY: 'socks5://127.0.0.1:1'}, url: httpsUrl, engine: 'refused', node: 'via', core: 'unreachable'}
    ]
    const finish = () => {
      servers.concat(unix).forEach(server => server.close())
      t.end()
    }
    const next = () => {
      const run = runs.shift()
      if (!run) {
        return finish()
      }
      const env = Object.assign({}, process.env, {NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: path.join(ssl, 'ca', 'ca.crt')})
      ;['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'NO_PROXY', 'no_proxy'].forEach(name => delete env[name])
      Object.assign(env, run.env)
      childProcess.execFile(process.execPath, [path.join(__dirname, 'env-proxy-child.js'), run.url, socketPath], {env, timeout: 60000}, (err, stdout, stderr) => {
        t.equal(err, null, stderr)
        const out = JSON.parse(stdout)
        if (!out.proxyEnv) {
          t.skip('this Node has no proxyEnv on its global agent')
          return finish()
        }
        const result = name => out.results.filter(entry => entry.name === name)[0]
        const label = run.label + ': '
        const agent = run.url === httpsUrl ? 'https.globalAgent' : 'http.globalAgent'
        const bodies = {via: run.url === httpsUrl ? 'via proxy /path' : 'via proxy ' + run.url, direct: 'direct /path'}
        const expect = (name, outcome, text) => {
          if (outcome === 'unreachable') {
            t.equal(result(name).code, 'ECONNRESET', label + name + ': ' + text + ' uses HTTPS_PROXY, which is not reachable')
          } else if (outcome === 'refused') {
            t.equal(result(name).code, 'OPTION_NOT_SUPPORTED', label + name + ': ' + text)
            t.equal(result(name).option, agent + '.options.proxyEnv')
            t.equal(result(name).message, 'request-compat-undici does not support the option ' + agent + '.options.proxyEnv: ' + reason)
          } else {
            t.equal(result(name).code, null, label + name + ': ' + text)
            t.equal(result(name).body, bodies[outcome], label + name + ': ' + outcome)
          }
        }
        expect('proxy: null', run.engine, 'engine')
        expect('proxy: false', run.engine, 'engine')
        expect('Node transport, proxy: null', run.node, 'Node transport')
        expect('no proxy option', run.core, 'the core\'s own proxy decision')
        expect('pool: false, proxy: null', 'direct', 'pool: false does not use the global agent')
        t.equal(result('unix socket, proxy: null').body, 'direct /unix', label + 'a unix socket is never proxied')
        t.equal(result('Node transport, unix socket, proxy: null').body, 'direct /unix', label + 'Node does not proxy a unix socket either')
        next()
      })
    }
    next()
  })))))
})

tape('tls.connect options reach the TLS context from every source, as in Node', t => {
  const server = https.createServer(Object.assign({maxVersion: 'TLSv1.2'}, trusted), (req, res) => res.end('ok'))
  const rows = [
    {label: 'control', options: {ca}, ok: true},
    {label: 'request options', options: {ca, minVersion: 'TLSv1.3'}},
    {label: 'agentOptions', options: freshPool({agentOptions: {ca, minVersion: 'TLSv1.3'}})},
    {label: 'https.globalAgent.options', options: {}, global: {https: {ca, minVersion: 'TLSv1.3'}}},
    {label: 'https.globalAgent.options control', options: {}, global: {https: {ca}}, ok: true}
  ]
  listen(server, () => {
    const next = () => {
      const row = rows.shift()
      if (!row) {
        server.close()
        return closeAll().then(() => t.end())
      }
      withGlobalAgentOptions(row.global, restore => {
        compare(copyOptions(row.options, {url: '/'}), server, (err, result) => {
          restore()
          t.equal(err, null)
          if (row.ok) {
            t.equal(result.node.error, null, row.label + ': Node accepts')
            t.equal(result.engine.error, null, row.label + ': engine accepts')
            t.equal(result.engine.statusCode, 200)
          } else {
            t.ok(result.node.error, row.label + ': Node fails')
            t.ok(result.engine.error, row.label + ': engine fails')
            t.notEqual(result.engine.error && result.engine.error.code, 'OPTION_NOT_SUPPORTED', row.label + ': in the handshake')
            t.equal(result.engine.statusCode, undefined)
          }
          next()
        })
      })
    }
    next()
  })
})

tape('maxHeaderSize limits the response headers, as in Node', t => {
  const server = http.createServer((req, res) => {
    res.setHeader('x-large', 'x'.repeat(req.url === '/small' ? 200 : 20000))
    res.end('ok')
  })
  const rows = [
    {options: {url: '/small', maxHeaderSize: 100}},
    {options: {url: '/small'}, ok: true},
    {options: {url: '/small', maxHeaderSize: 0}, ok: true},
    {options: {url: '/large'}},
    {options: {url: '/large', maxHeaderSize: 30000}, ok: true}
  ]
  listen(server, () => {
    const next = () => {
      const row = rows.shift()
      if (!row) {
        server.close()
        return closeAll().then(() => t.end())
      }
      const label = JSON.stringify(row.options)
      compare(row.options, server, (err, result) => {
        t.equal(err, null)
        if (row.ok) {
          t.equal(result.node.error, null, label + ': Node accepts')
          t.equal(result.engine.error, null, label + ': engine accepts')
          t.equal(result.engine.statusCode, 200)
        } else {
          t.equal(result.node.error && result.node.error.code, 'HPE_HEADER_OVERFLOW', label + ': Node fails')
          t.equal(result.engine.error && result.engine.error.code, 'UND_ERR_HEADERS_OVERFLOW', label + ': engine fails')
        }
        next()
      })
    }
    next()
  })
})

tape('a maxHeaderSize that Node rejects gives Node\'s error from send', t => {
  const server = counted(http.createServer((req, res) => res.end('ok')))
  const values = [null, NaN, '100', -1, 1.5, Infinity]
  listen(server, () => {
    const next = () => {
      if (!values.length) {
        t.equal(server.requests, 0, 'nothing reached the server')
        server.close()
        return closeAll().then(() => t.end())
      }
      const value = values.shift()
      compare({url: '/', maxHeaderSize: value}, server, (err, rows) => {
        const label = String(value)
        t.equal(err, null)
        t.ok(rows.node.error, label + ': Node fails')
        t.equal(rows.engine.error && rows.engine.error.code, rows.node.error && rows.node.error.code, label + ': same code')
        t.equal(rows.engine.error && rows.engine.error.message, rows.node.error && rows.node.error.message, label + ': same message')
        next()
      })
    }
    next()
  })
})

tape('hostname and protocol equal to the values of the hop act as in Node', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, () => {
    compare({url: '/', hostname: 'localhost', protocol: 'http:'}, server, (err, rows) => {
      t.equal(err, null)
      t.equal(rows.node.error, null)
      t.equal(rows.engine.error, null)
      t.equal(normalizeRequest(rows.engine.bytes, true), normalizeRequest(rows.node.bytes, true))
      server.close()
      closeAll().then(() => t.end())
    })
  })
})

tape('allowHalfOpen and highWaterMark are accepted without an effect on the wire, as in Node', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, () => {
    compare({url: '/', allowHalfOpen: true, highWaterMark: 1}, server, (err, rows) => {
      t.equal(err, null)
      t.equal(rows.node.error, null)
      t.equal(rows.engine.error, null)
      t.equal(rows.engine.body, rows.node.body)
      t.equal(normalizeRequest(rows.engine.bytes, true), normalizeRequest(rows.node.bytes, true))
      server.close()
      closeAll().then(() => t.end())
    })
  })
})

tape('maxHeaderSize applies through a tunnel, as in Node', t => {
  const server = http.createServer((req, res) => {
    res.setHeader('x-large', 'x'.repeat(200))
    res.end('ok')
  })
  const proxy = connectProxy()
  listen(server, () => listen(proxy, proxyPort => {
    const proxyUrl = 'http://localhost:' + proxyPort
    compare({url: '/', proxy: proxyUrl, tunnel: true, maxHeaderSize: 100}, server, (err, refused) => {
      t.equal(err, null)
      t.equal(refused.node.error && refused.node.error.code, 'HPE_HEADER_OVERFLOW', 'Node fails')
      t.equal(refused.engine.error && refused.engine.error.code, 'UND_ERR_HEADERS_OVERFLOW', 'engine fails')
      compare({url: '/', proxy: proxyUrl, tunnel: true}, server, (err, accepted) => {
        t.equal(err, null)
        t.equal(accepted.node.error, null, 'Node accepts without the limit')
        t.equal(accepted.engine.error, null, 'engine accepts without the limit')
        t.equal(proxy.connects.length, 4, 'every request went through the proxy')
        server.close()
        proxy.close()
        closeAll().then(() => t.end())
      })
    })
  }))
})

tape('family is passed to the connection, as in Node', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(0, '127.0.0.1', () => {
    const url = port => 'http://localhost:' + port + '/'
    compare({url, family: 4}, server, (err, four) => {
      t.equal(err, null)
      t.equal(four.node.body, 'ok', 'Node: family 4 reaches the server on 127.0.0.1')
      t.equal(four.engine.body, 'ok', 'engine: family 4 reaches the server on 127.0.0.1')
      compare({url, family: 6}, server, (err, six) => {
        t.equal(err, null)
        t.ok(six.node.error, 'Node: family 6 does not reach the server on 127.0.0.1')
        t.equal(six.engine.error && six.engine.error.code, six.node.error && six.node.error.code, 'engine: the same error')
        server.close()
        closeAll().then(() => t.end())
      })
    })
  })
})

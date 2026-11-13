'use strict'

const fs = require('fs')
const http = require('http')
const http2 = require('http2')
const https = require('https')
const net = require('net')
const os = require('os')
const path = require('path')
const tape = require('tape')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {forwardingProxy, connectProxy} = require('./proxy-servers')
const {dispatcherFor, cacheSize, oneOffCount, closeAll} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const read = (...parts) => fs.readFileSync(path.join(ssl, ...parts))
const ca = read('ca', 'ca.crt')
const trusted = {key: read('ca', 'localhost.key'), cert: read('ca', 'localhost.crt')}
const selfSigned = {key: read('self-signed.key'), cert: read('self-signed.crt')}
const ipCert = {key: fs.readFileSync(path.join(__dirname, 'fixtures', 'ip.key')), cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'ip.crt'))}

function basic (text) {
  return 'Basic ' + Buffer.from(text).toString('base64')
}

function listen (server, cb) {
  server.listen(0, () => cb(server.address().port))
}

function closeServers (t, servers) {
  servers.forEach(server => server.close())
  closeAll().then(() => t.end())
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

function targetOf (factory, seen) {
  const server = factory((req, res) => {
    seen.push({url: req.url, headers: req.headers})
    res.end('target ' + req.url)
  })
  return server
}

function lifecycleOf (r, events) {
  r.on('request', req => {
    req.on('connecting', connection => {
      events.push('connecting')
      connection.once('lookup', () => events.push('lookup'))
      connection.once('connect', () => events.push('connect'))
    })
    req.on('reused', () => events.push('reused'))
  })
}

function names (rawHeaders) {
  const list = []
  for (let i = 0; i < rawHeaders.length; i += 2) {
    list.push(rawHeaders[i].toLowerCase() + ': ' + rawHeaders[i + 1])
  }
  return list.sort()
}

function both (options, cb) {
  const results = {}
  const run = (name, api, next) => {
    const events = []
    const r = api(Object.assign({}, options), (error, response, body) => {
      results[name] = {error, response, body, events}
      next()
    })
    lifecycleOf(r, events)
  }
  run('node', nodeApi, () => run('engine', engineApi, () => cb(results.node, results.engine)))
}

function setEnvironment (name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function afterRejectUnauthorizedUnset (api, options, cb) {
  const results = []
  const step = () => {
    setEnvironment('NODE_TLS_REJECT_UNAUTHORIZED', results.length === 0 ? '0' : undefined)
    api(Object.assign({}, options), (error, response) => {
      results.push(error ? error.code : response.statusCode)
      if (results.length < 3) {
        return setTimeout(step, 20)
      }
      cb(results)
    })
  }
  step()
}

tape('http target through a forwarding proxy', t => {
  const proxy = forwardingProxy()
  listen(proxy, port => {
    const options = {
      url: 'http://target.invalid:81/path?a=1',
      proxy: 'http://localhost:' + port,
      headers: {'Proxy-Authorization': 'Basic Zm9vOmJhcg==', 'X-Custom': 'yes'}
    }
    both(options, (node, engine) => {
      t.equal(node.error, null)
      t.equal(engine.error, null)
      t.equal(engine.response.statusCode, 200)
      t.equal(engine.body, 'via proxy http://target.invalid:81/path?a=1')
      t.deepEqual(engine.body, node.body)
      t.equal(proxy.seen.length, 2)
      const [nodeSeen, engineSeen] = proxy.seen
      t.equal(engineSeen.method + ' ' + engineSeen.url, 'GET http://target.invalid:81/path?a=1')
      t.deepEqual(names(engineSeen.rawHeaders), names(nodeSeen.rawHeaders), 'the proxy sees the headers of the Node transport')
      t.ok(engineSeen.rawHeaders.indexOf('Proxy-Authorization') !== -1, 'Proxy-Authorization keeps the caller case')
      t.equal(engineSeen.headers['proxy-authorization'], 'Basic Zm9vOmJhcg==')
      t.deepEqual(engine.events, ['connecting', 'lookup', 'connect'])
      t.deepEqual(engine.events, node.events, 'the lifecycle of the proxy connection equals the Node transport')
      closeServers(t, [proxy])
    })
  })
})

tape('proxy credentials of the URL become Proxy-Authorization of a forwarded request', t => {
  const proxy = forwardingProxy()
  listen(proxy, port => {
    both({url: 'http://target.invalid/', proxy: 'http://user:p%40ss@localhost:' + port}, (node, engine) => {
      t.equal(engine.error, null)
      t.equal(proxy.seen[0].headers['proxy-authorization'], basic('user:p@ss'))
      t.equal(proxy.seen[1].headers['proxy-authorization'], proxy.seen[0].headers['proxy-authorization'])
      closeServers(t, [proxy])
    })
  })
})

tape('407 from a forwarding proxy is a response', t => {
  const proxy = forwardingProxy({status: 407})
  listen(proxy, port => {
    both({url: 'http://target.invalid/', proxy: 'http://localhost:' + port}, (node, engine) => {
      t.equal(node.error, null)
      t.equal(engine.error, null)
      t.equal(engine.response.statusCode, 407)
      t.equal(engine.response.statusCode, node.response.statusCode)
      t.equal(engine.body, 'need auth')
      t.equal(engine.response.headers['proxy-authenticate'], 'Basic realm="proxy"')
      closeServers(t, [proxy])
    })
  })
})

tape('an https target is forwarded as an absolute URL with tunnel: false, as in Node', t => {
  const proxy = forwardingProxy()
  listen(proxy, port => {
    both({url: 'https://target.invalid/secure', proxy: 'http://localhost:' + port, tunnel: false}, (node, engine) => {
      t.equal(node.error, null)
      t.equal(engine.error, null)
      t.equal(engine.body, 'via proxy https://target.invalid/secure')
      t.equal(proxy.seen.length, 2)
      t.equal(proxy.seen[1].url, proxy.seen[0].url)
      closeServers(t, [proxy])
    })
  })
})

tape('https target through CONNECT: the proxy sees the headers of the core, the target none of the proxy', t => {
  const seen = []
  const target = targetOf(handler => https.createServer(trusted, handler), seen)
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {
      url: 'https://localhost:' + targetPort + '/tunnelled',
      ca,
      proxy: 'http://user:pass@localhost:' + proxyPort,
      headers: {
        'User-Agent': 'tunnel-test',
        'Accept': 'text/plain',
        'Content-Type': 'text/x',
        'Proxy-Authorization': 'Basic Zm9vOmJhcg==',
        'X-White': 'w',
        'X-Excl': 'e',
        'X-Target': 't'
      },
      proxyHeaderWhiteList: ['x-white'],
      proxyHeaderExclusiveList: ['x-excl']
    }
    both(options, (node, engine) => {
      t.equal(node.error, null)
      t.equal(engine.error, null)
      t.equal(engine.response.statusCode, 200)
      t.equal(engine.body, 'target /tunnelled')
      const [nodeConnect, engineConnect] = proxy.connects
      t.equal(engineConnect.url, 'localhost:' + targetPort)
      const expected = names(nodeConnect.rawHeaders)
      const actual = names(engineConnect.rawHeaders)
      t.deepEqual(actual.filter(line => line.indexOf('proxy-connection:') !== 0), expected, 'every header of the Node transport reaches the proxy')
      t.ok(actual.indexOf('proxy-connection: keep-alive') !== -1, 'undici adds proxy-connection')
      t.equal(actual.filter(line => line.indexOf('proxy-authorization:') === 0).length, 1, 'one Proxy-Authorization')
      t.equal(engineConnect.headers['proxy-authorization'], basic('user:pass'), 'the URL credentials win')
      t.equal(engineConnect.headers['x-excl'], 'e', 'the exclusive list goes to the proxy')
      t.equal(engineConnect.headers['x-white'], 'w')
      t.equal(engineConnect.headers['x-target'], undefined, 'other headers stay off the CONNECT')
      const targetSeen = seen[1]
      t.deepEqual(Object.keys(targetSeen.headers).filter(name => name.indexOf('proxy-') === 0), [], 'the target sees no proxy header')
      t.equal(targetSeen.headers['x-excl'], undefined, 'the exclusive list stays off the target')
      t.equal(targetSeen.headers['x-target'], 't')
      t.equal(targetSeen.headers['x-white'], 'w')
      closeServers(t, [target, proxy])
    })
  }))
})

tape('Proxy-Authorization of the URL: user only, and a lower-case caller header', t => {
  const seen = []
  const target = targetOf(handler => http.createServer(handler), seen)
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const url = 'http://localhost:' + targetPort + '/'
    engineApi({url, proxy: 'http://user@localhost:' + proxyPort, tunnel: true}, (err, res) => {
      t.equal(err, null)
      t.equal(proxy.connects[0].headers['proxy-authorization'], basic('user'), 'user without a colon, as tunnel-agent')
      engineApi({url, proxy: 'http://u:p@localhost:' + proxyPort, tunnel: true, headers: {'proxy-authorization': 'Basic bG93ZXI='}}, (err, res) => {
        t.equal(err, null)
        t.equal(proxy.connects[1].rawHeaders.filter(name => name.toLowerCase() === 'proxy-authorization').length, 1, 'one header, not two as in tunnel-agent')
        t.equal(proxy.connects[1].headers['proxy-authorization'], basic('u:p'))
        engineApi({url, proxy: 'http://localhost:' + proxyPort, tunnel: true, headers: {'Proxy-Authorization': 'Basic bG93ZXI='}}, (err, res) => {
          t.equal(err, null)
          t.equal(proxy.connects[2].headers['proxy-authorization'], 'Basic bG93ZXI=', 'a caller header without URL credentials stays')
          closeServers(t, [target, proxy])
        })
      })
    })
  }))
})

tape('tunnel: true for an http target uses CONNECT', t => {
  const seen = []
  const target = targetOf(handler => http.createServer(handler), seen)
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    both({url: 'http://localhost:' + targetPort + '/plain', proxy: 'http://localhost:' + proxyPort, tunnel: true}, (node, engine) => {
      t.equal(node.error, null)
      t.equal(engine.error, null)
      t.equal(engine.body, 'target /plain')
      t.equal(proxy.connects.length, 2)
      t.equal(proxy.connects[1].url, 'localhost:' + targetPort)
      t.equal(engine.events[0], 'reused', 'the lifecycle starts with reused, as in Node')
      t.deepEqual(engine.events, node.events)
      closeServers(t, [target, proxy])
    })
  }))
})

tape('every request opens its own tunnel, as in Node', t => {
  const seen = []
  const target = targetOf(handler => https.createServer(trusted, handler), seen)
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {url: 'https://localhost:' + targetPort + '/', ca, proxy: 'http://localhost:' + proxyPort}
    const twice = (api, cb) => api(options, err => {
      t.equal(err, null)
      api(options, err => {
        t.equal(err, null)
        cb()
      })
    })
    twice(nodeApi, () => {
      t.equal(proxy.connects.length, 2, 'Node: a CONNECT per request')
      twice(engineApi, () => {
        t.equal(proxy.connects.length, 4, 'engine: a CONNECT per request')
        t.deepEqual(seen.map(entry => entry.headers.connection), ['close', 'close', 'close', 'close'], 'the request asks the target to close, as the tunnel agent does')
        closeServers(t, [target, proxy])
      })
    })
  }))
})

tape('407 to CONNECT is an error of the request', t => {
  const seen = []
  const target = targetOf(handler => https.createServer(trusted, handler), seen)
  const proxy = connectProxy({status: 407})
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {url: 'https://localhost:' + targetPort + '/', ca, proxy: 'http://localhost:' + proxyPort, time: true}
    const start = Date.now()
    const nodeEvents = []
    const nodeRequest = nodeApi(options, nodeErr => {
      const events = []
      const request = engineApi(options, (err, res) => {
        t.ok(Date.now() - start < 1000, 'within a second')
        t.ok(err && err.message.indexOf('tunneling socket could not be established, statusCode=407') === 0, err && err.message)
        t.equal(err && err.code, 'ECONNRESET')
        t.equal(err && err.message, nodeErr.message, 'the message of the Node transport')
        t.equal(err && err.code, nodeErr.code)
        t.equal(res, undefined)
        t.equal(seen.length, 0, 'no request reached the target')
        t.deepEqual(events, [], 'no reused for a refused CONNECT')
        t.deepEqual(events, nodeEvents, 'the events of the Node transport')
        t.deepEqual(request.timings, nodeRequest.timings, 'the timings of the Node transport')
        closeServers(t, [target, proxy])
      })
      lifecycleOf(request, events)
    })
    lifecycleOf(nodeRequest, nodeEvents)
  }))
})

tape('a proxy that refuses the connection or hangs up gives the tunnel error of Node', t => {
  const hangup = net.createServer(socket => socket.destroy())
  const refused = net.createServer()
  listen(refused, closedPort => {
    refused.close(() => {
      listen(hangup, hangupPort => {
        const check = (proxyPort, name, next) => {
          const options = {url: 'https://localhost:9/', proxy: 'http://localhost:' + proxyPort}
          nodeApi(options, nodeErr => {
            engineApi(options, err => {
              t.ok(err, name + ': an error')
              t.equal(err && err.code, 'ECONNRESET', name)
              t.ok(err && err.message.indexOf('tunneling socket could not be established, cause=') === 0, name + ': ' + (err && err.message))
              t.equal(err && err.message.replace(/\d+/g, 'N'), nodeErr.message.replace(/\d+/g, 'N'), name + ': the message of the Node transport')
              next()
            })
          })
        }
        check(closedPort, 'refused', () => check(hangupPort, 'hangup', () => closeServers(t, [hangup])))
      })
    })
  })
})

tape('timeout through a tunnel is ESOCKETTIMEDOUT and the timings are those of a reused socket', t => {
  const target = https.createServer(trusted, (req, res) => {
    res.writeHead(200)
    res.flushHeaders()
  })
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {url: 'https://localhost:' + targetPort + '/', ca, proxy: 'http://localhost:' + proxyPort, timeout: 100}
    both(options, (node, engine) => {
      t.equal(node.error && node.error.code, 'ESOCKETTIMEDOUT')
      t.equal(engine.error && engine.error.code, 'ESOCKETTIMEDOUT')
      t.notEqual(engine.error && engine.error.connect, true, 'not a connect timeout')
      t.deepEqual(engine.events, ['reused'])
      t.deepEqual(engine.events, node.events)
      const timed = Object.assign({}, options, {timeout: undefined, time: true, url: 'https://localhost:' + targetPort + '/'})
      delete timed.timeout
      const fast = https.createServer(trusted, (req, res) => res.end('fast'))
      listen(fast, fastPort => {
        timed.url = 'https://localhost:' + fastPort + '/'
        engineApi(timed, (err, res) => {
          t.equal(err, null)
          t.equal(res.timings.connect, res.timings.socket, 'connect equals socket')
          t.equal(res.timings.lookup, res.timings.socket)
          closeServers(t, [target, proxy, fast])
        })
      })
    })
  }))
})

tape('a stalled CONNECT does not report a connect timeout', t => {
  const proxy = connectProxy({delay: 400})
  const target = http.createServer((req, res) => res.end('late'))
  listen(target, targetPort => listen(proxy, proxyPort => {
    engineApi({url: 'http://localhost:' + targetPort + '/', proxy: 'http://localhost:' + proxyPort, tunnel: true, timeout: 200}, (err, res, body) => {
      t.equal(err, null, 'the timeout counts from the established tunnel')
      t.equal(body, 'late')
      closeServers(t, [target, proxy])
    })
  }))
})

tape('a CONNECT the proxy never answers has no headers or body timeout, as in Node', t => {
  const undici = require('undici')
  const Pool = undici.Pool
  const built = []
  undici.Pool = class extends Pool {
    constructor (origin, options) {
      super(origin, options)
      built.push({origin: String(origin), options})
    }
  }
  const file = require.resolve('../lib/dispatchers')
  const loaded = require.cache[file]
  delete require.cache[file]
  const spied = require('../lib/dispatchers')
  require.cache[file] = loaded
  undici.Pool = Pool
  spied.dispatcherFor({uri: {protocol: 'https:', hostname: 'localhost'}, proxy: {protocol: 'http:', hostname: 'localhost', port: '3128'}, tunnel: true}, {})
  t.deepEqual(built.map(entry => entry.origin), ['http://localhost:3128/'], 'one Pool to the proxy')
  t.equal(built[0].options.headersTimeout, 0, 'no headers timeout for the CONNECT')
  t.equal(built[0].options.bodyTimeout, 0, 'no body timeout for the CONNECT')
  spied.closeAll().then(() => t.end())
})

tape('abort while the proxy answers CONNECT: no error, nothing reaches the target', t => {
  const seen = []
  const target = targetOf(handler => http.createServer(handler), seen)
  const proxy = connectProxy({delay: 300})
  listen(target, targetPort => listen(proxy, proxyPort => {
    const events = []
    const r = engineApi({url: 'http://localhost:' + targetPort + '/', proxy: 'http://localhost:' + proxyPort, tunnel: true}, err => events.push('callback ' + (err && err.message)))
    r.on('error', err => events.push('error ' + err.message))
    setTimeout(() => r.abort(), 50)
    setTimeout(() => {
      t.deepEqual(events, [], 'no callback and no error after abort')
      t.equal(seen.length, 0)
      closeServers(t, [target, proxy])
    }, 700)
  }))
})

tape('NO_PROXY match connects directly', t => {
  const seen = []
  const target = targetOf(handler => http.createServer(handler), seen)
  const proxy = forwardingProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const saved = {http: process.env.HTTP_PROXY, none: process.env.NO_PROXY, lower: process.env.http_proxy}
    process.env.HTTP_PROXY = 'http://localhost:' + proxyPort
    delete process.env.http_proxy
    const restore = () => {
      ;[['HTTP_PROXY', saved.http], ['NO_PROXY', saved.none], ['http_proxy', saved.lower]].forEach(entry => {
        if (entry[1] === undefined) {
          delete process.env[entry[0]]
        } else {
          process.env[entry[0]] = entry[1]
        }
      })
    }
    const url = 'http://localhost:' + targetPort + '/direct'
    process.env.NO_PROXY = 'localhost'
    engineApi({url}, (err, res, body) => {
      t.equal(err, null)
      t.equal(body, 'target /direct', 'direct')
      t.equal(proxy.seen.length, 0, 'the proxy saw nothing')
      process.env.NO_PROXY = 'other.example'
      engineApi({url}, (err, res, body) => {
        t.equal(err, null)
        t.equal(body, 'via proxy ' + url, 'through the proxy from HTTP_PROXY when NO_PROXY does not match')
        restore()
        closeServers(t, [target, proxy])
      })
    })
  }))
})

tape('unix socket URL', t => {
  const socketPath = path.join(os.tmpdir(), 'undici-proxy-' + process.pid + '.sock')
  const server = http.createServer((req, res) => res.end('unix ' + req.url))
  server.listen(socketPath, () => {
    engineApi({url: 'http://unix:' + socketPath + ':/path'}, (err, res, body) => {
      t.equal(err, null)
      t.equal(res.statusCode, 200)
      t.equal(body, 'unix /path')
      const a = dispatcherFor({uri: {protocol: 'http:'}, socketPath}).dispatcher
      const b = dispatcherFor({uri: {protocol: 'http:'}, socketPath: socketPath + '.other'}).dispatcher
      t.notEqual(a, b, 'the socket path is part of the dispatcher key')
      closeServers(t, [server])
    })
  })
})

tape('a unix socket URL cannot be tunnelled', t => {
  engineApi({url: 'https://unix:/tmp/none.sock:/path', proxy: 'http://localhost:9', tunnel: true}, err => {
    t.equal(err && err.code, 'OPTION_NOT_SUPPORTED')
    t.equal(err && err.option, 'socketPath')
    t.end()
  })
})

tape('a socks5 proxy URL is spoken as HTTP, as in Node', t => {
  const seen = []
  const target = targetOf(handler => https.createServer(trusted, handler), seen)
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    both({url: 'https://localhost:' + targetPort + '/socks', ca, proxy: 'socks5://localhost:' + proxyPort}, (node, engine) => {
      t.equal(node.error, null)
      t.equal(engine.error, null)
      t.equal(engine.body, 'target /socks')
      const connect = 'localhost:' + targetPort
      t.deepEqual(proxy.connects.map(entry => entry.url), [connect, connect], 'the proxy sees a CONNECT from each transport')
      both({url: 'http://localhost:81/', proxy: 'socks5://localhost:' + proxyPort}, (node, engine) => {
        t.equal(node.error && node.error.message, 'Invalid protocol: socks5:')
        t.equal(engine.error && engine.error.message, node.error.message, 'a forwarded request is refused by the core, as in Node')
        t.equal(proxy.connects.length, 2)
        closeServers(t, [target, proxy])
      })
    })
  }))
})

tape('an https target that negotiates HTTP/2 stays on HTTP/1.1 through a tunnel', t => {
  const target = http2.createSecureServer(Object.assign({allowHTTP1: true}, trusted), (req, res) => res.end('version ' + req.httpVersion))
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    engineApi({url: 'https://localhost:' + targetPort + '/', ca, proxy: 'http://localhost:' + proxyPort}, (err, res, body) => {
      t.equal(err, null)
      t.equal(body, 'version 1.1')
      t.equal(res.httpVersion, '1.1')
      closeServers(t, [target, proxy])
    })
  }))
})

tape('a certificate that is not trusted fails through the tunnel with the TLS error, not the tunnel error', t => {
  const target = https.createServer(selfSigned, (req, res) => res.end('x'))
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {url: 'https://localhost:' + targetPort + '/', proxy: 'http://localhost:' + proxyPort}
    both(options, (node, engine) => {
      t.equal(node.error && node.error.code, 'DEPTH_ZERO_SELF_SIGNED_CERT')
      t.equal(engine.error && engine.error.code, 'DEPTH_ZERO_SELF_SIGNED_CERT')
      closeServers(t, [target, proxy])
    })
  }))
})

tape('http target through an https forwarding proxy', t => {
  const proxy = https.createServer(trusted, (req, res) => res.end('via tls proxy ' + req.url))
  listen(proxy, port => {
    both({url: 'http://localhost:81/p', proxy: 'https://localhost:' + port, ca}, (node, engine) => {
      t.equal(node.error, null)
      t.equal(engine.error, null)
      t.equal(engine.body, 'via tls proxy http://localhost:81/p')
      t.deepEqual(engine.events, node.events)
      closeServers(t, [proxy])
    })
  })
})

tape('tunnel dispatchers: one per proxy, headers and TLS context, none left open after closeAll', t => {
  const self = (extra, proxyAuth) => Object.assign({
    uri: {protocol: 'https:', hostname: 'localhost'},
    proxy: {protocol: 'http:', hostname: 'localhost', port: '3128', auth: proxyAuth},
    tunnel: true
  }, extra)
  const headers = {'user-agent': 'a', host: 'localhost:443'}
  const base = cacheSize()
  const a = dispatcherFor(self({}), headers).dispatcher
  t.equal(dispatcherFor(self({}), Object.assign({}, headers)).dispatcher, a, 'same proxy, headers and context')
  t.notEqual(dispatcherFor(self({}), {'user-agent': 'b', host: 'localhost:443'}).dispatcher, a, 'other headers')
  t.notEqual(dispatcherFor(self({}, 'u:p'), headers).dispatcher, a, 'other proxy credentials')
  t.notEqual(dispatcherFor(self({ca: ca}), headers).dispatcher, a, 'other TLS context')
  t.equal(dispatcherFor(self({}), {'user-agent': 'a', host: 'other:443'}).dispatcher, a, 'the host header of the CONNECT does not split dispatchers for an http proxy')
  const secure = proxy => ({protocol: 'https:', hostname: 'localhost', port: '3129'})
  const viaTls = host => dispatcherFor(Object.assign(self({}), {proxy: secure()}), {'user-agent': 'a', host}).dispatcher
  t.notEqual(viaTls('one.example:443'), viaTls('two.example:443'), 'an https proxy is checked against the target host name, so the host splits dispatchers')
  t.equal(viaTls('one.example:443'), viaTls('one.example:443'))
  t.equal(oneOffCount(), 0)
  const one = dispatcherFor(self({pool: false}), headers)
  t.equal(one.oneOff, true, 'pool false: a dispatcher of its own')
  t.equal(oneOffCount(), 1)
  t.ok(cacheSize() > base)
  closeAll().then(() => {
    t.equal(cacheSize(), 0)
    t.equal(oneOffCount(), 0)
    t.end()
  })
})

tape('CONNECT headers that contain the separators of the dispatcher key get their own tunnel dispatcher', t => {
  const seen = []
  const target = targetOf(handler => http.createServer(handler), seen)
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = headers => ({url: 'http://localhost:' + targetPort + '/', proxy: 'http://localhost:' + proxyPort, tunnel: true, headers})
    engineApi(options({accept: 'x,via:string:y'}), err => {
      t.equal(err, null)
      engineApi(options({accept: 'x', via: 'y'}), err => {
        t.equal(err, null)
        t.equal(proxy.connects.length, 2)
        t.equal(proxy.connects[0].headers.accept, 'x,via:string:y')
        t.equal(proxy.connects[0].headers.via, undefined)
        t.equal(proxy.connects[1].headers.accept, 'x', 'the second CONNECT carries its own headers')
        t.equal(proxy.connects[1].headers.via, 'y')
        closeServers(t, [target, proxy])
      })
    })
  }))
})

tape('strictSSL fails after a handshake that does not verify, also through a tunnel', t => {
  const target = https.createServer(selfSigned, (req, res) => res.end('x'))
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {url: 'https://localhost:' + targetPort + '/', proxy: 'http://localhost:' + proxyPort, strictSSL: true, rejectUnauthorized: false}
    both(options, (node, engine) => {
      t.equal(node.error && node.error.message, 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT')
      t.equal(engine.error && engine.error.message, 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT')
      closeServers(t, [target, proxy])
    })
  }))
})

tape('a tunnel resumes no TLS session of the target after NODE_TLS_REJECT_UNAUTHORIZED=0 is unset, as in Node', t => {
  let resumed = 0
  const target = https.createServer(ipCert, (req, res) => res.end('ok'))
  target.on('secureConnection', socket => {
    if (socket.isSessionReused()) {
      resumed++
    }
  })
  const proxy = connectProxy()
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {url: 'https://localhost:' + targetPort + '/', proxy: 'http://localhost:' + proxyPort, ca, tunnel: true}
    afterRejectUnauthorizedUnset(nodeApi, options, node => afterRejectUnauthorizedUnset(engineApi, options, engine => {
      setEnvironment('NODE_TLS_REJECT_UNAUTHORIZED', saved)
      t.deepEqual(node, [200, 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_ALTNAME_INVALID'], 'Node checks the host name of every tunnel')
      t.deepEqual(engine, node, 'the engine equals Node')
      t.equal(resumed, 0, 'no TLS session resumed')
      closeServers(t, [target, proxy])
    }))
  }))
})

tape('a stalled TLS handshake through a tunnel times out as ESOCKETTIMEDOUT', t => {
  const held = []
  const target = net.createServer(socket => {
    held.push(socket)
    socket.on('error', () => {})
    socket.resume()
  })
  const proxy = connectProxy()
  listen(target, targetPort => listen(proxy, proxyPort => {
    const options = {url: 'https://localhost:' + targetPort + '/', ca, proxy: 'http://localhost:' + proxyPort, timeout: 150}
    both(options, (node, engine) => {
      t.equal(node.error && node.error.code, 'ESOCKETTIMEDOUT', 'Node: ' + (node.error && node.error.code))
      t.equal(engine.error && engine.error.code, 'ESOCKETTIMEDOUT', 'engine: ' + (engine.error && engine.error.code))
      t.notEqual(engine.error && engine.error.connect, true)
      held.forEach(socket => socket.destroy())
      closeServers(t, [target, proxy])
    })
  }))
})

tape('a timeout or abort while the tunnel is being made closes its sockets at once', t => {
  const held = []
  const target = net.createServer(socket => {
    held.push(socket)
    socket.on('error', () => {})
    socket.resume()
  })
  const proxy = connectProxy({delay: 400})
  listen(target, targetPort => listen(proxy, proxyPort => {
    const url = 'https://localhost:' + targetPort + '/'
    const sockets = []
    proxy.on('connection', socket => sockets.push(socket))
    engineApi({url, ca, proxy: 'http://localhost:' + proxyPort, timeout: 600}, err => {
      t.equal(err && err.code, 'ESOCKETTIMEDOUT', 'the handshake stalls after the tunnel')
      waitFor(() => held[0].destroyed && sockets[0].destroyed, 500, closed => {
        t.ok(closed, 'the tunnel sockets are closed after the timeout')
        const second = engineApi({url, ca, proxy: 'http://localhost:' + proxyPort}, () => t.fail('no callback after abort'))
        setTimeout(() => second.abort(), 100)
        waitFor(() => sockets.length === 2 && sockets[1].destroyed, 1000, closedEarly => {
          t.ok(closedEarly, 'abort while the proxy has not answered CONNECT closes the proxy connection')
          held.forEach(socket => socket.destroy())
          closeServers(t, [target, proxy])
        })
      })
    })
  }))
})

tape('bytes a proxy sends right after its 200 are dropped, as in Node', t => {
  const seen = []
  const target = targetOf(handler => https.createServer(trusted, handler), seen)
  const proxy = connectProxy({afterOk: 'bytes after the 200'})
  listen(target, targetPort => listen(proxy, proxyPort => {
    both({url: 'https://localhost:' + targetPort + '/', ca, proxy: 'http://localhost:' + proxyPort}, (node, engine) => {
      t.equal(node.error, null)
      t.equal(node.body, 'target /', 'Node')
      t.equal(engine.error, null)
      t.equal(engine.body, 'target /', 'engine')
      closeServers(t, [target, proxy])
    })
  }))
})

tape('idle tunnel dispatchers beyond the bound are closed, busy ones stay open', t => {
  const forHeader = value => dispatcherFor({
    uri: {protocol: 'https:', hostname: 'localhost'},
    proxy: {protocol: 'http:', hostname: 'localhost', port: '3128'},
    tunnel: true
  }, {'user-agent': value}).dispatcher
  const first = forHeader('first')
  const others = []
  for (let i = 0; i < 32; i++) {
    others.push(forHeader('other-' + i))
  }
  t.equal(first.closed, true, 'the least recently used idle tunnel dispatcher is closed')
  t.equal(others.filter(dispatcher => dispatcher.closed).length, 0)
  t.notEqual(forHeader('first'), first, 'a closed dispatcher is not handed out again')
  closeAll().then(() => t.end())
})

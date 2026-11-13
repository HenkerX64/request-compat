'use strict'

const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const path = require('path')
const tape = require('tape')
const tls = require('tls')
const undici = require('undici')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {connectProxy} = require('./proxy-servers')
const {closeAll} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))
const trusted = {key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}
const selfSigned = {key: fs.readFileSync(path.join(ssl, 'self-signed.key')), cert: fs.readFileSync(path.join(ssl, 'self-signed.crt'))}
const ALTNAME = 'SSL Error: ERR_TLS_CERT_ALTNAME_INVALID'

function listen (server, cb) {
  server.listen(0, () => cb(server.address().port))
}

function finish (t, servers) {
  servers.forEach(server => server.close())
  closeAll().then(() => t.end())
}

function both (run, cb) {
  run(nodeApi, node => closeAll().then(() => run(engineApi, engine => cb(node, engine))))
}

function outcome (err, res, body) {
  return err ? err.code || err.message : res.statusCode + ' ' + body
}

function rawServer (reply) {
  const server = net.createServer(socket => {
    const seen = {data: ''}
    server.seen.push(seen)
    socket.on('error', () => {})
    socket.on('data', chunk => {
      seen.data += chunk.toString('latin1')
      if (!seen.answered && seen.data.indexOf('\r\n\r\n') !== -1) {
        seen.answered = true
        reply(socket)
      }
    })
  })
  server.seen = []
  return server
}

function heads (server, from) {
  return server.seen.slice(from).map(seen => seen.data.split('\r\n\r\n')[0].split('\r\n'))
}

function bodies (server, from) {
  return server.seen.slice(from).map(seen => seen.data.slice(seen.data.indexOf('\r\n\r\n') + 4))
}

function answerOk (socket) {
  setTimeout(() => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'), 20)
}

function withRejectUnauthorized (value, run, cb) {
  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const set = next => {
    if (next === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = next
    }
  }
  set(value)
  run(set, result => {
    set(saved)
    cb(result)
  })
}

function sequence (api, list, cb) {
  const results = []
  const next = () => {
    if (results.length === list.length) {
      return cb(results)
    }
    const step = list[results.length]
    if (step.before) {
      step.before()
    }
    api(step.options(), (err, res, body) => {
      results.push(outcome(err, res, body))
      setTimeout(next, 30)
    })
  }
  next()
}

function sessions (server) {
  const counts = {connections: 0, resumed: 0}
  server.on('secureConnection', socket => {
    counts.connections++
    if (socket.isSessionReused()) {
      counts.resumed++
    }
  })
  counts.reset = () => {
    counts.connections = 0
    counts.resumed = 0
  }
  return counts
}

tape('host and connection are written in lower case, other names keep the case of the caller', t => {
  const server = rawServer(answerOk)
  listen(server, port => {
    both((api, cb) => {
      const from = server.seen.length
      api({url: 'http://localhost:' + port + '/', headers: {Host: 'localhost:' + port, 'X-Case': '1'}}, err => {
        t.equal(err, null)
        cb(heads(server, from)[0])
      })
    }, (node, engine) => {
      t.ok(node.indexOf('Host: localhost:' + port) !== -1, 'Node: Host as given')
      t.ok(node.indexOf('Connection: keep-alive') !== -1, 'Node: Connection')
      t.ok(engine.indexOf('host: localhost:' + port) !== -1, 'engine: host')
      t.ok(engine.indexOf('connection: keep-alive') !== -1, 'engine: connection')
      t.ok(node.indexOf('X-Case: 1') !== -1 && engine.indexOf('X-Case: 1') !== -1, 'other names keep their case')
      finish(t, [server])
    })
  })
})

tape('CONNECT to the proxy: host without the default port, proxy-connection: keep-alive, names and order of undici', t => {
  const proxy = rawServer(socket => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'))
  const rows = [
    {url: 'http://example.test/', tunnel: true, node: 'host: example.test:80', engine: 'host: example.test', target: 'example.test:80'},
    {url: 'https://example.test/', node: 'host: example.test:443', engine: 'host: example.test', target: 'example.test:443'},
    {url: 'https://example.test:8443/', node: 'host: example.test:8443', engine: 'host: example.test:8443', target: 'example.test:8443'}
  ]
  listen(proxy, port => {
    const next = () => {
      const row = rows.shift()
      if (!row) {
        return finish(t, [proxy])
      }
      both((api, cb) => {
        const from = proxy.seen.length
        api({url: row.url, tunnel: row.tunnel, proxy: 'http://localhost:' + port, headers: {'User-Agent': 'ua', Authorization: 'not for the proxy'}}, err => {
          t.equal(err && err.message, 'tunneling socket could not be established, statusCode=403', row.url)
          cb(heads(proxy, from)[0])
        })
      }, (node, engine) => {
        t.deepEqual(node, ['CONNECT ' + row.target + ' HTTP/1.1', 'User-Agent: ua', row.node, 'Connection: close'], 'Node: ' + row.url)
        t.deepEqual(engine, ['CONNECT ' + row.target + ' HTTP/1.1', row.engine, 'connection: close', 'User-Agent: ua', 'proxy-connection: keep-alive'], 'engine: ' + row.url)
        next()
      })
    }
    next()
  })
})

tape('no content-length without a body for DELETE, OPTIONS and GET, also when the caller sets one', t => {
  const server = rawServer(answerOk)
  const rows = [
    {method: 'DELETE', node: 'content-length: 0'},
    {method: 'OPTIONS', node: 'content-length: 0'},
    {method: 'GET', node: 'content-length: 4'}
  ]
  listen(server, port => {
    const next = () => {
      const row = rows.shift()
      if (!row) {
        return finish(t, [server])
      }
      both((api, cb) => {
        const from = server.seen.length
        api({url: 'http://localhost:' + port + '/', method: row.method, headers: {'content-length': 4}}, err => {
          t.equal(err, null)
          cb(heads(server, from)[0])
        })
      }, (node, engine) => {
        t.ok(node.indexOf(row.node) !== -1, 'Node: ' + row.method + ' ' + row.node)
        t.deepEqual(engine.filter(line => /^content-length:/i.test(line)), [], 'engine: ' + row.method + ' without content-length')
        next()
      })
    }
    next()
  })
})

tape('an HTTP/1.0 response reports httpVersion 1.1', t => {
  const server = rawServer(socket => socket.end('HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nhello'))
  listen(server, port => {
    both((api, cb) => {
      api('http://localhost:' + port + '/', (err, res, body) => {
        t.equal(err, null)
        t.equal(body, 'hello')
        cb(res.httpVersion)
      })
    }, (node, engine) => {
      t.equal(node, '1.0', 'Node')
      t.equal(engine, '1.1', 'engine')
      finish(t, [server])
    })
  })
})

tape('r.req is not a ClientRequest and r.agent is not set', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    both((api, cb) => {
      const sockets = []
      const r = api('http://localhost:' + port + '/', err => {
        t.equal(err, null)
        cb({
          socketEvent: {count: sockets.length, net: sockets[0] instanceof net.Socket, socketOfReq: sockets[0] === r.req.socket},
          clientRequest: r.req instanceof http.ClientRequest,
          agent: r.agent === http.globalAgent ? 'http.globalAgent' : r.agent
        })
      })
      r.on('socket', socket => sockets.push(socket))
    }, (node, engine) => {
      t.deepEqual(node, {socketEvent: {count: 1, net: true, socketOfReq: true}, clientRequest: true, agent: 'http.globalAgent'}, 'Node')
      t.deepEqual(engine.socketEvent, node.socketEvent, 'engine: the socket event as in Node')
      t.deepEqual({clientRequest: engine.clientRequest, agent: engine.agent}, {clientRequest: false, agent: undefined}, 'engine')
      finish(t, [server])
    })
  })
})

tape('no socket event through a tunnel to an https target or with a dispatcher, Node emits one', t => {
  const target = https.createServer(trusted, (req, res) => res.end('ok'))
  const server = http.createServer((req, res) => res.end('ok'))
  const proxy = connectProxy()
  const dispatcher = new undici.Agent()
  listen(target, targetPort => listen(server, port => listen(proxy, proxyPort => {
    const rows = [
      {name: 'tunnel to an https target', options: () => ({url: 'https://localhost:' + targetPort + '/', ca, proxy: 'http://localhost:' + proxyPort}), node: 'TLSSocket'},
      {name: 'dispatcher', options: () => ({url: 'http://localhost:' + port + '/', dispatcher}), node: 'net.Socket'}
    ]
    const next = () => {
      const row = rows.shift()
      if (!row) {
        return dispatcher.close().then(() => finish(t, [target, server, proxy]))
      }
      both((api, cb) => {
        const sockets = []
        const r = api(row.options(), (err, res, body) => {
          t.equal(err, null)
          t.equal(body, 'ok')
          const socket = sockets[0]
          cb({
            count: sockets.length,
            kind: socket instanceof tls.TLSSocket ? 'TLSSocket' : socket instanceof net.Socket ? 'net.Socket' : String(socket),
            reqSocket: r.req.socket === null ? null : r.req.socket === socket ? 'the socket of the event' : 'another'
          })
        })
        r.on('socket', socket => sockets.push(socket))
      }, (node, engine) => {
        t.deepEqual(node, {count: 1, kind: row.node, reqSocket: 'the socket of the event'}, 'Node: ' + row.name)
        t.deepEqual(engine, {count: 0, kind: 'undefined', reqSocket: null}, 'engine: ' + row.name)
        next()
      })
    }
    next()
  })))
})

tape('an error emitted on the connected socket of a running request fails it in Node, undici completes the request and keeps the socket', t => {
  let socket = null
  const server = http.createServer((req, res) => {
    socket.emit('error', new Error('emitted on the socket'))
    setTimeout(() => res.end('ok'), 50)
  })
  listen(server, port => {
    both((api, cb) => {
      socket = null
      const r = api('http://localhost:' + port + '/', (err, res, body) => {
        const used = socket
        setImmediate(() => cb({result: outcome(err, res, body), destroyed: used.destroyed}))
      })
      r.on('socket', emitted => {
        socket = emitted
      })
    }, (node, engine) => {
      t.deepEqual(node, {result: 'emitted on the socket', destroyed: true}, 'Node: the request fails and the socket is destroyed')
      t.deepEqual(engine, {result: '200 ok', destroyed: false}, 'engine: the request completes and the socket stays open')
      finish(t, [server])
    })
  })
})

tape('forever sets keepAlive: true in r.agentOptions and in the agentOptions object of the caller, the engine leaves both as passed', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    both((api, cb) => {
      const given = {maxSockets: 2}
      const plain = api({url: 'http://localhost:' + port + '/', forever: true}, err => {
        t.equal(err, null)
        const r = api({url: 'http://localhost:' + port + '/', forever: true, agentOptions: given}, err => {
          t.equal(err, null)
          cb({plain: plain.agentOptions, given, same: r.agentOptions === given})
        })
      })
    }, (node, engine) => {
      t.deepEqual(node, {plain: {keepAlive: true}, given: {maxSockets: 2, keepAlive: true}, same: true}, 'Node')
      t.deepEqual(engine, {plain: undefined, given: {maxSockets: 2}, same: true}, 'engine')
      finish(t, [server])
    })
  })
})

tape('TLS options, agentOptions and a pool object keep the connection alive, where the pool agent of Node sends connection: close', t => {
  let connections = 0
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers.connection)
    res.end('ok')
  })
  server.on('connection', () => connections++)
  const rows = [
    {name: 'pool object', options: {}},
    {name: 'ca and a pool object', options: {ca}},
    {name: 'agentOptions and a pool object', options: {agentOptions: {ca}}},
    {name: 'a finite agentOptions.maxSockets and a pool object', options: {agentOptions: {maxSockets: 2}}, node: 'keep-alive'}
  ]
  listen(server, port => {
    const next = () => {
      const row = rows.shift()
      if (!row) {
        return finish(t, [server])
      }
      both((api, cb) => {
        connections = 0
        seen.length = 0
        const pool = {}
        const options = () => Object.assign({url: 'http://localhost:' + port + '/', pool}, row.options)
        api(options(), err => {
          t.equal(err, null)
          api(options(), err => {
            t.equal(err, null)
            cb({connections, connection: seen.slice()})
          })
        })
      }, (node, engine) => {
        t.deepEqual(node, {connections: 2, connection: [row.node || 'close', row.node || 'close']}, 'Node: ' + row.name)
        t.deepEqual(engine, {connections: 1, connection: ['keep-alive', 'keep-alive']}, 'engine: ' + row.name)
        next()
      })
    }
    next()
  })
})

tape('a HEAD request goes out with connection: close, so its response says close, where Node keeps the connection alive', t => {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.headers.connection)
    res.end('ok')
  })
  listen(server, port => {
    both((api, cb) => {
      seen.length = 0
      const url = 'http://localhost:' + port + '/'
      api({url, method: 'HEAD'}, (err, res) => {
        t.equal(err, null)
        const answered = res.headers.connection
        api({url}, err => {
          t.equal(err, null)
          cb({sent: seen.slice(), answered})
        })
      })
    }, (node, engine) => {
      t.deepEqual(node, {sent: ['HEAD keep-alive', 'GET keep-alive'], answered: 'keep-alive'}, 'Node')
      t.deepEqual(engine, {sent: ['HEAD close', 'GET keep-alive'], answered: 'close'}, 'engine')
      finish(t, [server])
    })
  })
})

tape('the response has no socket, client, httpVersionMajor or httpVersionMinor', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    both((api, cb) => {
      let seen
      api('http://localhost:' + port + '/', err => {
        t.equal(err, null)
        cb(seen)
      }).on('response', res => {
        seen = {socket: Boolean(res.socket), client: Boolean(res.client), major: res.httpVersionMajor, minor: res.httpVersionMinor}
      })
    }, (node, engine) => {
      t.deepEqual(node, {socket: true, client: true, major: 1, minor: 1}, 'Node')
      t.deepEqual(engine, {socket: false, client: false, major: undefined, minor: undefined}, 'engine')
      finish(t, [server])
    })
  })
})

tape('a key of http.globalAgent.options that Node ignores on an agent is refused where Node uses the global agent', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    http.globalAgent.options.foo = 1
    both((api, cb) => api('http://localhost:' + port + '/', (err, res, body) => cb({result: outcome(err, res, body), option: err ? err.option : undefined})), (node, engine) => {
      delete http.globalAgent.options.foo
      t.deepEqual(node, {result: '200 ok', option: undefined}, 'Node')
      t.deepEqual(engine, {result: 'OPTION_NOT_SUPPORTED', option: 'http.globalAgent.options.foo'}, 'engine')
      finish(t, [server])
    })
  })
})

tape('the pool object of the caller stays empty, Node fills it with its agents', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  listen(server, port => {
    both((api, cb) => {
      const pool = {}
      api({url: 'http://localhost:' + port + '/', pool}, err => {
        t.equal(err, null)
        cb(Object.keys(pool).map(key => key + ' ' + (pool[key] instanceof http.Agent)))
      })
    }, (node, engine) => {
      t.deepEqual(node, ['http: true'], 'Node: an http.Agent under its pool key')
      t.deepEqual(engine, [], 'engine: no key')
      finish(t, [server])
    })
  })
})

tape('a response used as a formData value makes form-data throw, as form-data reads the socket of a Node response', t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/source') {
      res.write('some ')
      return res.end('data')
    }
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => res.end(Buffer.concat(chunks).toString().indexOf('filename="source"') !== -1 ? 'with filename' : 'without filename'))
  })
  listen(server, port => {
    both((api, cb) => {
      api('http://localhost:' + port + '/source').on('response', source => {
        try {
          api.post({url: 'http://localhost:' + port + '/upload', formData: {param: source}}, (err, res, body) => cb(outcome(err, res, body)))
        } catch (err) {
          source.resume()
          cb('throws ' + err.constructor.name)
        }
      })
    }, (node, engine) => {
      t.equal(node, '200 with filename', 'Node: the request path of the response is the filename')
      t.equal(engine, 'throws TypeError', 'engine: form-data reads response.client._httpMessage.path')
      finish(t, [server])
    })
  })
})

tape('separate pool objects share the keep-alive connections of one TLS context', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  const counts = sessions(server)
  listen(server, port => {
    both((api, cb) => {
      counts.reset()
      const options = () => ({url: 'https://localhost:' + port + '/', ca, forever: true, pool: {}})
      api(options(), err => {
        t.equal(err, null)
        api(options(), err => {
          t.equal(err, null)
          cb(counts.connections)
        })
      })
    }, (node, engine) => {
      t.equal(node, 2, 'Node: a connection per pool object')
      t.equal(engine, 1, 'engine: one connection')
      finish(t, [server])
    })
  })
})

tape('a checkServerIdentity in agentOptions gets a connection of its own on every request', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  const counts = sessions(server)
  listen(server, port => {
    both((api, cb) => {
      counts.reset()
      let calls = 0
      const agentOptions = {ca, checkServerIdentity: () => { calls++ }}
      const pool = {}
      const options = () => ({url: 'https://localhost:' + port + '/', pool, forever: true, agentOptions})
      api(options(), err => {
        t.equal(err, null)
        setTimeout(() => api(options(), err => {
          t.equal(err, null)
          cb({connections: counts.connections, calls})
        }), 20)
      })
    }, (node, engine) => {
      t.deepEqual(node, {connections: 1, calls: 1}, 'Node reuses the keep-alive socket')
      t.deepEqual(engine, {connections: 2, calls: 2}, 'engine: a new connection and check each time')
      finish(t, [server])
    })
  })
})

tape('a response body longer than its content-length is cut to that length, where Node fails to parse', t => {
  const server = rawServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nabcd')
    setTimeout(() => socket.end(), 50)
  })
  listen(server, port => {
    both((api, cb) => {
      api('http://localhost:' + port + '/', (err, res, body) => cb(outcome(err, res, body)))
    }, (node, engine) => {
      t.equal(node, 'HPE_INVALID_CONSTANT', 'Node')
      t.equal(engine, '200 ab', 'engine')
      finish(t, [server])
    })
  })
})

tape('a caller body longer than its content-length is cut to that length, with a process warning', t => {
  const server = rawServer(answerOk)
  const warnings = []
  const onWarning = warning => warnings.push(warning.code)
  listen(server, port => {
    both((api, cb) => {
      const from = server.seen.length
      warnings.length = 0
      process.on('warning', onWarning)
      api({url: 'http://localhost:' + port + '/', method: 'POST', headers: {'content-length': 2}, body: 'abcd'}, err => {
        t.equal(err, null)
        setTimeout(() => {
          process.removeListener('warning', onWarning)
          cb({body: bodies(server, from)[0], warnings: warnings.slice()})
        }, 20)
      })
    }, (node, engine) => {
      t.deepEqual(node, {body: 'abcd', warnings: []}, 'Node sends the whole body')
      t.deepEqual(engine, {body: 'ab', warnings: ['UND_ERR_REQ_CONTENT_LENGTH_MISMATCH']}, 'engine')
      finish(t, [server])
    })
  })
})

tape('a keep-alive request header of the caller is dropped', t => {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers['keep-alive'])
    res.end('ok')
  })
  listen(server, port => {
    both((api, cb) => {
      api({url: 'http://localhost:' + port + '/', headers: {'Keep-Alive': 'timeout=5'}}, err => {
        t.equal(err, null)
        cb(seen.pop())
      })
    }, (node, engine) => {
      t.equal(node, 'timeout=5', 'Node sends it')
      t.equal(engine, undefined, 'engine drops it')
      finish(t, [server])
    })
  })
})

tape('with an IP address in the Host header or as the target of a tunnel the engine sends a host name as SNI, Node none', t => {
  const answer = (req, res) => res.end('sni:' + req.socket.servername)
  const server = https.createServer(trusted, answer)
  const proxy = https.createServer(trusted, answer)
  const plain = http.createServer((req, res) => res.end('plain'))
  const tunnelProxy = connectProxy({}, handler => https.createServer(trusted, handler))
  const tunnelSni = []
  tunnelProxy.on('secureConnection', socket => tunnelSni.push(socket.servername))
  listen(server, port => listen(proxy, proxyPort => listen(plain, plainPort => listen(tunnelProxy, tunnelPort => {
    const rows = [
      {name: 'direct', options: {url: 'https://localhost:' + port + '/', ca, headers: {host: '127.0.0.1:' + port}}, node: '200 sni:false', engine: '200 sni:localhost'},
      {name: 'forwarding https proxy', options: {url: 'http://localhost:81/', proxy: 'https://localhost:' + proxyPort, ca, headers: {host: '127.0.0.1'}}, node: '200 sni:false', engine: '200 sni:localhost'},
      {
        name: 'tunnel through an https proxy to an IP address, NODE_TLS_REJECT_UNAUTHORIZED=0',
        environment: '0',
        options: {url: 'http://127.0.0.1:' + plainPort + '/', proxy: 'https://localhost:' + tunnelPort, tunnel: true},
        node: '200 plain sni:false',
        engine: '200 plain sni:localhost'
      }
    ]
    const next = () => {
      const row = rows.shift()
      if (!row) {
        return finish(t, [server, proxy, plain, tunnelProxy])
      }
      withRejectUnauthorized(row.environment || process.env.NODE_TLS_REJECT_UNAUTHORIZED, (set, done) => {
        both((api, cb) => {
          tunnelSni.length = 0
          api(Object.assign({pool: {}}, row.options), (err, res, body) => cb(outcome(err, res, body) + (tunnelSni.length ? ' sni:' + tunnelSni.join(',') : '')))
        }, (node, engine) => done({node, engine}))
      }, result => {
        t.equal(result.node, row.node, 'Node: ' + row.name)
        t.equal(result.engine, row.engine, 'engine: ' + row.name)
        next()
      })
    }
    next()
  }))))
})

tape('under strictSSL a certificate error comes before any request byte is sent, Node sends the request first', t => {
  let requests = 0
  const server = https.createServer(selfSigned, (req, res) => {
    requests++
    req.resume()
    req.on('end', () => res.end('ok'))
  })
  listen(server, port => {
    both((api, cb) => {
      requests = 0
      api({url: 'https://localhost:' + port + '/', pool: {}, method: 'POST', body: 'payload', strictSSL: true, rejectUnauthorized: false}, err => {
        setTimeout(() => cb({error: err && err.message, requests}), 30)
      })
    }, (node, engine) => {
      t.deepEqual(node, {error: 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT', requests: 1}, 'Node')
      t.deepEqual(engine, {error: 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT', requests: 0}, 'engine')
      finish(t, [server])
    })
  })
})

tape('a TLS version the server refuses is ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION, where Node reports EPROTO', t => {
  const server = https.createServer(Object.assign({maxVersion: 'TLSv1.2'}, trusted), (req, res) => res.end('ok'))
  listen(server, port => {
    both((api, cb) => {
      api({url: 'https://localhost:' + port + '/', pool: {}, ca, minVersion: 'TLSv1.3'}, err => cb({code: err && err.code, write: Boolean(err && /^write EPROTO /.test(err.message))}))
    }, (node, engine) => {
      t.deepEqual(node, {code: 'EPROTO', write: true}, 'Node')
      t.deepEqual(engine, {code: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', write: false}, 'engine')
      finish(t, [server])
    })
  })
})

tape('after an SSL Error under strictSSL the engine fails again where Node resumes the TLS session and accepts, also after NODE_TLS_REJECT_UNAUTHORIZED=0 is set at runtime', t => {
  const server = https.createServer(trusted, (req, res) => res.end('ok'))
  listen(server, port => {
    const url = 'https://localhost:' + port + '/'
    both((api, cb) => {
      const pool = {}
      const mismatch = () => ({url, pool, ca, servername: 'other.example', rejectUnauthorized: false, strictSSL: true})
      sequence(api, [{options: mismatch}, {options: mismatch}, {options: mismatch}], cb)
    }, (node, engine) => {
      t.deepEqual(node, [ALTNAME, '200 ok', '200 ok'], 'Node')
      t.deepEqual(engine, [ALTNAME, ALTNAME, ALTNAME], 'engine')
      withRejectUnauthorized(undefined, (set, done) => {
        both((api, cb) => {
          const pool = {}
          const strict = () => ({url, pool, ca, servername: 'other.example', strictSSL: true})
          set(undefined)
          sequence(api, [{options: strict}, {options: strict, before: () => set('0')}, {options: strict}, {options: strict}], cb)
        }, (node, engine) => done({node, engine}))
      }, runtime => {
        t.deepEqual(runtime.node, ['ERR_TLS_CERT_ALTNAME_INVALID', ALTNAME, '200 ok', '200 ok'], 'Node after the switch')
        t.deepEqual(runtime.engine, ['ERR_TLS_CERT_ALTNAME_INVALID', ALTNAME, ALTNAME, ALTNAME], 'engine after the switch')
        finish(t, [server])
      })
    })
  })
})

tape('a TLS session is resumed only while a connection of the origin is open, the agents of Node resume after it closed', t => {
  let close = true
  const server = https.createServer(trusted, (req, res) => {
    if (close) {
      res.setHeader('connection', 'close')
    }
    setTimeout(() => res.end('ok'), req.url === '/slow' ? 150 : 0)
  })
  const counts = sessions(server)
  const rows = [
    {name: 'ca', options: {ca}, cached: true},
    {name: 'ca and strictSSL', options: {ca, strictSSL: true}},
    {name: 'ca, strictSSL and rejectUnauthorized: true', options: {ca, strictSSL: true, rejectUnauthorized: true}},
    {name: 'ca and servername \'\'', options: {ca, servername: ''}}
  ]
  listen(server, port => {
    const url = 'https://localhost:' + port
    const closing = (api, row, cb) => {
      close = true
      const pool = {}
      const options = () => Object.assign({url: url + '/', pool}, row.options)
      counts.reset()
      sequence(api, [{options}, {options}, {options}], results => cb({results, connections: counts.connections, resumed: counts.resumed}))
    }
    const parallel = (api, row, cb) => {
      close = false
      const pool = {}
      const options = path => Object.assign({url: url + path, pool}, row.options)
      api(options('/'), err => {
        t.equal(err, null)
        counts.reset()
        let pending = 3
        const done = err => {
          t.equal(err, null)
          if (--pending === 0) {
            cb({connections: counts.connections, resumed: counts.resumed})
          }
        }
        api(options('/slow'), done)
        api(options('/slow'), done)
        api(options('/slow'), done)
      })
    }
    const next = () => {
      const row = rows.shift()
      if (!row) {
        return finish(t, [server])
      }
      both((api, cb) => closing(api, row, cb), (node, engine) => {
        t.deepEqual(node.results, ['200 ok', '200 ok', '200 ok'], 'Node: ' + row.name)
        t.ok(node.resumed >= 2, 'Node resumes after the connection closed: ' + row.name + ', ' + node.resumed + ' of ' + node.connections)
        t.deepEqual(engine, {results: ['200 ok', '200 ok', '200 ok'], connections: 3, resumed: 0}, 'engine, connection closed: ' + row.name)
        both((api, cb) => parallel(api, row, cb), (node, engine) => {
          t.ok(node.resumed >= 2, 'Node resumes next to an open connection: ' + row.name + ', ' + node.resumed + ' of ' + node.connections)
          if (row.cached) {
            t.ok(engine.connections >= 1 && engine.resumed === engine.connections, 'engine resumes next to an open connection: ' + row.name + ', ' + engine.resumed + ' of ' + engine.connections)
          } else {
            t.equal(engine.resumed, 0, 'engine caches no session: ' + row.name + ', ' + engine.connections + ' connections')
          }
          next()
        })
      })
    }
    next()
  })
})

tape('the pool agents of Node serve a later request with the TLS options of an earlier one under the same pool key, the engine applies the options of each request', t => {
  const selfSignedServer = https.createServer(selfSigned, (req, res) => res.end('ok'))
  const tls12 = https.createServer(Object.assign({maxVersion: 'TLSv1.2'}, trusted), (req, res) => res.end('ok'))
  listen(selfSignedServer, selfPort => listen(tls12, tls12Port => {
    const selfUrl = 'https://localhost:' + selfPort + '/'
    const tls12Url = 'https://localhost:' + tls12Port + '/'
    withRejectUnauthorized('0', (set, done) => {
      both((api, cb) => {
        const pool = {}
        sequence(api, [{options: () => ({url: selfUrl, pool, rejectUnauthorized: ''})}, {options: () => ({url: selfUrl, pool})}], cb)
      }, (node, engine) => done({node, engine}))
    }, environment => {
      t.deepEqual(environment.node, ['DEPTH_ZERO_SELF_SIGNED_CERT', 'DEPTH_ZERO_SELF_SIGNED_CERT'], 'Node, NODE_TLS_REJECT_UNAUTHORIZED=0: the second request runs on the agent of the first')
      t.deepEqual(environment.engine, ['DEPTH_ZERO_SELF_SIGNED_CERT', '200 ok'], 'engine, NODE_TLS_REJECT_UNAUTHORIZED=0')
      both((api, cb) => {
        const pool = {}
        sequence(api, [{options: () => ({url: tls12Url, pool, ca})}, {options: () => ({url: tls12Url, pool, ca, agentOptions: {minVersion: 'TLSv1.3'}})}], cb)
      }, (node, engine) => {
        t.deepEqual(node, ['200 ok', '200 ok'], 'Node: agentOptions.minVersion of the second request is not applied')
        t.deepEqual(engine, ['200 ok', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION'], 'engine')
        finish(t, [selfSignedServer, tls12])
      })
    })
  }))
})

tape('an agentOptions key without an undici equivalent is refused, also with pool: false and through a tunnel, where Node ignores it', t => {
  const target = http.createServer((req, res) => res.end('ok'))
  const proxy = connectProxy()
  listen(target, port => listen(proxy, proxyPort => {
    const url = 'http://localhost:' + port + '/'
    const rows = [
      {name: 'pool: false', options: {url, pool: false, agentOptions: {maxTotalSockets: 3}}, option: 'agentOptions.maxTotalSockets'},
      {name: 'tunnel', options: {url, proxy: 'http://localhost:' + proxyPort, tunnel: true, agentOptions: {maxTotalSockets: 3}}, option: 'agentOptions.maxTotalSockets'},
      {name: 'unknown key', options: {url, agentOptions: {foo: 1}}, ownPool: true, option: 'agentOptions.foo'}
    ]
    const next = () => {
      const row = rows.shift()
      if (!row) {
        return finish(t, [target, proxy])
      }
      both((api, cb) => api(Object.assign({}, row.options, row.ownPool ? {pool: {}} : {}), (err, res, body) => cb({result: outcome(err, res, body), option: err ? err.option : undefined})), (node, engine) => {
        t.deepEqual(node, {result: '200 ok', option: undefined}, 'Node: ' + row.name)
        t.deepEqual(engine, {result: 'OPTION_NOT_SUPPORTED', option: row.option}, 'engine: ' + row.name)
        next()
      })
    }
    next()
  }))
})

tape('a MockAgent interceptor for an origin with the default port does not match, as with request() of undici', t => {
  const mock = () => {
    const agent = new undici.MockAgent()
    agent.disableNetConnect()
    agent.get('http://mock.example:80').intercept({path: '/x'}).reply(200, 'mocked')
    return agent
  }
  const viaEngine = mock()
  engineApi({url: 'http://mock.example/x', dispatcher: viaEngine}, err => {
    t.equal(err && err.code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED', 'engine')
    const viaUndici = mock()
    undici.request('http://mock.example/x', {dispatcher: viaUndici}).then(() => t.fail('undici request() matched'), err => {
      t.equal(err.code, 'UND_MOCK_ERR_MOCK_NOT_MATCHED', 'request() of undici')
    }).then(() => Promise.all([viaEngine.close(), viaUndici.close()])).then(() => t.end())
  })
})

tape('undici errors reach the callback unchanged where Node has an error of its own or none', t => {
  const server = rawServer(answerOk)
  const malformed = rawServer(socket => socket.end('HTTP/1.1 abc OK\r\n\r\n'))
  listen(server, port => listen(malformed, malformedPort => {
    const url = 'http://localhost:' + port + '/'
    const rows = [
      {name: 'a method that is not a token', options: {url, method: 'GE T'}, node: 'ERR_INVALID_HTTP_TOKEN', engine: 'UND_ERR_INVALID_ARG'},
      {name: 'a content-length that is not a number', options: {url, method: 'POST', body: 'x', headers: {'content-length': 'abc'}}, node: '200 ok', engine: 'UND_ERR_INVALID_ARG'}
    ]
    const next = () => {
      const row = rows.shift()
      if (!row) {
        const destroyed = new undici.Agent()
        return destroyed.destroy().then(() => engineApi({url, dispatcher: destroyed}, err => {
          t.equal(err && err.code, 'UND_ERR_DESTROYED', 'engine: a destroyed caller dispatcher')
          both((api, cb) => api('http://localhost:' + malformedPort + '/', err => cb(err && {name: err.name, code: err.code, message: err.message})), (node, engine) => {
            t.deepEqual(node, {name: 'Error', code: 'HPE_INVALID_STATUS', message: 'Parse Error: Invalid status code'}, 'Node: a response that is not HTTP/1.1')
            t.deepEqual(engine, {name: 'HTTPParserError', code: undefined, message: 'Response does not match the HTTP/1.1 protocol (Invalid status code)'}, 'engine: a response that is not HTTP/1.1')
            finish(t, [server, malformed])
          })
        }))
      }
      both((api, cb) => api(Object.assign({}, row.options), (err, res, body) => cb(outcome(err, res, body))), (node, engine) => {
        t.equal(node, row.node, 'Node: ' + row.name)
        t.equal(engine, row.engine, 'engine: ' + row.name)
        next()
      })
    }
    next()
  }))
})

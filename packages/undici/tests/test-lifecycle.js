'use strict'

const fs = require('fs')
const http = require('http')
const https = require('https')
const net = require('net')
const os = require('os')
const path = require('path')
const tls = require('tls')
const tape = require('tape')
const nodeApi = require('request-compat')
const engine = require('../index')
const {closeAll} = require('../lib/dispatchers')
const {forwardingProxy, connectProxy} = require('./proxy-servers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const ca = fs.readFileSync(path.join(ssl, 'ca', 'ca.crt'))
const trusted = {key: fs.readFileSync(path.join(ssl, 'ca', 'localhost.key')), cert: fs.readFileSync(path.join(ssl, 'ca', 'localhost.crt'))}

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

function timingsShape (timings) {
  return {
    ordered: timings.connect >= timings.lookup && timings.lookup >= timings.socket,
    response: timings.response >= timings.connect,
    end: timings.end >= timings.response
  }
}

tape('new connection emits connecting then connect', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(0, () => {
    const url = 'http://localhost:' + server.address().port + '/'
    nodeApi({url, time: true}, (nodeErr, nodeRes) => {
      t.equal(nodeErr, null)
      const events = []
      const r = engine({url, time: true}, (err, res) => {
        t.equal(err, null)
        t.equal(res.statusCode, 200)
        t.deepEqual(events, ['connecting', 'lookup', 'connect'])
        t.ok(res.timings.connect >= res.timings.lookup && res.timings.lookup >= res.timings.socket, 'connect >= lookup >= socket')
        t.deepEqual(timingsShape(res.timings), timingsShape(nodeRes.timings), 'same timings shape as the Node transport')
        t.deepEqual(Object.keys(res.timingPhases).sort(), Object.keys(nodeRes.timingPhases).sort())
        server.close()
        t.end()
      })
      lifecycleOf(r, events)
    })
  })
})

tape('keep-alive reuse emits reused', t => {
  let connections = 0
  const server = http.createServer((req, res) => res.end('ok'))
  server.on('connection', () => connections++)
  server.listen(0, () => {
    const url = 'http://localhost:' + server.address().port + '/'
    const events = []
    engine({url}, (err1, res1) => {
      t.equal(err1, null)
      t.equal(res1.statusCode, 200)
      const r = engine({url, time: true}, (err2, res2) => {
        t.equal(err2, null)
        t.deepEqual(events, ['reused'])
        t.equal(res2.timings.connect, res2.timings.socket)
        t.equal(res2.timings.lookup, res2.timings.socket)
        t.equal(connections, 1)
        server.close()
        t.end()
      })
      lifecycleOf(r, events)
    })
  })
})

tape('timeout on a reused connection arms the idle timer only', t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      return setTimeout(() => res.end('late'), 300)
    }
    res.end('ok')
  })
  server.listen(0, () => {
    const base = 'http://localhost:' + server.address().port
    engine({url: base + '/'}, err1 => {
      t.equal(err1, null)
      const events = []
      const start = Date.now()
      const r = engine({url: base + '/slow', timeout: 100}, err2 => {
        t.equal(err2 && err2.code, 'ESOCKETTIMEDOUT')
        t.notEqual(err2 && err2.connect, true)
        t.deepEqual(events, ['reused'])
        t.ok(Date.now() - start < 280)
        server.close()
        t.end()
      })
      lifecycleOf(r, events)
    })
  })
})

function nonRoutableAddresses () {
  return ['10.255.255.1', '10.0.0.0', '192.168.0.0', '192.168.255.255', '172.16.0.0', '172.31.255.255']
}

tape('connect timeout', t => {
  const addresses = nonRoutableAddresses()
  const attempt = () => {
    const host = addresses.shift()
    const events = []
    const r = engine({url: 'http://' + host + '/timeout', timeout: 50}, err => {
      t.notEqual(err, null)
      if (err.code === 'ENETUNREACH' && addresses.length) {
        return attempt()
      }
      t.equal(err.code, 'ETIMEDOUT')
      t.equal(err.connect, true)
      t.deepEqual(events.slice(0, 1), ['connecting'])
      t.notOk(events.indexOf('connect') !== -1)
      t.end()
    })
    lifecycleOf(r, events)
  }
  attempt()
})

function stalledTlsServer (cb) {
  const sockets = []
  const server = net.createServer(socket => {
    socket.on('error', () => {})
    socket.resume()
    sockets.push(socket)
    socket.closedAt = null
    socket.on('close', () => {
      socket.closedAt = Date.now()
    })
  })
  server.sockets = sockets
  server.listen(0, () => cb(server))
}

function closeStalled (server) {
  server.sockets.forEach(socket => socket.destroy())
  server.close()
}

tape('stalled TLS handshake is a read timeout', t => {
  stalledTlsServer(server => {
    const url = 'https://localhost:' + server.address().port + '/'
    const events = []
    const r = engine({url, ca, timeout: 50}, err => {
      t.equal(err && err.code, 'ESOCKETTIMEDOUT')
      t.notEqual(err && err.connect, true)
      t.deepEqual(events, ['connecting', 'lookup', 'connect'])
      closeStalled(server)
      t.end()
    })
    lifecycleOf(r, events)
  })
})

tape('stalled TLS handshake gives the same error code as the Node transport', t => {
  stalledTlsServer(server => {
    const url = 'https://localhost:' + server.address().port + '/'
    nodeApi({url, ca, timeout: 50}, nodeErr => {
      engine({url, ca, timeout: 50}, err => {
        t.equal(nodeErr.code, 'ESOCKETTIMEDOUT')
        t.equal(err.code, nodeErr.code)
        t.equal(err.connect, nodeErr.connect)
        closeStalled(server)
        t.end()
      })
    })
  })
})

tape('idle timeout during the body', t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200)
    res.write('x')
  })
  server.listen(0, () => {
    engine({url: 'http://localhost:' + server.address().port + '/', timeout: 100}, err => {
      t.equal(err && err.code, 'ESOCKETTIMEDOUT')
      t.notEqual(err && err.connect, true)
      server.close()
      t.end()
    })
  })
})

tape('abort during a stalled TLS handshake', t => {
  stalledTlsServer(server => {
    const url = 'https://localhost:' + server.address().port + '/'
    let errors = 0
    const r = engine({url, ca}, () => {
      errors++
    })
    r.on('error', () => {
      errors++
    })
    r.on('request', req => {
      req.on('connecting', connection => {
        connection.once('connect', () => {
          waitFor(() => server.sockets.length === 1, 1000, accepted => {
            t.ok(accepted, 'the server accepted the TCP connection')
            const abortedAt = Date.now()
            r.abort()
            waitFor(() => server.sockets[0].closedAt !== null, 1000, closed => {
              t.ok(closed, 'the server saw the socket closed')
              t.ok(server.sockets[0].closedAt - abortedAt < 100, 'within 100 ms')
              setTimeout(() => {
                t.equal(errors, 0, 'no error after abort')
                closeStalled(server)
                t.end()
              }, 50)
            })
          })
        })
      })
    })
  })
})

function gate (stallFirst, delayRest, cb) {
  const real = https.createServer(trusted, (req, res) => {
    if (req.url === '/close') {
      res.setHeader('connection', 'close')
    }
    res.end('ok')
  })
  const sockets = []
  const front = net.createServer(socket => {
    socket.on('error', () => {})
    sockets.push(socket)
    if (sockets.length <= stallFirst) {
      return socket.resume()
    }
    const upstream = net.connect(real.address().port, '127.0.0.1')
    upstream.on('error', () => {})
    const start = () => socket.pipe(upstream).pipe(socket)
    if (delayRest && sockets.length > delayRest.after) {
      setTimeout(start, delayRest.ms)
    } else {
      start()
    }
  })
  front.sockets = sockets
  front.stop = () => {
    sockets.forEach(socket => socket.destroy())
    front.close()
    real.close()
    real.closeAllConnections()
  }
  real.listen(0, () => front.listen(0, () => cb(front)))
}

tape('a connection the server closed is opened again with connecting', t => {
  let connections = 0
  const server = http.createServer((req, res) => res.end('ok'))
  server.keepAliveTimeout = 50
  server.on('connection', () => connections++)
  server.listen(0, () => {
    const url = 'http://localhost:' + server.address().port + '/'
    engine({url}, err1 => {
      t.equal(err1, null)
      setTimeout(() => {
        const events = []
        const r = engine({url, time: true}, (err2, res2) => {
          t.equal(err2, null)
          t.deepEqual(events, ['connecting', 'lookup', 'connect'])
          t.ok(res2.timings.connect > res2.timings.socket, 'connect is timed again')
          t.equal(connections, 2)
          server.close()
          t.end()
        })
        lifecycleOf(r, events)
        r.on('request', req => req.on('connecting', connection => {
          t.equal(connection.connected, false, 'a fresh connection object, not connected yet')
        }))
      }, 200)
    })
  })
})

tape('a subscriber that attaches after connect still gets connect and lookup', t => {
  const server = http.createServer((req, res) => setTimeout(() => res.end('ok'), 100))
  server.listen(0, () => {
    const seen = []
    const r = engine({url: 'http://localhost:' + server.address().port + '/'}, err => {
      t.equal(err, null)
      t.deepEqual(seen.sort(), ['connect', 'lookup'])
      server.close()
      t.end()
    })
    r.on('request', req => {
      req.on('connecting', connection => {
        setTimeout(() => {
          t.equal(connection.connected, true)
          let sync = true
          connection.on('connect', () => {
            t.equal(sync, false, 'replayed asynchronously')
            seen.push('connect')
          })
          connection.once('lookup', () => seen.push('lookup'))
          sync = false
        }, 40)
      })
    })
  })
})

tape('abort during the handshake frees the connection slot of pool.maxSockets', t => {
  gate(1, null, server => {
    const url = 'https://localhost:' + server.address().port + '/'
    const pool = {maxSockets: 1}
    const r = engine({url, ca, pool}, () => t.fail('no callback after abort'))
    r.on('request', req => {
      req.on('connecting', connection => {
        connection.once('connect', () => {
          setTimeout(() => {
            r.abort()
            const timer = setTimeout(() => {
              t.fail('the next request never got a connection')
              server.stop()
              t.end()
            }, 1000)
            engine({url, ca, pool}, (err, res, body) => {
              clearTimeout(timer)
              t.equal(err, null)
              t.equal(body, 'ok')
              server.stop()
              t.end()
            })
          }, 20)
        })
      })
    })
  })
})

tape('a connect timeout frees the connection slot of pool.maxSockets', t => {
  gate(1, null, server => {
    const url = 'https://localhost:' + server.address().port + '/'
    const pool = {maxSockets: 1}
    engine({url, ca, pool, timeout: 50}, err1 => {
      t.equal(err1 && err1.code, 'ESOCKETTIMEDOUT')
      const timer = setTimeout(() => {
        t.fail('the next request never got a connection')
        server.stop()
        t.end()
      }, 1000)
      engine({url, ca, pool}, (err2, res, body) => {
        clearTimeout(timer)
        t.equal(err2, null)
        t.equal(body, 'ok')
        server.stop()
        t.end()
      })
    })
  })
})

tape('timeouts while connecting leave no Client behind', t => {
  stalledTlsServer(server => {
    const port = server.address().port
    const url = 'https://localhost:' + port + '/'
    let dispatcher
    let remaining = 6
    const next = () => {
      const r = engine({url, ca, timeout: 30}, err => {
        t.equal(err && err.code, 'ESOCKETTIMEDOUT')
        if (--remaining) {
          return next()
        }
        setTimeout(() => {
          const stats = dispatcher.stats['https://localhost:' + port]
          t.ok(!stats || (stats.size === 0 && stats.pending === 0 && stats.connected === 0), 'no pending request and no stuck Client: ' + JSON.stringify(stats))
          closeStalled(server)
          t.end()
        }, 50)
      })
      r.on('request', req => {
        dispatcher = req.dispatcher
      })
    }
    next()
  })
})

tape('abort of a finished request leaves the connecting socket of another request alone', t => {
  gate(0, {after: 2, ms: 100}, server => {
    const base = 'https://localhost:' + server.address().port
    let pending = 2
    let first
    const next = () => {
      if (--pending) {
        return
      }
      setTimeout(() => {
        const r = engine({url: base + '/', ca, timeout: 500}, (err, res, body) => {
          t.equal(err, null)
          t.equal(body, 'ok')
          server.stop()
          t.end()
        })
        r.on('request', req => {
          req.on('connecting', connection => {
            t.equal(connection.connected, false, 'a reconnecting Client hands out a fresh connection object')
            connection.once('connect', () => first.abort())
          })
          req.on('reused', () => t.fail('the request was expected on a new connection'))
        })
      }, 50)
    }
    first = engine({url: base + '/close', ca}, err => {
      t.equal(err, null)
      next()
    })
    engine({url: base + '/', ca}, err => {
      t.equal(err, null)
      next()
    })
  })
})

tape('abort inside the connecting listener opens no connection', t => {
  gate(1000, null, server => {
    const events = []
    const r = engine({url: 'https://localhost:' + server.address().port + '/', ca}, () => t.fail('no callback after abort'))
    r.on('request', req => {
      req.on('connecting', connection => {
        connection.once('lookup', () => events.push('lookup'))
        connection.once('connect', () => events.push('connect'))
        r.abort()
      })
    })
    setTimeout(() => {
      t.equal(server.sockets.filter(socket => !socket.destroyed).length, 0, 'no socket left open')
      t.deepEqual(events, [])
      server.stop()
      t.end()
    }, 150)
  })
})

tape('a request moved to a new TLS connection by another Host header emits connecting like Node', t => {
  const run = (api, cb) => {
    let connections = 0
    const server = https.createServer(trusted, (req, res) => res.end('ok'))
    server.on('connection', () => connections++)
    server.listen(0, () => {
      const url = 'https://localhost:' + server.address().port + '/'
      const options = {url, ca, forever: true, rejectUnauthorized: false}
      api(options, err1 => {
        t.equal(err1, null)
        const events = []
        const r = api(Object.assign({headers: {host: 'other.example'}, time: true}, options), (err2, res) => {
          t.equal(err2, null)
          server.close()
          server.closeAllConnections()
          cb({events, connections, timed: res.timings.connect > res.timings.socket})
        })
        lifecycleOf(r, events)
      })
    })
  }
  run(nodeApi, node => {
    run(engine, result => {
      t.deepEqual(node.events, ['connecting', 'lookup', 'connect'])
      t.deepEqual(result.events, node.events)
      t.equal(result.connections, 2)
      t.equal(result.timed, node.timed)
      t.end()
    })
  })
})

tape('abort of a request that already has its response leaves the connection alone', t => {
  gate(0, null, server => {
    const url = 'https://localhost:' + server.address().port + '/'
    const events = []
    const r = engine({url, ca}, (err, res, body) => {
      t.equal(err, null)
      r.abort()
      engine({url, ca}, (err2, res2, body2) => {
        t.equal(err2, null)
        t.equal(body2, 'ok')
        server.stop()
        t.end()
      })
    })
    lifecycleOf(r, events)
  })
})

function sequence (api, hostname, steps, cb) {
  let connections = 0
  const handler = (req, res) => req.url === '/slow' ? setTimeout(() => res.end('slow'), 400) : res.end('ok')
  const secure = !steps.plain
  const server = secure ? https.createServer(trusted, handler) : http.createServer(handler)
  server.on('connection', () => connections++)
  server.listen(0, '127.0.0.1', () => {
    const base = (secure ? 'https://' : 'http://') + hostname + ':' + server.address().port
    const results = []
    const next = () => {
      const step = steps[results.length]
      if (!step) {
        server.close()
        server.closeAllConnections()
        return cb(results, connections)
      }
      const events = []
      const r = api(Object.assign({url: base + (step.path || '/'), ca, forever: true, rejectUnauthorized: false}, step.options), err => {
        results.push(events.concat(err ? [err.code + (err.connect === true ? '+connect' : '')] : []))
        next()
      })
      lifecycleOf(r, events)
    }
    next()
  })
}

function sameAsNode (name, hostname, steps, expected) {
  tape(name, t => {
    sequence(nodeApi, hostname, steps, node => {
      sequence(engine, hostname, steps, (result, connections) => {
        t.deepEqual(result, node, 'same events as the Node transport')
        t.deepEqual(result, expected)
        t.equal(connections, expected.filter(events => events[0] === 'connecting').length, 'one TCP connection per connecting')
        t.end()
      })
    })
  })
}

const NEW = ['connecting', 'lookup', 'connect']

sameAsNode('https keep-alive request is reused', 'localhost', [{}, {}], [NEW, ['reused']])
sameAsNode('https IP host keep-alive request is reused', '127.0.0.1', [{}, {}], [['connecting', 'connect'], ['reused']])
sameAsNode('idle timeout on a reused https IP host connection is not a connect timeout', '127.0.0.1',
  [{}, {path: '/slow', options: {timeout: 150}}], [['connecting', 'connect'], ['reused', 'ESOCKETTIMEDOUT']])
sameAsNode('same servername option is reused', 'localhost',
  [{options: {servername: 'a.example'}}, {options: {servername: 'a.example'}}], [NEW, ['reused']])
sameAsNode('same Host header in another spelling and with a port is reused', 'localhost',
  [{options: {headers: {Host: 'other.example'}}}, {options: {headers: {HOST: 'other.example:8443'}}}], [NEW, ['reused']])
sameAsNode('an IP Host header is reused', 'localhost',
  [{options: {headers: {host: '127.0.0.1'}}}, {options: {headers: {host: '[::1]:443'}}}], [NEW, ['reused']])
sameAsNode('another Host header on http stays on the connection', 'localhost',
  Object.assign([{}, {options: {headers: {host: 'other.example'}}}], {plain: true}), [NEW, ['reused']])

tape('abort inside the connecting listener frees the connection slot of pool.maxSockets', t => {
  gate(0, null, server => {
    const url = 'https://localhost:' + server.address().port + '/'
    const pool = {maxSockets: 1}
    const r = engine({url, ca, pool}, () => t.fail('no callback after abort'))
    r.on('request', req => req.on('connecting', () => {
      r.abort()
      setTimeout(() => {
        const timer = setTimeout(() => {
          t.fail('the next request never got a connection')
          server.stop()
          t.end()
        }, 1000)
        engine({url, ca, pool}, (err, res, body) => {
          clearTimeout(timer)
          t.equal(err, null)
          t.equal(body, 'ok')
          server.stop()
          t.end()
        })
      }, 50)
    }))
  })
})

tape('abort inside the connecting listener of a request moved to another servername opens no connection', t => {
  gate(0, null, server => {
    const options = {url: 'https://localhost:' + server.address().port + '/', ca, rejectUnauthorized: false}
    engine(options, err => {
      t.equal(err, null)
      const events = []
      const r = engine(Object.assign({headers: {host: 'other.example'}}, options), () => t.fail('no callback after abort'))
      r.on('request', req => req.on('connecting', connection => {
        connection.once('lookup', () => events.push('lookup'))
        connection.once('connect', () => events.push('connect'))
        r.abort()
      }))
      setTimeout(() => {
        t.deepEqual(events, [], 'no lookup or connect after the abort')
        t.equal(server.sockets.length, 1, 'no second TCP connection')
        engine(options, (err2, res, body) => {
          t.equal(err2, null)
          t.equal(body, 'ok')
          server.stop()
          t.end()
        })
      }, 150)
    })
  })
})

tape('abort of a failed request leaves the connecting socket of another request alone', t => {
  const real = https.createServer(trusted, (req, res) => req.url === '/reset' ? req.socket.destroy() : res.end('ok'))
  const sockets = []
  const front = net.createServer(socket => {
    socket.on('error', () => {})
    sockets.push(socket)
    const upstream = net.connect(real.address().port, '127.0.0.1')
    upstream.on('error', () => {})
    setTimeout(() => socket.pipe(upstream).pipe(socket), sockets.length > 2 ? 100 : 0)
  })
  real.listen(0, () => front.listen(0, () => {
    const base = 'https://localhost:' + front.address().port
    let pending = 2
    let first
    const next = () => {
      if (--pending) {
        return
      }
      setTimeout(() => {
        const r = engine({url: base + '/', ca, timeout: 500}, (err, res, body) => {
          t.equal(err, null)
          t.equal(body, 'ok')
          sockets.forEach(socket => socket.destroy())
          front.close()
          real.close()
          real.closeAllConnections()
          t.end()
        })
        r.on('request', req => {
          req.on('connecting', connection => connection.once('connect', () => first.abort()))
          req.on('reused', () => t.fail('the request was expected on a new connection'))
        })
      }, 50)
    }
    first = engine({url: base + '/reset', ca}, err => {
      t.equal(err && err.code, 'ECONNRESET')
      next()
    })
    engine({url: base + '/', ca}, err => {
      t.equal(err, null)
      next()
    })
  }))
})

tape('exactly one lifecycle event per exchange', t => {
  const server = http.createServer((req, res) => {
    const hop = Number(req.url.slice(1))
    if (hop < 3) {
      res.writeHead(302, {Location: '/' + (hop + 1)})
      return res.end()
    }
    res.end('done')
  })
  server.listen(0, () => {
    const url = 'http://localhost:' + server.address().port + '/0'
    const counts = {connecting: 0, reused: 0}
    const r = engine({url}, (err, res, body) => {
      t.equal(err, null)
      t.equal(body, 'done')
      t.equal(counts.connecting, 1)
      t.equal(counts.reused, 3)
      server.close()
      t.end()
    })
    r.on('redirect', () => {})
    const watch = req => {
      req.on('connecting', () => counts.connecting++)
      req.on('reused', () => counts.reused++)
    }
    r.on('request', watch)
  })
})

tape('exactly one lifecycle event and one socket event per exchange when a request moves a live connection to another servername, as in Node', t => {
  const run = (api, cb) => {
    let connections = 0
    const server = https.createServer(trusted, (req, res) => res.end('ok'))
    server.on('connection', () => connections++)
    server.listen(0, () => {
      const options = {url: 'https://localhost:' + server.address().port + '/', ca, forever: true, rejectUnauthorized: false, pool: {}}
      const exchanges = []
      const send = (headers, next) => {
        const seen = {lifecycle: [], sockets: []}
        const r = api(Object.assign({headers}, options), err => {
          t.equal(err, null)
          exchanges.push(seen)
          next()
        })
        r.on('request', req => {
          req.on('connecting', () => seen.lifecycle.push('connecting'))
          req.on('reused', () => seen.lifecycle.push('reused'))
        })
        r.on('socket', socket => seen.sockets.push(socket))
      }
      send({}, () => send({host: 'other.example'}, () => {
        server.close()
        server.closeAllConnections()
        cb({
          lifecycle: exchanges.map(seen => seen.lifecycle),
          sockets: exchanges.map(seen => seen.sockets.map(kindOf)),
          moved: exchanges[1].sockets[0] !== exchanges[0].sockets[0],
          connections
        })
      }))
    })
  }
  run(nodeApi, node => run(engine, result => {
    t.deepEqual(node, {lifecycle: [['connecting'], ['connecting']], sockets: [['TLSSocket'], ['TLSSocket']], moved: true, connections: 2}, 'Node')
    t.deepEqual(result, node, 'engine')
    t.end()
  }))
})

function kindOf (socket) {
  return socket instanceof tls.TLSSocket ? 'TLSSocket' : socket instanceof net.Socket ? 'net.Socket' : String(socket)
}

function socketEvents (api, options, cb) {
  const events = []
  const sockets = []
  const r = api(options, (err, res, body) => cb({error: err && (err.code || err.message), body, events}, sockets))
  r.on('socket', socket => {
    sockets.push(socket)
    events.push('socket ' + kindOf(socket) + (r.req.socket === socket ? ' of r.req' : ''))
  })
  r.on('redirect', () => events.push('redirect'))
  r.on('response', () => events.push('response'))
}

let socketServerCount = 0

function socketServers (cb) {
  const handler = (req, res) => {
    const hops = /^\/redirect\/(\d+)$/.exec(req.url)
    if (hops && hops[1] !== '0') {
      res.writeHead(302, {Location: '/redirect/' + (hops[1] - 1)})
      return res.end()
    }
    res.end('ok ' + req.url)
  }
  const servers = {
    plain: http.createServer(handler),
    secure: https.createServer(trusted, handler),
    proxy: forwardingProxy(),
    tunnel: connectProxy(),
    tlsTunnel: connectProxy({}, tlsHandler => https.createServer(trusted, tlsHandler)),
    unix: http.createServer(handler)
  }
  servers.socketPath = path.join(os.tmpdir(), 'undici-lifecycle-' + process.pid + '-' + (++socketServerCount) + '.sock')
  servers.close = () => {
    ['plain', 'secure', 'proxy', 'tunnel', 'tlsTunnel', 'unix'].forEach(name => {
      servers[name].close()
      servers[name].closeAllConnections()
    })
  }
  servers.plain.listen(0, () => servers.secure.listen(0, () => servers.proxy.listen(0, () => servers.tunnel.listen(0, () => {
    servers.tlsTunnel.listen(0, () => servers.unix.listen(servers.socketPath, () => cb(servers)))
  }))))
}

function setRejectUnauthorized (value) {
  if (value === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = value
  }
}

tape('a socket event per hop before the response, with the socket of r.req, as in Node', t => {
  socketServers(servers => {
    const base = 'http://localhost:' + servers.plain.address().port
    const NEW = 'socket net.Socket of r.req'
    const rows = [
      {name: 'http', options: {url: base + '/'}, events: [NEW, 'response']},
      {name: 'https', options: {url: 'https://localhost:' + servers.secure.address().port + '/', ca}, events: ['socket TLSSocket of r.req', 'response']},
      {name: 'redirect', options: {url: base + '/redirect/2'}, events: [NEW, 'redirect', NEW, 'redirect', NEW, 'response']},
      {name: 'forwarding proxy', options: {url: 'http://target.invalid:81/', proxy: 'http://localhost:' + servers.proxy.address().port}, events: [NEW, 'response']},
      {name: 'tunnel to an http target', options: {url: base + '/', proxy: 'http://localhost:' + servers.tunnel.address().port, tunnel: true}, events: [NEW, 'response']},
      {
        name: 'tunnel to an http target through an https proxy, NODE_TLS_REJECT_UNAUTHORIZED=0',
        environment: '0',
        options: {url: base + '/', proxy: 'https://localhost:' + servers.tlsTunnel.address().port, tunnel: true},
        events: ['socket TLSSocket of r.req', 'response']
      },
      {name: 'unix socket', options: {url: 'http://unix:' + servers.socketPath + ':/'}, events: [NEW, 'response']}
    ]
    const next = () => {
      const row = rows.shift()
      if (!row) {
        servers.close()
        return closeAll().then(() => t.end())
      }
      const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
      setRejectUnauthorized('environment' in row ? row.environment : saved)
      socketEvents(nodeApi, Object.assign({}, row.options), node => socketEvents(engine, Object.assign({}, row.options), result => {
        setRejectUnauthorized(saved)
        t.deepEqual(node.events, row.events, 'Node: ' + row.name)
        t.deepEqual(result, node, 'engine: ' + row.name)
        next()
      }))
    }
    next()
  })
})

tape('a request on a keep-alive connection gets the socket of the request before, as in Node', t => {
  socketServers(servers => {
    const rows = [
      {name: 'http', options: () => ({url: 'http://localhost:' + servers.plain.address().port + '/'})},
      {name: 'https', options: () => ({url: 'https://localhost:' + servers.secure.address().port + '/', ca, forever: true, pool: {}})}
    ]
    const twice = (api, options, cb) => socketEvents(api, Object.assign({}, options), (first, firstSockets) => {
      socketEvents(api, Object.assign({}, options), (second, secondSockets) => {
        cb({first, second, same: firstSockets.length === 1 && firstSockets[0] === secondSockets[0]})
      })
    })
    const next = () => {
      const row = rows.shift()
      if (!row) {
        servers.close()
        return closeAll().then(() => t.end())
      }
      twice(nodeApi, row.options(), node => twice(engine, row.options(), result => {
        t.equal(node.same, true, 'Node: ' + row.name + ' reuses the socket')
        t.deepEqual(result, node, 'engine: ' + row.name)
        next()
      }))
    }
    next()
  })
})

tape('an error emitted on a new socket fails the request and closes the socket, as in Node', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(0, () => {
    const run = (api, cb) => {
      let socket
      const r = api({url: 'http://localhost:' + server.address().port + '/'}, err => {
        setImmediate(() => cb({error: err && err.message, destroyed: Boolean(socket && socket.destroyed)}))
      })
      r.on('socket', emitted => {
        socket = emitted
        emitted.emit('error', new Error('emitted on the socket'))
      })
    }
    run(nodeApi, node => run(engine, result => {
      t.deepEqual(node, {error: 'emitted on the socket', destroyed: true}, 'Node')
      t.deepEqual(result, node, 'engine')
      server.close()
      t.end()
    }))
  })
})

tape('a request undici refuses inside dispatch emits no lifecycle event', t => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(0, () => {
    const events = []
    const r = engine({url: 'http://localhost:' + server.address().port + '/', headers: {'x-invalid': 'b\u0100'}}, err => {
      t.notEqual(err, null)
      setTimeout(() => {
        t.deepEqual(events, [])
        server.close()
        t.end()
      }, 20)
    })
    lifecycleOf(r, events)
  })
})

tape('close dispatchers', t => {
  closeAll().then(() => t.end())
})

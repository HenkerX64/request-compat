'use strict'

const diagnosticsChannel = require('diagnostics_channel')
const http = require('http')
const net = require('net')
const tape = require('tape')
const nodeApi = require('request-compat')
const engine = require('../index')

function listen (handler, cb) {
  const server = http.createServer(handler)
  server.listen(0, () => cb(server, 'http://localhost:' + server.address().port))
}

function lifecycleOf (r, events) {
  r.on('request', req => {
    req.on('connecting', (connection, socket) => {
      events.push('connecting')
      events.push(connection === socket && socket instanceof net.Socket ? 'real socket' : 'no socket')
      connection.once('lookup', () => events.push('lookup'))
      connection.once('connect', () => events.push('connect'))
    })
    req.on('reused', socket => {
      events.push('reused')
      events.push(socket instanceof net.Socket ? 'real socket' : 'no socket')
    })
  })
  r.on('socket', () => events.push('socket'))
  r.on('response', () => events.push('response'))
}

function run (api, options, cb) {
  const events = []
  const r = api(options, (err, res, body) => cb(err, res, body, events, r))
  lifecycleOf(r, events)
}

tape('a new connection emits connecting with the real socket, then lookup and connect, and the request emits socket, as in Node', t => {
  listen((req, res) => res.end('ok'), (server, url) => {
    run(nodeApi, {url, pool: false}, (nodeErr, nodeRes, nodeBody, nodeEvents) => {
      run(engine, {url, pool: false}, (err, res, body, events, r) => {
        t.error(nodeErr)
        t.error(err)
        t.deepEqual(events, nodeEvents)
        t.deepEqual(events, ['socket', 'connecting', 'real socket', 'lookup', 'connect', 'response'])
        t.ok(r.req.socket instanceof net.Socket, 'r.req.socket is the socket')
        server.close(t.end)
      })
    })
  })
})

tape('a kept-alive connection emits reused with the same socket, as in Node', t => {
  listen((req, res) => res.end('ok'), (server, url) => {
    const agent = new http.Agent({keepAlive: true})
    const sockets = []
    run(engine, {url, agent}, (err, res, body, firstEvents, first) => {
      t.error(err)
      sockets.push(first.req.socket)
      setImmediate(() => {
        run(engine, {url, agent}, (err2, res2, body2, events, second) => {
          t.error(err2)
          sockets.push(second.req.socket)
          t.deepEqual(firstEvents.slice(0, 3), ['socket', 'connecting', 'real socket'])
          t.deepEqual(events, ['socket', 'reused', 'real socket', 'response'])
          t.equal(sockets[0], sockets[1], 'the same socket')
          agent.destroy()
          server.close(t.end)
        })
      })
    })
  })
})

tape('a socket event per hop before the response, with the socket of r.req, as in Node', t => {
  listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, {location: '/end'})
      return res.end()
    }
    res.end('done')
  }, (server, url) => {
    run(nodeApi, {url: url + '/start', pool: false}, (nodeErr, nodeRes, nodeBody, nodeEvents) => {
      run(engine, {url: url + '/start', pool: false}, (err, res, body, events) => {
        t.error(nodeErr)
        t.error(err)
        t.equal(body, 'done')
        t.deepEqual(events, nodeEvents)
        t.equal(events.filter(name => name === 'socket').length, 2)
        server.close(t.end)
      })
    })
  })
})

tape('every hop, redirects included, goes through got', t => {
  const created = []
  const onCreate = message => created.push(message.url)
  diagnosticsChannel.subscribe('got:request:create', onCreate)
  listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, {location: '/end'})
      return res.end()
    }
    res.end('done')
  }, (server, url) => {
    engine(url + '/start', (err, res, body) => {
      diagnosticsChannel.unsubscribe('got:request:create', onCreate)
      t.error(err)
      t.equal(body, 'done')
      t.deepEqual(created, [url + '/start', url + '/end'])
      server.close(t.end)
    })
  })
})

tape('time: true gives the timings in order, as in Node', t => {
  listen((req, res) => res.end('ok'), (server, url) => {
    engine({url, time: true, pool: false}, (err, res) => {
      t.error(err)
      const timings = res.timings
      t.ok(timings.socket >= 0 && timings.lookup >= timings.socket && timings.connect >= timings.lookup, 'socket, lookup, connect')
      t.ok(timings.response >= timings.connect && timings.end >= timings.response, 'response, end')
      t.equal(typeof res.timingPhases.total, 'number')
      server.close(t.end)
    })
  })
})

tape('timeout gives ESOCKETTIMEDOUT for a stalled response, as in Node', t => {
  listen((req, res) => {
    res.writeHead(200)
    res.write('start')
  }, (server, url) => {
    nodeApi({url, timeout: 100}, nodeErr => {
      engine({url, timeout: 100}, err => {
        t.equal(nodeErr.code, 'ESOCKETTIMEDOUT')
        t.equal(err.code, 'ESOCKETTIMEDOUT')
        t.equal(err.connect, false)
        server.closeAllConnections()
        server.close(t.end)
      })
    })
  })
})

tape('timeout gives ETIMEDOUT with connect: true while the connection is not established, as in Node', t => {
  const neverResolves = () => {}
  const options = {url: 'http://request-compat-got.test/', timeout: 100, lookup: neverResolves, pool: false}
  nodeApi(options, nodeErr => {
    engine(options, err => {
      t.equal(nodeErr.code, 'ETIMEDOUT')
      t.equal(err.code, 'ETIMEDOUT')
      t.equal(err.connect, true)
      t.end()
    })
  })
})

tape('a server that accepts and never answers gives ESOCKETTIMEDOUT with connect: false, as in Node', t => {
  listen(() => {}, (server, url) => {
    nodeApi({url, timeout: 100}, nodeErr => {
      engine({url, timeout: 100}, err => {
        t.equal(nodeErr.code, 'ESOCKETTIMEDOUT')
        t.equal(err.code, nodeErr.code)
        t.equal(err.connect, nodeErr.connect)
        server.closeAllConnections()
        server.close(t.end)
      })
    })
  })
})

tape('abort() before the start sends nothing, as in Node', t => {
  let reached = 0
  listen((req, res) => {
    reached++
    res.end()
  }, (server, url) => {
    const r = engine(url, () => t.fail('no callback'))
    r.abort()
    setTimeout(() => {
      t.equal(reached, 0)
      t.equal(r.req, undefined)
      server.close(t.end)
    }, 100)
  })
})

tape('abort() during the response ends it without an error, as in Node', t => {
  listen((req, res) => {
    res.writeHead(200, {'content-length': 100})
    res.write('part')
  }, (server, url) => {
    const r = engine(url)
    const events = []
    r.on('error', err => events.push('error ' + err.code))
    r.on('abort', () => events.push('abort'))
    r.on('response', res => {
      res.on('aborted', () => events.push('aborted'))
      res.on('close', () => {
        events.push('close')
        setTimeout(() => {
          t.deepEqual(events, ['abort', 'aborted', 'close'])
          server.closeAllConnections()
          server.close(t.end)
        }, 50)
      })
      r.on('data', () => r.abort())
    })
  })
})

tape('abort() in a response listener drops the body that has already arrived, as in Node', t => {
  listen((req, res) => {
    res.write('x'.repeat(5000))
    setTimeout(() => res.end('y'), 100)
  }, (server, url) => {
    const run = (api, cb) => {
      const events = []
      let bytes = 0
      const r = api(url, () => events.push('callback'))
      r.on('response', () => {
        events.push('response')
        r.abort()
      })
      r.on('data', chunk => {
        bytes += chunk.length
        events.push('data')
      })
      ;['end', 'complete', 'error', 'close'].forEach(name => r.on(name, () => events.push(name)))
      setTimeout(() => cb(events, bytes), 300)
    }
    run(nodeApi, (nodeEvents, nodeBytes) => {
      run(engine, (events, bytes) => {
        t.deepEqual(nodeEvents, ['response', 'end', 'close'])
        t.equal(nodeBytes, 0)
        t.deepEqual(events, nodeEvents)
        t.equal(bytes, nodeBytes)
        server.closeAllConnections()
        server.close(t.end)
      })
    })
  })
})

tape('a request error after the response reaches the request, as in Node: the upload that a 413 response cut off', t => {
  listen((req, res) => {
    res.writeHead(413, {connection: 'close'})
    res.end('too big')
  }, (server, url) => {
    const run = (api, cb) => {
      const events = []
      const r = api.post({url, body: Buffer.alloc(8 * 1024 * 1024, 'a')}, (err, res) => events.push(err ? 'callback error' : 'callback ' + res.statusCode))
      r.on('error', err => events.push(/^(EPIPE|ECONNRESET)$/.test(err.code) ? 'error after the response' : 'error ' + err.code))
      setTimeout(() => cb(events), 300)
    }
    run(nodeApi, nodeEvents => {
      run(engine, events => {
        t.deepEqual(nodeEvents, ['callback 413', 'error after the response'])
        t.deepEqual(events, nodeEvents)
        server.close(t.end)
      })
    })
  })
})

tape('abort() on the next tick and response.destroy() in a response listener drop the body that has already arrived; abort() in a later microtask gets it, as in Node', t => {
  listen((req, res) => {
    res.write('x'.repeat(5000))
    setTimeout(() => res.end('y'), 100)
  }, (server, url) => {
    const reactions = {
      'abort() on the next tick': (r, res) => process.nextTick(() => r.abort()),
      'response.destroy()': (r, res) => res.destroy(),
      'abort() in a promise microtask': (r, res) => Promise.resolve().then(() => r.abort())
    }
    const names = Object.keys(reactions)
    const run = (api, react, cb) => {
      const events = []
      let bytes = 0
      const r = api(url)
      r.on('response', res => {
        events.push('response')
        react(r, res)
      })
      r.on('data', chunk => {
        bytes += chunk.length
      })
      ;['end', 'complete', 'error', 'close'].forEach(name => r.on(name, () => events.push(name)))
      setTimeout(() => cb(events, bytes), 300)
    }
    const next = () => {
      const name = names.shift()
      if (!name) {
        server.closeAllConnections()
        return server.close(t.end)
      }
      run(nodeApi, reactions[name], (nodeEvents, nodeBytes) => {
        run(engine, reactions[name], (events, bytes) => {
          t.deepEqual(events, nodeEvents, name)
          t.equal(bytes, nodeBytes, name + ': ' + nodeBytes + ' bytes')
          next()
        })
      })
    }
    next()
  })
})

function abortedBody (req, res) {
  res.writeHead(200, {'content-length': 100})
  res.write('part')
  setTimeout(() => req.socket.destroy(), 20)
}

tape('errors keep Node\'s code and message', t => {
  const cases = [
    {name: 'connection refused', handler: null},
    {name: 'socket hang up', handler: req => req.socket.destroy()},
    {name: 'aborted body', handler: abortedBody}
  ]
  const next = () => {
    const item = cases.shift()
    if (!item) {
      return t.end()
    }
    if (!item.handler) {
      return nodeApi('http://localhost:1/', nodeErr => {
        engine('http://localhost:1/', err => {
          t.equal(err.code, nodeErr.code, item.name)
          t.equal(err.message, nodeErr.message, item.name)
          next()
        })
      })
    }
    listen(item.handler, (server, url) => {
      nodeApi(url, nodeErr => {
        engine(url, err => {
          t.equal(err.code, nodeErr.code, item.name)
          t.equal(err.message, nodeErr.message, item.name)
          server.close(next)
        })
      })
    })
  }
  next()
})

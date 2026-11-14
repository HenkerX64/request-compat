'use strict'

const http = require('http')
const {PassThrough} = require('stream')
const nodeApi = require('request-compat')
const engine = require('../index')
const {test, listen, close, call, wait, httpServer, rawServer} = require('./helpers')

function lifecycleOf (r, events) {
  r.on('socket', () => events.push('socket'))
  r.on('request', req => {
    events.push('request')
    req.on('connecting', (connection, socket) => {
      events.push('connecting ' + typeof socket)
      connection.once('lookup', () => events.push('lookup'))
      connection.once('connect', () => events.push('connect'))
    })
    req.on('reused', () => events.push('reused'))
  })
  r.on('response', () => events.push('response'))
}

test('every exchange emits connecting without a socket, then lookup and connect, and the request emits no socket event', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  for (const attempt of ['new connection', 'kept-alive connection']) {
    const events = []
    const done = new Promise(resolve => {
      const r = engine({url}, (err, res) => resolve({err, res, r}))
      lifecycleOf(r, events)
      t.deepEqual(events, [], attempt + ': no event before send returns')
    })
    const {err, res, r} = await done
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.deepEqual(events, ['request', 'connecting undefined', 'lookup', 'connect', 'response'], attempt)
    t.equal(r.req.socket, undefined, 'r.req.socket is not set')
    t.equal(res.socket, undefined, 'the response has no socket')
  }
  t.equal(new Set(server.seen.map(entry => entry.port)).size, 1, 'both requests used one connection')
  await close(server)
})

test('time: true gives the timings of the Node transport with lookup and connect equal to socket', async t => {
  const server = httpServer((req, res) => setTimeout(() => res.end('ok'), 30))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const node = await call(nodeApi, {url, time: true})
  const {err, res} = await call(engine, {url, time: true})
  t.equal(err, null)
  t.deepEqual(Object.keys(res.timings), ['socket', 'lookup', 'connect', 'response', 'end'], 'the keys of a Node request to a host name')
  t.deepEqual(Object.keys(res.timings).sort(), Object.keys(node.res.timings).sort())
  t.deepEqual(Object.keys(res.timingPhases), Object.keys(node.res.timingPhases))
  t.ok(res.timings.connect - res.timings.socket < 5, 'connect follows socket at once')
  t.ok(res.timings.lookup >= res.timings.socket && res.timings.connect >= res.timings.lookup)
  t.ok(res.timings.response >= 25, 'response carries the wait for the headers')
  t.ok(res.timingPhases.firstByte >= 25, 'firstByte carries connecting and waiting')
  t.ok(res.timings.end >= res.timings.response)
  t.equal(typeof res.elapsedTime, 'number')
  await close(server)
})

test('timeout before the response headers is ESOCKETTIMEDOUT with connect false, where Node says the same', async t => {
  const server = httpServer((req, res) => setTimeout(() => res.end('late'), 400))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const node = await call(nodeApi, {url, timeout: 100})
  const started = Date.now()
  const {err, res} = await call(engine, {url, timeout: 100})
  t.equal(node.err.code, 'ESOCKETTIMEDOUT')
  t.equal(err && err.code, 'ESOCKETTIMEDOUT')
  t.equal(err && err.connect, false)
  t.equal(res, undefined)
  t.ok(Date.now() - started < 350, 'the error comes at the timeout, not at the response')
  await close(server)
})

test('timeout in the middle of the body is ESOCKETTIMEDOUT and stops the download', async t => {
  let closedEarly = false
  const server = httpServer((req, res) => {
    res.write('first')
    const timer = setTimeout(() => res.end('second'), 400)
    res.on('close', () => {
      closedEarly = !res.writableEnded
      clearTimeout(timer)
    })
  })
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const {err} = await call(engine, {url, timeout: 100})
  t.equal(err && err.code, 'ESOCKETTIMEDOUT')
  t.equal(err && err.connect, false)
  await wait(100)
  t.equal(closedEarly, true, 'the server saw the connection close before its response ended')
  await close(server)
})

test('a body that keeps arriving within the timeout is not timed out', async t => {
  const server = httpServer((req, res) => {
    res.write('a')
    setTimeout(() => res.write('b'), 80)
    setTimeout(() => res.end('c'), 160)
  })
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const {err, body} = await call(engine, {url, timeout: 120})
  t.equal(err, null)
  t.equal(body, 'abc')
  await close(server)
})

test('a connection that is never established is ESOCKETTIMEDOUT with connect false, Node says ETIMEDOUT with connect true', async t => {
  const url = 'http://10.255.255.1/'
  const node = await call(nodeApi, {url, timeout: 150})
  const {err} = await call(engine, {url, timeout: 150})
  if (node.err.code !== 'ETIMEDOUT') {
    t.comment('this network answers for 10.255.255.1 (' + node.err.code + '), the connect timeout cannot be shown here')
    return
  }
  t.equal(node.err.connect, true)
  t.equal(err && err.code, 'ESOCKETTIMEDOUT', 'the engine cannot tell connecting from waiting')
  t.equal(err && err.connect, false)
})

test('abort() before the request starts sends nothing and emits abort', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const events = []
  const r = engine({url}, () => events.push('callback'))
  r.on('abort', () => events.push('abort'))
  r.on('error', () => events.push('error'))
  r.abort()
  await wait(100)
  t.deepEqual(events, ['abort'])
  t.equal(server.seen.length, 0)
  await close(server)
})

test('abort() while waiting for the response closes the exchange without an error', async t => {
  const server = httpServer((req, res) => setTimeout(() => res.end('late'), 300))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const events = []
  const r = engine({url, timeout: 2000}, () => events.push('callback'))
  r.on('abort', () => events.push('abort'))
  r.on('error', err => events.push('error ' + err.code))
  await wait(60)
  r.abort()
  await wait(400)
  t.deepEqual(events, ['abort'])
  await close(server)
})

async function reachedAfterEarlyAbort (api) {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const callbacks = []
  for (let i = 0; i < 10; i++) {
    const r = api.post({url: url + i, body: 'payload'}, err => callbacks.push(err))
    r.on('request', () => setTimeout(() => r.abort(), 0))
  }
  await wait(500)
  const reached = server.seen.length
  await close(server)
  return {reached, callbacks: callbacks.length}
}

test('abort() after the start does not stop impit: the request still reaches the server', async t => {
  const node = await reachedAfterEarlyAbort(nodeApi)
  const impit = await reachedAfterEarlyAbort(engine)
  t.comment('Node: ' + node.reached + ' of 10 requests reached the server')
  t.equal(impit.reached, 10, 'impit sends every request although it was aborted before a response')
  t.equal(impit.callbacks, 0, 'the caller hears nothing more of them, as in Node')
})

async function connectionsLeftOpenByATimeout (api) {
  let opened = 0
  let closed = 0
  const server = http.createServer(() => {})
  server.on('connection', socket => {
    opened++
    socket.on('close', () => closed++)
  })
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const {err} = await call(api, {url, timeout: 100})
  await wait(400)
  const left = opened - closed
  await close(server)
  return {code: err && err.code, opened, left}
}

test('a timeout before the response does not stop impit: its request and its connection stay open, Node closes the connection', async t => {
  const node = await connectionsLeftOpenByATimeout(nodeApi)
  const impit = await connectionsLeftOpenByATimeout(engine)
  t.deepEqual(node, {code: 'ESOCKETTIMEDOUT', opened: 1, left: 0}, 'Node')
  t.deepEqual(impit, {code: 'ESOCKETTIMEDOUT', opened: 1, left: 1}, 'the caller gets the same error, the server keeps the connection')
})

test('abort() in the middle of the body stops the download and calls back nothing', async t => {
  let closedEarly = false
  const server = httpServer((req, res) => {
    res.write('first')
    const timer = setTimeout(() => res.end('second'), 500)
    res.on('close', () => {
      closedEarly = !res.writableEnded
      clearTimeout(timer)
    })
  })
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const events = []
  const r = engine({url}, () => events.push('callback'))
  r.on('data', () => {
    events.push('data')
    r.abort()
  })
  r.on('abort', () => events.push('abort'))
  r.on('error', err => events.push('error ' + err.code))
  await wait(250)
  t.deepEqual(events, ['data', 'abort'])
  t.equal(closedEarly, true, 'the server saw the connection close before its response ended')
  await close(server)
})

test('a piped upload reaches the server while it is written and waits for the connection under backpressure', async t => {
  const arrivals = []
  const server = httpServer()
  server.prependListener('request', req => req.on('data', chunk => arrivals.push(chunk.length)))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const source = new PassThrough()
  const r = engine.put({url})
  const done = new Promise(resolve => r.on('complete', resolve))
  let drains = 0
  r.on('drain', () => drains++)
  source.pipe(r)
  source.write(Buffer.alloc(100, 'a'))
  await wait(100)
  t.deepEqual(arrivals, [100], 'the first chunk arrived before the source ended')
  r.write(Buffer.alloc(100000, 'b'))
  t.equal(r.write(Buffer.alloc(100000, 'c')), false, 'a chunk over the buffer limit asks the caller to wait')
  await wait(100)
  t.ok(drains >= 1, 'drain was emitted')
  source.end()
  await done
  t.equal(server.seen[0].body.length, 200100)
  t.equal(server.seen[0].headers['transfer-encoding'], 'chunked')
  t.equal(server.seen[0].headers['content-length'], undefined)
  await close(server)
})

test('the idle timer ends with its exchange', async t => {
  const server = httpServer()
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const errors = []
  const {err, request} = await call(engine, {url, timeout: 80})
  request.on('error', error => errors.push(error))
  t.equal(err, null)
  await wait(200)
  t.deepEqual(errors, [], 'no timeout after the response has ended')
  t.equal(request.req.idleTimer, null)
  await close(server)
})

test('a response the caller does not read keeps the exchange open until abort()', async t => {
  const server = rawServer(socket => socket.write('HTTP/1.1 200 OK\r\nContent-Length: 400000\r\n\r\n' + 'x'.repeat(400000)))
  const url = 'http://127.0.0.1:' + await listen(server) + '/'
  const r = engine({url})
  const res = await new Promise(resolve => r.on('response', resolve))
  r.pause()
  await wait(100)
  t.equal(res.complete, false)
  r.abort()
  await wait(50)
  t.equal(res.destroyed, true)
  await close(server)
})

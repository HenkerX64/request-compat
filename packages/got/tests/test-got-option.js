'use strict'

const http = require('http')
const net = require('net')
const {URL} = require('url')
const zlib = require('zlib')
const tape = require('tape')
const gotModule = require('got')
const nodeApi = require('request-compat')
const engine = require('../index')

const got = gotModule.default

const {AbortController} = global

function listen (handler, cb) {
  const server = http.createServer(handler)
  server.listen(0, () => cb(server, 'http://localhost:' + server.address().port))
}

function rawHeaders (req) {
  const headers = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1])
  }
  return headers
}

tape('a beforeRequest hook of the got instance adds, changes and removes headers; the other header names keep their case', t => {
  const instance = got.extend({
    hooks: {
      beforeRequest: [options => {
        options.headers['x-signed'] = 'yes'
        options.headers['x-change'] = 'after'
        delete options.headers['x-drop']
      }]
    }
  })
  listen((req, res) => res.end(JSON.stringify(rawHeaders(req))), (server, url) => {
    engine({url, got: instance, headers: {'X-Keep': 'k', 'X-Change': 'before', 'X-Drop': 'd'}}, (err, res, body) => {
      t.error(err)
      t.deepEqual(JSON.parse(body), [
        'X-Keep: k',
        'X-Change: after',
        'host: localhost:' + server.address().port,
        'x-signed: yes',
        'Connection: keep-alive'
      ])
      server.close(t.end)
    })
  })
})

tape('every hop runs the hooks of the got instance, and request.defaults({got}) gives an API on one instance', t => {
  const hops = []
  const instance = got.extend({hooks: {beforeRequest: [options => { hops.push(options.url.pathname) }]}})
  const client = engine.defaults({got: instance})
  listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, {location: '/end'})
      return res.end()
    }
    res.end('done')
  }, (server, url) => {
    client.get(url + '/start', (err, res, body) => {
      t.error(err)
      t.equal(body, 'done')
      t.deepEqual(hops, ['/start', '/end'])
      server.close(t.end)
    })
  })
})

tape('the engine overrides the got options the core owns: redirects, decompression, retry, timeouts, cookie jar, HTTP errors and cache', t => {
  let hits = 0
  const jar = {getCookieString: () => Promise.resolve('from=got'), setCookie: () => Promise.resolve()}
  const instance = got.extend({
    followRedirect: true,
    decompress: true,
    retry: {limit: 3},
    timeout: {request: 1},
    cookieJar: jar,
    throwHttpErrors: true,
    cache: new Map()
  })
  listen((req, res) => {
    hits++
    if (req.url === '/redirect') {
      res.writeHead(302, {location: '/gzip'})
      return res.end()
    }
    if (req.url === '/gzip') {
      setTimeout(() => {
        res.writeHead(500, {'content-encoding': 'gzip', 'x-cookie': String(req.headers.cookie)})
        res.end(zlib.gzipSync('compressed'))
      }, 20)
    }
  }, (server, url) => {
    engine({url: url + '/redirect', got: instance, followRedirect: false, encoding: null}, (err, res, body) => {
      t.error(err)
      t.equal(res.statusCode, 302, 'the core decides on redirects')
      engine({url: url + '/gzip', got: instance, encoding: null}, (err2, res2, body2) => {
        t.error(err2, 'no got HTTP error, no got timeout')
        t.equal(res2.statusCode, 500)
        t.equal(zlib.gunzipSync(body2).toString(), 'compressed', 'no got decompression')
        t.equal(res2.headers['x-cookie'], 'undefined', 'no cookie from the got jar')
        t.equal(hits, 2, 'no got retry')
        server.close(t.end)
      })
    })
  })
})

tape('got\'s own default headers are not sent: no got user-agent, no accept-encoding', t => {
  listen((req, res) => res.end(JSON.stringify(req.headers)), (server, url) => {
    engine(url, (err, res, body) => {
      t.error(err)
      const headers = JSON.parse(body)
      t.equal(headers['user-agent'], undefined)
      t.equal(headers['accept-encoding'], undefined)
      server.close(t.end)
    })
  })
})

tape('options of the got instance that the engine cannot honour are refused with OPTION_NOT_SUPPORTED before anything is sent', t => {
  const refused = [
    ['agent', {agent: {http: new http.Agent()}}],
    ['https', {https: {rejectUnauthorized: false}}],
    ['http2', {http2: true}],
    ['localAddress', {localAddress: '127.0.0.1'}],
    ['createConnection', {createConnection: () => null}],
    ['maxHeaderSize', {maxHeaderSize: 100}],
    ['setHost', {setHost: false}],
    ['signal', {signal: new AbortController().signal}],
    ['request', {request: http.request}],
    ['headers', {headers: {'x-instance': 'yes'}}],
    ['encoding', {encoding: 'base64'}]
  ]
  let hits = 0
  listen((req, res) => {
    hits++
    res.end()
  }, (server, url) => {
    const next = () => {
      const item = refused.shift()
      if (!item) {
        t.equal(hits, 0, 'nothing was sent')
        return server.close(t.end)
      }
      engine({url, got: got.extend(item[1])}, err => {
        t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', item[0])
        t.equal(err && err.option, 'got.' + item[0])
        next()
      })
    }
    next()
  })
})

tape('options that a got handler or hook sets and the engine does not pass to Node are refused with OPTION_NOT_SUPPORTED before anything is sent', t => {
  const hooked = change => got.extend({hooks: {beforeRequest: [change]}})
  const refused = [
    ['agent', hooked(options => { options.agent = {http: new http.Agent()} })],
    ['https', hooked(options => { options.https = {rejectUnauthorized: false} })],
    ['http2', hooked(options => { options.http2 = true })],
    ['localAddress', hooked(options => { options.localAddress = '127.0.0.1' })],
    ['createConnection', hooked(options => { options.createConnection = () => null })],
    ['maxHeaderSize', hooked(options => { options.maxHeaderSize = 100 })],
    ['setHost', hooked(options => { options.setHost = false })],
    ['signal', hooked(options => { options.signal = new AbortController().signal })],
    ['dnsLookup', hooked(options => { options.dnsLookup = (hostname, lookupOptions, cb) => cb(null, '127.0.0.1', 4) })],
    ['request', hooked(options => { options.request = http.request })],
    ['enableUnixSockets', hooked(options => { options.enableUnixSockets = false })],
    ['encoding', hooked(options => { options.encoding = 'base64' })],
    ['https', got.extend({handlers: [(options, next) => { options.https = {rejectUnauthorized: false}; return next(options) }]})],
    ['request', got.extend({handlers: [() => got.stream('http://localhost:1/')]})]
  ]
  let hits = 0
  listen((req, res) => {
    hits++
    res.end()
  }, (server, url) => {
    const next = () => {
      const item = refused.shift()
      if (!item) {
        t.equal(hits, 0, 'nothing was sent')
        return server.close(t.end)
      }
      engine({url, got: item[1]}, err => {
        t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', item[0])
        t.equal(err && err.option, 'got.' + item[0])
        next()
      })
    }
    next()
  })
})

tape('a response that arrives while an asynchronous beforeRequest hook runs reaches the callback, as without the hook', t => {
  const server = net.createServer(socket => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'))
  const instance = got.extend({hooks: {beforeRequest: [() => new Promise(resolve => setTimeout(resolve, 100))]}})
  server.listen(0, () => {
    engine({url: 'http://localhost:' + server.address().port + '/', got: instance, timeout: 2000}, (err, res, body) => {
      t.error(err)
      t.equal(res && res.statusCode, 200)
      t.equal(body, 'ok')
      server.close(t.end)
    })
  })
})

const slowHook = () => new Promise(resolve => setTimeout(resolve, 150))

function earlyServer (handler, cb) {
  const sockets = []
  const server = net.createServer(socket => {
    sockets.push(socket)
    socket.on('error', () => {})
    handler(socket)
  })
  const close = done => {
    sockets.forEach(socket => socket.destroy())
    server.close(done)
  }
  server.listen(0, () => cb(close, 'http://localhost:' + server.address().port + '/'))
}

function observe (r, events, counted) {
  r.on('response', res => {
    events.push('response')
    res.on('aborted', () => events.push('response aborted'))
  })
  r.on('data', chunk => {
    counted.bytes += chunk.length
  })
  ;['end', 'complete', 'close'].forEach(name => r.on(name, () => events.push(name)))
  r.on('error', err => events.push('error ' + err.code))
}

tape('a hook that changes the list of beforeRequest hooks is refused as got.hooks.beforeRequest before anything is sent', t => {
  const hooked = change => got.extend({hooks: {beforeRequest: [change]}})
  const changes = [
    ['emptied, then https set', hooked(options => {
      options.hooks.beforeRequest.length = 0
      options.https = {rejectUnauthorized: false}
    })],
    ['the engine check spliced out, then localAddress set', hooked(options => {
      options.hooks.beforeRequest.splice(1)
      options.localAddress = '127.0.0.1'
    })],
    ['a hook added that runs after the engine check', hooked(options => {
      options.hooks.beforeRequest.push(later => { later.localAddress = '127.0.0.1' })
    })],
    ['the hooks replaced', hooked(options => {
      options.hooks = {beforeRequest: []}
    })]
  ]
  let hits = 0
  listen((req, res) => {
    hits++
    res.end()
  }, (server, url) => {
    const next = () => {
      const item = changes.shift()
      if (!item) {
        t.equal(hits, 0, 'nothing was sent')
        return server.close(t.end)
      }
      engine({url, got: item[1]}, err => {
        t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', item[0])
        t.equal(err && err.option, 'got.hooks.beforeRequest', item[0])
        next()
      })
    }
    next()
  })
})

tape('a response that breaks off while an asynchronous beforeRequest hook runs gives the events and the error of Node\'s transport; the body bytes that came before the break are not emitted', t => {
  earlyServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nok')
    setTimeout(() => socket.destroy(), 50)
  }, (close, url) => {
    const run = (api, options, cb) => {
      const events = []
      const counted = {bytes: 0}
      const r = api(Object.assign({url, timeout: 2000}, options), err => events.push('callback ' + (err && err.code + ' ' + err.message)))
      observe(r, events, counted)
      setTimeout(() => cb(events, counted.bytes), 600)
    }
    run(engine, {got: got.extend({hooks: {beforeRequest: [slowHook]}})}, (events, bytes) => {
      run(nodeApi, {}, (nodeEvents, nodeBytes) => {
        t.deepEqual(nodeEvents, ['response', 'response aborted', 'callback ECONNRESET aborted', 'error ECONNRESET', 'end', 'complete', 'close'])
        t.deepEqual(events, nodeEvents)
        t.equal(nodeBytes, 2, 'Node\'s transport emits the two bytes before the break')
        t.equal(bytes, 0, 'the engine does not')
        close(t.end)
      })
    })
  })
})

tape('abort() and response.destroy() in a response listener drop the body of a response that arrived while a hook ran, as without the hook', t => {
  const body = 'x'.repeat(5000)
  earlyServer(socket => {
    socket.write('HTTP/1.1 200 OK\r\ncontent-length: 5001\r\n\r\n' + body)
    setTimeout(() => socket.end('y'), 300)
  }, (close, url) => {
    const reactions = {
      'abort()': (r, res) => r.abort(),
      'response.destroy()': (r, res) => res.destroy(),
      'abort() on the next tick': (r, res) => process.nextTick(() => r.abort())
    }
    const names = Object.keys(reactions)
    const run = (api, options, react, cb) => {
      const events = []
      const counted = {bytes: 0}
      const r = api(Object.assign({url}, options))
      observe(r, events, counted)
      r.on('response', res => react(r, res))
      setTimeout(() => cb(events, counted.bytes), 500)
    }
    const next = () => {
      const name = names.shift()
      if (!name) {
        return close(t.end)
      }
      run(nodeApi, {}, reactions[name], (nodeEvents, nodeBytes) => {
        run(engine, {got: got.extend({hooks: {beforeRequest: [slowHook]}})}, reactions[name], (events, bytes) => {
          t.equal(nodeBytes, 0, name + ' on Node\'s transport')
          t.equal(bytes, 0, name)
          t.deepEqual(events, nodeEvents, name)
          next()
        })
      })
    }
    next()
  })
})

tape('a response that arrives while a hook runs keeps Node\'s state: complete is set, and a listener the caller adds survives the removal of the others', t => {
  earlyServer(socket => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'), (close, url) => {
    let completeInListener
    const r = engine({url, got: got.extend({hooks: {beforeRequest: [slowHook]}})}, (err, res) => {
      t.error(err)
      t.equal(completeInListener, true, 'complete in the response listener')
      const probe = () => {}
      res.on('probe', probe)
      res.eventNames().filter(name => name !== 'probe').forEach(name => res.removeAllListeners(name))
      t.equal(res.listenerCount('probe'), 1)
      close(t.end)
    })
    r.on('response', res => {
      completeInListener = res.complete
    })
  })
})

tape('a value that is not a got instance is a TypeError with code INVALID_GOT_INSTANCE', t => {
  engine({url: 'http://localhost:1/', got: {stream: () => null}}, err => {
    t.ok(err instanceof TypeError)
    t.equal(err.code, 'INVALID_GOT_INSTANCE')
    t.end()
  })
})

tape('a beforeRequest hook that changes the URL or the method is refused with OPTION_NOT_SUPPORTED', t => {
  const changes = [
    ['url', options => { options.url = new URL('http://localhost:1/elsewhere') }],
    ['method', options => { options.method = 'PUT' }]
  ]
  let hits = 0
  listen((req, res) => {
    hits++
    res.end()
  }, (server, url) => {
    const next = () => {
      const item = changes.shift()
      if (!item) {
        t.equal(hits, 0, 'nothing reached the server')
        return server.close(t.end)
      }
      engine({url, got: got.extend({hooks: {beforeRequest: [item[1]]}})}, err => {
        t.equal(err && err.code, 'OPTION_NOT_SUPPORTED', item[0])
        t.equal(err && err.option, 'got.' + item[0])
        next()
      })
    }
    next()
  })
})

tape('a got handler that turns a core-owned option back on is refused with OPTION_NOT_SUPPORTED', t => {
  const instance = got.extend({
    handlers: [(options, next) => {
      options.followRedirect = true
      return next(options)
    }]
  })
  engine({url: 'http://localhost:1/', got: instance}, err => {
    t.equal(err && err.code, 'OPTION_NOT_SUPPORTED')
    t.equal(err && err.option, 'got.followRedirect')
    t.end()
  })
})

tape('a beforeRequest hook that returns a response is refused with OPTION_NOT_SUPPORTED', t => {
  const instance = got.extend({hooks: {beforeRequest: [() => new http.IncomingMessage(null)]}})
  listen((req, res) => res.end(), (server, url) => {
    engine({url, got: instance}, err => {
      t.equal(err && err.code, 'OPTION_NOT_SUPPORTED')
      t.equal(err && err.option, 'got.hooks.beforeRequest')
      server.close(t.end)
    })
  })
})

tape('dnsLookup, dnsCache and dnsLookupIpVersion of the got instance resolve the host where the request sets no lookup or family; the request\'s own win', t => {
  const asked = []
  const toLoopback = name => (hostname, options, cb) => {
    asked.push(name + ' ' + hostname)
    if (options && options.all) {
      return cb(null, [{address: '127.0.0.1', family: 4}])
    }
    cb(null, '127.0.0.1', 4)
  }
  listen((req, res) => res.end('ok'), (server) => {
    const url = 'http://request-compat-got.test:' + server.address().port + '/'
    engine({url, pool: false, got: got.extend({dnsLookup: toLoopback('got')})}, (err, res, body) => {
      t.error(err)
      t.equal(body, 'ok')
      engine({url, pool: false, got: got.extend({dnsCache: {lookup: toLoopback('cache')}})}, (err2, res2, body2) => {
        t.error(err2)
        t.equal(body2, 'ok')
        engine({url, pool: false, lookup: toLoopback('request'), got: got.extend({dnsLookup: toLoopback('got')})}, (err3, res3, body3) => {
          t.error(err3)
          t.equal(body3, 'ok')
          engine({url, pool: false, family: 4, got: got.extend({dnsLookupIpVersion: 6, dnsLookup: toLoopback('family')})}, (err4, res4, body4) => {
            t.error(err4, 'the request\'s family wins over dnsLookupIpVersion')
            t.deepEqual(asked, [
              'got request-compat-got.test',
              'cache request-compat-got.test',
              'request request-compat-got.test',
              'family request-compat-got.test'
            ])
            server.close(t.end)
          })
        })
      })
    })
  })
})

tape('beforeError hooks of the got instance see errors before the response and may replace them', t => {
  const seen = []
  const instance = got.extend({
    hooks: {
      beforeError: [error => {
        seen.push(error.code)
        const replaced = new Error('replaced')
        replaced.code = 'EREPLACED'
        return replaced
      }]
    }
  })
  engine({url: 'http://localhost:1/', got: instance}, err => {
    t.deepEqual(seen, ['ECONNREFUSED'])
    t.equal(err.code, 'EREPLACED')
    t.end()
  })
})

tape('got publishes its diagnostics_channel events for every hop; bodySize is 0 because the core reads the body', t => {
  const diagnosticsChannel = require('diagnostics_channel')
  const names = ['got:request:create', 'got:request:start', 'got:response:start', 'got:response:end', 'got:request:error']
  const seen = []
  const subscribers = names.map(name => {
    const subscriber = message => seen.push(name.replace('got:', '') + (message.bodySize !== undefined ? ' ' + message.bodySize : ''))
    diagnosticsChannel.subscribe(name, subscriber)
    return subscriber
  })
  const unsubscribe = () => names.forEach((name, index) => diagnosticsChannel.unsubscribe(name, subscribers[index]))
  listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, {location: '/end'})
      return res.end()
    }
    res.end('done')
  }, (server, url) => {
    engine(url + '/start', (err, res, body) => {
      t.error(err)
      t.equal(body, 'done')
      engine('http://localhost:1/', err2 => {
        unsubscribe()
        t.equal(err2.code, 'ECONNREFUSED')
        t.deepEqual(seen, [
          'request:create', 'request:start', 'response:start', 'response:end 0',
          'request:create', 'request:start', 'response:start', 'response:end 0',
          'request:create', 'request:start', 'request:error'
        ])
        server.close(t.end)
      })
    })
  })
})

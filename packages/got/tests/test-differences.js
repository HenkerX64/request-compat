'use strict'

const http = require('http')
const net = require('net')
const tape = require('tape')
const gotModule = require('got')
const compare = require('./compare')
const nodeApi = require('request-compat')
const engine = require('../index')

const got = gotModule.default
const CORE_RESPONSE_FIELDS = ['request', 'toJSON', 'caseless', 'body']

function listen (handler, cb) {
  const server = http.createServer(handler)
  server.listen(0, () => cb(server, 'http://localhost:' + server.address().port))
}

function rawServer (response, cb) {
  const sockets = []
  const server = net.createServer(socket => {
    sockets.push(socket)
    socket.once('data', () => socket.write(response))
  })
  server.listen(0, () => cb(server, 'http://localhost:' + server.address().port + '/', sockets))
}

function ownFields (response) {
  return Object.keys(response).filter(name => CORE_RESPONSE_FIELDS.indexOf(name) === -1).sort()
}

tape('r.req is the engine\'s exchange, not a ClientRequest; r.req.socket is the socket, and response.req is Node\'s ClientRequest', t => {
  listen((req, res) => res.end('ok'), (server, url) => {
    let exchange
    const r = engine({url, pool: false}, (err, res) => {
      t.error(err)
      t.notOk(exchange instanceof http.ClientRequest, 'the request event carries the exchange')
      t.equal(typeof exchange.setHeader, 'undefined', 'no ClientRequest methods such as setHeader')
      t.ok(r.req.socket instanceof net.Socket, 'r.req.socket')
      t.ok(res.req instanceof http.ClientRequest, 'response.req')
      t.equal(res.req.socket, r.req.socket)
      server.close(t.end)
    })
    r.on('request', req => {
      exchange = req
    })
  })
})

tape('write() returns false until got hands the chunk to the ClientRequest, where Node returns true below its high-water mark; the bytes are the same', t => {
  const bodies = []
  listen((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString())
      res.end()
    })
  }, (server, url) => {
    const results = {}
    const n = nodeApi.put({url, pool: false}, () => {
      const e = engine.put({url, pool: false}, () => {
        t.deepEqual(results, {node: true, engine: false})
        t.deepEqual(bodies, ['abc', 'abc'])
        server.close(t.end)
      })
      results.engine = e.write('abc')
      e.end()
    })
    results.node = n.write('abc')
    n.end()
  })
})

tape('got keeps its timings on Node\'s ClientRequest: response.req.timings is set, Node has none', t => {
  listen((req, res) => res.end(), (server, url) => {
    nodeApi(url, (nodeErr, nodeRes) => {
      engine(url, (err, res) => {
        t.error(nodeErr)
        t.error(err)
        t.equal(nodeRes.req.timings, undefined)
        t.equal(typeof res.req.timings, 'object')
        t.equal(res.timings, undefined, 'the response itself has no got timings')
        server.close(t.end)
      })
    })
  })
})

tape('the response is Node\'s IncomingMessage with the fields Node sets, the status message as sent and none of got\'s fields, as in Node', t => {
  rawServer('HTTP/1.1 200 \r\ncontent-length: 2\r\n\r\nok', (server, url) => {
    nodeApi({url, pool: false}, (nodeErr, nodeRes) => {
      engine({url, pool: false}, (err, res) => {
        t.error(nodeErr)
        t.error(err)
        t.ok(res instanceof http.IncomingMessage)
        t.equal(res.statusMessage, nodeRes.statusMessage)
        t.equal(res.statusMessage, '')
        t.equal(res.url, '')
        t.deepEqual(ownFields(res), ownFields(nodeRes))
        server.close(t.end)
      })
    })
  })
})

tape('the response ends in the same tick as in Node: a kept-alive socket is still in agent.sockets in the callback', t => {
  listen((req, res) => res.end('ok'), (server, url) => {
    const agent = new http.Agent({keepAlive: true})
    const name = agent.getName({host: 'localhost', port: server.address().port})
    nodeApi({url, agent}, () => {
      const nodeBusy = (agent.sockets[name] || []).length
      setImmediate(() => {
        engine({url, agent}, () => {
          t.equal(nodeBusy, 1)
          t.equal((agent.sockets[name] || []).length, 1)
          agent.destroy()
          server.close(t.end)
        })
      })
    })
  })
})

tape('request bytes are Node\'s: header names keep their case and order, and the path is sent as given, dot segments included', t => {
  listen((req, res) => res.end(req.url), server => {
    compare({url: '/a/../b?x=1&y', headers: {'X-Upper': 'A', 'x-lower': 'b', Accept: 'text/plain'}, pool: false}, server, (err, result) => {
      t.error(err)
      t.equal(result.engine.bytes, result.node.bytes)
      t.equal(result.engine.body, '/a/../b?x=1&y')
      server.close(t.end)
    })
  })
})

function recordingServer (cb) {
  const requests = []
  const server = net.createServer(socket => {
    let received = ''
    socket.on('data', chunk => {
      received += chunk.toString('latin1')
      if (received.endsWith('0\r\n\r\n')) {
        requests.push(received.replace(new RegExp(String(server.address().port), 'g'), 'PORT'))
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      }
    })
  })
  server.listen(0, () => cb(server, 'http://localhost:' + server.address().port + '/', requests))
}

tape('transfer-encoding given with a body sends the content-length the core adds as well, as in Node; got alone would drop it', t => {
  const instance = got.extend({hooks: {beforeRequest: [options => { options.headers['x-hook'] = '1' }]}})
  const shapes = [
    {method: 'POST', body: 'abc', headers: {'transfer-encoding': 'chunked'}},
    {method: 'PUT', json: {a: 1}, headers: {'Transfer-Encoding': 'chunked', 'Content-Length': '7'}}
  ]
  recordingServer((server, url, requests) => {
    const next = () => {
      const shape = shapes.shift()
      if (!shape) {
        return server.close(t.end)
      }
      nodeApi(Object.assign({url}, shape), nodeErr => {
        engine(Object.assign({url}, shape), err => {
          engine(Object.assign({url, got: instance}, shape), hookedErr => {
            t.error(nodeErr)
            t.error(err)
            t.error(hookedErr)
            const node = requests[requests.length - 3]
            t.ok(/content-length: \d/i.test(node) && /transfer-encoding: chunked/i.test(node), 'Node sends both headers')
            t.equal(requests[requests.length - 2], node)
            t.ok(requests[requests.length - 1].indexOf('x-hook: 1\r\n') !== -1, 'the hook header is sent')
            t.equal(requests[requests.length - 1].replace('x-hook: 1\r\n', ''), node)
            next()
          })
        })
      })
    }
    next()
  })
})

tape('a 101 response without an upgrade listener closes the socket, as in Node', t => {
  rawServer('HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: probe\r\n\r\n', (server, url, sockets) => {
    const closed = []
    const run = (api, name, cb) => {
      const r = api({url, pool: false, headers: {connection: 'upgrade', upgrade: 'probe'}})
      r.on('error', () => {})
      setTimeout(() => {
        const socket = sockets[sockets.length - 1]
        closed.push(name + ' ' + (socket.destroyed || socket.readableEnded))
        r.abort()
        cb()
      }, 200)
    }
    run(nodeApi, 'node', () => {
      run(engine, 'engine', () => {
        t.deepEqual(closed, ['node true', 'engine true'])
        server.close(t.end)
      })
    })
  })
})

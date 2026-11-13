'use strict'

const http = require('http')
const net = require('net')

function forwardingProxy (options) {
  const settings = options || {}
  const server = http.createServer((req, res) => {
    server.seen.push({method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders})
    if (settings.status) {
      res.writeHead(settings.status, {'Proxy-Authenticate': 'Basic realm="proxy"'})
      return res.end('need auth')
    }
    res.end('via proxy ' + req.url)
  })
  server.seen = []
  return server
}

function connectProxy (options, factory) {
  const settings = options || {}
  const server = (factory || http.createServer)((req, res) => res.end('not a CONNECT'))
  server.connects = []
  server.on('connect', (req, socket, head) => {
    server.connects.push({url: req.url, headers: req.headers, rawHeaders: req.rawHeaders})
    if (settings.status) {
      socket.end('HTTP/1.1 ' + settings.status + ' Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const separator = req.url.lastIndexOf(':')
    const upstream = net.connect(+req.url.slice(separator + 1), req.url.slice(0, separator), () => {
      const reply = () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n' + (settings.afterOk || ''))
        upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      }
      if (settings.delay) {
        setTimeout(reply, settings.delay)
      } else {
        reply()
      }
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  return server
}

module.exports = {forwardingProxy, connectProxy}

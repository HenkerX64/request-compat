'use strict'

const net = require('net')

const LOOPBACK_NAMES = ['localhost', 'ipv6']

function addressOf (message) {
  const type = message[3]
  if (type === 1) {
    return {host: Array.from(message.slice(4, 8)).join('.'), end: 8}
  }
  if (type === 3) {
    return {host: message.slice(5, 5 + message[4]).toString(), end: 5 + message[4]}
  }
  if (type === 4) {
    return {host: 'ipv6', end: 20}
  }
  return null
}

function socks5Server () {
  const server = net.createServer(client => {
    client.on('error', () => {})
    client.once('data', greeting => {
      if (greeting[0] !== 5) {
        return client.destroy()
      }
      client.write(Buffer.from([5, 0]))
      client.once('data', message => {
        const address = addressOf(message)
        if (message[1] !== 1 || !address) {
          return client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
        }
        const port = message.readUInt16BE(address.end)
        server.seen.push(address.host + ':' + port)
        const upstream = net.connect(port, LOOPBACK_NAMES.indexOf(address.host) !== -1 ? '127.0.0.1' : address.host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => client.destroy())
      })
    })
  })
  server.seen = []
  return server
}

module.exports = socks5Server

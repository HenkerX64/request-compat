'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const tls = require('tls')
const constants = require('constants')
const tape = require('tape')
const nodeApi = require('request-compat')
const engineApi = require('../index')
const {connectProxy} = require('./proxy-servers')
const {dispatcherFor, cacheSize, closeAll, acquire, release} = require('../lib/dispatchers')

const ssl = path.join(__dirname, '..', '..', '..', 'tests', 'ssl')
const read = (...parts) => fs.readFileSync(path.join(ssl, ...parts))
const ca = read('ca', 'ca.crt')
const trusted = {key: read('ca', 'localhost.key'), cert: read('ca', 'localhost.crt')}
const selfSigned = {key: read('self-signed.key'), cert: read('self-signed.crt')}
const client = {key: read('ca', 'client.key'), cert: read('ca', 'client.crt')}
const clientPfx = fs.readFileSync(path.join(__dirname, 'fixtures', 'client.pfx'))
const pfxPassphrase = 'password'
const IDLE_IDENTITY_DISPATCHERS = 32

const calls = []

function pin (label, result) {
  return () => {
    calls.push(label)
    return result
  }
}

const SERVERS = {
  trusted: handler => https.createServer(trusted, handler),
  selfSigned: handler => https.createServer(selfSigned, handler),
  tls13: handler => https.createServer(Object.assign({minVersion: 'TLSv1.3'}, trusted), handler),
  clientCert: handler => https.createServer(Object.assign({requestCert: true, rejectUnauthorized: false}, trusted), handler),
  sni: () => https.createServer(trusted, (req, res) => res.end('sni:' + req.socket.servername)),
  http: handler => http.createServer(handler)
}

function answer (req, res) {
  const certificate = req.socket.getPeerCertificate && req.socket.getPeerCertificate()
  res.end(certificate && certificate.subject ? 'cert:yes' : 'cert:no')
}

const ROWS = [
  {
    name: 'own check accepts, global pin rejects: the global pin wins',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({checkServerIdentity: pin('own')}),
    expect: 'global pin'
  },
  {
    name: 'own check rejects, global pin accepts: the global pin wins',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global')}),
    options: () => ({checkServerIdentity: pin('own', new Error('own check'))}),
    expect: 200
  },
  {
    name: 'strictSSL false ignores the global maxVersion',
    server: 'tls13',
    global: () => ({maxVersion: 'TLSv1.2'}),
    options: () => ({strictSSL: false}),
    expect: 200
  },
  {
    name: 'strictSSL false does not send the global client certificate',
    server: 'clientCert',
    global: () => Object.assign({ca: ca}, client),
    options: () => ({strictSSL: false}),
    expect: 'cert:no'
  },
  {
    name: 'rejectUnauthorized false does not send the global client certificate',
    server: 'clientCert',
    global: () => Object.assign({ca: ca}, client),
    options: () => ({rejectUnauthorized: false}),
    expect: 'cert:no'
  },
  {
    name: 'no TLS option sends the global client certificate',
    server: 'clientCert',
    global: () => Object.assign({ca: ca}, client),
    options: () => ({}),
    expect: 'cert:yes'
  },
  {
    name: 'agentOptions {} still uses the global pin',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({agentOptions: {}}),
    expect: 'global pin'
  },
  {
    name: 'own ca bypasses the global pin',
    server: 'trusted',
    global: () => ({checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({ca: ca}),
    expect: 200
  },
  {
    name: 'forever bypasses the global pin',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({forever: true, ca: ca}),
    expect: 200
  },
  {
    name: 'caller pool {maxSockets: 5} ignores the global rejectUnauthorized false',
    server: 'selfSigned',
    global: () => ({rejectUnauthorized: false}),
    options: () => ({pool: {maxSockets: 5}}),
    expect: 'DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    name: 'pool false ignores agentOptions.rejectUnauthorized false',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({pool: false, agentOptions: {rejectUnauthorized: false}}),
    expect: 'DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    name: 'pool false keeps the own rejectUnauthorized false',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({pool: false, rejectUnauthorized: false}),
    expect: 200
  },
  {
    name: 'a default global checkServerIdentity does not switch off the own check',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: tls.checkServerIdentity}),
    options: () => ({checkServerIdentity: pin('own', new Error('own check'))}),
    expect: 'own check'
  },
  {
    name: 'request servername decides the identity check',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, servername: 'other.example'}),
    expect: 'ERR_TLS_CERT_ALTNAME_INVALID'
  },
  {
    name: 'global servername decides the identity check',
    server: 'trusted',
    global: () => ({ca: ca, servername: 'other.example'}),
    options: () => ({}),
    expect: 'ERR_TLS_CERT_ALTNAME_INVALID'
  },
  {
    name: 'agentOptions servername decides the identity check',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, pool: {}, agentOptions: {servername: 'other.example'}}),
    expect: 'ERR_TLS_CERT_ALTNAME_INVALID'
  },
  {
    name: 'servername wins over the host header',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, servername: 'localhost', headers: {host: 'other.example'}}),
    expect: 200
  },
  {
    name: 'request secureContext is honoured',
    server: 'trusted',
    global: () => ({}),
    options: () => ({secureContext: tls.createSecureContext({ca: ca})}),
    expect: 200
  },
  {
    name: 'agentOptions secureContext is honoured',
    server: 'trusted',
    global: () => ({}),
    options: () => ({pool: {}, agentOptions: {secureContext: tls.createSecureContext({ca: ca})}}),
    expect: 200
  },
  {
    name: 'global secureContext is honoured',
    server: 'trusted',
    global: () => ({secureContext: tls.createSecureContext({ca: ca})}),
    options: () => ({}),
    expect: 200
  },
  {
    name: 'plain http requests with an own checkServerIdentity share one connection',
    server: 'http',
    global: () => ({}),
    options: () => ({checkServerIdentity: pin('own', new Error('own check'))}),
    repeat: 3,
    expect: 200
  },
  {
    name: 'forever ignores the global ca and pin',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({forever: true}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {
    name: 'own cert and key ignore the global ca and pin',
    server: 'clientCert',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => client,
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {
    name: 'own passphrase ignores the global ca and pin',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({passphrase: 'secret'}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {
    name: 'own ciphers ignore the global ca and pin',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({ciphers: 'DEFAULT'}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {
    name: 'own secureProtocol ignores the global ca and pin',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({secureProtocol: 'TLS_method'}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {
    name: 'own secureOptions ignore the global ca and pin',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({secureOptions: constants.SSL_OP_NO_SSLv3}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {
    name: 'the global maxVersion wins over the own one',
    server: 'tls13',
    global: () => ({ca: ca, maxVersion: 'TLSv1.2'}),
    options: () => ({maxVersion: 'TLSv1.3'}),
    anyError: true,
    expect: 'rejected'
  },
  {
    name: 'pool false ignores a check in agentOptions',
    server: 'trusted',
    global: () => ({}),
    options: () => ({pool: false, ca: ca, agentOptions: {checkServerIdentity: pin('agent', new Error('agent check'))}}),
    expect: 200
  },
  {
    name: 'global rejectUnauthorized false applies without own options',
    server: 'selfSigned',
    global: () => ({rejectUnauthorized: false}),
    options: () => ({}),
    expect: 200
  },
  {
    name: 'agent false still uses the global agent options',
    server: 'trusted',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({agent: false}),
    expect: 'global pin'
  },
  {
    name: 'plain http requests ignore a global pin and share one connection',
    server: 'http',
    global: () => ({checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({}),
    repeat: 3,
    expect: 200
  },
  {
    name: 'strictSSL 1 fails after a handshake with rejectUnauthorized false',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({strictSSL: 1, rejectUnauthorized: false}),
    expect: 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    name: "strictSSL 'true' fails after a handshake with agentOptions.rejectUnauthorized false",
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({strictSSL: 'true', pool: {}, agentOptions: {rejectUnauthorized: false}}),
    expect: 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    name: 'strictSSL 1 fails after a handshake with the global rejectUnauthorized false',
    server: 'selfSigned',
    global: () => ({rejectUnauthorized: false}),
    options: () => ({strictSSL: 1}),
    expect: 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    name: 'servername empty sends no SNI and checks the URL host, not the host header',
    server: 'sni',
    global: () => ({}),
    options: () => ({ca: ca, servername: '', headers: {host: 'other.example'}}),
    expect: 'sni:false'
  },
  {
    name: 'pool false keeps the own servername',
    server: 'trusted',
    global: () => ({}),
    options: () => ({pool: false, ca: ca, servername: 'other.example'}),
    expect: 'ERR_TLS_CERT_ALTNAME_INVALID'
  },
  {
    name: 'own rejectUnauthorized 0 still verifies',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({rejectUnauthorized: 0}),
    expect: 'DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    name: 'agentOptions.rejectUnauthorized false applies',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({pool: {}, agentOptions: {rejectUnauthorized: false}}),
    expect: 200
  },
  {
    name: 'own pfx sends the client certificate',
    server: 'clientCert',
    global: () => ({}),
    options: () => ({ca: ca, pfx: [{buf: clientPfx, passphrase: pfxPassphrase}]}),
    expect: 'cert:yes'
  },
  {
    name: 'own pfx ignores the global ca and pin',
    server: 'clientCert',
    global: () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))}),
    options: () => ({pfx: [{buf: clientPfx, passphrase: pfxPassphrase}]}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  }
]

const PIN_REJECT = () => ({ca: ca, checkServerIdentity: pin('global', new Error('global pin'))})
const TUNNEL_PROXY_TLS = 'tunneling socket could not be established, cause=unable to verify the first certificate'

const PROXIED_ROWS = [
  {via: 'forward', name: 'https proxy: the global ca verifies the proxy', server: 'trusted', global: () => ({ca: ca}), options: () => ({}), expect: 200},
  {via: 'forward', name: 'https proxy: no CA rejects the proxy certificate', server: 'trusted', global: () => ({}), options: () => ({}), expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'},
  {via: 'forward', name: 'https proxy: own ca verifies the proxy', server: 'trusted', global: () => ({}), options: () => ({ca: ca}), expect: 200},
  {via: 'forward', name: 'https proxy: rejectUnauthorized false accepts a self-signed proxy', server: 'selfSigned', global: () => ({}), options: () => ({rejectUnauthorized: false}), expect: 200},
  {via: 'forward', name: 'https proxy: the global pin applies', server: 'trusted', global: PIN_REJECT, options: () => ({}), expect: 'global pin'},
  {
    via: 'forward',
    name: 'https proxy: strictSSL fails after a handshake with rejectUnauthorized false',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({strictSSL: 1, rejectUnauthorized: false}),
    expect: 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    via: 'forward',
    name: 'https proxy: the servername option decides the identity check of the proxy',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, servername: 'other.example'}),
    expect: 'ERR_TLS_CERT_ALTNAME_INVALID'
  },
  {
    via: 'forward',
    name: 'https proxy: the host of the target decides the identity check of the proxy',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, url: 'http://other.example/'}),
    expect: 'ERR_TLS_CERT_ALTNAME_INVALID'
  },
  {
    via: 'forward',
    name: 'https proxy: agentOptions.rejectUnauthorized false applies',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({pool: {}, agentOptions: {rejectUnauthorized: false}}),
    expect: 200
  },
  {via: 'forward', name: 'https proxy: the client certificate is sent', server: 'clientCert', global: () => ({}), options: () => Object.assign({ca: ca}, client), expect: 'cert:yes'},
  {via: 'tunnel', name: 'tunnel: own ca verifies the target', server: 'trusted', global: () => ({}), options: () => ({ca: ca}), expect: 200},
  {via: 'tunnel', name: 'tunnel: the global ca is not used', server: 'trusted', global: () => ({ca: ca}), options: () => ({}), expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'},
  {
    via: 'tunnel',
    name: 'tunnel: agentOptions are not used',
    server: 'trusted',
    global: () => ({}),
    options: () => ({pool: {}, agentOptions: {ca: ca}}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {via: 'tunnel', name: 'tunnel: rejectUnauthorized false accepts a self-signed target', server: 'selfSigned', global: () => ({}), options: () => ({rejectUnauthorized: false}), expect: 200},
  {
    via: 'tunnel',
    name: 'tunnel: agentOptions.rejectUnauthorized false is ignored',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({pool: {}, agentOptions: {rejectUnauthorized: false}}),
    expect: 'DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {
    via: 'tunnel',
    name: 'tunnel: strictSSL fails after a handshake with rejectUnauthorized false',
    server: 'selfSigned',
    global: () => ({}),
    options: () => ({strictSSL: 1, rejectUnauthorized: false}),
    expect: 'SSL Error: DEPTH_ZERO_SELF_SIGNED_CERT'
  },
  {via: 'tunnel', name: 'tunnel: strictSSL false accepts a self-signed target', server: 'selfSigned', global: () => ({}), options: () => ({strictSSL: false}), expect: 200},
  {via: 'tunnel', name: 'tunnel: own rejectUnauthorized 0 still verifies', server: 'selfSigned', global: () => ({}), options: () => ({rejectUnauthorized: 0}), expect: 'DEPTH_ZERO_SELF_SIGNED_CERT'},
  {via: 'tunnel', name: 'tunnel: the servername option is ignored', server: 'trusted', global: () => ({}), options: () => ({ca: ca, servername: 'other.example'}), expect: 200},
  {via: 'tunnel', name: 'tunnel: the host header does not decide the identity check', server: 'trusted', global: () => ({}), options: () => ({ca: ca, headers: {host: 'other.example'}}), expect: 200},
  {
    via: 'tunnel',
    name: 'tunnel: an IP address is checked against the certificate',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, url: 'https://127.0.0.1:{port}/'}),
    nodeRefusesIp: true,
    expect: 'ERR_TLS_CERT_ALTNAME_INVALID'
  },
  {
    via: 'tunnel',
    name: 'tunnel: own checkServerIdentity rejects',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, checkServerIdentity: pin('own', new Error('own check'))}),
    expect: 'own check'
  },
  {
    via: 'tunnel',
    name: 'tunnel: checkServerIdentity of agentOptions rejects',
    server: 'trusted',
    global: () => ({}),
    options: () => ({ca: ca, pool: {}, agentOptions: {checkServerIdentity: pin('agent', new Error('agent check'))}}),
    expect: 'agent check'
  },
  {via: 'tunnel', name: 'tunnel: the global pin is not used', server: 'trusted', global: PIN_REJECT, options: () => ({ca: ca}), expect: 200},
  {via: 'tunnel', name: 'tunnel: the client certificate is sent', server: 'clientCert', global: () => ({}), options: () => Object.assign({ca: ca}, client), expect: 'cert:yes'},
  {
    via: 'tunnel',
    name: 'tunnel: pfx sends the client certificate',
    server: 'clientCert',
    global: () => ({}),
    options: () => ({ca: ca, pfx: [{buf: clientPfx, passphrase: pfxPassphrase}]}),
    expect: 'cert:yes'
  },
  {via: 'tunnel', name: 'tunnel: pool false', server: 'trusted', global: () => ({}), options: () => ({pool: false, ca: ca}), expect: 200},
  {
    via: 'tunnel',
    name: 'tunnel: a secureContext is ignored',
    server: 'trusted',
    global: () => ({}),
    options: () => ({secureContext: tls.createSecureContext({ca: ca})}),
    expect: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  },
  {via: 'tunnel', name: 'tunnel: three requests open three tunnels', server: 'trusted', global: () => ({}), options: () => ({ca: ca}), repeat: 3, expect: 200},
  {
    via: 'tunnel',
    name: 'tunnel: an http target does not call checkServerIdentity',
    server: 'http',
    global: () => ({}),
    options: () => ({checkServerIdentity: pin('own', new Error('own check'))}),
    expect: 200
  },
  {via: 'tunnelTls', name: 'https proxy tunnel: the default trust rejects the proxy', server: 'trusted', global: () => ({}), options: () => ({ca: ca}), message: true, expect: TUNNEL_PROXY_TLS},
  {via: 'tunnelTls', name: 'https proxy tunnel: the global ca is not used', server: 'trusted', global: () => ({ca: ca}), options: () => ({}), message: true, expect: TUNNEL_PROXY_TLS},
  {
    via: 'tunnelTls',
    name: 'https proxy tunnel: rejectUnauthorized false does not reach the proxy',
    server: 'trusted',
    global: () => ({}),
    options: () => ({rejectUnauthorized: false}),
    message: true,
    expect: TUNNEL_PROXY_TLS
  },
  {via: 'tunnelTls', name: 'https proxy tunnel to an http target', server: 'http', global: () => ({}), options: () => ({}), message: true, expect: TUNNEL_PROXY_TLS}
]

ROWS.push.apply(ROWS, PROXIED_ROWS)

function outcome (error, response, body, calls, connections, row) {
  return {
    error: error ? (row.anyError ? 'rejected' : (row.message ? error.message.replace(/; if the root CA is installed locally.*$/, '') : error.code || error.message)) : null,
    status: response && response.statusCode,
    body: body,
    calls: calls.slice(),
    connections: connections
  }
}

function requestBase (row, server, proxy) {
  const scheme = row.server === 'http' ? 'http' : 'https'
  if (row.via === 'forward') {
    return {url: 'http://localhost:81/', proxy: 'https://localhost:' + server.address().port}
  }
  if (row.via) {
    return {url: scheme + '://localhost:' + server.address().port + '/', proxy: (row.via === 'tunnelTls' ? 'https' : 'http') + '://localhost:' + proxy.address().port, tunnel: true}
  }
  return {url: scheme + '://localhost:' + server.address().port + '/'}
}

function run (api, row, server, proxy, cb) {
  const options = Object.assign(requestBase(row, server, proxy), row.options())
  if (options.url.indexOf('{port}') !== -1) {
    options.url = options.url.replace('{port}', server.address().port)
  }
  let connections = 0
  const count = () => connections++
  server.on(row.server === 'http' ? 'connection' : 'secureConnection', count)
  calls.length = 0
  let left = row.repeat || 1
  const next = () => {
    api(Object.assign({}, options), (error, response, body) => {
      left--
      if (left && !error) {
        return next()
      }
      setTimeout(() => {
        server.removeListener(row.server === 'http' ? 'connection' : 'secureConnection', count)
        cb(outcome(error, response, body, calls, connections, row))
      }, 20)
    })
  }
  next()
}

function withGlobalOptions (values, fn, cb) {
  const options = https.globalAgent.options
  const saved = {}
  Object.keys(values).forEach(name => {
    saved[name] = options[name]
    options[name] = values[name]
  })
  fn(() => {
    Object.keys(values).forEach(name => {
      if (saved[name] === undefined) {
        delete options[name]
      } else {
        options[name] = saved[name]
      }
    })
    cb()
  })
}

function proxyOf (row, cb) {
  if (!row.via || row.via === 'forward') {
    return cb(null)
  }
  const proxy = connectProxy({}, row.via === 'tunnelTls' ? handler => https.createServer(trusted, handler) : undefined)
  proxy.listen(0, () => cb(proxy))
}

ROWS.forEach(row => {
  tape('TLS parity: ' + row.name, t => {
    const server = SERVERS[row.server](answer)
    server.listen(0, () => proxyOf(row, proxy => {
      withGlobalOptions(row.global(), done => {
        run(nodeApi, row, server, proxy, node => {
          run(engineApi, row, server, proxy, engine => {
            if (row.nodeRefusesIp && node.error === 'ERR_INVALID_ARG_VALUE') {
              t.equal(engine.error, row.expect, 'Node 26 tunnel-agent cannot connect to an IP address, the engine checks the certificate')
              return done()
            }
            t.deepEqual(engine, node, 'engine equals the Node transport')
            t.equal(node.error || node.body, typeof row.expect === 'number' ? node.body : row.expect, 'the row tests what it claims')
            if (typeof row.expect === 'number') {
              t.equal(node.status, row.expect)
            }
            done()
          })
        })
      }, () => {
        server.close()
        if (proxy) {
          proxy.close()
        }
        t.end()
      })
    }))
  })
})

tape('plain-object pfx and key arrays get different dispatchers', t => {
  const self = (name, value) => ({uri: {protocol: 'https:'}, [name]: value})
  ;['pfx', 'key'].forEach(name => {
    const a = dispatcherFor(self(name, [{buf: Buffer.from('a'), passphrase: 'x'}])).dispatcher
    const b = dispatcherFor(self(name, [{buf: Buffer.from('b'), passphrase: 'x'}])).dispatcher
    const c = dispatcherFor(self(name, [{passphrase: 'x', buf: Buffer.from('a')}])).dispatcher
    t.notEqual(a, b, name + ': different content, different dispatcher')
    t.equal(a, c, name + ': same content, same dispatcher')
  })
  closeAll().then(() => t.end())
})

tape('TLS option values that contain the separators of the dispatcher key get their own dispatcher', t => {
  const self = options => Object.assign({uri: {protocol: 'https:', hostname: 'localhost'}}, options)
  const unverified = dispatcherFor(self({passphrase: 'x', rejectUnauthorized: false, servername: 'y|rejectUnauthorized=boolean:true'})).dispatcher
  const verifying = dispatcherFor(self({passphrase: 'x|rejectUnauthorized=boolean:false|servername=string:y', rejectUnauthorized: true})).dispatcher
  t.notEqual(verifying, unverified, 'a verifying request does not get the dispatcher of an unverified one')
  closeAll().then(() => t.end())
})

tape('SecureContexts are keyed by identity, typed arrays by content', t => {
  const self = options => Object.assign({uri: {protocol: 'https:', hostname: 'localhost'}}, options)
  const first = tls.createSecureContext({ca: ca})
  const second = tls.createSecureContext({ca: ca})
  const before = cacheSize()
  const a = dispatcherFor(self({secureContext: first})).dispatcher
  t.equal(dispatcherFor(self({secureContext: first})).dispatcher, a, 'the same SecureContext, the same dispatcher')
  t.notEqual(dispatcherFor(self({secureContext: second})).dispatcher, a, 'another SecureContext, another dispatcher')
  const b = dispatcherFor(self({ca: new Uint8Array(ca)})).dispatcher
  t.equal(dispatcherFor(self({ca: new Uint8Array(ca)})).dispatcher, b, 'equal typed arrays, the same dispatcher')
  t.equal(dispatcherFor(self({ca: Buffer.from(ca)})).dispatcher, b, 'a Buffer with the same bytes, the same dispatcher')
  t.equal(cacheSize(), before + 3, 'cacheSize counts the dispatchers of live SecureContexts')
  closeAll().then(() => {
    t.notEqual(dispatcherFor(self({secureContext: first})).dispatcher, a, 'closeAll drops the dispatchers of live SecureContexts')
    return closeAll()
  }).then(() => t.end())
})

tape('idle identity dispatchers beyond the bound are closed, busy ones stay open', t => {
  const self = options => Object.assign({uri: {protocol: 'https:', hostname: 'localhost'}}, options)
  const fresh = () => dispatcherFor(self({secureContext: tls.createSecureContext({ca: ca})})).dispatcher
  const kept = tls.createSecureContext({ca: ca})
  const idle = dispatcherFor(self({secureContext: kept})).dispatcher
  const recent = []
  for (let i = 0; i < IDLE_IDENTITY_DISPATCHERS; i++) {
    recent.push(fresh())
  }
  t.equal(idle.closed, true, 'the least recently used idle dispatcher is closed')
  t.equal(recent.filter(dispatcher => dispatcher.closed).length, 0, 'the most recent ones stay open')
  const replacement = dispatcherFor(self({secureContext: kept})).dispatcher
  t.notEqual(replacement, idle, 'a closed dispatcher is not handed out again')
  t.equal(replacement.closed, false)
  for (let i = 1; i < IDLE_IDENTITY_DISPATCHERS; i++) {
    fresh()
  }
  t.equal(dispatcherFor(self({secureContext: kept})).dispatcher, replacement)
  fresh()
  t.equal(replacement.closed, false, 'a reused dispatcher counts as recently used')
  acquire(replacement)
  for (let i = 0; i <= IDLE_IDENTITY_DISPATCHERS; i++) {
    fresh()
  }
  t.equal(replacement.closed, false, 'a dispatcher with a running exchange stays open')
  release(replacement)
  fresh()
  t.equal(replacement.closed, true, 'closed once released and least recently used')
  const busy = []
  for (let i = 0; i < IDLE_IDENTITY_DISPATCHERS; i++) {
    busy.push(fresh())
    acquire(busy[i])
  }
  t.equal(fresh().closed, false, 'the dispatcher just handed out stays open while all others are busy')
  busy.forEach(release)
  closeAll().then(() => t.end())
})

function identityLoad (requests, parallel) {
  const child = childProcess.spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'identity-cache-child.js'), String(requests), String(parallel)], {
    encoding: 'utf8',
    timeout: 110000
  })
  return {status: child.status, output: child.stderr || child.stdout, result: child.status === 0 ? JSON.parse(child.stdout) : {}}
}

tape('new SecureContexts per request do not pile up dispatchers or connections', t => {
  const {status, output, result} = identityLoad(2000, 1)
  t.equal(status, 0, output)
  t.ok(result.nested <= IDLE_IDENTITY_DISPATCHERS, 'dispatchers keyed by nested objects: ' + result.nested + ' left')
  t.equal(result.connections, 2000, 'one connection per SecureContext')
  t.ok(result.peak <= IDLE_IDENTITY_DISPATCHERS + 1, 'open at once: ' + result.peak)
  t.ok(result.cached <= IDLE_IDENTITY_DISPATCHERS, 'dispatchers left: ' + result.cached)
  t.equal(result.open, 0, 'idle connections closed')
  t.end()
})

tape('new SecureContexts per request at parallelism 8 stay under the open-connection bound', t => {
  const {status, output, result} = identityLoad(800, 8)
  t.equal(status, 0, output)
  t.equal(result.connections, 800, 'one connection per SecureContext')
  t.ok(result.peak <= IDLE_IDENTITY_DISPATCHERS + 8, 'open at once: ' + result.peak)
  t.equal(result.open, 0, 'idle connections closed')
  t.end()
})

tape('a TLS session of one port is not offered to another port of the same host name, as in Node', t => {
  const ticketKeys = Buffer.alloc(48, 7)
  const server = (credentials, name) => https.createServer(Object.assign({ticketKeys}, credentials), (req, res) => {
    res.setHeader('connection', 'close')
    res.end(name)
  })
  const first = server(trusted, 'A')
  const second = server(selfSigned, 'B')
  const rows = [
    {name: 'strictSSL and rejectUnauthorized: true', options: {ca, strictSSL: true, rejectUnauthorized: true}},
    {name: 'servername \'\'', options: {ca, servername: ''}}
  ]
  first.listen(0, () => second.listen(0, () => {
    const urls = [first, first, second, second].map(target => 'https://localhost:' + target.address().port + '/')
    const run = (api, row, cb) => {
      const pool = {}
      const results = []
      const next = () => {
        if (results.length === urls.length) {
          return closeAll().then(() => cb(results))
        }
        api(Object.assign({url: urls[results.length], pool}, row.options), (error, response, body) => {
          results.push(error ? error.code || error.message : response.statusCode + ' ' + body)
          setTimeout(next, 30)
        })
      }
      next()
    }
    const next = () => {
      const row = rows.shift()
      if (!row) {
        first.close()
        second.close()
        return t.end()
      }
      run(nodeApi, row, node => run(engineApi, row, engine => {
        t.deepEqual(node, ['200 A', '200 A', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'DEPTH_ZERO_SELF_SIGNED_CERT'], 'Node: ' + row.name)
        t.deepEqual(engine, node, 'engine equals the Node transport: ' + row.name)
        next()
      }))
    }
    next()
  }))
})

const ENV_CASES = require('./tls-env-child')

tape('NODE_TLS_REJECT_UNAUTHORIZED=0 acts as in Node', t => {
  const child = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'tls-env-child.js')], {
    env: Object.assign({}, process.env, {NODE_TLS_REJECT_UNAUTHORIZED: '0'}),
    encoding: 'utf8',
    timeout: 60000
  })
  t.equal(child.status, 0, child.stderr)
  const results = JSON.parse(child.stdout)
  ENV_CASES.forEach((entry, index) => {
    t.deepEqual(results[index].engine, results[index].node, entry.name)
    t.equal(results[index].node.error || results[index].node.status, entry.expect, 'the case tests what it claims: ' + entry.name)
  })
  t.end()
})

;[
  {name: 'NODE_EXTRA_CA_CERTS', env: {NODE_EXTRA_CA_CERTS: path.join(ssl, 'ca', 'ca.crt')}},
  {name: 'NODE_TLS_REJECT_UNAUTHORIZED=0', env: {NODE_TLS_REJECT_UNAUTHORIZED: '0'}}
].forEach(entry => {
  tape('tunnel through an https proxy acts as in Node with ' + entry.name, t => {
    const child = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'tls-proxy-env-child.js')], {
      env: Object.assign({}, process.env, entry.env),
      encoding: 'utf8',
      timeout: 60000
    })
    t.equal(child.status, 0, child.stderr)
    JSON.parse(child.stdout).forEach(result => {
      t.deepEqual(result.engine, result.node, result.name)
      t.deepEqual(result.node.map(outcome => outcome.error ? 'rejected' : outcome.status), result.expect, 'the case tests what it claims: ' + result.name)
    })
    t.end()
  })
})

tape('forever keeps a request off https.globalAgent only when its first hop is not a tunnel, as in Node', t => {
  const child = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'forever-redirect-child.js')], {
    env: Object.assign({}, process.env, {NODE_EXTRA_CA_CERTS: path.join(ssl, 'ca', 'ca.crt')}),
    encoding: 'utf8',
    timeout: 60000
  })
  t.equal(child.status, 0, child.stderr)
  JSON.parse(child.stdout).forEach(result => {
    t.deepEqual(result.engine, result.node, result.name)
    t.equal(result.node.error || result.node.status, result.expect, 'the case tests what it claims: ' + result.name)
  })
  t.end()
})

const SELF_SIGNED = 'DEPTH_ZERO_SELF_SIGNED_CERT'
const UNSET_AT_RUNTIME_ROWS = [
  {name: 'pool {}', options: () => ({pool: {}})},
  {name: 'ca', options: () => ({ca: ca})},
  {name: 'agentOptions', options: () => ({agentOptions: {ca: ca}})},
  {name: 'client certificate', options: () => Object.assign({}, client)},
  {name: 'no TLS option', options: () => ({}), node: [200, 200]}
]

function setRejectUnauthorized (value) {
  if (value === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = value
  }
}

function beforeAndAfterUnset (api, options, cb) {
  setRejectUnauthorized('0')
  api(Object.assign({}, options), (error, response) => {
    const first = error ? error.code || error.message : response.statusCode
    setRejectUnauthorized(undefined)
    setTimeout(() => api(Object.assign({}, options), (error, response) => {
      cb([first, error ? error.code || error.message : response.statusCode])
    }), 20)
  })
}

;['direct', 'forward'].forEach(via => UNSET_AT_RUNTIME_ROWS.forEach(row => {
  const outcome = row.node
    ? ': the engine connects again and rejects, stricter than the kept-alive connection of Node\'s global agent'
    : ': a new handshake rejects, as in Node'
  tape('NODE_TLS_REJECT_UNAUTHORIZED=0 unset at runtime, ' + via + ', ' + row.name + outcome, t => {
    const server = SERVERS.selfSigned(answer)
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    server.listen(0, () => {
      const port = server.address().port
      const base = via === 'forward' ? {url: 'http://localhost:81/', proxy: 'https://localhost:' + port} : {url: 'https://localhost:' + port + '/'}
      beforeAndAfterUnset(nodeApi, Object.assign({}, base, row.options()), node => {
        https.globalAgent.destroy()
        beforeAndAfterUnset(engineApi, Object.assign({}, base, row.options()), engine => {
          setRejectUnauthorized(saved)
          t.deepEqual(node, row.node || [200, SELF_SIGNED], 'Node')
          t.deepEqual(engine, [200, SELF_SIGNED], 'the engine')
          closeAll().then(() => {
            server.close()
            t.end()
          })
        })
      })
    })
  })
}))

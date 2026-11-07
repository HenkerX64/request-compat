'use strict'

var url = require('url')
var fs = require('fs')
var isstream = require('isstream')
var Multipart = require('./multipart').Multipart
var isUrl = /^https?:/

function hopBodySent (req) {
  return typeof req.writableFinished === 'boolean' ? req.writableFinished : req.finished
}

function fileRange (stream) {
  var range = {}
  if (typeof stream.start === 'number') {
    range.start = stream.start
  }
  if (typeof stream.end === 'number') {
    range.end = stream.end
  }
  return range
}

function originOf (uri) {
  return uri.protocol + '//' + uri.hostname + ':' + (uri.port || (uri.protocol === 'https:' ? '443' : '80'))
}

function bodyResendable (request) {
  if (request._form) {
    return Boolean(request.formData)
  }
  if (request._multipart && request._multipart.chunked) {
    return false
  }
  return !request.src && !request.requestBodyStream && !isstream(request.body)
}

function Redirect (request) {
  this.request = request
  this.followRedirect = true
  this.followRedirects = true
  this.followAllRedirects = false
  this.followOriginalHttpMethod = false
  this.allowRedirect = function () { return true }
  this.maxRedirects = 10
  this.redirects = []
  this.redirectsFollowed = 0
  this.removeRefererHeader = false
  this.allowInsecureRedirect = false
  this.agentFromCaller = false
  this.callerAgent = undefined
  this.callerAgentClass = undefined
  this.credentialsHost = null
  this.credentialsOrigin = null
  this.credentialsGiven = false
  this.leftCredentialsHost = false
  this.credentialsAllowedBefore = true
  this.callerCookie = undefined
  this.callerCookieSent = false
  this.awsGiven = undefined
}

Redirect.prototype.onRequest = function (options) {
  var self = this

  if (options.maxRedirects !== undefined) {
    self.maxRedirects = options.maxRedirects
  }
  if (typeof options.followRedirect === 'function') {
    self.allowRedirect = options.followRedirect
  }
  if (options.followRedirect !== undefined) {
    self.followRedirects = !!options.followRedirect
  }
  if (options.followAllRedirects !== undefined) {
    self.followAllRedirects = options.followAllRedirects
  }
  if (self.followRedirects || self.followAllRedirects) {
    self.redirects = self.redirects || []
  }
  if (options.removeRefererHeader !== undefined) {
    self.removeRefererHeader = options.removeRefererHeader
  }
  if (options.followOriginalHttpMethod !== undefined) {
    self.followOriginalHttpMethod = options.followOriginalHttpMethod
  }
  if (options.allowInsecureRedirect !== undefined) {
    self.allowInsecureRedirect = options.allowInsecureRedirect
  }
  if (options.agent || options.agentClass) {
    self.agentFromCaller = true
    self.callerAgent = options.agent
    self.callerAgentClass = options.agentClass
  }
}

Redirect.prototype.usesCallerAgent = function () {
  var self = this
  var agent = self.request.agent
  return self.agentFromCaller && Boolean(agent) && (agent === self.callerAgent ||
    (typeof self.callerAgentClass === 'function' && agent instanceof self.callerAgentClass))
}

Redirect.prototype.redirectTo = function (response) {
  var self = this
  var request = self.request

  var redirectTo = null
  if (response.statusCode >= 300 && response.statusCode < 400 && response.caseless.has('location')) {
    var location = response.caseless.get('location')
    request.debug('redirect', location)

    if (self.followAllRedirects) {
      redirectTo = location
    } else if (self.followRedirects) {
      switch (request.method) {
        case 'PATCH':
        case 'PUT':
        case 'POST':
        case 'DELETE':
          // Do not follow redirects
          break
        default:
          redirectTo = location
          break
      }
    }
  } else if (response.statusCode === 401) {
    // retry the request with the new Authorization header value using
    // WWW-Authenticate response header.
    // https://tools.ietf.org/html/rfc7235#section-3.1
    var authHeader = request._auth.onResponse(response)
    if (authHeader) {
      request.setHeader('authorization', authHeader)
      redirectTo = request.uri
    }
  }
  return redirectTo
}

Redirect.prototype.onResponse = function (response) {
  var self = this
  var request = self.request
  var options = {}

  var redirectTo = self.redirectTo(response)
  if (!redirectTo || !self.allowRedirect.call(request, response)) {
    return false
  }

  request.debug('redirect to', redirectTo)

  // ignore any potential response body.  it cannot possibly be useful
  // to us at this point.
  // response.resume should be defined, but check anyway before calling. Workaround for browserify.
  if (response.resume) {
    response.resume()
  }

  if (self.redirectsFollowed >= self.maxRedirects) {
    request.emit('error', new Error('Exceeded maxRedirects. Probably stuck in a redirect loop ' + request.uri.href))
    return false
  }
  self.redirectsFollowed += 1

  var uriNext
  try {
    if (!isUrl.test(redirectTo)) {
      redirectTo = url.resolve(request.uri.href, redirectTo)
    }
    uriNext = url.parse(redirectTo)
  } catch (err) {
    request.emit('error', err)
    return false
  }

  var uriPrev = request.uri
  request.uri = uriNext

  // handle the case where we change protocol from https to http or vice versa
  if (request.uri.protocol !== uriPrev.protocol && (self.allowInsecureRedirect || !self.usesCallerAgent())) {
    delete request.agent
  }

  // remove the host header if the response is a 307 or 308, & the host has changed.
  // (the new host will be populated auto-magically).
  // For other types of redirects, it's removed automatically (see code below)
  if ((response.statusCode === 307 || response.statusCode === 308) &&
    request.headers && uriPrev.host !== request.uri.host) {
    request.removeHeader('host')
  }

  self.redirects.push({ statusCode: response.statusCode, redirectUri: redirectTo })

  var resendBody = bodyResendable(request)
  var keepBody = response.statusCode === 401 || response.statusCode === 307 ||
    (response.statusCode === 308 && resendBody)

  if (self.followAllRedirects && request.method !== 'HEAD' && !keepBody) {
    request.method = self.followOriginalHttpMethod ? request.method : 'GET'
  }
  // request.method = 'GET' // Force all redirects to use GET || commented out fixes #215

  // The previous hop is no longer part of this request, so its errors must
  // not surface on it. Swallow them instead of leaving them unhandled.
  var prevReq = request.req
  ;[prevReq, response].forEach(function (hop) {
    if (hop) {
      hop.removeAllListeners('error')
      hop.on('error', function () {})
    }
  })

  // A hop whose body was not fully sent can never release its socket, so
  // close it instead of leaking it until the server times out. A fully sent
  // hop is left alone so its socket can still be reused for keep-alive.
  if (prevReq && !hopBodySent(prevReq)) {
    prevReq.abort()
  }

  // Detach the stream piped into the previous hop, so its remaining bytes
  // and end() do not reach the next one.
  if (request.src && typeof request.src.unpipe === 'function') {
    request.src.unpipe(request)
  }

  delete request.src
  delete request.req
  delete request._started
  if (!keepBody) {
    // Remove parameters from the previous response, unless this is the second request
    // for a server that requires digest authentication.
    // @note: when followOriginalHttpMethod is set, the request body is retained.
    if (!self.followOriginalHttpMethod || !resendBody) {
      delete request.body
      delete request._form
      request._multipart = new Multipart(request)
    }
    if (request.headers) {
      request.removeHeader('host')
      if (!self.followOriginalHttpMethod || !resendBody) {
        request.removeHeader('content-type')
        request.removeHeader('content-length')
      }
      if (request.uri.hostname !== request.originalHost.split(':')[0]) {
        // Remove authorization if changing hostnames (but not if just
        // changing ports or protocols).  This matches the behavior of curl:
        // https://github.com/bagder/curl/blob/6beb0eee/lib/http.c#L710
        request.removeHeader('authorization')
      }
    }
  }

  // Restore form-data stream if request body is retained
  if (request.formData &&
      // make sure _form is released and there's no pending _streams left
      // which will be the case for 401 redirects. so, reuse _form on redirect
      // @note: multiple form-param / file-streams may cause following issue:
      // https://github.com/request/request/issues/887
      // @todo: expose stream errors as events
      request._form && request._form._released &&
      request._form._streams && !request._form._streams.length) {
    // reinitialize FormData stream for 307 or 308 redirects, or with followOriginalHttpMethod
    delete request._form
    // remove content-type header for new boundary
    request.removeHeader('content-type')
    // remove content-length header since FormValue may be dropped if its not a file stream
    request.removeHeader('content-length')

    var formData = {}
    var resetFormData = function (key, value) {
      var newValue
      var formValue = value && value.hasOwnProperty('value') ? value.value : value

      // if `formValue` is of type stream
      if (typeof formValue === 'object' && typeof formValue.pipe === 'function') {
        // bail out if not a file stream
        if (!(formValue.hasOwnProperty('fd') && formValue.path)) return
        // create new file stream
        formValue = fs.createReadStream(formValue.path, fileRange(formValue))
      }

      if (value && value.hasOwnProperty('value') && value.hasOwnProperty('options')) {
        newValue = { value: formValue, options: value.options }
      } else {
        newValue = formValue
      }

      if (!formData.hasOwnProperty(key)) {
        formData[key] = newValue
        return
      }

      // at this point, we know that form has duplicate
      if (!Array.isArray(formData[key])) {
        formData[key] = [formData[key]]
      }

      formData[key].push(newValue)
    }
    for (var formKey in request.formData) {
      if (request.formData.hasOwnProperty(formKey)) {
        var formValue = request.formData[formKey]
        if (Array.isArray(formValue)) {
          for (var j = 0; j < formValue.length; j++) {
            resetFormData(formKey, formValue[j])
          }
        } else {
          resetFormData(formKey, formValue)
        }
      }
    }

    // setting `options.formData` will reinitialize FormData in `request.init`
    options.formData = formData
  }

  if (self.credentialsHost === null) {
    self.credentialsHost = uriPrev.hostname
    self.credentialsOrigin = originOf(uriPrev)
    self.credentialsGiven = request._auth.hasAuth
    self.callerCookie = request.originalCookieHeader
    self.callerCookieSent = Boolean(self.callerCookie)
    self.awsGiven = request._aws
  }
  if (request.uri.hostname !== self.credentialsHost) {
    self.leftCredentialsHost = true
  }
  var credentialsAllowed = request.uri.hostname === self.credentialsHost &&
    (!self.leftCredentialsHost || originOf(request.uri) === self.credentialsOrigin)

  if (request.headers && request.uri.hostname !== uriPrev.hostname &&
    (response.statusCode === 307 || response.statusCode === 308)) {
    request.removeHeader('authorization')
  }
  var callerCookieChanged = Boolean(self.callerCookie) && self.leftCredentialsHost &&
    credentialsAllowed !== self.callerCookieSent
  if (request.headers && (request.uri.hostname !== uriPrev.hostname || callerCookieChanged)) {
    request.removeHeader('cookie')
    delete request.originalCookieHeader
    self.callerCookieSent = false
    if (self.callerCookie && credentialsAllowed) {
      request.originalCookieHeader = self.callerCookie
      request.setHeader('cookie', self.callerCookie)
      self.callerCookieSent = true
    }
  }
  if (request.headers && request._jar && uriPrev.protocol === 'https:' && request.uri.protocol !== 'https:') {
    if (request.originalCookieHeader) {
      request.setHeader('cookie', request.originalCookieHeader)
    } else {
      request.removeHeader('cookie')
    }
  }

  request._auth.hasAuth = self.credentialsGiven && credentialsAllowed
  if (request.headers && !credentialsAllowed && self.credentialsAllowedBefore) {
    request.removeHeader('authorization')
  }
  self.credentialsAllowedBefore = credentialsAllowed
  if (self.awsGiven) {
    request._aws = credentialsAllowed ? self.awsGiven : undefined
    if (!credentialsAllowed && request.headers) {
      request.removeHeader('x-amz-security-token')
      request.removeHeader('x-amz-date')
    }
  }

  if (!self.removeRefererHeader) {
    request.setHeader('referer', uriPrev.href)
  }

  request.emit('redirect')

  request.init(options)

  return true
}

exports.Redirect = Redirect

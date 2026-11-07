'use strict'

module.exports = function (config) {
  config.set({
    client: { requestTestUrl: process.argv[4] },
    basePath: '../..',
    frameworks: ['tap', 'browserify'],
    preprocessors: {
      'tests/browser/test.js': ['browserify']
    },
    files: [
      'tests/browser/test.js'
    ],
    port: 9876,

    reporters: ['dots'],

    colors: true,

    logLevel: config.LOG_ERROR,

    autoWatch: false,

    browsers: ['ChromeHeadlessWithoutSecurity'],

    singleRun: true,

    plugins: [
      'karma-chrome-launcher',
      'karma-browserify',
      'karma-tap'
    ],
    browserify: {
      debug: true
    },

    // Custom launcher to allow self signed certs.
    customLaunchers: {
      ChromeHeadlessWithoutSecurity: {
        base: 'ChromeHeadless',
        flags: [
          '--no-sandbox',
          '--ignore-certificate-errors'
        ]
      }
    }
  })
}

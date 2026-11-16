'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const repo = path.resolve(__dirname, '..', '..', '..')
const useEngine = path.join(__dirname, 'use-engine.js')
const expectedFile = path.join(__dirname, 'core-suite-expected.json')
const EXCLUDED = ['test-transport.js', 'test-node-transport.js', 'test-api-shape.js']
const TIMEOUT = 120000
const MAX_SKIPS = 30
const TEARDOWN_TEST = 'cleanup'
const SUMMARY = /^# (tests|pass|fail)\s+\d+$/
const FINAL = /^# (ok|fail\s+\d+)$/

function listTests () {
  return fs.readdirSync(path.join(repo, 'tests'))
    .filter(name => /^test-.*\.js$/.test(name) && EXCLUDED.indexOf(name) === -1)
    .sort()
    .map(name => path.join(repo, 'tests', name))
}

function parseTap (output) {
  const failures = []
  let open = null
  let final = false
  output.split('\n').forEach(line => {
    if (FINAL.test(line)) {
      final = true
    }
    if (line.indexOf('# ') === 0 && !SUMMARY.test(line) && line !== '# ok') {
      open = line.slice(2)
      return
    }
    const failed = /^not ok \d+ (.*)$/.exec(line)
    if (failed) {
      if (failed[1].indexOf('test exited without ending') === 0) {
        failures.push('*')
      } else {
        failures.push(open === null ? '*' : open)
      }
    }
  })
  return {failures, final, open}
}

function runOnce (file, logFile, skip) {
  const result = childProcess.spawnSync(process.execPath, ['-r', useEngine, file], {
    cwd: repo,
    env: Object.assign({}, process.env, {IMPIT_FALLBACK_LOG: logFile, IMPIT_SKIP_TESTS: skip.join('\n')}),
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8'
  })
  const output = (result.stdout || '') + '\n'
  const tap = parseTap(output)
  const passes = /^# pass\s+(\d+)$/m.exec(output)
  return {
    tap: tap,
    status: result.status,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    passes: passes ? Number(passes[1]) : 0,
    open: tap.open
  }
}

function runFile (file, logFile, intermittent) {
  const skip = []
  const crashed = []
  for (;;) {
    const run = runOnce(file, logFile, skip)
    const crash = run.timedOut || (run.status !== 0 && !run.tap.final)
    if (crash && intermittent.indexOf(run.open) !== -1) {
      return {failures: crashed.concat(run.tap.failures.filter(name => name !== '*')).concat(run.open), passes: run.passes}
    }
    if (crash && run.open === TEARDOWN_TEST) {
      return {failures: crashed.concat(run.tap.failures.filter(name => name !== '*')).concat(TEARDOWN_TEST), passes: run.passes}
    }
    if (!crash) {
      const failures = crashed.concat(run.tap.failures.filter(name => name !== '*'))
      if (run.tap.failures.indexOf('*') !== -1 || (run.status !== 0 && !run.tap.failures.length)) {
        failures.push('*')
      }
      return {failures: failures, passes: run.passes}
    }
    if (!run.open || skip.indexOf(run.open) !== -1 || skip.length >= MAX_SKIPS) {
      return {failures: crashed.concat(run.tap.failures.filter(name => name !== '*')).concat('*'), passes: 0}
    }
    skip.push(run.open)
    crashed.push(run.open)
  }
}

function main () {
  const args = process.argv.slice(2)
  const printFailures = args.indexOf('--print-failures') !== -1
  const requested = args.filter(arg => arg !== '--print-failures').map(arg => path.resolve(repo, arg))
  const files = requested.length ? requested : listTests()
  const expected = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, 'utf8')) : []
  const logFile = process.env.IMPIT_FALLBACK_LOG || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'impit-suite-')), 'fallback.log')
  fs.writeFileSync(logFile, '')

  const found = []
  let passedFiles = 0
  files.forEach(file => {
    const name = path.basename(file)
    const intermittent = expected.filter(entry => entry.file === name && entry.intermittent).map(entry => entry.test)
    const result = runFile(file, logFile, intermittent)
    process.stderr.write(name + ': ' + (result.failures.length ? result.failures.length + ' failing' : 'ok') + '\n')
    if (!result.failures.length) {
      passedFiles++
    }
    result.failures.forEach(test => {
      if (!found.some(entry => entry.file === name && entry.test === test)) {
        found.push({file: name, test})
      }
    })
  })

  if (printFailures) {
    console.log(JSON.stringify(found.map(entry => ({file: entry.file, test: entry.test, reason: ''})), null, 2))
    return 0
  }

  const names = files.map(file => path.basename(file))
  const fullRun = requested.length === 0
  const matches = (entry, failure) => entry.file === failure.file && (entry.test === '*' || entry.test === failure.test)
  const unlisted = found.filter(failure => !expected.some(entry => matches(entry, failure)))
  const missing = entry => names.indexOf(entry.file) === -1 ? fullRun : !entry.intermittent && !found.some(failure => matches(entry, failure))
  const stale = expected.filter(missing)
  const fallback = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  let status = 0
  unlisted.forEach(failure => {
    console.log('unexpected failure: ' + failure.file + ' / ' + failure.test)
    status = 1
  })
  stale.forEach(entry => {
    console.log('stale entry: remove it: ' + entry.file + ' / ' + entry.test)
    status = 1
  })
  if (fallback.length) {
    console.log('the core reached the Node transport in: ' + fallback.join(', '))
    status = 1
  }
  console.log('core suite through impit: ' + files.length + ' files, ' + passedFiles + ' passed, ' + expected.length + ' expected differences')
  return status
}

process.exit(main())

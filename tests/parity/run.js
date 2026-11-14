'use strict'

const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const repo = path.resolve(__dirname, '..', '..')
const ENGINES = ['got', 'undici', 'impit']
const TARGETS = ['core'].concat(ENGINES)
const REFERENCE = {'request': '2.88.2', 'request-promise-native': '1.0.9'}
const NPM_INSTALL = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error']
const COMMIT = /^[0-9a-f]{40}$/
const PINNED_BY = /^(packages\/(?:got|undici|impit)\/tests\/[^:]+\.js): (.+)$/
const COPY_EXCLUDED = ['.git', 'node_modules']
const FILE_FAILED = '(the test file failed outside its tests)'

function run (command, args, options) {
  const result = childProcess.spawnSync(command, args, Object.assign({encoding: 'utf8', maxBuffer: 256 * 1024 * 1024}, options))
  if (result.error) {
    throw result.error
  }
  return result
}

function runOrFail (command, args, options) {
  const result = run(command, args, options)
  if (result.status !== 0) {
    throw new Error(command + ' ' + args.join(' ') + ' exited with ' + result.status + '\n' + result.stdout + result.stderr)
  }
  return result.stdout
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson (file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function settings (env) {
  const targets = (env.PARITY_TARGETS || TARGETS.join(' ')).split(/\s+/).filter(Boolean)
  const unknown = targets.filter(target => TARGETS.indexOf(target) === -1)
  if (unknown.length) {
    throw new Error('unknown PARITY_TARGETS ' + unknown.join(' ') + '; known: ' + TARGETS.join(' '))
  }
  if (!COMMIT.test(env.PARITY_SUITE_COMMIT || '')) {
    throw new Error('PARITY_SUITE_COMMIT must be the full commit of the suite; make reads it from .github/workflows/parity.yml')
  }
  if (!env.PARITY_SUITE && !env.PARITY_SUITE_REPOSITORY) {
    throw new Error('set PARITY_SUITE to a checkout of the suite or PARITY_SUITE_REPOSITORY to its GitHub repository')
  }
  const work = env.PARITY_WORK ? path.resolve(env.PARITY_WORK) : fs.mkdtempSync(path.join(os.tmpdir(), 'request-compat-parity-'))
  return {
    targets,
    commit: env.PARITY_SUITE_COMMIT,
    repository: env.PARITY_SUITE_REPOSITORY,
    suite: env.PARITY_SUITE ? path.resolve(env.PARITY_SUITE) : null,
    work,
    out: env.PARITY_OUT ? path.resolve(env.PARITY_OUT) : path.join(work, 'results')
  }
}

function suiteCheckout (config) {
  let dir = config.suite
  if (!dir) {
    dir = path.join(config.work, 'suite-checkout')
    runOrFail('git', ['init', '--quiet', dir])
    runOrFail('git', ['-C', dir, 'fetch', '--quiet', '--depth', '1', 'https://github.com/' + config.repository + '.git', config.commit])
    runOrFail('git', ['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'])
  }
  const head = runOrFail('git', ['-C', dir, 'rev-parse', 'HEAD']).trim()
  if (head !== config.commit) {
    throw new Error('the suite in ' + dir + ' is at ' + head + ', not at ' + config.commit)
  }
  return dir
}

function prepareSuite (checkout, work) {
  const dir = path.join(work, 'suite')
  fs.cpSync(checkout, dir, {recursive: true, filter: source => COPY_EXCLUDED.indexOf(path.basename(source)) === -1})
  runOrFail('npm', ['pkg', 'delete', 'devDependencies.request-got-adapter'], {cwd: dir})
  runOrFail('npm', NPM_INSTALL, {cwd: dir})
  Object.keys(REFERENCE).forEach(name => {
    const version = readJson(path.join(dir, 'node_modules', name, 'package.json')).version
    if (version !== REFERENCE[name]) {
      throw new Error('the suite installed ' + name + '@' + version + ' as the reference, the expected lists assume ' + REFERENCE[name])
    }
  })
  fs.copyFileSync(path.join(__dirname, 'clients.js'), path.join(dir, 'src', 'clients.js'))
  return dir
}

function pack (dir, destination) {
  const info = JSON.parse(runOrFail('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {cwd: dir}))[0]
  return {file: path.join(destination, info.filename), name: info.name, version: info.version, files: info.files.map(file => file.path)}
}

function sameFile (a, b) {
  return fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b))
}

function packageDir (name, from) {
  return path.dirname(require.resolve(name + '/package.json', {paths: [from]}))
}

function verifyTarget (target, dir, packs) {
  const own = packs[target]
  const requestDir = path.join(dir, 'node_modules', 'request')
  const installed = readJson(path.join(requestDir, 'package.json'))
  if (installed.name !== own.name || installed.version !== own.version) {
    throw new Error(target + ': node_modules/request is ' + installed.name + '@' + installed.version + ', not ' + own.name + '@' + own.version)
  }
  const seen = packageDir('request', packageDir('request-promise-native', dir))
  if (seen !== requestDir) {
    throw new Error(target + ': request-promise-native gets request from ' + seen + ', not ' + requestDir)
  }
  if (target === 'core') {
    return
  }
  const core = packageDir('request-compat', requestDir)
  const changed = packs.core.files.filter(file => !sameFile(path.join(repo, file), path.join(core, file)))
  if (changed.length) {
    throw new Error(target + ': the engine does not get the core of this checkout, ' + core + ' differs in ' + changed.join(', '))
  }
}

function installTarget (target, packs, work) {
  const dir = path.join(work, 'targets', target)
  fs.mkdirSync(dir, {recursive: true})
  const overrides = {request: '$request'}
  if (target !== 'core') {
    overrides['request-compat'] = 'file:' + packs.core.file
  }
  writeJson(path.join(dir, 'package.json'), {
    name: 'parity-' + target,
    version: '1.0.0',
    private: true,
    dependencies: {'request': 'file:' + packs[target].file, 'request-promise-native': REFERENCE['request-promise-native']},
    overrides
  })
  runOrFail('npm', NPM_INSTALL, {cwd: dir})
  verifyTarget(target, dir, packs)
  return dir
}

function runJest (target, suite, targetDir, out) {
  const json = path.join(out, 'parity-' + target + '.json')
  const log = path.join(out, 'parity-' + target + '.log')
  if (fs.existsSync(json)) {
    fs.unlinkSync(json)
  }
  const jest = path.join(suite, 'node_modules', 'jest', 'bin', 'jest.js')
  const result = run(process.execPath, [jest, '--runInBand', '--json', '--outputFile=' + json], {
    cwd: suite,
    env: Object.assign({}, process.env, {PARITY_TARGET: targetDir})
  })
  fs.writeFileSync(log, result.stdout + result.stderr)
  if (!fs.existsSync(json)) {
    throw new Error(target + ': jest wrote no result, see ' + log)
  }
  return readJson(json)
}

function failuresOf (result) {
  const failures = []
  result.testResults.forEach(file => {
    const name = path.basename(file.name)
    const failed = file.assertionResults.filter(assertion => assertion.status !== 'passed')
    failed.forEach(assertion => failures.push({file: name, test: assertion.fullName}))
    if (file.status !== 'passed' && !failed.length) {
      failures.push({file: name, test: FILE_FAILED})
    }
  })
  return failures
}

function entryProblems (entry) {
  const label = entry.file + ' / ' + entry.test
  if (!entry.file || !entry.test || !entry.reason || !entry.pinnedBy) {
    return ['entry without file, test, reason or pinnedBy: ' + label]
  }
  const pinned = PINNED_BY.exec(entry.pinnedBy)
  if (!pinned) {
    return ['pinnedBy is not "packages/<engine>/tests/<file>.js: <test name>": ' + label]
  }
  const file = path.join(repo, pinned[1])
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\\'/g, '\'') : ''
  return source.indexOf(pinned[2]) === -1 ? ['pinnedBy names no test in ' + pinned[1] + ': ' + label] : []
}

function compare (failures, expected) {
  const key = entry => entry.file + ' / ' + entry.test
  const failed = failures.map(key)
  const listed = expected.map(key)
  const problems = []
  expected.forEach(entry => {
    entryProblems(entry).forEach(problem => problems.push(problem))
  })
  failures.filter(failure => listed.indexOf(key(failure)) === -1).forEach(failure => {
    problems.push('unexpected failure: ' + key(failure))
  })
  expected.filter(entry => failed.indexOf(key(entry)) === -1).forEach(entry => {
    problems.push('stale entry, the test passes: ' + key(entry))
  })
  return problems
}

function main () {
  const config = settings(process.env)
  const packDir = path.join(config.work, 'packs')
  fs.mkdirSync(packDir, {recursive: true})
  fs.mkdirSync(config.out, {recursive: true})
  const packs = {core: pack(repo, packDir)}
  config.targets.filter(target => target !== 'core').forEach(engine => {
    packs[engine] = pack(path.join(repo, 'packages', engine), packDir)
  })
  const suite = prepareSuite(suiteCheckout(config), config.work)
  const lines = ['suite ' + config.commit + ', reference request-promise-native ' + REFERENCE['request-promise-native'] + ' on request ' + REFERENCE.request + ', ' + process.version]
  let status = 0
  config.targets.forEach(target => {
    const targetDir = installTarget(target, packs, config.work)
    const result = runJest(target, suite, targetDir, config.out)
    const expected = readJson(path.join(__dirname, 'expected', target + '.json'))
    const problems = compare(failuresOf(result), expected)
    lines.push(target + ' (' + packs[target].name + ' ' + packs[target].version + ' from this checkout): ' + result.numPassedTests + ' of ' +
      result.numTotalTests + ' passed, ' + expected.length + ' expected differences, ' + (problems.length ? problems.length + ' problems' : 'as expected'))
    problems.forEach(problem => lines.push('  ' + problem))
    if (problems.length) {
      status = 1
    }
  })
  fs.writeFileSync(path.join(config.out, 'summary.txt'), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
  console.log('results: ' + config.out)
  return status
}

try {
  process.exitCode = main()
} catch (err) {
  console.error(err.message)
  process.exitCode = 2
}

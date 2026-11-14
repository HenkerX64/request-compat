'use strict'

const path = require('path')
const {Worker, isMainThread, parentPort, workerData, SHARE_ENV} = require('worker_threads')
const nodeApi = require('request-compat')
const enginePath = path.join(__dirname, '..', 'index.js')
const engine = require(enginePath)

function outcomeOf (api, options) {
  return new Promise(resolve => {
    api(options, (err, res, body) => resolve(err ? {error: err.code || err.message, option: err.option} : {body}))
  })
}

async function outcomesOf (cases) {
  const outcomes = []
  for (const options of cases) {
    outcomes.push({node: await outcomeOf(nodeApi, options), engine: await outcomeOf(engine, options)})
  }
  return outcomes
}

function environmentOf (changes) {
  if (changes === 'shared') {
    return SHARE_ENV
  }
  const environment = Object.assign({}, process.env)
  Object.keys(changes || {}).forEach(name => {
    if (changes[name] === null) {
      delete environment[name]
    } else {
      environment[name] = changes[name]
    }
  })
  return environment
}

function inWorker (cases, changes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {workerData: cases, env: environmentOf(changes)})
    worker.once('message', resolve)
    worker.once('error', reject)
  })
}

function main () {
  const cases = JSON.parse(process.argv[3])
  const changes = process.argv[4] ? JSON.parse(process.argv[4]) : null
  const running = process.argv[2] === 'worker' ? inWorker(cases, changes) : outcomesOf(cases)
  running.then(outcomes => {
    console.log(JSON.stringify(outcomes))
    process.exit(0)
  }, err => {
    console.error(err)
    process.exit(1)
  })
}

if (isMainThread) {
  main()
} else {
  outcomesOf(workerData).then(outcomes => parentPort.postMessage(outcomes))
}

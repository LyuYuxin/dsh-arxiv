#!/usr/bin/env node
// Boot an isolated DSH web dev instance for dsh-arxiv verification.
//
//   node tools/boot.mjs                 pick a free port, boot, print URL + PID, stay alive
//   node tools/boot.mjs --port 5123     force a specific port
//   node tools/boot.mjs --keep          reuse an already-running instance from the state file
//   node tools/boot.mjs --timeout 900   kill the child after 900 s (0 = never, default 1800)
//
// The child inherits DSH_HOME (%TEMP%\dsh-arxiv-dev by default) and is killed when this
// process exits, receives SIGINT/SIGTERM, or the timeout expires. A state file
// (test-artifacts/dev-instance.json) lets tools/e2e.mjs attach without a second boot.
//
// Sandbox note: this environment forbids piped stdio (spawn with 'pipe' fails with
// EPERM on Windows). The child's stdout/stderr are redirected to files and this script
// tails the log file for the printed URL instead.
//
// Exit codes: 0 = clean shutdown, 1 = boot failed (child printed no URL), 2 = bad args.

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const artifactsDir = path.join(pluginRoot, 'test-artifacts')
const stateFile = path.join(artifactsDir, 'dev-instance.json')
const logFile = path.join(artifactsDir, 'dev-instance.log')
const errFile = path.join(artifactsDir, 'dev-instance.err.log')

const DSH_CLI = process.env.DSH_CLI ?? 'D:\\DeepseekHarness\\resources\\runtime\\cli\\bin\\dsh.cmd'
// Never inherit the ambient DSH_HOME: the host harness points it at the real
// ~/.dsh profile, which is read-only here and belongs to the desktop app.
const DSH_HOME = process.env.DSH_ARXIV_DEV_HOME ?? path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'dsh-arxiv-dev')

function parseArgs(argv) {
  const opts = { port: 0, keep: false, timeout: 1800 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') opts.port = Number(argv[++i])
    else if (arg === '--keep') opts.keep = true
    else if (arg === '--timeout') opts.timeout = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/boot.mjs [--port <n>] [--keep] [--timeout <seconds>]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error(`invalid --port: ${opts.port}`)
    process.exit(2)
  }
  return opts
}

// Ask the OS for a free loopback port, then release it for DSH to claim.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

// A token URL is printed by the CLI; a first GET of it answers with a redirect and
// sets the browser-session cookie. Resolve that cookie once so callers can reuse it.
async function bootstrapAuth(url, { timeoutMs = 60000 } = {}) {
  const origin = new URL(url).origin
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      const setCookies = response.headers.getSetCookie?.() ?? []
      const cookie = setCookies.map((value) => value.split(';')[0]).filter(Boolean).join('; ')
      if (response.status === 200) return { origin, cookie, status: 200 }
      const location = response.headers.get('location')
      if (location) {
        const next = await fetch(new URL(location, url), { headers: cookie ? { cookie } : {} })
        if (next.ok) return { origin, cookie, status: next.status }
      }
      lastError = new Error(`token bootstrap answered HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw lastError ?? new Error('auth bootstrap timed out')
}

async function isHealthy(origin, cookie) {
  try {
    const response = await fetch(`${origin}/`, { headers: cookie ? { cookie } : {} })
    return response.status === 200
  } catch {
    return false
  }
}

function tailForUrl(logPath) {
  try {
    const text = readFileSync(logPath, 'utf8')
    const match = text.match(/https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/)
    return match ? match[0] : null
  } catch {
    return null
  }
}

async function waitForUrl(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const url = tailForUrl(logPath)
    if (url) return url
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  mkdirSync(artifactsDir, { recursive: true })

  if (opts.keep && existsSync(stateFile)) {
    const state = readState()
    if (state?.url && state.pid) {
      try {
        process.kill(state.pid, 0)
        const auth = await bootstrapAuth(state.url)
        if (await isHealthy(auth.origin, auth.cookie)) {
          console.log(`reusing dsh web: ${state.url}`)
          console.log(`PID ${state.pid}`)
          return
        }
      } catch {
        // stale state file: fall through to a fresh boot
      }
    }
  }

  if (!existsSync(path.join(DSH_HOME, 'profiles', 'web', 'package.json'))) {
    console.error(`no web profile at ${path.join(DSH_HOME, 'profiles', 'web')} — run tools/install-dev.mjs first`)
    process.exit(1)
  }

  const port = opts.port || (await findFreePort())
  const args = ['web', '--no-open', '--port', String(port)]
  const env = { ...process.env, DSH_HOME }

  writeFileSync(logFile, '')
  writeFileSync(errFile, '')
  const outFd = openSync(logFile, 'w')
  const errFd = openSync(errFile, 'w')
  const child = spawn(DSH_CLI, args, { env, windowsHide: true, stdio: ['ignore', outFd, errFd] })
  closeSync(outFd)
  closeSync(errFd)

  let exiting = false
  let timeoutTimer = null
  const shutdown = (code = 0) => {
    if (exiting) return
    exiting = true
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (child.pid && child.exitCode === null) {
      // Windows: taskkill walks the Electron child tree (renderer/utility processes).
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    }
    console.log(`stopped dsh web (PID ${child.pid})`)
    setTimeout(() => process.exit(code), 1500)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  process.on('exit', () => {
    if (child.pid && child.exitCode === null) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        // best effort
      }
    }
  })
  child.on('error', (error) => {
    console.error(`failed to spawn ${DSH_CLI}: ${error.message}`)
    shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (exiting) return
    console.error(`child exited unexpectedly (code ${code}, signal ${signal})`)
    try {
      const tail = readFileSync(errFile, 'utf8').trim().split('\n').slice(-20).join('\n')
      if (tail) console.error(tail)
    } catch {
      // ignore
    }
    process.exit(1)
  })

  if (opts.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      console.error(`boot timeout after ${opts.timeout}s — killing child`)
      shutdown(0)
    }, opts.timeout * 1000)
  }

  const url = await waitForUrl(logFile, 120000)
  if (!url) {
    console.error('no GUI URL was printed within 120s')
    try {
      console.error(readFileSync(logFile, 'utf8').trim())
      console.error(readFileSync(errFile, 'utf8').trim())
    } catch {
      // ignore
    }
    shutdown(1)
    return
  }

  const auth = await bootstrapAuth(url)
  if (!(await isHealthy(auth.origin, auth.cookie))) {
    console.error('GUI did not answer HTTP 200 after token bootstrap')
    shutdown(1)
    return
  }

  const state = {
    pid: child.pid,
    port: Number(new URL(url).port),
    url,
    origin: auth.origin,
    cookie: auth.cookie,
    dshHome: DSH_HOME,
    dshCli: DSH_CLI,
    logFile,
    errFile,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`)

  console.log('dsh web dev instance ready')
  console.log(`URL  ${url}`)
  console.log(`PID  ${child.pid}`)
  console.log(`DSH_HOME  ${DSH_HOME}`)
  console.log(`state ${stateFile}`)
  console.log('Ctrl+C stops the instance.')
}

await main()

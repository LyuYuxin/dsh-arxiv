#!/usr/bin/env node
// Prepare an isolated DSH_HOME + web profile for dsh-arxiv verification.
//
//   node tools/install-dev.mjs            fresh dev home, install dsh-arxiv, patch model
//   node tools/install-dev.mjs --keep     reuse the existing dev home (reinstall plugin)
//   node tools/install-dev.mjs --link     junction node_modules/dsh-arxiv -> plugin source
//                                         (live edits during iteration; default is a real
//                                         file: copy, exactly like a user install)
//   node tools/install-dev.mjs --no-plugin only the DSH_HOME + credentials (harness smoke)
//   node tools/install-dev.mjs --home <dir>   override the dev home
//
// Never touches %USERPROFILE%\.dsh (read-only here): credentials and the
// llm-deepseek cache are copied into the isolated home.
//
// Sandbox note: this script uses file-descriptor redirection (not piped stdio)
// for child processes, because piped stdio is denied in this environment.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(here, '..')
const DEFAULT_DEV_HOME = path.join(process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), 'dsh-arxiv-dev')
const USER_DSH = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh')
const DSH_CLI = process.env.DSH_CLI ?? 'D:\\DeepseekHarness\\resources\\runtime\\cli\\bin\\dsh.cmd'
const PROFILE = 'web'

const MODEL_PATCH_MARKER = 'agent-default-model'
const MODEL_PATCH = `- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
`

function parseArgs(argv) {
  const opts = { keep: false, link: false, plugin: true, home: DEFAULT_DEV_HOME }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--keep') opts.keep = true
    else if (arg === '--link') opts.link = true
    else if (arg === '--no-plugin') opts.plugin = false
    else if (arg === '--home') opts.home = path.resolve(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tools/install-dev.mjs [--keep] [--link] [--no-plugin] [--home <dir>]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return opts
}

function runCli(args, label) {
  console.log(`\n$ dsh ${args.join(' ')}`)
  const result = spawnSync(DSH_CLI, args, {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, DSH_HOME: DEV_HOME },
  })
  if (result.error) throw new Error(`${label}: failed to spawn ${DSH_CLI}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}: dsh exited with code ${result.status}`)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

const opts = parseArgs(process.argv.slice(2))
const DEV_HOME = opts.home
const profileDir = path.join(DEV_HOME, 'profiles', PROFILE)

// --- safety: only ever delete the dedicated dev home ----------------------
function assertSafeDevHome(target) {
  const resolved = path.resolve(target)
  const temp = path.resolve(process.env.TEMP ?? process.env.TMP ?? os.tmpdir())
  if (!resolved.startsWith(temp + path.sep) || !/dsh-arxiv-dev$/.test(resolved)) {
    throw new Error(`refusing to delete ${resolved}: not a dsh-arxiv-dev directory under ${temp}`)
  }
}

// --- 1. dev home ----------------------------------------------------------
mkdirSync(DEV_HOME, { recursive: true })
if (!opts.keep) {
  assertSafeDevHome(DEV_HOME)
  for (const entry of ['profiles', 'llm-deepseek', '.credentials.yaml', 'storages', 'sessions', 'cache']) {
    const target = path.join(DEV_HOME, entry)
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  }
  console.log(`fresh DSH_HOME  ${DEV_HOME}`)
} else {
  console.log(`reusing DSH_HOME  ${DEV_HOME}`)
}

// --- 2. credentials + caches copied from the real (read-only) ~/.dsh ------
const credentials = path.join(USER_DSH, '.credentials.yaml')
if (!existsSync(credentials)) throw new Error(`missing ${credentials} — cannot route real DeepSeek models`)
cpSync(credentials, path.join(DEV_HOME, '.credentials.yaml'))
console.log(`copied credentials  ${credentials}`)

for (const name of ['llm-deepseek', '.anonymous-user-id']) {
  const source = path.join(USER_DSH, name)
  if (!existsSync(source)) {
    console.log(`skip ${name}  (not present in ${USER_DSH})`)
    continue
  }
  const target = path.join(DEV_HOME, name)
  cpSync(source, target, { recursive: true, force: true })
  console.log(`copied ${name}  ${source}`)
}

// --- 3. initialize the web profile (first use writes the shipped template) -
if (!existsSync(path.join(profileDir, 'package.json'))) {
  // `dsh web --help` prepares the profile before printing help; it is the
  // cheapest way to materialize the shipped template without booting.
  runCli(['web', '--help'], 'profile init')
}

const profilePackage = path.join(profileDir, 'package.json')
const pkg = readJson(profilePackage)
console.log(`\nprofile  ${profilePackage}`)
console.log(`bundles  ${(pkg.dsh?.profile?.bundles ?? []).join(', ')}`)

// --- 4. install dsh-arxiv into the profile --------------------------------
if (opts.plugin) {
  const spec = `file:${pluginRoot}`
  const already = pkg.dependencies?.['dsh-arxiv']
  if (already === spec || (already && opts.keep)) {
    // Repoint the copy/link from the current source (file: deps are copied by pnpm,
    // so a source edit does not refresh node_modules on its own).
    runCli(['plugin', '--profile', PROFILE, 'install', '--force'], 'reinstall plugin')
  } else {
    runCli(['plugin', '--profile', PROFILE, 'add', spec], 'install plugin')
  }

  // --- 5. make sure the bundle is in dsh.profile.bundles, base first ------
  const after = readJson(profilePackage)
  const bundles = after.dsh?.profile?.bundles ?? []
  if (!bundles.includes('dsh-arxiv')) {
    const first = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].filter((name) => bundles.includes(name))
    const rest = bundles.filter((name) => !first.includes(name))
    after.dsh ??= {}
    after.dsh.profile ??= {}
    after.dsh.profile.bundles = [...first, ...rest, 'dsh-arxiv']
    writeJson(profilePackage, after)
    console.log('added dsh-arxiv to dsh.profile.bundles')
  } else {
    console.log('dsh.profile.bundles already contains dsh-arxiv')
  }

  // --- 6. optional junction for live iteration ---------------------------
  if (opts.link) {
    const installed = path.join(profileDir, 'node_modules', 'dsh-arxiv')
    if (existsSync(installed)) rmSync(installed, { recursive: true, force: true })
    const result = spawnSync('cmd.exe', ['/d', '/c', 'mklink', '/J', installed, pluginRoot], {
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    })
    if (result.status !== 0) throw new Error(`mklink /J failed with code ${result.status}`)
    console.log(`linked ${installed} -> ${pluginRoot}`)
  }
}

// --- 7. route the default model through the copied DeepSeek account ------
// A fresh web profile defaults to provider deepseek-official, which needs
// DEEPSEEK_API_KEY; the copied credentials authenticate the account platform.
const patchFile = path.join(profileDir, 'cordis.patch.yml')
if (opts.plugin) {
  const current = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  const hasEntry = current.includes(MODEL_PATCH_MARKER)
  // `[]` is the template placeholder document; a patch file must be a single
  // YAML array of entries, so an appended entry cannot coexist with it. The
  // entry may follow comment lines, so look for a list item anywhere.
  const validEntryList = /^\s*-(?:\s|$)/m.test(current)
  if (!hasEntry || !validEntryList) {
    const placeholder = current.trim() === '[]' || current.trim() === '' || !validEntryList
    const header = placeholder
      ? '# dsh-arxiv dev profile overlay: the copied credentials authenticate the\n' +
        '# DeepSeek account platform, so route the default model through it.\n'
      : current.replace(/\s*$/, '\n')
    writeFileSync(patchFile, `${header}${MODEL_PATCH}`)
    console.log(`patched ${patchFile} (provider deepseek-account, model deepseek-flash)`)
  } else {
    console.log(`model override already present in ${patchFile}`)
  }
}

// --- 8. verify the composed config sees what we expect -------------------
if (opts.plugin) {
  // Piped stdio is denied in this sandbox (spawn EPERM), so redirect the dump
  // to files and read them back.
  const dumpFile = path.join(DEV_HOME, 'dump-config.txt')
  const dumpErrFile = path.join(DEV_HOME, 'dump-config.err.txt')
  writeFileSync(dumpFile, '')
  writeFileSync(dumpErrFile, '')
  const outFd = openSync(dumpFile, 'w')
  const errFd = openSync(dumpErrFile, 'w')
  const dump = spawnSync(DSH_CLI, ['web', '--dump-config'], {
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: { ...process.env, DSH_HOME: DEV_HOME },
  })
  closeSync(outFd)
  closeSync(errFd)
  if (dump.status === 0) {
    const text = readFileSync(dumpFile, 'utf8')
    const modelRow = text.includes('provider: deepseek-account')
    const pluginRow = text.includes('  name: dsh-arxiv') || text.includes("name: 'dsh-arxiv'")
    if (!modelRow) console.error('WARN: composed config has no agent-default-model provider deepseek-account')
    if (!pluginRow) console.error('WARN: composed config has no dsh-arxiv runtime row')
    console.log(`composed: dsh-arxiv row ${pluginRow ? 'OK' : 'MISSING'}, deepseek-account default ${modelRow ? 'OK' : 'MISSING'}`)
  } else {
    console.error('WARN: `dsh web --dump-config` failed; run it manually to inspect the composed profile')
    const detail = readFileSync(dumpErrFile, 'utf8').trim().split('\n').slice(-12).join('\n')
    if (detail) console.error(detail)
  }
}

console.log('\ninstall-dev done')
console.log(`DSH_HOME  ${DEV_HOME}`)
console.log(`next:  node tools/boot.mjs`)
console.log(`then:  node tools/e2e.mjs            (full Playwright, needs an unrestricted shell)`)
console.log(`       node tools/e2e.mjs --http-only  (routes + boot manifest only)`)

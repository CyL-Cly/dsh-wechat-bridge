#!/usr/bin/env node
/**
 * Patch installed @deepseek-ai/dsh-client-connection so DSH_WEB_NO_TOKEN=1
 * skips launch-token + cookie gate (免token鉴权).
 *
 * Patches:
 *   - **/dsh-client-connection/lib/index.js (published bundle)
 *   - **/browser-auth.js|ts (source / rare layouts)
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '/* dsh-web-no-token-patch */'
const HELPER = `${MARKER}
function webNoTokenEnabled() {
  const noToken = (process.env.DSH_WEB_NO_TOKEN ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(noToken)) return true;
  const browserAuth = (process.env.DSH_BROWSER_AUTH ?? "").trim().toLowerCase();
  return ["disabled", "off", "none", "0", "false"].includes(browserAuth);
}
`

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === '.git') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (
      name === 'browser-auth.js' ||
      name === 'browser-auth.mjs' ||
      name === 'browser-auth.ts' ||
      (name === 'index.js' && p.includes(`${join('dsh-client-connection', 'lib')}${name === 'index.js' ? '' : ''}`))
    ) {
      // index.js under .../dsh-client-connection/lib/
      if (name === 'index.js' && !p.replace(/\\/g, '/').includes('/dsh-client-connection/lib/index.js')) continue
      out.push(p)
    }
  }
  return out
}

function stripOld(src) {
  let s = src
  s = s.replace(/\/\* dsh-web-no-token-patch \*\/[\s\S]*?function webNoTokenEnabled\(\) \{[\s\S]*?\n\}\n+/g, '')
  s = s.replace(/\n    if \(webNoTokenEnabled\(\)\) return true;\n/g, '\n')
  s = s.replace(/\n    if \(webNoTokenEnabled\(\)\) return baseUrl;\n/g, '\n')
  s = s.replace(
    /\n    if \(webNoTokenEnabled\(\)\) \{\n[\s\S]*?return true;\n    \}\n/g,
    '\n',
  )
  return s
}

function patchFile(path) {
  let src = readFileSync(path, 'utf8')
  if (!src.includes('authorizeIndex') && !src.includes('class BrowserAuth') && !src.includes('isAuthenticated')) {
    console.log('[skip unrelated]', path)
    return false
  }
  // Always re-apply cleanly
  const bak = path + '.bak-no-token'
  if (!existsSync(bak) && !src.includes(MARKER)) writeFileSync(bak, src)
  if (existsSync(bak) && src.includes(MARKER)) src = readFileSync(bak, 'utf8')
  else src = stripOld(src)

  if (src.includes('webNoTokenEnabled')) {
    console.log('[skip already patched]', path)
    return false
  }

  // Insert helper after last import (never splice into `class BrowserAuth`)
  const importRe = /^import .*;\n/gm
  let last = null
  for (const m of src.matchAll(importRe)) last = m
  if (last) {
    const idx = last.index + last[0].length
    src = src.slice(0, idx) + '\n' + HELPER + '\n' + src.slice(idx)
  } else {
    src = HELPER + '\n' + src
  }

  src = src.replace(/(isAuthenticated\s*\([^)]*\)\s*\{)/, `$1\n    if (webNoTokenEnabled()) return true;`)
  src = src.replace(/(authenticatedUrl\s*\([^)]*\)\s*\{)/, `$1\n    if (webNoTokenEnabled()) return baseUrl;`)
  src = src.replace(
    /(authorizeIndex\s*\([^)]*\)\s*\{)/,
    `$1
    if (webNoTokenEnabled()) {
      const __u = new URL(req.url ?? "/", "http://dsh.invalid");
      if (__u.searchParams.has("token") && req.method === "GET") {
        res.writeHead(303, { "cache-control": "no-store", location: "./", "referrer-policy": "no-referrer" });
        res.end();
        return false;
      }
      return true;
    }`,
  )

  const decls = (src.match(/\bclass BrowserAuth\b/g) || []).length
  if (src.includes('class BrowserAuth') && decls !== 1) {
    console.error('[fail] bad BrowserAuth class count', decls, path)
    return false
  }
  if (!src.includes('webNoTokenEnabled')) {
    console.error('[fail] helper missing', path)
    return false
  }
  writeFileSync(path, src)
  console.log('[patched]', path)
  return true
}

const roots = process.argv.slice(2)
if (!roots.length) {
  const here = dirname(fileURLToPath(import.meta.url))
  roots.push(join(here, '..'), '/opt/dsh-wechat-bridge', '/usr/local/lib/node_modules', process.cwd())
}

const seen = new Set()
let n = 0
for (const root of roots) {
  if (!existsSync(root)) continue
  for (const f of walk(root)) {
    if (seen.has(f)) continue
    seen.add(f)
    if (patchFile(f)) n++
  }
}
console.log(`[done] patched ${n} file(s); enable with DSH_WEB_NO_TOKEN=1`)
if (n === 0) process.exitCode = 2

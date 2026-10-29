#!/usr/bin/env node
/**
 * Patch installed @deepseek-ai/dsh-client-connection so DSH_WEB_NO_TOKEN=1
 * skips launch-token + cookie gate (免token鉴权).
 *
 * Usage: node scripts/patch-dsh-web-no-token.mjs [searchRoot...]
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = '/* dsh-web-no-token-patch */'
const HELPER = `
${MARKER}
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
    if (name === 'node_modules' && !dir.includes('@deepseek-ai')) {
      // still descend into top-level node_modules
    }
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (name === '.git' || name === 'dist' && dir.endsWith('dsh-wechat-bridge')) continue
      walk(p, out)
    } else if (name === 'browser-auth.js' || name === 'browser-auth.mjs' || name === 'browser-auth.ts') {
      out.push(p)
    }
  }
  return out
}

function patchFile(path) {
  let src = readFileSync(path, 'utf8')
  if (src.includes('webNoTokenEnabled')) {
    console.log('[skip already patched]', path)
    return false
  }
  // Insert helper near PROCESS_LAUNCH_TOKENS or top after imports
  if (!src.includes('function webNoTokenEnabled')) {
    if (src.includes('PROCESS_LAUNCH_TOKENS')) {
      src = src.replace(
        /(const PROCESS_LAUNCH_TOKENS[\s\S]*?\n)/,
        `$1${HELPER}\n`,
      )
    } else {
      // compiled: inject after first import block
      const m = src.match(/^(?:import .*\n)+/)
      if (m) src = m[0] + HELPER + '\n' + src.slice(m[0].length)
      else src = HELPER + '\n' + src
    }
  }

  // isAuthenticated
  if (/isAuthenticated\s*\([^)]*\)\s*\{/.test(src) && !/isAuthenticated[\s\S]{0,120}webNoTokenEnabled/.test(src)) {
    src = src.replace(
      /(isAuthenticated\s*\([^)]*\)\s*\{)/,
      `$1\n    if (webNoTokenEnabled()) return true;`,
    )
  }

  // authenticatedUrl — skip token query
  if (/authenticatedUrl\s*\([^)]*\)\s*\{/.test(src) && !/authenticatedUrl[\s\S]{0,80}webNoTokenEnabled/.test(src)) {
    src = src.replace(
      /(authenticatedUrl\s*\([^)]*\)\s*\{)/,
      `$1\n    if (webNoTokenEnabled()) return baseUrl;`,
    )
  }

  // authorizeIndex — early allow
  if (/authorizeIndex\s*\([^)]*\)\s*\{/.test(src) && !/authorizeIndex[\s\S]{0,200}webNoTokenEnabled/.test(src)) {
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
  }

  if (!src.includes('webNoTokenEnabled')) {
    console.error('[fail] could not inject helper', path)
    return false
  }
  writeFileSync(path, src)
  console.log('[patched]', path)
  return true
}

const roots = process.argv.slice(2)
if (!roots.length) {
  const here = dirname(fileURLToPath(import.meta.url))
  roots.push(join(here, '..'), '/opt/dsh-wechat-bridge', '/opt/deepseek-harness', process.cwd())
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

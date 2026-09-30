/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response first passes Connection's browser authentication, then the
 * webserver's index render (structured injection rows, then raw taps).
 * Non-index assets stay public and carry a weak size-and-mtime validator with
 * `Cache-Control: no-cache`, so a rebuild that keeps an unhashed file's size and
 * modification time is not detected. The dist location is workspace knowledge of
 * the composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * Freshness contract for one non-index asset: a stored copy may be reused, but
 * every reuse is revalidated. `no-cache` (not `no-store`) keeps the client
 * re-checking validators while the dist may be rebuilt at any time.
 */
const ASSET_CACHE_CONTROL = 'no-cache'

/** Weak validator over size and modification time — no content read. */
function assetEtag(size: number, mtimeMs: number): string {
  return `W/"${String(size)}-${String(Math.floor(mtimeMs))}"`
}

/**
 * Whether the request already proves the current asset representation fresh.
 * A present `If-None-Match` decides alone; `If-Modified-Since` is the fallback
 * for a client that never saw an ETag. Entity tags compare weakly.
 * @param headers - request headers carrying the conditional validators.
 * @param etag - the asset's current weak validator.
 * @param mtimeMs - modification time the `If-Modified-Since` date is compared against.
 * @returns whether the response is a 304 rather than the bytes.
 */
function notModified(headers: IncomingMessage['headers'], etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = headers['if-none-match']
  if (ifNoneMatch !== undefined) {
    return ifNoneMatch.split(',').some((candidate) => {
      const tag = candidate.trim()
      return tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, '')
    })
  }
  const ifModifiedSince = headers['if-modified-since']
  if (ifModifiedSince === undefined) return false
  const since = Date.parse(ifModifiedSince)
  // HTTP dates have second granularity, so compare whole seconds.
  return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since
}

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param headers - request headers, read only to revalidate a non-index asset.
 * @param authorizeIndex - authenticates an index response before its bytes are read.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  headers: IncomingMessage['headers'],
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  // Non-index targets resolve metadata first, so a revalidating request is
  // answered from size and mtime without the file being read at all.
  if (target !== distRoot && target !== distIndex) {
    let asset: AssetOutcome
    try {
      asset = await resolveAsset(target, headers)
    } catch (error) {
      // Only absent or non-file targets are 404; other filesystem failures
      // reach the webserver's request-failure handling.
      if (!isMissingPath(error)) throw error
      asset = { kind: 'miss' }
    }
    if (asset.kind === 'miss') res.writeHead(404)
    else if (asset.kind === 'fresh') res.writeHead(304, asset.validators)
    else res.writeHead(200, { 'content-type': asset.type, ...asset.validators })
    res.end(asset.kind === 'body' ? asset.body : undefined)
    return
  }
  // The index is rendered per request (fresh injection rows, base insertion),
  // so it carries no validators and stays uncached.
  let body: string
  try {
    if (!authorizeIndex()) return
    body = await renderIndex()
  } catch (error) {
    if (!isMissingPath(error)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': HTML_MIME })
  res.end(body)
}

/**
 * One non-index dist outcome: the target's bytes, its revalidation-only 304, or
 * the empty 404 an absent or non-file target keeps.
 */
type AssetOutcome =
  | { kind: 'body'; validators: Record<string, string>; type: string; body: Buffer }
  | { kind: 'fresh'; validators: Record<string, string> }
  | { kind: 'miss' }

/**
 * Resolve one non-index target: metadata first, bytes only when the request's
 * validators do not already prove the representation fresh.
 * @param target - absolute path of the target inside the dist root.
 * @param headers - request headers carrying the conditional validators.
 * @returns the bytes to send, the 304 validators, or the empty-404 outcome.
 */
async function resolveAsset(target: string, headers: IncomingMessage['headers']): Promise<AssetOutcome> {
  const info = await stat(target)
  // A directory, socket, or device has no bytes to serve; it is the same empty
  // 404 the old directory read produced through EISDIR.
  if (!info.isFile()) return { kind: 'miss' }
  const validators = {
    etag: assetEtag(info.size, info.mtimeMs),
    'last-modified': info.mtime.toUTCString(),
    'cache-control': ASSET_CACHE_CONTROL,
  }
  if (notModified(headers, validators.etag, info.mtimeMs)) return { kind: 'fresh', validators }
  return {
    kind: 'body',
    validators,
    type: MIME[extname(target)] ?? 'application/octet-stream',
    body: await readFile(target),
  }
}

/** Whether a filesystem failure is the path being absent or non-file, not a real error. */
function isMissingPath(error: unknown): boolean {
  return STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // Insert after all index transforms so the base precedes every resource reference.
  const renderIndex = async (): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      distIndex,
      req.headers,
      () => ctx.connection.authorizeIndex(req, res),
      renderIndex,
    )
  }), 'frontend-static: fallback seat')
}

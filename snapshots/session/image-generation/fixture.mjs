/** Deterministic external image API reply; generation, tools, and storage remain real. */

const ENDPOINT = 'https://images.snapshot.test/v1/images/generations'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

/** Cordis fixture identity. */
export const name = 'image-generation-fixture'

/** Scope the external fetch replacement to this plugin fiber. */
export function apply(ctx) {
  ctx.effect(() => {
    const originalFetch = globalThis.fetch
    const fixtureFetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.url !== ENDPOINT) return originalFetch(input, init)
      request.signal.throwIfAborted()
      if (request.method !== 'POST') throw new Error('image-generation-fixture: expected POST')
      if (request.headers.get('Authorization') !== 'Bearer snapshot-key') {
        throw new Error('image-generation-fixture: expected configured credential')
      }
      if (request.headers.get('Content-Type') !== 'application/json') {
        throw new Error('image-generation-fixture: expected JSON content type')
      }
      const body = await request.json()
      if (body.model !== 'draw' || body.prompt !== 'A red pixel') {
        throw new Error('image-generation-fixture: unexpected model or prompt')
      }
      request.signal.throwIfAborted()
      return new Response(JSON.stringify({ data: [{
        b64_json: PNG, media_type: 'image/png', revised_prompt: 'A red pixel',
      }] }), { headers: { 'Content-Type': 'application/json' } })
    }
    globalThis.fetch = fixtureFetch
    return () => {
      if (globalThis.fetch !== fixtureFetch) {
        throw new Error('image-generation-fixture: global fetch owner changed before cleanup')
      }
      globalThis.fetch = originalFetch
    }
  }, 'image-generation external fetch fixture')
}

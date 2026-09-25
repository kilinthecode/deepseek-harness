/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page; plugin composition and the renderer handoff are
 * `bootClient` and `mountClient`. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  BootManifest, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { bootClient } from './boot-client.ts'
import { BootPage } from './boot-page.ts'
import { mountClient } from './mount.ts'
import { getStaticModules } from './seed.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/**
 * Marker a pre-boot bootstrap sets while it renders its own screen ahead of
 * the boot gate; the structural read needs no package edge to that bootstrap.
 */
interface PreBootStageGlobal {
  __DSH_PREBOOT_OWNED__?: boolean
}

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  /** Kernel-owned page; a pre-boot stage defers it to the boot gate. */
  private page: BootPage | undefined
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest

  /**
   * Bind the mount point; {@link run} draws the boot page once the pre-boot
   * stage releases the document, then starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    // A pre-boot stage (the preview source chooser) owns the screen until the
    // boot gate settles; every other carrier wants the brand up before its
    // injections land so no empty frame precedes the boot page.
    if ((globalThis as PreBootStageGlobal).__DSH_PREBOOT_OWNED__ !== true) this.page = new BootPage(container)
  }

  /**
   * Load and activate every client entry, then hand the mount point to the
   * UI renderer. Plugin failures remain visible on the boot page.
   * @param onFailure - Optional carrier-owned fatal presentation; keeps the boot page visible.
   * @returns Resolves after application mount or failure reporting.
   */
  async run(onFailure?: (reason: unknown) => void): Promise<void> {
    try {
      // Boot-readiness gate: whichever bootstrap applies the injection table
      // settles this deferred once every row has taken effect — the served
      // index resolves it in the rendered tail, so the await returns on the
      // next microtask; an asynchronous bootstrap resolves it after its last
      // row, or rejects it into the failure rendering below. An absent global
      // means no bootstrap owns the document and there is nothing to wait for.
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__?.promise
      // The pre-boot stage releases the page here; draw the brand moment only
      // over an actual boot.
      const page = this.page ??= new BootPage(this.container)
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      page.setTotal(this.manifest.plugins.length)
      await prefetching
      await bootClient({
        ctx,
        modules: this.modules,
        manifest: this.manifest,
        onEntryState: (name, state) => {
          if (onFailure === undefined || state !== 'failed') page.setState(name, state)
        },
      })
      await mountClient(ctx, this.container)
      // The application now renders beneath the boot page overlay; start its
      // leave sequence so the brand moment plays out and fades to the app.
      page.dispose()
    } catch (reason) {
      console.error(reason)
      // A gate rejection arrives before the page draws; the failure report
      // still needs the kernel-owned surface to render on.
      const page = this.page ??= new BootPage(this.container)
      if (onFailure !== undefined) onFailure(reason)
      else page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page?.dispose()
  }

  /** Prefetch stage-one bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }
}

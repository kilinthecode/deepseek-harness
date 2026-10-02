/**
 * The command-line dispatch shared by the launcher's bin entries: parse the
 * launcher flags, then run the selected command mode. Both `dsh` and `portal`
 * enter here, differing only in the launcher name they report and the profile
 * that name implies.
 * @module @deepseek-ai/dsh/cli
 */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs, type LauncherName } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'

/**
 * Run the public dsh command-line interface under one launcher entry name.
 * @param launcherName - the bin name this process was started as; `portal` boots the Portal terminal agent profile.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(launcherName: LauncherName = 'dsh'): Promise<void> {
  const version = getDshRuntimeVersion()
  const invocation = parseDshArgs(process.argv.slice(2), version, launcherName)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      const { modelProfilePatches } = await import('./model-profile.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          patches: invocation.modelsFrom === undefined ? [] : modelProfilePatches(invocation.modelsFrom),
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

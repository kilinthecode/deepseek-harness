/**
 * Two `dsh` processes, one Harness home, one repository.
 *
 * REAL composition (`packages/AGENTS.md`): both sessions boot the shipped
 * launcher with a profile that mounts the peer-sessions bundle, a keyless
 * deterministic adapter, and no Team bundle, so presence, the mailbox drain,
 * the delivery frame, and the log rows under test are all production code.
 *
 * The fixture repository is written by hand because the identity under test is
 * read from disk alone: a main checkout with a `.git` directory plus a linked
 * worktree whose `.git` is a gitfile naming `<main>/.git/worktrees/wt` and whose
 * `commondir` resolves back to `<main>/.git`. Both sessions therefore share one
 * repository key while living in different directories, which is what lets the
 * sender see the receiver as a peer.
 *
 * Long-lived SDK processes follow `apps/cli/tests/profiles/sdk/office-cli.e2e.ts`.
 * The restart follows `dsh --profile headless --session-id <id>`, the shipped
 * resume path, so the queued envelope is delivered by the receiver's own
 * `agent/created` drain.
 */

import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import {
  enqueueMail,
  PEER_MAIL_VERSION,
  peerRepoKey,
  type PeerMailEnvelope,
  type PeerMessageId,
} from '../src/index.ts'
import { mailShardDirectory } from '../src/paths.ts'

/** Loose shape of one persisted or streamed session record. */
interface JsonObject {
  [key: string]: unknown
}

/** One line of the SDK server's stdio protocol. */
interface JsonRpcRecord {
  readonly id?: number
  readonly error?: unknown
  readonly params?: { readonly event?: { readonly type?: string }; readonly sessionId?: string }
}

/** Deadline for one spawned `dsh` process. */
const PROCESS_TIMEOUT_MS = 120_000
/** Deadline for the whole scenario, which owns three processes in sequence. */
const TEST_TIMEOUT_MS = 5 * LOADER_SMOKE_TEST_TIMEOUT_MS
/** How long a log- or file-shaped expectation may take to become true. */
const OBSERVE_TIMEOUT_MS = 30_000

/** Session id of the sending process, and the sender of every envelope here. */
const SESSION_A = 'peer-session-a'
/** Session id of the receiving process; the mailbox under test belongs to it. */
const SESSION_B = 'peer-session-b'
/** Task text that identifies the sender's session to the fixture adapter. */
const START_A = 'PEER_E2E_SENDER_START'
/** Task text that identifies the receiver's session to the fixture adapter. */
const START_B = 'PEER_E2E_TARGET_START'
/** Body the sender relays over `send_peer_message`. */
const SEND_BODY = 'PEER_E2E_RELAY_BODY'
/** Prompt of the receiver's continuable subagent, which must never receive mail. */
const CHILD_PROMPT = 'PEER_E2E_CHILD_PROMPT'
/** Envelope id planted by this test while the receiver is down. */
const RESUME_MAIL_ID = 'peer-e2e-resume-1'
/** Envelope id planted for the receiver's subagent, which the drain must delete. */
const SUBAGENT_MAIL_ID = 'peer-e2e-subagent-1'
/** Task text of the resume that adopts the receiver's persisted Session. */
const RESUME_TASK = 'PEER_E2E_RESUME_TASK'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const binScript = join(repoRoot, 'apps/cli/src/bin.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const fixtureAdapter = new URL('./fixtures/peer-session-llm.mjs', import.meta.url).href

/** One spawned `dsh` process with its JSON-RPC transcript. */
interface DshProcess {
  /** Every protocol line the process wrote, in arrival order. */
  readonly records: JsonRpcRecord[]
  /** Settles once the process exited, with what it printed. */
  readonly exit: Promise<ProcessExit>
  /** Whether the process is still running. */
  readonly running: boolean
  /**
   * Send one request.
   * @param method - JSON-RPC method name.
   * @param params - request parameters.
   * @returns the id its response will carry.
   */
  send(method: string, params?: object): number
  /**
   * Count one session's committed turns.
   * @param sessionId - the session whose `turn/end` notifications to count.
   * @returns how many turns ended.
   */
  turnEnds(sessionId: string): number
  /** Kill the process, used only by failure cleanup. */
  kill(): void
}

/** What one `dsh` process printed and exited with. */
interface ProcessExit {
  readonly exitCode: number | undefined
  readonly signal: NodeJS.Signals | undefined
  readonly stdout: string
  readonly stderr: string
}

/** One persisted session log, split into its header and its event records. */
interface SessionLog {
  readonly path: string
  readonly header: JsonObject
  readonly events: JsonObject[]
}

/** Inputs to {@link startDsh}. */
interface StartDshOptions {
  /** Harness home every process in this scenario shares. */
  readonly home: string
  /** Profile directory name carrying both the composition and its patch. */
  readonly profile: string
  /** Process working directory; a session's own cwd comes from the launch args. */
  readonly cwd: string
  /** Arguments after `--profile <name>`; the resume adds `--session-id` and its task. */
  readonly args?: readonly string[]
}

/** Mailbox limits of the shipped profile, which this test does not override. */
const MAILBOX_LIMITS = { maxPendingPerTarget: 8, maxPendingPerSenderPerTarget: 4 }

/**
 * Write one profile directory: the bundle list plus the user patch layer that
 * keeps the model deterministic and the persisted log plain text.
 * @param home - Harness home the profile lives under.
 * @param profile - profile directory name.
 * @param role - which fixture adapter role the process runs.
 * @param bundles - ordered bundle layers, including the peer-sessions bundle.
 * @returns the profile directory path.
 */
async function writeProfile(home: string, profile: string, role: 'a' | 'b', bundles: readonly string[]): Promise<string> {
  const directory = join(home, 'profiles', profile)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { '@deepseek-ai/dsh-experimental-peer-sessions-profile': 'workspace:*' },
    dsh: { profile: { bundles: [...bundles] } },
  }, undefined, 2)}\n`)
  await writeFile(join(directory, 'cordis.patch.yml'), [
    '# The fixture adapter owns every model call: no account provider, no title',
    '# generation, no inventory suggestion. The log stays uncompressed text.',
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: plugin-package-inventory-deepseek',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: '${join(home, 'sessions')}'`,
    '    compression: none',
    '- insert:',
    '    - id: peer-session-fixture-llm',
    `      name: '${fixtureAdapter}'`,
    '      config:',
    `        role: ${role}`,
    `        start: '${START_B}'`,
    `        target: '${SESSION_B}'`,
    `        body: '${SEND_BODY}'`,
    `        childPrompt: '${CHILD_PROMPT}'`,
    '',
  ].join('\n'))
  return directory
}

/**
 * Spawn one `dsh` process and start recording its protocol lines.
 * @param options - home, profile, cwd, and the arguments after the profile flag.
 * @returns the process handle.
 */
function startDsh(options: StartDshOptions): DshProcess {
  const launch = resolveExampleLaunch({
    srcBin: binScript,
    configArgs: ['--profile', options.profile, ...options.args ?? []],
    tsconfigPath,
    env: {
      DSH_HOME: options.home,
      DSH_AGENTS_HOME: join(options.home, 'agents'),
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
    },
  })
  const child = execa(launch.command, launch.args, {
    cwd: options.cwd,
    env: launch.env,
    timeout: PROCESS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    reject: false,
  })
  const records: JsonRpcRecord[] = []
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    // A live process can leave only its last line unparsable, and the
    // assertions below read parsed records rather than raw protocol text.
    if (!line.startsWith('{')) return
    records.push(JSON.parse(line) as JsonRpcRecord)
  })
  let running = true
  const exit = child.then((result): ProcessExit => {
    running = false
    return {
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }, (error: unknown) => {
    running = false
    throw error
  })
  let nextId = 1
  return {
    exit,
    records,
    get running() {
      return running
    },
    send(method, params) {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return id
    },
    turnEnds(sessionId) {
      return records.filter(record => record.params?.sessionId === sessionId
        && record.params.event?.type === 'turn/end').length
    },
    kill() {
      child.kill('SIGKILL')
    },
  }
}

/**
 * Await one request's response and fail on a JSON-RPC error.
 * @param process - the process that must answer.
 * @param id - the request id returned by {@link DshProcess.send}.
 * @param label - diagnostic prefix.
 * @returns fulfillment once the response arrived without an error.
 */
async function awaitResponse(process: DshProcess, id: number, label: string): Promise<void> {
  await vi.waitFor(() => {
    expect(process.records.some(record => record.id === id), `${label}: response`).toBe(true)
  }, { timeout: OBSERVE_TIMEOUT_MS, interval: 50 })
  expect(process.records.find(record => record.id === id)?.error, `${label}: JSON-RPC error`).toBeUndefined()
}

/**
 * Await one session's committed turns.
 * @param process - the process holding the session.
 * @param sessionId - the session whose turns must end.
 * @param count - how many `turn/end` notifications to wait for.
 * @param label - diagnostic prefix.
 * @returns fulfillment once that many turns ended.
 */
async function awaitTurns(process: DshProcess, sessionId: string, count: number, label: string): Promise<void> {
  await vi.waitFor(() => {
    expect(process.turnEnds(sessionId), `${label}: turns of ${sessionId}`).toBeGreaterThanOrEqual(count)
  }, { timeout: OBSERVE_TIMEOUT_MS, interval: 50 })
}

/**
 * Stop one process through its own protocol and await a clean exit.
 * @param process - the process to stop.
 * @returns the settled execa result.
 */
async function stop(process: DshProcess): Promise<ProcessExit> {
  process.send('shutdown')
  const result = await process.exit
  expect(result.exitCode, `clean exit\n${result.stdout}\n${result.stderr}`).toBe(0)
  return result
}

/**
 * Parse one persisted session log.
 * @param path - absolute path of the `.jsonl` log.
 * @returns the header and every event record that was complete on disk.
 */
async function readLog(path: string): Promise<SessionLog> {
  const lines = (await readFile(path, 'utf8')).split('\n').filter(line => line.length > 0)
  const parsed = lines.flatMap((line, index) => {
    try {
      return [JSON.parse(line) as JsonObject]
    } catch (error: unknown) {
      // Only a still-writing process can leave an incomplete final line.
      if (index === lines.length - 1) return []
      throw error
    }
  })
  const [header] = parsed
  if (header === undefined) throw new Error(`${path}: persisted log has no header`)
  return { path, header, events: parsed.slice(1) }
}

/**
 * Read every persisted session log under one Harness home.
 * @param home - the shared Harness home.
 * @returns one entry per log file.
 */
async function readLogs(home: string): Promise<SessionLog[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  try {
    await visit(join(home, 'sessions'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return await Promise.all(files.sort().map(async path => await readLog(path)))
}

/**
 * Read the persisted log that carries one session id in its header.
 * @param home - the shared Harness home.
 * @param sessionId - the session to find.
 * @returns the log, or `undefined` while it does not exist.
 */
async function findLog(home: string, sessionId: string): Promise<SessionLog | undefined> {
  return (await readLogs(home)).find(log => log.header.id === sessionId)
}

/**
 * List every framed peer-message delivery in one log.
 * @param log - the parsed session log.
 * @returns the delivery sources, in log order.
 */
function peerDeliveries(log: SessionLog): JsonObject[] {
  return log.events
    .filter(event => event.type === 'user/message')
    .map(event => (event.data as JsonObject).source as JsonObject)
    .filter(source => source.kind === 'peer-message')
}

/**
 * Read the rendered text of one tool result.
 * @param log - the parsed session log.
 * @param callId - id of the call that produced the result.
 * @returns the joined text blocks, or `undefined` before the result landed.
 */
function toolResultText(log: SessionLog, callId: string): string | undefined {
  const match = log.events.filter(event => event.type === 'tool/result').find((event) => {
    const message = (event.data as JsonObject).message as JsonObject | undefined
    return (message?.source as JsonObject | undefined)?.callId === callId
  })
  if (match === undefined) return undefined
  const message = (match.data as JsonObject).message as JsonObject
  return (message.content as JsonObject[])
    .filter(block => block.type === 'text')
    .map(block => block.text as string)
    .join('')
}

/**
 * Find the call id of the first tool call with a given name.
 * @param log - the parsed session log.
 * @param name - tool name.
 * @returns the call id, or `undefined` when the tool was never called.
 */
function toolCallId(log: SessionLog, name: string): string | undefined {
  const call = log.events.find(event => event.type === 'tool/call' && (event.data as JsonObject).name === name)
  return call === undefined ? undefined : (call.data as JsonObject).callId as string
}

/**
 * List the envelope files pending in one target's mailbox shard.
 * @param home - the shared Harness home.
 * @param target - the session whose shard to read.
 * @returns the file names, sorted.
 */
async function mailFiles(home: string, target: string): Promise<string[]> {
  try {
    return (await readdir(mailShardDirectory(home, target))).filter(name => name.endsWith('.json')).sort()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Build one durable envelope the way a foreign process sharing the home would.
 * @param messageId - the envelope id, which also names its file.
 * @param targetId - the session whose mailbox receives it.
 * @param repoKey - repository key the target's drain compares against.
 * @param text - the sender's own words.
 * @returns the complete envelope.
 */
function envelope(messageId: string, targetId: string, repoKey: string, text: string): PeerMailEnvelope {
  return {
    version: PEER_MAIL_VERSION,
    messageId: brandString<PeerMessageId>(messageId),
    targetId: brandString<SessionId>(targetId),
    senderSessionId: brandString<SessionId>(SESSION_A),
    senderName: SESSION_A,
    fromRepo: repoKey,
    relayDepth: 1,
    kind: 'peer-message',
    text,
  }
}

describe('peer sessions across two dsh processes', () => {
  it('lists, steers, queues, and drops per target session', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-peer-e2e-')))
    const home = join(root, 'home')
    const main = join(root, 'repo')
    const worktree = join(root, 'repo-wt')
    const processes: DshProcess[] = []
    try {
      await mkdir(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
      await writeFile(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
      await writeFile(join(main, 'README.md'), 'peer e2e fixture checkout\n')
      await mkdir(worktree, { recursive: true })
      await writeFile(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
      const repoKey = await peerRepoKey(await realpathNormalize(worktree))
      expect(await peerRepoKey(await realpathNormalize(main)), 'fixture worktrees share one repository').toBe(repoKey)

      const sdkBundles = [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-sdk-app',
        '@deepseek-ai/dsh-experimental-peer-sessions-profile',
      ]
      await writeProfile(home, 'peer-e2e-a', 'a', sdkBundles)
      await writeProfile(home, 'peer-e2e-b', 'b', sdkBundles)
      await writeProfile(home, 'peer-e2e-resume', 'b', [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-headless',
        '@deepseek-ai/dsh-experimental-peer-sessions-profile',
      ])

      // The receiver starts first and stays idle, so its presence row is
      // published before the sender ever looks for a peer.
      const target = startDsh({ home, profile: 'peer-e2e-b', cwd: root })
      processes.push(target)
      await awaitResponse(target, target.send('initialize', {
        cwd: worktree, provider: 'deepseek-official', model: 'deepseek-flash',
      }), 'receiver initialize')
      target.send('session/prompt', {
        sessionId: SESSION_B,
        contentBlocks: [{ type: 'text', text: START_B }],
      })
      await awaitTurns(target, SESSION_B, 1, 'receiver start turn')

      const sender = startDsh({ home, profile: 'peer-e2e-a', cwd: root })
      processes.push(sender)
      await awaitResponse(sender, sender.send('initialize', {
        cwd: main, provider: 'deepseek-official', model: 'deepseek-flash',
      }), 'sender initialize')
      sender.send('session/prompt', {
        sessionId: SESSION_A,
        contentBlocks: [{ type: 'text', text: START_A }],
      })
      await awaitTurns(sender, SESSION_A, 1, 'sender turn')

      const sendResult = await vi.waitFor(async () => {
        const log = await findLog(home, SESSION_A)
        expect(log, 'sender log exists').toBeDefined()
        const listCall = toolCallId(log as SessionLog, 'list_peers')
        expect(listCall, 'sender listed peers').toBeDefined()
        expect(toolResultText(log as SessionLog, listCall as string), 'the receiver is listed')
          .toContain(`"id":"${SESSION_B}"`)
        const sendCall = toolCallId(log as SessionLog, 'send_peer_message')
        expect(sendCall, 'sender relayed one message').toBeDefined()
        return JSON.parse(toolResultText(log as SessionLog, sendCall as string) as string) as {
          messageId: string
          status: string
        }
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })
      // The sender holds no live target, so the shared mailbox is the carrier
      // and only the receiver's own poll can deliver it.
      expect(sendResult.status, 'a remote target is queued, never delivered').toBe('queued')

      const firstDelivery = await vi.waitFor(async () => {
        const log = await findLog(home, SESSION_B)
        expect(log, 'receiver log exists').toBeDefined()
        const deliveries = peerDeliveries(log as SessionLog)
        expect(deliveries, 'the receiver poll steered the envelope').toHaveLength(1)
        return deliveries[0] as JsonObject
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })
      expect(firstDelivery.messageId, 'the steered row carries the envelope id').toBe(sendResult.messageId)
      expect(firstDelivery.kind).toBe('peer-message')
      expect(firstDelivery.form).toBe('relay')
      expect(firstDelivery.senderSessionId).toBe(SESSION_A)
      expect(firstDelivery.relayDepth).toBe(1)
      const framed = await vi.waitFor(async () => {
        const log = await findLog(home, SESSION_B)
        const message = (log as SessionLog).events
          .filter(event => event.type === 'user/message')
          .find(event => ((event.data as JsonObject).source as JsonObject).messageId === sendResult.messageId)
        expect(message, 'the framed row is committed').toBeDefined()
        return (message as JsonObject).data as JsonObject
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })
      expect(JSON.stringify(framed.content), 'the body is framed, not raw').toContain(`Peer message ${sendResult.messageId} from`)
      expect(JSON.stringify(framed.content)).toContain(SEND_BODY)
      await vi.waitFor(async () => {
        expect(await mailFiles(home, SESSION_B), 'a delivered envelope is deleted').toEqual([])
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })

      // The receiver owns a continuable subagent, so its process holds a second
      // session: an envelope aimed there is dropped instead of steered.
      const childId = await vi.waitFor(async () => {
        const log = await findLog(home, SESSION_B)
        const started = (log as SessionLog).events
          .filter(event => event.type === 'tool/result')
          .flatMap(event => ((event.data as JsonObject).message as JsonObject).content as JsonObject[])
          .filter(block => block.type === 'text')
          .map(block => block.text as string)
          .find(text => text.startsWith('started subagent '))
        expect(started, 'the subagent tool answered').toBeDefined()
        return /started subagent (\S+)/u.exec(started as string)?.[1] as string
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })
      await vi.waitFor(async () => {
        expect(await findLog(home, childId), 'the subagent log exists').toBeDefined()
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })
      await enqueueMail(home, envelope(SUBAGENT_MAIL_ID, childId, repoKey, 'PEER_E2E_SUBAGENT_BODY'), MAILBOX_LIMITS, childId)
      // Deletion needs a live target in a draining process (tests/authorize.spec.ts), so observe instead of waiting for the file to go.
      // The profile polls every 1 s, so two passes plus margin bound the observation.
      await new Promise(resolve => setTimeout(resolve, 2 * 1_000 + 500))
      const childLog = (await findLog(home, childId)) as SessionLog
      expect(peerDeliveries(childLog), 'a subagent is never steered').toEqual([])
      const consumed = childLog.events
        .filter(event => event.type === 'user/message')
        .find(event => JSON.stringify((event.data as JsonObject).source ?? {}).includes(SUBAGENT_MAIL_ID))
      expect(consumed, 'the waiting envelope is never consumed into a child message').toBeUndefined()

      // Mail committed while the receiver is down waits for its next start.
      await stop(target)
      await enqueueMail(home, envelope(RESUME_MAIL_ID, SESSION_B, repoKey, 'PEER_E2E_RESUME_BODY'), MAILBOX_LIMITS, SESSION_B)

      const resume = startDsh({
        home,
        profile: 'peer-e2e-resume',
        cwd: worktree,
        args: ['--session-id', SESSION_B, RESUME_TASK],
      })
      processes.push(resume)
      const resumed = await resume.exit
      expect(resumed.exitCode, `resume exit\n${resumed.stdout}\n${resumed.stderr}`).toBe(0)
      expect(resumed.stdout, 'the resumed turn answered').toContain('B_DONE')

      const finalDeliveries = await vi.waitFor(async () => {
        const log = await findLog(home, SESSION_B)
        const deliveries = peerDeliveries(log as SessionLog)
        expect(deliveries, 'one framed row per queued envelope').toHaveLength(2)
        return deliveries
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })
      expect(finalDeliveries.map(delivery => delivery.messageId as string).sort())
        .toEqual([sendResult.messageId, RESUME_MAIL_ID].sort())
      for (const delivery of finalDeliveries) {
        expect(delivery.kind).toBe('peer-message')
        expect(delivery.form).toBe('relay')
        expect(delivery.senderSessionId).toBe(SESSION_A)
      }
      await vi.waitFor(async () => {
        expect(await mailFiles(home, SESSION_B), 'the queued envelope was deleted after delivery').toEqual([])
      }, { timeout: OBSERVE_TIMEOUT_MS, interval: 100 })

      await stop(sender)
    } finally {
      for (const process of processes) {
        if (process.running) process.kill()
        await process.exit.catch(() => undefined)
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, TEST_TIMEOUT_MS)
})

/** Root/subcall Tool composition with one keyed atomic dispatch path. */
import { memo, useCallback, useMemo, type ReactNode } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  RenderResultImages, ToolCallHookContext, ToolCallOwnerProps, ToolCallPhaseProps, ToolTreeProps,
} from '../contract/slots.ts'
import { toolRowModel } from './models/tool-call-model.ts'
import { GenericToolCard } from './toolviews/GenericToolCard.tsx'
import css from './ToolCallTree.module.css'

function toolCallPhase(block: ToolCallBlock): ToolCallPhaseProps {
  if ('kind' in block) return { phase: 'result', block }
  return block.phase === 'preparing' ? { phase: 'preparing', block } : { phase: 'start', block }
}

/** Resolve a Tool call's wire name from its current stage. */
function callName(call: ToolCallPhaseProps): string {
  return call.phase === 'result' ? call.block.call?.name ?? '' : call.block.name
}

/** One atomic call dispatched through the Tool-owned keyed slot. */
const ToolCall = memo(function ToolCall({
  renderSlot, callId, toolName, call, assistant, openFile, cwd, home, inspectCall, loadImage, useDisclosure,
  renderResultImages, t, children,
}: Pick<ToolTreeProps, 'renderSlot' | 'openFile' | 'cwd' | 'inspectCall' | 'loadImage' | 'useDisclosure' | 't'> & {
  callId: string
  toolName: string
  call: ToolCallPhaseProps
  assistant: ToolCallHookContext['assistant']
  home?: string | undefined
  renderResultImages: RenderResultImages
  children?: ReactNode
}) {
  const preparing = call.phase === 'preparing'
  const hookContext = useMemo<ToolCallHookContext>(() => ({
    callId, assistant: preparing ? assistant : undefined,
  }), [assistant, callId, preparing])
  const owner: ToolCallOwnerProps = useMemo(() => ({
    callId,
    toolName,
    ...call,
    openFile,
    cwd,
    home,
    loadImage,
    useDisclosure,
    inspect: inspectCall === undefined ? undefined : () => { inspectCall(callId) },
  }), [callId, toolName, call, openFile, cwd, home, loadImage, inspectCall, useDisclosure])
  const autoReviewDenied = useMemo(
    () => call.phase === 'result' && toolRowModel(toolName, call.block).autoReviewDenial !== null,
    [toolName, call],
  )
  return (
    <div
      className={css.callRow}
      data-chat-anchor-key={`call:${callId}`}
      data-chat-call-id={callId}
    >
      {autoReviewDenied
        ? <GenericToolCard {...owner} t={t} renderResultImages={renderResultImages} />
        : renderSlot('tool.call.toolview', owner, {
          entryKey: toolName,
          hookContext,
          fallback: <GenericToolCard {...owner} t={t} renderResultImages={renderResultImages} />,
        })}
      {children}
    </div>
  )
})

const ToolCallBranch = memo(function ToolCallBranch({
  renderSlot, block, assistant, cwd, home, openFile, inspectCall, loadImage, useDisclosure, renderResultImages, t,
}: Pick<ToolTreeProps, 'renderSlot' | 'cwd' | 'openFile' | 'inspectCall' | 'loadImage' | 'useDisclosure' | 't'> & {
  block: ToolCallBlock
  assistant: ToolCallHookContext['assistant']
  home?: string | undefined
  renderResultImages: RenderResultImages
}) {
  const call = useMemo(() => toolCallPhase(block), [block])
  return (
    <ToolCall
      renderSlot={renderSlot}
      callId={call.block.callId}
      toolName={callName(call)}
      call={call}
      assistant={assistant}
      openFile={openFile}
      cwd={cwd}
      home={home}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
      renderResultImages={renderResultImages}
      t={t}
    >
      {call.phase !== 'preparing' && call.block.subCalls.length > 0 ? (
        <div className={css.subCalls} data-subcalls>
          {call.block.subCalls.map(child => (
            <ToolCallBranch
              key={child.callId}
              renderSlot={renderSlot}
              block={child}
              assistant={assistant}
              cwd={cwd}
              home={home}
              openFile={openFile}
              inspectCall={inspectCall}
              useDisclosure={useDisclosure}
              loadImage={loadImage}
              renderResultImages={renderResultImages}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </ToolCall>
  )
})

/**
 * Render one root Tool call and its recursive children through the same
 * atomic keyed dispatch.
 * @param props - whole-Tool owner data and the Tool-owned child-slot share.
 * @returns the Tool call tree.
 */
export function ToolCallTree({
  renderSlot, node, cwd, openFile, inspectCall, loadImage, useDisclosure, useHostInfo, t,
}: ToolTreeProps) {
  const home = useHostInfo(info => info.home)
  const assistant = node.location.kind === 'step' ? node.location.step.data.source('assistant-step') : undefined
  // Generic-row gallery dispatch: closes over this tree's loader so the
  // GenericToolCard fallback (and its recursive sub-calls) supply only the
  // claimed images, placement, and the text shown for an unfilled slot.
  const renderResultImages = useCallback<RenderResultImages>(
    (owner, fallback) => renderSlot('tool.call.resultImages', { ...owner, loadImage }, { fallback }),
    [loadImage, renderSlot],
  )
  return (
    <ToolCallBranch
      renderSlot={renderSlot}
      block={node.data.root}
      assistant={assistant}
      cwd={cwd}
      home={home}
      openFile={openFile}
      inspectCall={inspectCall}
      useDisclosure={useDisclosure}
      loadImage={loadImage}
      renderResultImages={renderResultImages}
      t={t}
    />
  )
}

/** V4 framing with native tool-role admission and released physical rows. */

import { SessionFormatError, isSessionFormatJsonObject, snapshotSessionFormatJson } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader, SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import { assertV4SourceRowAdmission } from './message-sources.ts'
import { assertV4RetiredSyntax } from './retired-syntax.ts'
import { assertV4SystemMessageFields } from './system-message.ts'
import { assertV4DeveloperData } from './developer.ts'
import { assertV4ForkResult } from './fork-result.ts'
import { assertV4ToolResultMessage } from './tool-role.ts'
import { assertReleasedV4Header } from './validation.ts'

function decodeHeader(value: unknown): SessionFormatHeader {
  const snapshot = snapshotSessionFormatJson(value, 'format v4 physical header')
  if (!isSessionFormatJsonObject(snapshot) || snapshot['type'] !== 'session' || snapshot['version'] !== 4) throw new SessionFormatError('expected format v4 physical header')
  const { type: _type, ...header } = snapshot
  assertReleasedV4Header(header)
  const logical = header as SessionFormatHeader
  const framed = releasedV2SessionFormatCodec.decodeHeader({ type: 'session', ...framingHeader(logical) })
  return { ...framed, version: 4,
    ...(logical.cwd?.startsWith('dsh-') === true ? { cwd: logical.cwd } : {}) }
}

/** Legacy row framing does not interpret V4 execution-directory metadata. */
function framingHeader(header: SessionFormatHeader): SessionFormatHeader {
  if (header.cwd?.startsWith('dsh-') !== true) return { ...header, version: 2 }
  const { cwd: _cwd, ...metadata } = header
  return { ...metadata, version: 2 }
}

/**
 * V4 physical encoder and decoder retain the released row framing while
 * validating the native tool-role message directly.
 */
export const releasedV4SessionFormatCodec = Object.freeze({
  version: 4,
  decodeHeader,
  createDecoder(value, recovery) {
    const header = decodeHeader(value)
    const decoder = releasedV2SessionFormatCodec.createDecoder({ type: 'session', ...framingHeader(header) }, recovery)
    return {
      ...decoder,
      header,
      decodeRow(row, context) {
        assertV4RowAdmission(row)
        decoder.decodeRow(row, {
          emitRun: context.emitRun.bind(context),
          emitEvent: context.emitEvent.bind(context),
        })
      },
    }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV4Header(header)
    return { ...releasedV2SessionFormatCodec.encodeHeader(framingHeader(header), inheritedEventCount), version: 4,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }) }
  },
  encodeEvent(event: SessionFormatEvent) {
    if (event.type === 'developer/message' && event['ignorable'] === true) {
      assertV4DeveloperData(event)
      assertV4RetiredSyntax(event)
    }
    assertV4RowAdmission(event)
    return releasedV2SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Apply native V4 admission before a scanner discards a recoverable suffix.
 * Ignorable developer payloads require reader vocabulary; physical decoding defers them.
 * @param row - parsed physical row before framing and source-event range decoding.
 * @param knownEventTypes - installed event types, supplied by native readers before tail recovery.
 */
export function assertV4RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  if (isSessionFormatJsonObject(row)) {
    if (row['type'] === 'developer/message' && row['ignorable'] === true
      && knownEventTypes?.has('developer/message') !== true) return
    assertV4DeveloperData(row as unknown as SessionFormatEvent)
  }
  assertV4SourceRowAdmission(row)
  assertV4RetiredSyntax(row)
  assertV4SystemMessageFields(row)
  if (!isSessionFormatJsonObject(row) || row['type'] !== 'tool/result') return
  const event = row as unknown as SessionFormatEvent
  assertV4ToolResultMessage(event)
  assertV4ForkResult(event)
}

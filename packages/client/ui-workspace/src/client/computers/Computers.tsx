/** Computer headers and user-owned SSH connection/directory interactions. */
import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Modal,
  Tooltip,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconEllipsisOutlineRegular,
  IconGlobeOutlineRegular,
  IconPlusOutlineRegular,
  IconFolderCloseRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComputerState, RemoteComputer } from '@deepseek-ai/dsh-client-remote-work/client'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './Computers.module.css'

type ComputerProps = Pick<WorkspaceBrowserProps, 't'>
/** One captured computer action; no password is retained in viewing state. */
export type ComputerAction =
  | { readonly kind: 'connect'; readonly computer?: RemoteComputer }
  | { readonly kind: 'folder'; readonly computer: RemoteComputer }

/** Tree header; expansion is independent of folder and Session expansion. */
export function ComputerHeader({
  computer,
  computerId,
  expanded,
  onToggle,
  onAdd,
  onManage,
  t,
}: ComputerProps & {
  computer?: ComputerState | undefined
  computerId?: string | undefined
  expanded: boolean
  onToggle: () => void
  onAdd?: (() => void) | undefined
  onManage?: (() => void) | undefined
}) {
  const title =
    computer?.computer.name ?? (computerId === undefined ? t('computer.local') : t('computer.remoteUnknown'))
  const status =
    computer === undefined
      ? t(computerId === undefined ? 'computer.status.local' : 'computer.status.unavailable')
      : t(`computer.status.${computer.status}`)
  return (
    <>
      <div className={css.header} data-row-key={`computer:${computer?.computer.id ?? computerId ?? 'local'}`}>
        <button type="button" className={css.disclosure} aria-expanded={expanded} onClick={onToggle}>
          {expanded ? <IconChevronDownOutlineRegular /> : <IconChevronRightOutlineRegular />}
          <IconGlobeOutlineRegular />
          <span className={css.title}>{title}</span>
        </button>
        <Tooltip label={computer?.error ?? status} portal>
          <span
            className={css.status}
            data-status={computer?.status ?? (computerId === undefined ? 'connected' : 'disconnected')}
            aria-label={status}
            role="img"
          />
        </Tooltip>
        {onAdd !== undefined && (
          <Tooltip label={t('computer.addFolder')} portal>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('computer.addFolderTo', { name: title })}
              onClick={onAdd}
            >
              <IconPlusOutlineRegular />
            </button>
          </Tooltip>
        )}
        {onManage !== undefined && (
          <Tooltip label={t('computer.manage')} portal>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('computer.manageNamed', { name: title })}
              onClick={onManage}
            >
              <IconEllipsisOutlineRegular />
            </button>
          </Tooltip>
        )}
      </div>
      {computer !== undefined && (
        <div className={css.connectionNotice} role="status">
          {status}
        </div>
      )}
    </>
  )
}

type DialogProps = Pick<
  WorkspaceBrowserProps,
  't' | 'connectComputer' | 'disconnectComputer' | 'browseComputer' | 'addRemoteFolder'
> & {
  action: ComputerAction
  onClose: () => void
}

/** Connection flow owns its secret draft until it is dismissed. */
export function ComputerDialog(props: DialogProps) {
  return props.action.kind === 'folder' ? (
    <RemoteFolderDialog {...props} computer={props.action.computer} />
  ) : (
    <ConnectionDialog {...props} />
  )
}

function ConnectionDialog({ action, onClose, connectComputer, disconnectComputer, t }: DialogProps) {
  const existing = action.computer
  const [name, setName] = useState(existing?.name ?? '')
  const [host, setHost] = useState(existing?.host ?? '')
  const [username, setUsername] = useState(existing?.username ?? '')
  const [port, setPort] = useState(String(existing?.port ?? 22))
  const [identityFile, setIdentityFile] = useState(existing?.identityFile ?? '')
  const [password, setPassword] = useState('')
  const [fingerprint, setFingerprint] = useState<string | undefined>(existing?.fingerprint)
  const [needsTrust, setNeedsTrust] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const operation = useRef<AbortController>()
  useEffect(
    () => () => {
      operation.current?.abort()
    },
    [],
  )
  const close = (): void => {
    operation.current?.abort()
    setPassword('')
    onClose()
  }
  const connect = async (): Promise<void> => {
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError(undefined)
    try {
      const result = await connectComputer(
        {
          ...(existing === undefined ? {} : { id: existing.id }),
          name: name.trim() || host.trim(),
          host: host.trim(),
          port: Number(port),
          username: username.trim(),
          ...(identityFile.trim() === '' ? {} : { identityFile: identityFile.trim() }),
          ...(password === '' ? {} : { password }),
          ...(fingerprint === undefined ? {} : { fingerprint }),
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (result.kind === 'trust-required') {
        setFingerprint(result.fingerprint)
        setNeedsTrust(true)
        setBusy(false)
        return
      }
      setPassword('')
      onClose()
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  const disconnect = async (): Promise<void> => {
    if (existing === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await disconnectComputer(existing.id)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }
  const valid =
    host.trim() !== '' &&
    username.trim() !== '' &&
    Number.isInteger(Number(port)) &&
    Number(port) >= 1 &&
    Number(port) <= 65535
  const fields = [
    { key: 'computer.name' as const, value: name, change: setName, locked: false },
    { key: 'computer.host' as const, value: host, change: setHost, locked: existing !== undefined },
    { key: 'computer.port' as const, value: port, change: setPort, locked: existing !== undefined },
    { key: 'computer.username' as const, value: username, change: setUsername, locked: existing !== undefined },
    { key: 'computer.identityFile' as const, value: identityFile, change: setIdentityFile, locked: false },
  ]
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('computer.remoteWork')}
      description={t('computer.description')}
      footer={
        <>
          {existing !== undefined && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void disconnect()
              }}
            >
              {t('computer.disconnect')}
            </Button>
          )}
          <Button variant="outline" onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid || busy}
            onClick={() => {
              void connect()
            }}
          >
            {busy ? t('computer.installing') : needsTrust ? t('computer.trustInstall') : t('computer.connect')}
          </Button>
        </>
      }
    >
      <div className={css.form}>
        {fields.map(field => (
          <label key={field.key} className={css.field}>
            <span>{t(field.key)}</span>
            <input
              value={field.value}
              disabled={busy || field.locked}
              data-modal-autofocus={field.key === 'computer.host' ? '' : undefined}
              autoComplete="off"
              onChange={(event) => {
                field.change(event.target.value)
                if (field.key === 'computer.host' || field.key === 'computer.port') setFingerprint(undefined)
              }}
            />
          </label>
        ))}
        <label className={css.field}>
          <span>{t('computer.password')}</span>
          <input
            type="password"
            value={password}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => {
              setPassword(event.target.value)
            }}
          />
        </label>
        <p className={css.hint}>{t('computer.authenticationHint')}</p>
        {fingerprint !== undefined && needsTrust && (
          <div className={css.trust}>
            <p>{t('computer.confirmFingerprint')}</p>
            <code>{fingerprint}</code>
          </div>
        )}
        {error !== undefined && (
          <p role="alert" className={css.error}>
            {t('computer.operationFailed', { message: error })}
          </p>
        )}
      </div>
    </Modal>
  )
}

function RemoteFolderDialog({
  computer,
  onClose,
  browseComputer,
  addRemoteFolder,
  t,
}: DialogProps & { computer: RemoteComputer }) {
  const [path, setPath] = useState(computer.home ?? '')
  const [entries, setEntries] = useState<readonly { name: string; path: string }[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const operation = useRef<AbortController>()
  const browse = async (directory: string | undefined): Promise<void> => {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError(undefined)
    try {
      const listing = await browseComputer(computer.id, directory, controller.signal)
      if (!controller.signal.aborted) {
        setPath(listing.path)
        setEntries(listing.entries)
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }
  useEffect(() => {
    void browse(computer.home)
    return () => {
      operation.current?.abort()
    }
  }, [])
  const add = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await addRemoteFolder(computer.id, path)
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('computer.folderTitle', { name: computer.name })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={busy || path.trim() === ''}
            onClick={() => {
              void add()
            }}
          >
            {t('computer.useFolder')}
          </Button>
        </>
      }
    >
      <div className={css.form}>
        <label className={css.field}>
          <span>{t('computer.directory')}</span>
          <input
            value={path}
            disabled={busy}
            data-modal-autofocus
            onChange={(event) => {
              setPath(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void browse(path)
            }}
          />
        </label>
        <div className={css.browseActions}>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void browse(undefined)
            }}
          >
            {t('computer.home')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              void browse(path)
            }}
          >
            {t('computer.browse')}
          </Button>
        </div>
        {busy && (
          <span role="status" className={css.hint}>
            {t('computer.loading')}
          </span>
        )}
        <div className={css.directories}>
          {entries.map(entry => (
            <button
              key={entry.path}
              type="button"
              disabled={busy}
              onClick={() => {
                void browse(entry.path)
              }}
            >
              <IconFolderCloseRegular />
              <span>{entry.name}</span>
            </button>
          ))}
        </div>
        {error !== undefined && (
          <p role="alert" className={css.error}>
            {t('computer.operationFailed', { message: error })}
          </p>
        )}
      </div>
    </Modal>
  )
}

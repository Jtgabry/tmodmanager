import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import { useServers } from '../../lib/servers'
import { type Server, type ServerAbility, SERVER_ABILITIES, type User } from '../../lib/types'
import { t } from '../../i18n'

const abilityLabel = (ability: ServerAbility): string =>
  ({
    view: t('Access'),
    console: 'Console',
    power: t('Start/stop'),
    mods: t('Mods and plugins'),
    files: t('Files'),
    backups: t('Backups'),
  })[ability]

const USERS_KEY = ['admin', 'users']

export default function UsersPage() {
  const { data: users, isLoading, error } = useQuery({
    queryKey: USERS_KEY,
    queryFn: async () => (await api.get<{ data: User[] }>('/admin/users')).data.data,
  })
  const { data: servers = [] } = useServers()

  return (
    <section>
      <div className="page-header">
        <h1>{t('Users')}</h1>
      </div>
      {isLoading && <div className="spinner" />}
      {error && <div className="alert alert-error">{errorMessage(error)}</div>}
      <div className="stack">
        {users?.map((u) => <UserCard key={u.id} user={u} servers={servers} />)}
      </div>
    </section>
  )
}

function UserCard({ user, servers }: { user: User; servers: Server[] }) {
  const { user: me } = useAuth()
  const queryClient = useQueryClient()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isMe = me?.id === user.id

  const replaceUser = (updated: User) =>
    queryClient.setQueryData<User[]>(USERS_KEY, (list) => list?.map((u) => (u.id === updated.id ? updated : u)))

  const update = useMutation({
    mutationFn: async (data: { isAdmin?: boolean; isApproved?: boolean }) =>
      (await api.patch<{ data: User }>(`/admin/users/${user.id}`, data)).data.data,
    onSuccess: replaceUser,
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/users/${user.id}`),
    onSuccess: () => queryClient.setQueryData<User[]>(USERS_KEY, (list) => list?.filter((u) => u.id !== user.id)),
  })

  const access = useMutation({
    mutationFn: async ({ serverId, abilities }: { serverId: string; abilities: ServerAbility[] | null }) =>
      abilities === null
        ? (await api.delete<{ data: User }>(`/admin/users/${user.id}/servers/${serverId}`)).data.data
        : (await api.put<{ data: User }>(`/admin/users/${user.id}/servers/${serverId}`, { abilities })).data.data,
    onSuccess: replaceUser,
  })

  const toggleAbility = (serverId: string, ability: ServerAbility) => {
    const current = user.servers?.[serverId] ?? []
    if (ability === 'view') {
      access.mutate({ serverId, abilities: current.length ? null : [] })
      return
    }
    const next = current.includes(ability) ? current.filter((a) => a !== ability) : [...current, ability]
    access.mutate({ serverId, abilities: next.filter((a) => a !== 'view') })
  }

  const mutationError = update.error ?? remove.error ?? access.error

  return (
    <article className="card">
      <header className="user-header">
        <div>
          <strong>{user.name}</strong> {isMe && <span className="tag">{t('you')}</span>}
          {user.isAdmin && <span className="tag tag-accent">admin</span>}
          {!user.isApproved && <span className="tag tag-warning">{t('pending')}</span>}
          <div className="muted small">
            {user.email} · {t('signed up {date}', { date: formatDate(user.createdAt) })}
          </div>
        </div>
        <div className="btn-row">
          {!user.isApproved ? (
            <button type="button" className="btn btn-success btn-sm" onClick={() => update.mutate({ isApproved: true })}>
              {t('Approve')}
            </button>
          ) : (
            !isMe && (
              <button type="button" className="btn btn-sm" onClick={() => update.mutate({ isApproved: false })}>
                {t('Suspend')}
              </button>
            )
          )}
          {!isMe && user.isApproved && (
            <button type="button" className="btn btn-sm" onClick={() => update.mutate({ isAdmin: !user.isAdmin })}>
              {user.isAdmin ? t('Remove admin') : t('Make admin')}
            </button>
          )}
          {!isMe &&
            (confirmDelete ? (
              <>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => remove.mutate()}>
                  {t('Confirm deletion')}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>
                  {t('Cancel')}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => setConfirmDelete(true)}>
                {t('Delete')}
              </button>
            ))}
        </div>
      </header>

      {mutationError && <p className="error-text">{errorMessage(mutationError)}</p>}

      {user.isAdmin ? (
        <p className="muted small">{t('Administrators have every permission on every server.')}</p>
      ) : (
        user.isApproved && (
          <div className="table-wrap">
            <table className="table permissions">
              <thead>
                <tr>
                  <th>Server</th>
                  {SERVER_ABILITIES.map((a) => (
                    <th key={a}>{abilityLabel(a)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((server) => {
                  const abilities = user.servers?.[server.id] ?? []
                  const hasAccess = abilities.length > 0
                  return (
                    <tr key={server.id}>
                      <td>{server.name}</td>
                      {SERVER_ABILITIES.map((ability) => (
                        <td key={ability}>
                          <input
                            type="checkbox"
                            aria-label={t('{ability} on {server}', { ability: abilityLabel(ability), server: server.name })}
                            checked={abilities.includes(ability)}
                            disabled={access.isPending || (ability !== 'view' && !hasAccess)}
                            onChange={() => toggleAbility(server.id, ability)}
                          />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </article>
  )
}

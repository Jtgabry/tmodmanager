import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { api, errorMessage } from '../../lib/api'
import { formatDate } from '../../lib/format'
import type { Invitation } from '../../lib/types'

const KEY = ['admin', 'invitations']
const STATUS_LABEL: Record<Invitation['status'], string> = { active: 'Attivo', used: 'Usato', expired: 'Scaduto' }

export default function InvitationsPage() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [days, setDays] = useState(7)
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const { data: invitations, isLoading } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get<{ data: Invitation[] }>('/admin/invitations')).data.data,
  })

  const create = useMutation({
    mutationFn: async () =>
      (await api.post<{ data: Invitation; url: string }>('/admin/invitations', { email: email || null, expiresInDays: days }))
        .data,
    onSuccess: ({ url }) => {
      setLink(url)
      setCopied(false)
      setEmail('')
      queryClient.invalidateQueries({ queryKey: KEY })
    },
  })

  const revoke = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/invitations/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>Inviti</h1>
      </div>

      <form className="card form-inline" onSubmit={submit}>
        <label className="field">
          <span>Email (facoltativa)</span>
          <input type="email" placeholder="Solo per questo indirizzo" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field field-narrow">
          <span>Validità (giorni)</span>
          <input type="number" min={1} max={30} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>
          Crea invito
        </button>
      </form>
      {create.isError && <div className="alert alert-error">{errorMessage(create.error)}</div>}

      {link && (
        <div className="card invite-link">
          <p>
            <strong>Link di invito</strong> — copialo ora: non sarà più visibile.
          </p>
          <div className="copy-row">
            <input readOnly value={link} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={copy}>
              {copied ? 'Copiato ✓' : 'Copia'}
            </button>
          </div>
        </div>
      )}

      {isLoading && <div className="spinner" />}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Stato</th>
              <th>Email</th>
              <th>Creato da</th>
              <th>Scadenza</th>
              <th>Usato da</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invitations?.map((inv) => (
              <tr key={inv.id}>
                <td>
                  <span className={`tag tag-${inv.status}`}>{STATUS_LABEL[inv.status]}</span>
                </td>
                <td>{inv.email ?? <span className="muted">qualsiasi</span>}</td>
                <td>{inv.createdBy ?? '—'}</td>
                <td>{formatDate(inv.expiresAt)}</td>
                <td>{inv.usedBy ? `${inv.usedBy} (${formatDate(inv.usedAt)})` : '—'}</td>
                <td>
                  {inv.status === 'active' && (
                    <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => revoke.mutate(inv.id)}>
                      Revoca
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {invitations?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Nessun invito.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

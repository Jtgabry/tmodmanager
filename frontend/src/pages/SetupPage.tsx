import { useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import logo from '../assets/logo.png'
import { FullPageSpinner } from '../components/RouteGuards'
import { api, ensureCsrfCookie, errorMessage, fieldErrors } from '../lib/api'
import { useSetupRequired } from '../lib/setup'
import type { User } from '../lib/types'
import { t } from '../i18n'
import { LanguageSelect } from '../i18n/LocaleProvider'

/** Primo avvio: creazione dell'amministratore con il codice mostrato dall'installer. */
export default function SetupPage() {
  const required = useSetupRequired()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [form, setForm] = useState({ code: params.get('code') ?? '', name: '', email: '', password: '', password_confirmation: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (required.isLoading) return <FullPageSpinner />
  if (required.data === false) return <Navigate to="/login" replace />

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setErrors({})
    setError(null)
    try {
      await ensureCsrfCookie()
      const { data } = await api.post<{ data: User }>('/setup', form)
      queryClient.setQueryData(['setup'], false)
      queryClient.setQueryData(['auth', 'user'], data.data)
      navigate('/admin/servers', { replace: true })
    } catch (err) {
      const fields = fieldErrors(err)
      setErrors(fields)
      if (Object.keys(fields).length === 0) setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={submit}>
        <LanguageSelect className="auth-lang" />
        <h1 className="auth-title">
          <img className="brand-mark auth-logo" src={logo} alt="" /> {t('Welcome')}
        </h1>
        <p className="muted small">
          {t('Create the administrator account. Then you will install tModLoader and create the first server from the Server management page.')}
        </p>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span>{t('Setup code')}</span>
          <input required autoComplete="off" className="mono" value={form.code} onChange={set('code')} />
          {errors.code ? (
            <small className="error-text">{errors.code}</small>
          ) : (
            <small className="muted">{t('The installer shows it (or: php artisan setup:code).')}</small>
          )}
        </label>
        <label className="field">
          <span>{t('Name')}</span>
          <input autoComplete="name" required value={form.name} onChange={set('name')} />
          {errors.name && <small className="error-text">{errors.name}</small>}
        </label>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          {errors.email && <small className="error-text">{errors.email}</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="new-password" required value={form.password} onChange={set('password')} />
          {errors.password && <small className="error-text">{errors.password}</small>}
        </label>
        <label className="field">
          <span>{t('Confirm password')}</span>
          <input type="password" autoComplete="new-password" required value={form.password_confirmation} onChange={set('password_confirmation')} />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? t('Creating…') : t('Create administrator')}
        </button>
      </form>
    </div>
  )
}

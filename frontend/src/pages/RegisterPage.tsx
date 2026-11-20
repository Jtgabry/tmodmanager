import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { errorMessage, fieldErrors } from '../lib/api'
import { t } from '../i18n'
import { LanguageSelect } from '../i18n/LocaleProvider'

export default function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const invitation = params.get('invite') ?? undefined
  const [form, setForm] = useState({ name: '', email: '', password: '', password_confirmation: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setErrors({})
    setError(null)
    try {
      const status = await register({ ...form, invitation })
      if (status === 'active') navigate('/', { replace: true })
      else setPending(true)
    } catch (err) {
      const fields = fieldErrors(err)
      setErrors(fields)
      if (Object.keys(fields).length === 0 || fields.invitation) setError(fields.invitation ?? errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (pending) {
    return (
      <div className="center-page">
        <div className="card auth-card">
          <h1 className="auth-title">{t('Registration sent')}</h1>
          <p>{t('Your account is waiting for approval by an administrator. You can log in as soon as it is approved.')}</p>
          <Link to="/login" className="btn btn-block">
            {t('Back to login')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={submit}>
        <LanguageSelect className="auth-lang" />
        <h1 className="auth-title">{t('Create an account')}</h1>
        <p className="muted small">
          {invitation
            ? t('You have an invitation: the account will be active right away.')
            : t('Without an invitation, the account must be approved by an administrator.')}
        </p>
        {error && <div className="alert alert-error">{error}</div>}
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
          <input
            type="password"
            autoComplete="new-password"
            required
            value={form.password_confirmation}
            onChange={set('password_confirmation')}
          />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? t('Sending…') : t('Sign up')}
        </button>
        <p className="muted small">
          {t('Already have an account?')} <Link to="/login">{t('Log in')}</Link>
        </p>
      </form>
    </div>
  )
}

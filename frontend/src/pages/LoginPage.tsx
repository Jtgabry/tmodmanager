import { type FormEvent, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { errorMessage } from '../lib/api'
import { useSetupRequired } from '../lib/setup'
import logo from '../assets/logo.png'
import { t } from '../i18n'
import { LanguageSelect } from '../i18n/LocaleProvider'

export default function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const setupRequired = useSetupRequired()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await login(email, password, remember)
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Primo avvio: non esiste ancora un amministratore
  if (setupRequired.data) return <Navigate to="/setup" replace />

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={submit}>
        <LanguageSelect className="auth-lang" />
        <h1 className="auth-title">
          <img className="brand-mark auth-logo" src={logo} alt="" /> tModManager
        </h1>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t('Remember me')}
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? t('Logging in…') : t('Log in')}
        </button>
        <p className="muted small">
          {t("Don't have an account?")} <Link to="/register">{t('Sign up')}</Link>
        </p>
      </form>
    </div>
  )
}

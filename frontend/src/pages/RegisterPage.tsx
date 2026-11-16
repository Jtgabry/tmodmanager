import { type FormEvent, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { errorMessage, fieldErrors } from '../lib/api'

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
          <h1 className="auth-title">Registrazione inviata</h1>
          <p>Il tuo account è in attesa di approvazione da parte di un amministratore. Potrai accedere appena verrà approvato.</p>
          <Link to="/login" className="btn btn-block">
            Torna al login
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={submit}>
        <h1 className="auth-title">Crea un account</h1>
        <p className="muted small">
          {invitation
            ? 'Hai un invito: l’account sarà attivo subito.'
            : 'Senza invito, l’account dovrà essere approvato da un amministratore.'}
        </p>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field">
          <span>Nome</span>
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
          <span>Conferma password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={form.password_confirmation}
            onChange={set('password_confirmation')}
          />
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
          {submitting ? 'Invio…' : 'Registrati'}
        </button>
        <p className="muted small">
          Hai già un account? <Link to="/login">Accedi</Link>
        </p>
      </form>
    </div>
  )
}

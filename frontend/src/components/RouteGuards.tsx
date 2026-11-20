import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { t } from '../i18n'

export function FullPageSpinner() {
  return (
    <div className="center-page">
      <div className="spinner" aria-label={t('Loading')} />
    </div>
  )
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()
  const location = useLocation()
  if (isLoading) return <FullPageSpinner />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return children
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/" replace />
  return children
}

export function GuestOnly({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()
  if (isLoading) return <FullPageSpinner />
  if (user) return <Navigate to="/" replace />
  return children
}

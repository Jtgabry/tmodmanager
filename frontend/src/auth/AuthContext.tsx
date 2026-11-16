import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react'
import { api, ensureCsrfCookie, statusOf } from '../lib/api'
import type { ServerAbility, User } from '../lib/types'

type RegisterInput = {
  name: string
  email: string
  password: string
  password_confirmation: string
  invitation?: string
}

type AuthContextValue = {
  user: User | null
  isLoading: boolean
  login: (email: string, password: string, remember: boolean) => Promise<void>
  logout: () => Promise<void>
  /** Restituisce 'active' (già loggato) o 'pending' (in attesa di approvazione). */
  register: (input: RegisterInput) => Promise<'active' | 'pending'>
  can: (serverId: string, ability: ServerAbility) => boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)
const ME_KEY = ['auth', 'user']

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  const { data: user = null, isLoading } = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await api.get<{ data: User }>('/auth/user')).data.data
      } catch (error) {
        // 401 = non loggato, 403 = non (più) approvato: in entrambi i casi niente utente
        if ([401, 403].includes(statusOf(error) ?? 0)) return null
        throw error
      }
    },
    staleTime: 60_000,
    retry: false,
  })

  const login = useCallback(
    async (email: string, password: string, remember: boolean) => {
      await ensureCsrfCookie()
      const { data } = await api.post<{ data: User }>('/auth/login', { email, password, remember })
      queryClient.setQueryData(ME_KEY, data.data)
    },
    [queryClient],
  )

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined)
    queryClient.clear()
    queryClient.setQueryData(ME_KEY, null)
  }, [queryClient])

  const register = useCallback(
    async (input: RegisterInput) => {
      await ensureCsrfCookie()
      const { data } = await api.post<{ status: 'active' | 'pending'; user?: User }>('/auth/register', input)
      if (data.status === 'active' && data.user) queryClient.setQueryData(ME_KEY, data.user)
      return data.status
    },
    [queryClient],
  )

  const can = useCallback(
    (serverId: string, ability: ServerAbility) => {
      if (!user) return false
      if (user.isAdmin || user.servers === null) return true
      return user.servers[serverId]?.includes(ability) ?? false
    },
    [user],
  )

  const value = useMemo(
    () => ({ user, isLoading, login, logout, register, can }),
    [user, isLoading, login, logout, register, can],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth va usato dentro <AuthProvider>')
  return ctx
}

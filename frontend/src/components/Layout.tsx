import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import ErrorBoundary from './ErrorBoundary'
import PowerButtons from './PowerButtons'
import StateBadge from './StateBadge'
import {
  IconAdmin,
  IconConsole,
  IconFiles,
  IconInvites,
  IconLogout,
  IconMenu,
  IconModpacks,
  IconMods,
  IconOverview,
  IconServers,
  IconSettings,
  IconTrash,
  IconUsers,
  IconWorkshop,
} from './icons'
import { useAuth } from '../auth/AuthContext'
import { useServer } from '../lib/servers'
import type { Server } from '../lib/types'
import logo from '../assets/logo.png'

function NavItem({ to, end, icon, children }: { to: string; end?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <NavLink to={to} end={end} className="nav-item">
      {icon}
      <span>{children}</span>
    </NavLink>
  )
}

/** Scheda del server corrente in cima alla sidebar: nome, stato, giocatori e pulsanti di accensione. */
function ServerCard({ server }: { server: Server }) {
  const { can } = useAuth()
  const on = server.state !== 'stopped'
  return (
    <div className="server-panel">
      <div className="server-panel-head">
        <span className="server-panel-name">{server.name}</span>
        <StateBadge state={server.state} />
      </div>
      <div className="server-panel-meta">
        Giocatori {on ? `${server.players.online} / ${server.players.max}` : '—'} · Porta {server.port}
      </div>
      {can(server.id, 'power') && <PowerButtons server={server} variant="tile" />}
    </div>
  )
}

function ServerNav({ serverId, server }: { serverId: string; server: Server | undefined }) {
  const { can, user } = useAuth()
  const base = `/servers/${serverId}`

  return (
    <>
      {server ? <ServerCard server={server} /> : <div className="server-panel server-panel-loading" />}
      <nav className="sidebar-nav" aria-label="Server corrente">
        <NavItem to={base} end icon={<IconOverview />}>
          Panoramica
        </NavItem>
        {can(serverId, 'console') && (
          <NavItem to={`${base}/console`} icon={<IconConsole />}>
            Console
          </NavItem>
        )}
        {can(serverId, 'mods') && server?.game === 'tmodloader' && (
          <>
            <NavItem to={`${base}/mods`} icon={<IconMods />}>
              Mod
            </NavItem>
            <NavItem to={`${base}/workshop`} icon={<IconWorkshop />}>
              Workshop
            </NavItem>
            <NavItem to={`${base}/modpacks`} icon={<IconModpacks />}>
              Modpack
            </NavItem>
          </>
        )}
        {can(serverId, 'files') && (
          <NavItem to={`${base}/files`} icon={<IconFiles />}>
            File
          </NavItem>
        )}
        {(can(serverId, 'files') || can(serverId, 'mods')) && (
          <NavItem to={`${base}/trash`} icon={<IconTrash />}>
            Cestino
          </NavItem>
        )}
        {user?.isAdmin && (
          <NavItem to={`${base}/settings`} icon={<IconSettings />}>
            Impostazioni
          </NavItem>
        )}
      </nav>
      <div className="sidebar-divider" />
    </>
  )
}

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const serverId = useMatch('/servers/:serverId/*')?.params.serverId
  // Il menu mobile resta aperto solo sulla pagina in cui è stato aperto: cambiando pagina si richiude
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const drawerOpen = drawerPath === pathname
  const setDrawerOpen = (open: boolean | ((o: boolean) => boolean)) =>
    setDrawerPath((typeof open === 'function' ? open(drawerOpen) : open) ? pathname : null)
  const { data: server } = useServer(serverId ?? '', { enabled: !!serverId })

  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerPath(null)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  return (
    <div className={drawerOpen ? 'app drawer-open' : 'app'}>
      <header className="topbar">
        <button
          type="button"
          className="icon-btn menu-btn"
          aria-label={drawerOpen ? 'Chiudi menu' : 'Apri menu'}
          aria-expanded={drawerOpen}
          aria-controls="sidebar"
          onClick={() => setDrawerOpen((o) => !o)}
        >
          <IconMenu />
        </button>
        <NavLink to="/" className="brand">
          <img className="brand-mark" src={logo} alt="" />
          <span>tModManager</span>
        </NavLink>
        <div className="topbar-spacer" />
        {server && (
          <button type="button" className="server-chip" onClick={() => setDrawerOpen(true)}>
            <span className={`chip-dot chip-dot-${server.state}`} aria-hidden="true" />
            <span className="server-chip-name">{server.name}</span>
          </button>
        )}
        <div className="topbar-user">
          <span className="muted">{user?.name}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
            <IconLogout />
            Esci
          </button>
        </div>
      </header>

      <button
        type="button"
        className="sidebar-backdrop"
        aria-label="Chiudi menu"
        tabIndex={-1}
        onClick={() => setDrawerOpen(false)}
      />

      <aside id="sidebar" className="sidebar">
        {serverId && <ServerNav serverId={serverId} server={server} />}
        <nav className="sidebar-nav" aria-label="Generale">
          <NavItem to="/" end icon={<IconServers />}>
            Server
          </NavItem>
          {user?.isAdmin && (
            <>
              <NavItem to="/admin/servers" icon={<IconAdmin />}>
                Gestione server
              </NavItem>
              <NavItem to="/admin/users" icon={<IconUsers />}>
                Utenti
              </NavItem>
              <NavItem to="/admin/invitations" icon={<IconInvites />}>
                Inviti
              </NavItem>
            </>
          )}
        </nav>
        <div className="sidebar-user">
          <span className="muted">{user?.name}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
            <IconLogout />
            Esci
          </button>
        </div>
      </aside>

      <main className="content">
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext'
import Layout from './components/Layout'
import { GuestOnly, RequireAdmin, RequireAuth } from './components/RouteGuards'
import InvitationsPage from './pages/admin/InvitationsPage'
import UsersPage from './pages/admin/UsersPage'
import LoginPage from './pages/LoginPage'
import ConsoleTab from './pages/ConsoleTab'
import FilesTab from './pages/files/FilesTab'
import ModpackPage from './pages/mods/ModpackPage'
import ModpacksTab from './pages/mods/ModpacksTab'
import ModsTab from './pages/mods/ModsTab'
import WorkshopTab from './pages/mods/WorkshopTab'
import RegisterPage from './pages/RegisterPage'
import SetupPage from './pages/SetupPage'
import ServerPage, { ServerOverview } from './pages/ServerPage'
import ServersPage from './pages/ServersPage'
import TrashTab from './pages/TrashTab'
import UpdatePrompt from './components/UpdatePrompt'
import ServersAdminPage from './pages/admin/ServersAdminPage'
import { ServerSettingsTab } from './pages/settings/ServerSettings'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
          <Route path="/setup" element={<GuestOnly><SetupPage /></GuestOnly>} />

          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<ServersPage />} />
            <Route path="servers/:serverId" element={<ServerPage />}>
              <Route index element={<ServerOverview />} />
              <Route path="console" element={<ConsoleTab />} />
              <Route path="mods" element={<ModsTab />} />
              <Route path="workshop" element={<WorkshopTab />} />
              <Route path="modpacks" element={<ModpacksTab />} />
              <Route path="modpacks/:packId" element={<ModpackPage />} />
              <Route path="files" element={<FilesTab />} />
              <Route path="trash" element={<TrashTab />} />
              <Route path="settings" element={<RequireAdmin><ServerSettingsTab /></RequireAdmin>} />
            </Route>
            <Route path="admin/servers" element={<RequireAdmin><ServersAdminPage /></RequireAdmin>} />
            <Route path="admin/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
            <Route path="admin/invitations" element={<RequireAdmin><InvitationsPage /></RequireAdmin>} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <UpdatePrompt />
      </AuthProvider>
    </BrowserRouter>
  )
}

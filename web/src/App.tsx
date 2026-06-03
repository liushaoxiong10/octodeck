import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupPage } from './pages/SetupPage';
import { SetupProvidersPage } from './pages/SetupProvidersPage';
import { SetupChannelsPage } from './pages/SetupChannelsPage';
import { MemoryPage } from './pages/MemoryPage';
import { SkillsPage } from './pages/SkillsPage';
import { McpServersPage } from './pages/McpServersPage';
import { PluginsPage } from './pages/PluginsPage';
import { AgentDefinitionsPage } from './pages/AgentDefinitionsPage';
import { UsersPage } from './pages/UsersPage';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { APP_BASE, shouldUseHashRouter } from './utils/url';
import { Toaster } from '@/components/ui/sonner';

const ChatPage = lazy(() => import('./pages/ChatPage').then(m => ({ default: m.ChatPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then(m => ({ default: m.TasksPage })));
const IssuesPage = lazy(() => import('./pages/IssuesPage').then(m => ({ default: m.IssuesPage })));
const DevicesPage = lazy(() => import('./pages/DevicesPage').then(m => ({ default: m.DevicesPage })));
const ReposPage = lazy(() => import('./pages/ReposPage').then(m => ({ default: m.ReposPage })));
const AgentsPage = lazy(() => import('./pages/AgentsPage').then(m => ({ default: m.AgentsPage })));
const ModelEndpointsPage = lazy(() => import('./pages/ModelEndpointsPage').then(m => ({ default: m.ModelEndpointsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const BillingPage = lazy(() => import('./pages/BillingPage'));

export function App() {
  const Router = shouldUseHashRouter() ? HashRouter : BrowserRouter;

  return (
    <Router basename={APP_BASE === '/' ? undefined : APP_BASE}>
      <Toaster position="top-right" richColors />
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route
          path="/setup/providers"
          element={
            <AuthGuard>
              <SetupProvidersPage />
            </AuthGuard>
          }
        />
        <Route
          path="/setup/channels"
          element={
            <AuthGuard>
              <SetupChannelsPage />
            </AuthGuard>
          }
        />

        {/* Protected Routes with Layout */}
        <Route
          element={
            <AuthGuard>
              <AppLayout />
            </AuthGuard>
          }
        >
          <Route path="/chat/:groupFolder?" element={<Suspense fallback={null}><ChatPage /></Suspense>} />
          <Route path="/groups" element={<Navigate to="/settings?tab=groups" replace />} />
          <Route path="/tasks" element={<Suspense fallback={null}><TasksPage /></Suspense>} />
          <Route path="/issues/:groupFolder?" element={<Suspense fallback={null}><IssuesPage /></Suspense>} />
          <Route path="/repos" element={<Suspense fallback={null}><ReposPage /></Suspense>} />
          <Route path="/devices" element={<Suspense fallback={null}><DevicesPage /></Suspense>} />
          <Route path="/agents" element={<Suspense fallback={null}><AgentsPage /></Suspense>} />
          <Route path="/model-endpoints" element={<Suspense fallback={null}><ModelEndpointsPage /></Suspense>} />
          <Route path="/monitor" element={<Navigate to="/settings?tab=monitor" replace />} />
          <Route path="/usage" element={<Navigate to="/settings?tab=usage" replace />} />
          <Route path="/billing" element={<Suspense fallback={null}><BillingPage /></Suspense>} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/mcp-servers" element={<McpServersPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/agent-definitions" element={<AgentDefinitionsPage />} />
          <Route path="/settings" element={<Suspense fallback={null}><SettingsPage /></Suspense>} />
          <Route
            path="/users"
            element={
              <AuthGuard requiredAnyPermissions={['manage_users', 'manage_invites', 'view_audit_log']}>
                <UsersPage />
              </AuthGuard>
            }
          />
        </Route>

        {/* Default redirect — go through AuthGuard to detect setup state */}
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </Router>
  );
}

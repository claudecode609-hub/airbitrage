import { Sidebar } from '@/components/dashboard/sidebar';
import { AgentTabBar } from '@/components/dashboard/agent-tab-bar';
import { AgentRunProvider } from '@/components/providers/agent-run-provider';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AgentRunProvider>
      <div className="min-h-screen">
        <Sidebar />
        <div style={{ marginLeft: 'var(--sidebar-width)' }}>
          <AgentTabBar />
          <main className="p-6">
            {children}
          </main>
        </div>
      </div>
    </AgentRunProvider>
  );
}

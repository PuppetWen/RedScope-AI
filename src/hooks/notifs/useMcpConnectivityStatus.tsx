import { useEffect } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import type { MCPServerConnection } from '../../services/mcp/types.js';

type Props = {
  mcpClients?: MCPServerConnection[];
};

const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];
const MCP_FOOTER_NOTIFICATION_KEYS = [
  'mcp-failed',
  'mcp-claudeai-failed',
  'mcp-needs-auth',
  'mcp-claudeai-needs-auth',
] as const;

export function useMcpConnectivityStatus({ mcpClients = EMPTY_MCP_CLIENTS }: Props): void {
  const { removeNotification } = useNotifications();

  useEffect(() => {
    for (const key of MCP_FOOTER_NOTIFICATION_KEYS) {
      removeNotification(key);
    }
    // Keep the footer's basic information row clean. MCP health and auth
    // details remain available in the dedicated /mcp screen.
  }, [removeNotification, mcpClients]);
}

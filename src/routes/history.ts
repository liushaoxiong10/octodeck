import { Hono } from 'hono';

import { getAllRegisteredGroups, listSystemHistoryFlows, type SystemHistoryFilters } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import { canAccessGroup, hasHostExecutionPermission, isHostExecutionGroup, type Variables } from '../web-context.js';

const historyRoutes = new Hono<{ Variables: Variables }>();

historyRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const typeParam = c.req.query('type');
  const type: SystemHistoryFilters['type'] =
    typeParam === 'task' || typeParam === 'issue' || typeParam === 'team' || typeParam === 'message'
      ? typeParam
      : 'all';
  const limit = Number(c.req.query('limit') || 100);
  const offset = Number(c.req.query('offset') || 0);
  const query = c.req.query('q') || undefined;
  const visibleGroups = Object.entries(getAllRegisteredGroups()).filter(
    ([jid, group]) =>
      canAccessGroup(
        { id: authUser.id, role: authUser.role },
        { ...group, jid },
      ) &&
      (!isHostExecutionGroup(group) || hasHostExecutionPermission(authUser)),
  );
  const flows = listSystemHistoryFlows({
    type,
    query,
    limit,
    offset,
    userId: authUser.id,
    includeAllUsers: authUser.role === 'admin',
    accessibleWorkspaceJids: visibleGroups.map(([jid]) => jid),
    accessibleGroupFolders: Array.from(
      new Set(visibleGroups.map(([, group]) => group.folder).filter(Boolean)),
    ),
  });
  return c.json({ flows });
});

export default historyRoutes;

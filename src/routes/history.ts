import { Hono } from 'hono';

import { listSystemHistoryFlows, type SystemHistoryFilters } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';

const historyRoutes = new Hono<{ Variables: Variables }>();

historyRoutes.get('/', authMiddleware, (c) => {
  const typeParam = c.req.query('type');
  const type: SystemHistoryFilters['type'] =
    typeParam === 'task' || typeParam === 'issue' || typeParam === 'team' || typeParam === 'message'
      ? typeParam
      : 'all';
  const limit = Number(c.req.query('limit') || 100);
  const offset = Number(c.req.query('offset') || 0);
  const query = c.req.query('q') || undefined;
  const flows = listSystemHistoryFlows({ type, query, limit, offset });
  return c.json({ flows });
});

export default historyRoutes;

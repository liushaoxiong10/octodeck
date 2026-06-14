import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  backfillMissingUsageRecordsFromMessages,
  getUsageDailyStats,
  getUsageDailySummary,
  getUsageModels,
  getUsageSourceStats,
  getUsageUsers,
  repairSystemUsageRecordOwners,
} from '../db.js';
import type { AuthUser } from '../types.js';
import { logger } from '../logger.js';

const usage = new Hono<{ Variables: Variables }>();

usage.use('*', authMiddleware);

let ownerRepairRan = false;

function ensureUsageOwnersRepaired(): void {
  if (ownerRepairRan) return;
  ownerRepairRan = true;
  // Rebuilds usage_daily_summary from usage_records, which can be slow on large
  // datasets. Run it off the request path so the first /usage page load doesn't
  // block long enough to trip the frontend request timeout.
  setImmediate(() => {
    try {
      backfillMissingUsageRecordsFromMessages();
      repairSystemUsageRecordOwners();
    } catch (err) {
      logger.error({ err }, 'repairSystemUsageRecordOwners failed');
    }
  });
}

/**
 * Resolve userId for queries:
 * - Admin can filter by any userId or see all (undefined = all)
 * - Member always sees only their own data
 */
function resolveUserId(
  user: AuthUser,
  requestedUserId?: string,
): string | undefined {
  if (user.role === 'admin') {
    return requestedUserId || undefined; // undefined = all users
  }
  return user.id; // member always sees only own data
}

/**
 * GET /api/usage/stats?days=7&userId=&model=
 * Returns aggregated token usage statistics from usage_daily_summary.
 * Fixes: token KPI (uses modelUsage data) + timezone (local date grouping).
 */
usage.get('/stats', (c) => {
  ensureUsageOwnersRepaired();
  const user = c.get('user') as AuthUser;
  const daysParam = c.req.query('days');
  const days = daysParam
    ? Math.min(Math.max(parseInt(daysParam, 10) || 7, 1), 365)
    : 7;

  const userId = resolveUserId(user, c.req.query('userId') || undefined);
  const model = c.req.query('model') || undefined;

  const summary = getUsageDailySummary(days, userId, model);
  const breakdown = getUsageDailyStats(days, userId, model);
  const sourceBreakdown = getUsageSourceStats(days, userId, model);

  // Compute actual data range for frontend display
  const dates = breakdown.map((r) => r.date);
  const uniqueDates = [...new Set(dates)].sort();
  const dataRange =
    uniqueDates.length > 0
      ? {
          from: uniqueDates[0],
          to: uniqueDates[uniqueDates.length - 1],
          activeDays: uniqueDates.length,
        }
      : null;

  return c.json({ summary, breakdown, sourceBreakdown, days, dataRange });
});

/**
 * GET /api/usage/models
 * Returns list of all models that have usage data.
 */
usage.get('/models', (c) => {
  ensureUsageOwnersRepaired();
  const models = getUsageModels();
  return c.json({ models });
});

/**
 * GET /api/usage/users
 * Returns list of users that have usage data. Admin only.
 */
usage.get('/users', (c) => {
  ensureUsageOwnersRepaired();
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ users: [{ id: user.id, username: user.username }] });
  }
  const users = getUsageUsers();
  return c.json({ users });
});

export { usage };

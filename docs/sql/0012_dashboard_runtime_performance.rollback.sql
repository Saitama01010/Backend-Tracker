-- Manual rollback only. The application remains compatible with this additive
-- index, so leave it in place during an application-only rollback.
-- Run outside a transaction after confirming the index itself is the problem.
DROP INDEX CONCURRENTLY IF EXISTS "phone_calls_dashboard_stats_cover_idx";

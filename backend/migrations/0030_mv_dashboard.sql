-- P8: Materialized view for dashboard ticket counts
-- Drops 5-8 live aggregation queries to a single indexed read
-- Refresh every 5 minutes via pg_cron (requires pg_cron extension on Supabase)

CREATE MATERIALIZED VIEW IF NOT EXISTS app.mv_ticket_counts AS
SELECT
  organization_id,
  status,
  COUNT(*) AS ticket_count,
  COUNT(*) FILTER (WHERE priority = 'urgent') AS urgent_count,
  COUNT(*) FILTER (WHERE priority = 'high')   AS high_count,
  COUNT(*) FILTER (
    WHERE is_overdue = true
      AND status NOT IN ('resolved', 'closed')
  ) AS overdue_count
FROM app.tickets
GROUP BY organization_id, status;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_ticket_counts_org_status
  ON app.mv_ticket_counts(organization_id, status);

-- pg_cron refresh every 5 minutes (runs only when pg_cron extension is present)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE format(
      'SELECT cron.schedule(%L, %L, %L)',
      'refresh-mv-ticket-counts',
      '*/5 * * * *',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY app.mv_ticket_counts'
    );
  END IF;
END
$$;

-- Active accounts from before the site analytics counted them (0006): every sign-in that's still on record
-- (sessions.created_at; a session lasts 30 days) and every account's own creation is a day that account was active.
-- Each day, week and month gets at least that many accounts (MAX, so a count already kept is never lowered), and
-- accounts.seen_day gets the latest such day where it's empty. Devices can't be worked out afterwards; they count
-- from 0006 on.

INSERT INTO site_counts (day, metric, n)
SELECT day, 'acct:d', COUNT(DISTINCT account_id) FROM (
  SELECT account_id, date(created_at, 'unixepoch') AS day FROM sessions
  UNION SELECT id, date(created_at, 'unixepoch') FROM accounts
) WHERE 1 GROUP BY day
ON CONFLICT (day, metric) DO UPDATE SET n = max(n, excluded.n);

INSERT INTO site_counts (day, metric, n)
SELECT day, 'acct:w', COUNT(DISTINCT account_id) FROM (
  SELECT account_id, date(created_at, 'unixepoch', '-6 days', 'weekday 1') AS day FROM sessions
  UNION SELECT id, date(created_at, 'unixepoch', '-6 days', 'weekday 1') FROM accounts
) WHERE 1 GROUP BY day
ON CONFLICT (day, metric) DO UPDATE SET n = max(n, excluded.n);

INSERT INTO site_counts (day, metric, n)
SELECT day, 'acct:m', COUNT(DISTINCT account_id) FROM (
  SELECT account_id, strftime('%Y-%m-01', created_at, 'unixepoch') AS day FROM sessions
  UNION SELECT id, strftime('%Y-%m-01', created_at, 'unixepoch') FROM accounts
) WHERE 1 GROUP BY day
ON CONFLICT (day, metric) DO UPDATE SET n = max(n, excluded.n);

UPDATE accounts SET seen_day = (
  SELECT date(MAX(t), 'unixepoch') FROM (
    SELECT created_at AS t FROM sessions WHERE account_id = accounts.id
    UNION ALL SELECT accounts.created_at
  )
) WHERE seen_day IS NULL;

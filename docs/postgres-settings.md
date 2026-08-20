# Production Postgres settings

Settings applied to the production database with `ALTER SYSTEM` on 2026-08-20,
during the `journey_stops` surrogate-key migration. They live in
`postgresql.auto.conf` on the server, not in this repo, so they are recorded
here — nothing in the codebase would otherwise reveal them, and a container
rebuild that loses the data volume loses them too.

Inspect the live values with:

```sql
SELECT name, setting, source FROM pg_settings
WHERE name IN ('max_wal_size','checkpoint_timeout','wal_compression','maintenance_work_mem');
```

`source = 'configuration file'` means the value came from `ALTER SYSTEM`;
`'default'` means it reverted.

| Setting | Default | Now | Why |
|---|---|---|---|
| `max_wal_size` | 1 GB | 4 GB | At 1 GB a bulk rewrite forces a checkpoint roughly every 1 GB of WAL, and each one flushes the whole buffer pool. Measured during the `delay_min` rebuild: 44 MB/30 s at 1 GB against 2456 MB/30 s once raised. 4 GB is the steady-state compromise — it was briefly 12 GB for the rewrite itself, which is more than the poller ever needs and parks segments on a disk this migration exists to free. |
| `checkpoint_timeout` | 5 min | 15 min | Same reasoning. Fewer, larger checkpoints under the poller's continuous write load. |
| `wal_compression` | off | lz4 | Less WAL per byte written, which is the binding constraint on a 75 GB disk. Costs CPU the database has spare. |
| `maintenance_work_mem` | 64 MB | 128 MB | Faster index builds and vacuums. **Deliberately not larger**: it is per-worker, and `autovacuum_max_workers` is 3, so the real ceiling is 3x this. It was set to 1 GB during the rewrite, which on a 7 GB box with ~2 GB available is 3 GB of autovacuum headroom and an OOM risk — that was a mistake, corrected the same day. Anything above ~256 MB needs the worker count checked first. |

## If you are considering a bulk rewrite

Raise `max_wal_size` for the duration and put it back afterwards. The cost is
disk for WAL segments, and the payoff was ~56x on the one measurement taken.
`maintenance_work_mem` may also be worth raising **for a session**
(`SET maintenance_work_mem`), which does not apply to autovacuum workers and so
avoids the memory trap above.

See `scripts/rebuild-delay-min.sh` for the shape of a rewrite that stops ingest
first, and `drizzle/20260820140000_delay_min_expression/migration.sql` for why
a generated column must not call a SQL function.

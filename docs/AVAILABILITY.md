# Availability and artifact storage

## The availability boundary

DevWeft's primary/standby arrangement protects the control plane from one host process or host becoming unavailable. Both control planes can use the same PostgreSQL database, but PostgreSQL does not store uploaded Git bundles, test specifications, or run artifacts. The primary host's blob directory remains the authoritative artifact store.

The standby has no local artifact cache and does not become an artifact replica. It uploads to the primary blob endpoint configured by `AWP_BLOB_BASE_URL`, or—when that override is blank—to the non-loopback primary link saved in the dashboard link pool and shared database. A standby reports ready only when its database schema and that remote endpoint are ready. For control-plane failover, configure the separate blob endpoint (default port `8792`) directly; a dashboard link that points to the primary control plane may be unavailable during its restart. If the primary blob endpoint or its storage is unavailable, the standby returns HTTP 503 from `/api/health/ready`; remote uploads return `BLOB_STORE_UNAVAILABLE` (503). After restoring the endpoint, retry the submission. No durable upload queue is kept on the standby.

SQLite deployments keep the local blob store in the control-plane process and do not start the separate `awp-blob-store` PM2 process. PostgreSQL deployments start the separate process on `AWP_BLOB_PORT` (default `8792`) so artifact uploads can remain available while the primary control plane restarts. The PostgreSQL database and the blob directory are separate dependencies and must both be backed up.

## Health endpoints

`GET /api/health/live` answers whether the process is alive. `GET /api/health/ready` checks the database migration/schema state, node role, execution mode, and the blob dependency required by that role.

The response includes:

- `node.role`: `primary` or `standby`.
- `node.executionMode`: `disabled`, `hyperv`, or `local-process`.
- `blobStorage`: local/remote mode, current state, whether a local cache exists, durability boundary, and a recovery action. URLs, filesystem paths, and raw connection errors are omitted.
- `standbyUploadEndpoint`: on a PostgreSQL primary, the independent blob service status. It is reported separately because the primary can still use its local store when this standby-only upload endpoint is degraded.

The standalone blob service exposes both `/api/health/live` and `/api/health/ready`. Its readiness requires a PostgreSQL query and readable/writable local blob storage.

## Recovery guide

| Observed state | Impact | Recovery |
|---|---|---|
| Primary `blobStorage.state=local_storage_unavailable` | New local artifact writes can fail; existing artifacts may be inaccessible. | Restore the configured blob volume/directory permissions or recover the blob directory from backup/replica, then check `/api/health/ready`. |
| Primary `standbyUploadEndpoint.state=remote_unavailable` | Primary control plane can remain ready; standby artifact submissions cannot reach the canonical store. | Restore the `awp-blob-store` PM2 process, its PostgreSQL connection, and its local blob directory. Verify `http://127.0.0.1:<AWP_BLOB_PORT>/api/health/ready`, then verify the standby's readiness. |
| Standby `blobStorage.state=remote_unavailable` | The standby is not ready to accept submissions; it has no local cache or durable upload queue. | Restore the primary blob endpoint and shared PostgreSQL, then retry the submission. |
| Standby `blobStorage.state=remote_not_configured` | The standby cannot identify its artifact destination. | Set `AWP_BLOB_BASE_URL` in ignored `data/node.env`, or configure a reachable non-loopback primary link in the dashboard's link pool using the shared database, then restart the standby. |
| `BLOB_STORE_UNAVAILABLE` | The remote prepare/upload call failed with a network, timeout, throttling, or server error. | Check primary blob readiness and storage, then retry after service recovery. A content hash mismatch remains `SNAPSHOT_HASH_MISMATCH` and requires regenerating the bundle. |

## What this design does not provide

- PostgreSQL replication alone is not full artifact high availability.
- A standby does not serve artifacts already uploaded only to the primary.
- A local disk health check does not prove that a backup is restorable; run the documented backup and restore verification separately.
- Hyper-V execution is a primary-host capability. A standby control plane does not execute jobs unless a separately designed worker topology is introduced.
- The local process runner is also primary-host only and runs static checks with host permissions; it is not a substitute for Hyper-V isolation.

For a single host, SQLite plus the local `data/blobs` directory is the simplest setup. For a failover pair, use shared PostgreSQL and a stable primary blob endpoint. For artifact-level recovery across host loss, back up or replicate the blob directory and test restoration independently from the PostgreSQL backup.

# Assessment Notes

## Architecture and business rules

ProjectFlow is a pnpm/Turborepo monorepo. `apps/api` is NestJS with Mongoose and MongoDB; `apps/web` is a Next.js App Router client; `packages/shared` carries the API-facing types and enums. API controllers validate DTOs and delegate business rules to services. Authentication is a global JWT guard. `ProjectAccessService` resolves organization and project roles and is the authorization boundary for project-scoped resources. The browser uses one API client and TanStack Query query keys for server state; local component state is limited to UI concerns such as member filtering.

The main relationships are User → OrganizationMember → Organization, Organization → Project, Project → ProjectMember → User, and Project → Task → Comment. A task's `createdBy` is immutable provenance, while nullable `assignee` is its current responsibility. An assignee must have an explicit project-membership row. OWNER, ADMIN and PROJECT_MANAGER can assign any project member; a regular MEMBER may assign or remove only themselves. Activity is deliberately limited to assignee changes.

Business logic is in `TasksService`, `ProjectsService`, `CommentsService`, and `ProjectAccessService`, rather than controllers or frontend checks. The task detail UI requests task, project members and assignment activity independently, and invalidates/synchronizes relevant TanStack Query entries after a mutation.

## Risks found and disposition

The original status mutation accepted no acting user and performed no project access check. That was an IDOR: any authenticated user who knew a task ObjectId could change its status. It is fixed now because it is a direct cross-project integrity issue, and regression tests cover all task mutation paths.

The former `countDocuments({ projectId }) + 1` allocator raced under concurrent requests. It is fixed now with an atomic project-local counter and a unique compound task-number index. Existing databases need a migration because a missing/stale counter could otherwise begin at the wrong number; this is handled by an idempotent command and documented deployment order.

Task and activity are separate documents. A standalone MongoDB deployment cannot atomically write both without a transaction. The current code uses a compensating rollback if activity insertion fails, which is appropriate for the existing single-node test topology but has a narrow failure window if the rollback itself fails. A replica-set transaction is deferred until the deployment topology guarantees transaction support.

## Task-number concurrency and migration

`Project.nextTaskNumber` stores the next number to allocate, defaulting to `1`. Creation atomically uses `$inc` and reads the pre-update value, so every successful allocator call receives a unique number without application locking. The task key remains `${project.key}-${number}`. The database also enforces a unique `{ projectId: 1, number: 1 }` index; this protects against programming mistakes, manually corrupted counters, and concurrent legacy deployment anomalies.

`pnpm --filter @projectflow/api migrate:task-counters` is the safe rollout step. It scans each project, finds its greatest numeric task number, calculates `max + 1` (or `1` for no tasks), and applies `$max` to `nextTaskNumber`. `$max` makes the operation idempotent and guarantees it never moves a safe counter backward. Deploy order is: build the new API, run the migration against the production database, verify the index, then start API instances using the allocator. The create path also handles a task-number duplicate once: it derives a repaired counter from the current maximum and retries. This fallback is not a substitute for the migration; it can leave harmless gaps after a failed insert, which is the tradeoff for maintaining a simple monotonic sequence without locking.

## Code Review

The supplied insecure `assignTask` implementation should not be accepted as-is if it only loads the task, accepts an arbitrary user ID, changes an assignment and saves. Correctness requires treating null as an intentional unassignment, retaining `createdBy` independently, rejecting no-op changes without a false audit event, and recording prior and next assignees. Authorization must first establish access to the task's project, then distinguish managers/elevated organization roles from a regular member assigning only themselves. Checking that a target user exists is insufficient: the target must be an explicit member of the same project, otherwise the method permits cross-project assignment.

Security and data consistency are backend responsibilities; a frontend selector is never sufficient. The controller should only parse IDs and validate the DTO. The service should use `ProjectAccessService` and project-membership queries, return clear 403/404 errors, and preserve a single authorization pattern for every mutation. The activity query should fetch a page first and resolve all referenced users with one `$in` query rather than loading one actor per row. For strict audit consistency, task and activity should be in a Mongo transaction when the database runs as a replica set; until then, a documented compensating rollback is preferable to silently losing audit history.

## Scaling the Activity System

At current scale, task-scoped activity is a straightforward write-on-change/read-on-task-detail workload. The primary query is `taskId`, newest first, with a bounded page. The compound `{ taskId: 1, createdAt: -1, _id: -1 }` index matches that query and provides a deterministic tie-breaker. User resolution is intentionally batched so a page does not create N extra database queries. Keep projections small: an activity needs IDs, transition values and time; rendering obtains only safe user-summary fields.

Offset pagination is suitable for short task histories and preserves the application’s established response shape. It becomes expensive for deep history because the server must skip increasing numbers of index entries and because inserts can move page boundaries. Once activity is routinely browsed deeply or becomes one of the largest collections, introduce a cursor composed of `createdAt` and `_id`. The same ordering index supports a cursor predicate, avoids large skips, and makes live append behavior predictable. Continue offering offset pages only where existing clients require them during migration.

Retention should be driven by product and audit needs, not by an arbitrary database limit. Keep recent, user-visible activity in the primary collection. If history grows from thousands toward millions of users, archive old records by age and organization/project policy to cheaper storage, with controlled retrieval or export for audit requests. Deleting activity is only appropriate once legal, contractual and support requirements are understood. Activity records should remain immutable; profile changes should not rewrite historical records, which is why user IDs rather than copied names are stored.

Writes are synchronous today because an assignee change needs an audit record before it is presented as complete. At higher volume, noncritical downstream work—notifications, analytics, search indexing and reporting—can be emitted through a durable outbox and processed by background workers. That evolution should follow measured request latency or retry pressure, not precede it. The assignment itself and its audit transition remain in the primary write path, ideally inside a transaction when supported.

Real-time activity is optional. If collaboration requires it, publish only after the durable write succeeds, scope subscriptions by task/project authorization, and let reconnecting clients catch up through the paginated API. Avoid using a real-time channel as the source of truth. Cache stable user summaries carefully, with profile-change invalidation; avoid caching mutable first pages of activity unless cache keys and invalidation make freshness guarantees explicit.

Observability should include activity write failures, rollback failures, request latency, slow query/index use, page-depth distribution, activity collection growth, archive lag, and eventual queue lag. These measurements show whether the next investment should be a cursor migration, index adjustment, archival, partitioning, or asynchronous fan-out. Partitioning or sharding is not justified merely by user count; choose it only after query distribution and hot-project behavior demonstrate a bottleneck.

## If I Had Two More Days

I would run the counter migration against a production-like restored dataset and rehearse the deployment/index checks. Next I would switch assignment plus activity to a transaction in a replica-set environment and add fault-injection coverage for rollback failures. Finally, I would add cursor pagination and an operational retention/archival plan before activity history becomes a high-volume dataset.

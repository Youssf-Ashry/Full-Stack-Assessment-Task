# Task mutation authorization investigation

## Root cause

`PATCH /tasks/:taskId/status` called `TasksService.updateStatus` without the authenticated user ID. The service loaded a task by ID and saved the new status without checking `ProjectAccessService`.

## Impact

Any authenticated user who knew or guessed a task ObjectId could change its status, including a task in a project they could not view.

## Reproduction

Create a task in project A, authenticate as a user with no membership in A, then call `PATCH /tasks/<id>/status` with a valid status. Before this change it returned 200.

## Fix

The controller now passes the current user and the service calls `assertCanView`; it then applies the same manager-or-creator edit rule used by general task updates.

## Regression prevention

Integration tests cover cross-project general update, status update, assignment and deletion attempts. Every task mutation now accepts an acting user and resolves project access before writing.

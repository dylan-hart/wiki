# Decision: elevated-group guard on user-route membership changes

Status: **Adopted** — OpenProject #3571.

## Decision

`ELEVATED_PERMISSIONS` (`models/groups.ts`) is `manage:users`, `manage:groups` and `manage:system`.
A caller of `POST /users` or `PUT /users/:userId` may add or remove membership of a group carrying
any of them (the root administrators group always counts) only if they hold `manage:groups` or
`manage:system`. Adding a group that carries `manage:system` still needs `manage:system` itself.
`Groups.assertMembershipChangeAllowed(req, before, after)` is the one implementation; it compares
the two membership lists, so a removal is covered and resending an unchanged membership is not
refused. `POST /users` passes `[]` as `before`, which closes creating an account directly inside a
`manage:system` group (`models/users.createUser` applies no group guard of its own).

## Why

Group permissions are not `manage:system`-only: `PUT /groups/:groupId` needs plain `manage:groups`
and refuses only toggling `manage:system` itself and editing the root administrators group. That made
`manage:users` a two-step route to `manage:groups`: join any group that carries it, then edit group
permissions. The same shape reaches `manage:system` groups through create-user.

## What is deliberately left open

- **`manage:groups` is effectively everything short of `manage:system`.** It can edit the
  permissions of any non-system group, so it can grant `manage:users` to a group and then assign
  users to it (`POST /groups/:groupId/users/:userId`). That is by design and is not guarded.
- **`manage:users` holders can still join groups carrying non-elevated permissions**
  (`manage:sites`, `manage:theme`, ...). A general "cannot grant what you do not hold" cap was
  considered and not chosen.
- Upstream's `write:users`/`write:groups` rungs (upstream `76845ab46`) do not exist here and were not
  imported.

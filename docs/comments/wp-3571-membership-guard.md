# Comment recommendations: OpenProject #3571

## `backend/api/users/admin.ts`, `PUT /:userId`, above `assertMembershipChangeAllowed`

The existing block comment ("Handing somebody `manage:system` by putting them in a group that
carries it. Only ADDING is checked ...") no longer matches the code. Suggested replacement:

```
/*
  Adding or removing a group carrying manage:users, manage:groups or manage:system is a privilege
  change: see `Groups.assertMembershipChangeAllowed`. A user already in a manage:system group is
  protected by `systemUserGuard` above, which has refused this request before it gets here.
*/
```

## `backend/api/users/admin.ts`, `POST /`, above the `assertMembershipChangeAllowed` call

```
// -> A new account is a membership change from nothing: without this a manage:users holder could
//    create one inside a manage:system group.
```

## `backend/models/groups.ts`

- `ELEVATED_PERMISSIONS`: `/** Groups carrying any of these make joining or leaving them a privilege change. */`
- `elevatedGroupIds()`: `/** Groups carrying an ELEVATED_PERMISSIONS entry, plus the root administrators group whether or not its row carries one. */`
- `assertMembershipChangeAllowed()`: two tiers -- a manage:system group gains members only through a
  manage:system holder; any elevated group gains or loses members only through manage:groups or
  manage:system. Unchanged membership is never refused.

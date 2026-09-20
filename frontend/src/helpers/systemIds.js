/**
 * Ids the backend seeds into every instance at first run, and which the frontend therefore has to
 * recognise by value. Mirrors `systemIds` in `backend/base.yml`.
 */

/**
 * The group every request that isn't signed in belongs to (`systemIds.guestsGroupId`). It is not a
 * group anyone can be enrolled into, renamed or deleted, so the surfaces that list groups to pick
 * from filter it out and `GroupEditOverlay.vue` locks its own name/delete controls against it. A
 * mistyped copy of the literal un-filters it silently -- no error, just the group where it should
 * not be.
 */
export const GUESTS_GROUP_ID = '10000000-0000-4000-8000-000000000001'

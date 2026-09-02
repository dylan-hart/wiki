/**
 * Ids the backend seeds into every instance at first run, and which the frontend therefore has to
 * recognise by value. Mirrors `systemIds` in `backend/base.yml`.
 */

/**
 * The group every request that isn't signed in belongs to (`systemIds.guestsGroupId`). It is not a
 * group anyone can be enrolled into, renamed or deleted, so the surfaces that list groups to pick
 * from filter it out and `GroupEditOverlay.vue` locks its own name/delete controls against it.
 *
 * A literal repeated across six files was one typo away from silently un-filtering the guests
 * group -- there is no error to notice, just the group appearing where it should not.
 */
export const GUESTS_GROUP_ID = '10000000-0000-4000-8000-000000000001'

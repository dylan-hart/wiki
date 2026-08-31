-- Sweep rows already orphaned before the constraint below can be added: a userAvatars row whose id
-- no longer names a users row (the user was deleted before this cascade existed to clean it up).
DELETE FROM "userAvatars" WHERE "id" NOT IN (SELECT "id" FROM "users");
--> statement-breakpoint
ALTER TABLE "userAvatars" ADD CONSTRAINT "userAvatars_id_users_id_fkey" FOREIGN KEY ("id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE TYPE "assetKind" AS ENUM('document', 'image', 'other');--> statement-breakpoint
CREATE TYPE "hookState" AS ENUM('pending', 'success', 'error');--> statement-breakpoint
CREATE TYPE "jobHistoryState" AS ENUM('active', 'completed', 'failed', 'interrupted');--> statement-breakpoint
CREATE TYPE "pagePublishState" AS ENUM('draft', 'published', 'scheduled');--> statement-breakpoint
CREATE TYPE "submissionStatus" AS ENUM('open', 'approved', 'declined');--> statement-breakpoint
CREATE TYPE "syncContentType" AS ENUM('page', 'asset');--> statement-breakpoint
CREATE TYPE "syncDirection" AS ENUM('push', 'pull');--> statement-breakpoint
CREATE TYPE "treeNavigationMode" AS ENUM('inherit', 'override', 'overrideExact', 'hide', 'hideExact');--> statement-breakpoint
CREATE TYPE "treeNavigationSource" AS ENUM('static', 'auto', 'mixed');--> statement-breakpoint
CREATE TYPE "treeType" AS ENUM('folder', 'page', 'asset');--> statement-breakpoint
CREATE TABLE "apiKeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) NOT NULL,
	"keyShort" varchar(8) NOT NULL,
	"groups" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"scope" jsonb DEFAULT 'null',
	"siteId" uuid,
	"allowedClassifications" jsonb DEFAULT 'null',
	"userId" uuid,
	"expiration" timestamp with time zone DEFAULT now() NOT NULL,
	"isRevoked" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvalRules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) DEFAULT '' NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"match" varchar(16) DEFAULT 'START' NOT NULL,
	"path" varchar(2048) DEFAULT '' NOT NULL,
	"submitterGroups" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reviewerGroups" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"minApprovals" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"fileName" varchar(255) NOT NULL,
	"fileExt" varchar(255) NOT NULL,
	"isSystem" boolean DEFAULT false NOT NULL,
	"kind" "assetKind" DEFAULT 'other'::"assetKind" NOT NULL,
	"mimeType" varchar(255) DEFAULT 'application/octet-stream' NOT NULL,
	"fileSize" bigint,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"data" bytea,
	"preview" bytea,
	"authorId" uuid NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditLog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"event" varchar(64) NOT NULL,
	"actorId" uuid,
	"actorName" varchar(255) DEFAULT '' NOT NULL,
	"actorIp" varchar(64) DEFAULT '' NOT NULL,
	"targetType" varchar(32) DEFAULT '' NOT NULL,
	"targetId" varchar(255) DEFAULT '' NOT NULL,
	"targetLabel" varchar(255) DEFAULT '' NOT NULL,
	"detail" jsonb DEFAULT '{}' NOT NULL,
	"siteId" uuid,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authentication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"module" varchar(255) NOT NULL,
	"isEnabled" boolean DEFAULT false NOT NULL,
	"displayName" varchar(255) DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"selfRegistration" boolean DEFAULT false NOT NULL,
	"autoProvision" boolean DEFAULT false NOT NULL,
	"allowedEmailRegex" varchar(255) DEFAULT '' NOT NULL,
	"allowedEmailDomains" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"autoEnrollGroups" uuid[] DEFAULT '{}'::uuid[],
	"trustEmailForLinking" boolean DEFAULT false NOT NULL,
	"mappableGroups" uuid[] DEFAULT '{}'::uuid[]
);
--> statement-breakpoint
CREATE TABLE "blockCode" (
	"blockId" uuid PRIMARY KEY,
	"code" bytea NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blockCredentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"secret" text NOT NULL,
	"allowedOrigins" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"block" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(255) NOT NULL,
	"icon" varchar(255) NOT NULL,
	"isEnabled" boolean DEFAULT false NOT NULL,
	"isCustom" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"props" jsonb DEFAULT '[]' NOT NULL,
	"template" text DEFAULT '' NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklistExecutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"pageId" uuid NOT NULL,
	"blockKey" varchar(255) NOT NULL,
	"itemCount" integer NOT NULL,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"startedBy" uuid,
	"completedAt" timestamp with time zone,
	"completedBy" uuid
);
--> statement-breakpoint
CREATE TABLE "checklistItemChecks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"executionId" uuid NOT NULL,
	"itemKey" varchar(255) NOT NULL,
	"checkedBy" uuid,
	"checkedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classificationLevels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commentProviders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"module" varchar(255) NOT NULL,
	"isEnabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"content" text NOT NULL,
	"render" text,
	"guestName" varchar(255),
	"guestEmail" varchar(255),
	"guestIp" varchar(45),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"pageId" uuid NOT NULL,
	"siteId" uuid NOT NULL,
	"authorId" uuid,
	"replyTo" uuid
);
--> statement-breakpoint
CREATE TABLE "contentSyncState" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"contentType" "syncContentType" NOT NULL,
	"contentId" uuid NOT NULL,
	"targetId" uuid NOT NULL,
	"lastDirection" "syncDirection",
	"targetRef" jsonb,
	"lastSyncedAt" timestamp with time zone,
	"lastError" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eventSubscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"userId" uuid NOT NULL,
	"event" varchar(64) NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossaryTerms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"term" varchar(255) NOT NULL,
	"definition" text NOT NULL,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"siteId" uuid NOT NULL,
	"pageId" uuid
);
--> statement-breakpoint
CREATE TABLE "glossaryVersions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"termCount" integer NOT NULL,
	"actorId" uuid,
	"actorName" varchar(255) DEFAULT '' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) NOT NULL,
	"permissions" jsonb NOT NULL,
	"rules" jsonb NOT NULL,
	"redirectOnLogin" varchar(255) DEFAULT '' NOT NULL,
	"redirectOnFirstLogin" varchar(255) DEFAULT '' NOT NULL,
	"redirectOnLogout" varchar(255) DEFAULT '' NOT NULL,
	"isSystem" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" varchar(255) NOT NULL,
	"events" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"url" text NOT NULL,
	"includeMetadata" boolean DEFAULT true NOT NULL,
	"includeContent" boolean DEFAULT false NOT NULL,
	"acceptUntrusted" boolean DEFAULT false NOT NULL,
	"authHeader" text,
	"state" "hookState" DEFAULT 'pending'::"hookState" NOT NULL,
	"lastErrorMessage" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"siteId" uuid
);
--> statement-breakpoint
CREATE TABLE "iconSets" (
	"prefix" varchar(64) PRIMARY KEY,
	"name" varchar(255) NOT NULL,
	"isEnabled" boolean DEFAULT true NOT NULL,
	"info" jsonb DEFAULT '{}' NOT NULL,
	"refreshedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "icons" (
	"prefix" varchar(64),
	"name" varchar(255),
	"body" text NOT NULL,
	"width" integer DEFAULT 16 NOT NULL,
	"height" integer DEFAULT 16 NOT NULL,
	"left" integer DEFAULT 0 NOT NULL,
	"top" integer DEFAULT 0 NOT NULL,
	"rotate" integer DEFAULT 0 NOT NULL,
	"hFlip" boolean DEFAULT false NOT NULL,
	"vFlip" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "icons_pkey" PRIMARY KEY("prefix","name")
);
--> statement-breakpoint
CREATE TABLE "jobHistory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"task" varchar(255) NOT NULL,
	"state" "jobHistoryState" NOT NULL,
	"useWorker" boolean DEFAULT false NOT NULL,
	"wasScheduled" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"attempt" integer DEFAULT 1 NOT NULL,
	"maxRetries" integer DEFAULT 0 NOT NULL,
	"lastErrorMessage" text,
	"executedBy" varchar(255),
	"createdAt" timestamp with time zone NOT NULL,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"completedAt" timestamp with time zone,
	"result" jsonb
);
--> statement-breakpoint
CREATE TABLE "jobLock" (
	"key" varchar(255) PRIMARY KEY,
	"lastCheckedBy" varchar(255),
	"lastCheckedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobSchedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"task" varchar(255) NOT NULL,
	"cron" varchar(255) NOT NULL,
	"type" varchar(255) DEFAULT 'system' NOT NULL,
	"payload" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"task" varchar(255) NOT NULL,
	"useWorker" boolean DEFAULT false NOT NULL,
	"payload" jsonb,
	"retries" integer DEFAULT 0 NOT NULL,
	"maxRetries" integer DEFAULT 0 NOT NULL,
	"waitUntil" timestamp with time zone,
	"isScheduled" boolean DEFAULT false NOT NULL,
	"createdBy" varchar(255),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locales" (
	"code" varchar(255) PRIMARY KEY,
	"name" varchar(255) NOT NULL,
	"nativeName" varchar(255) NOT NULL,
	"language" varchar(8) NOT NULL,
	"region" varchar(3) NOT NULL,
	"script" varchar(4) NOT NULL,
	"isRTL" boolean DEFAULT false NOT NULL,
	"strings" jsonb DEFAULT '[]' NOT NULL,
	"completeness" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "navigation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"items" jsonb DEFAULT '[]' NOT NULL,
	"mode" "treeNavigationSource" DEFAULT 'static'::"treeNavigationSource" NOT NULL,
	"locale" varchar(255),
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pageDrafts" (
	"pageId" uuid PRIMARY KEY,
	"siteId" uuid NOT NULL,
	"state" bytea NOT NULL,
	"authorId" uuid,
	"authorName" varchar(255),
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pageEditSubmissionApprovals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"submissionId" uuid NOT NULL,
	"reviewerId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pageEditSubmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"content" text NOT NULL,
	"patch" text NOT NULL,
	"baseHash" varchar(64) NOT NULL,
	"guestName" varchar(255),
	"guestEmail" varchar(255),
	"status" "submissionStatus" DEFAULT 'open'::"submissionStatus" NOT NULL,
	"resolvedReason" text,
	"resolvedBy" uuid,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"pageId" uuid NOT NULL,
	"siteId" uuid NOT NULL,
	"authorId" uuid
);
--> statement-breakpoint
CREATE TABLE "pageHistory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"pageId" uuid NOT NULL,
	"action" varchar(16) DEFAULT 'updated' NOT NULL,
	"via" varchar(16) DEFAULT 'editor' NOT NULL,
	"changedFields" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"locale" varchar(255) NOT NULL,
	"path" varchar(255) NOT NULL,
	"title" varchar(255) NOT NULL,
	"content" text,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"reason" varchar(255),
	"versionDate" timestamp with time zone DEFAULT now() NOT NULL,
	"authorId" uuid,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pageRenderQueue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"allowScripts" boolean DEFAULT false NOT NULL,
	"allowStyles" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"pageId" uuid NOT NULL UNIQUE,
	"siteId" uuid NOT NULL,
	"requestedById" uuid
);
--> statement-breakpoint
CREATE TABLE "pageWatchEvents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"action" varchar(16) NOT NULL,
	"changedFields" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"deliveredAt" timestamp with time zone,
	"readAt" timestamp with time zone,
	"pageId" uuid NOT NULL,
	"pageTitle" text NOT NULL,
	"pagePath" text NOT NULL,
	"pageLocale" text DEFAULT 'en' NOT NULL,
	"siteId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"actorId" uuid,
	"notifyMode" varchar(16) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pageWatching" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"pageId" uuid NOT NULL,
	"siteId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"notifyMode" varchar(16),
	"notifyOnEdited" boolean,
	"notifyOnMoved" boolean,
	"notifyOnDeleted" boolean
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"locale" varchar(255) NOT NULL,
	"path" varchar(255) NOT NULL,
	"hash" varchar(255) NOT NULL,
	"alias" varchar(255),
	"title" varchar(255) NOT NULL,
	"description" varchar(255),
	"icon" varchar(255),
	"publishState" "pagePublishState" DEFAULT 'draft'::"pagePublishState" NOT NULL,
	"publishStartDate" timestamp with time zone,
	"publishEndDate" timestamp with time zone,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"relations" jsonb DEFAULT '[]' NOT NULL,
	"links" jsonb DEFAULT '[]' NOT NULL,
	"content" text,
	"render" text,
	"searchContent" text,
	"ts" tsvector,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"toc" jsonb,
	"editor" varchar(255) NOT NULL,
	"contentType" varchar(255) NOT NULL,
	"isBrowsable" boolean DEFAULT true NOT NULL,
	"isSearchable" boolean DEFAULT true NOT NULL,
	"password" varchar(255),
	"historyData" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"authorId" uuid NOT NULL,
	"creatorId" uuid NOT NULL,
	"ownerId" uuid NOT NULL,
	"siteId" uuid NOT NULL,
	"classification" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pageviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"siteId" uuid NOT NULL,
	"pageId" uuid NOT NULL,
	"clientType" varchar(16) NOT NULL,
	"visitorHash" text NOT NULL,
	"viewedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rateLimits" (
	"key" varchar(255) PRIMARY KEY,
	"hits" integer DEFAULT 0 NOT NULL,
	"windowStartedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"bannedUntil" timestamp with time zone,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(255) PRIMARY KEY,
	"userId" uuid,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(255) PRIMARY KEY,
	"value" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "siteAssets" (
	"siteId" uuid,
	"kind" varchar(255),
	"data" bytea NOT NULL,
	"hash" varchar(255) NOT NULL,
	CONSTRAINT "siteAssets_pkey" PRIMARY KEY("siteId","kind")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"hostname" varchar(255) NOT NULL UNIQUE,
	"isEnabled" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"module" varchar(255) NOT NULL,
	"isEnabled" boolean DEFAULT false NOT NULL,
	"contentTypes" jsonb DEFAULT '{}' NOT NULL,
	"assetDelivery" jsonb DEFAULT '{}' NOT NULL,
	"versioning" jsonb DEFAULT '{}' NOT NULL,
	"syncMode" varchar(32) DEFAULT 'push' NOT NULL,
	"scheduleOverride" varchar(32),
	"lastTickAt" timestamp with time zone,
	"config" jsonb DEFAULT '{}' NOT NULL,
	"state" jsonb DEFAULT '{}' NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tag" varchar(255) NOT NULL,
	"usageCount" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tree" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"folderPath" ltree NOT NULL,
	"fileName" varchar(255) NOT NULL,
	"tree" "treeType" NOT NULL,
	"locale" varchar(255) NOT NULL,
	"title" varchar(255) NOT NULL,
	"navigationMode" "treeNavigationMode" DEFAULT 'inherit'::"treeNavigationMode" NOT NULL,
	"navigationId" uuid,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"siteId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "userAvatars" (
	"id" uuid PRIMARY KEY,
	"data" bytea NOT NULL,
	"hash" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "userGroups" (
	"userId" uuid,
	"groupId" uuid,
	CONSTRAINT "userGroups_pkey" PRIMARY KEY("userId","groupId")
);
--> statement-breakpoint
CREATE TABLE "userKeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"kind" varchar(255) NOT NULL,
	"token" varchar(255) NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"validUntil" timestamp with time zone NOT NULL,
	"userId" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" varchar(255) NOT NULL UNIQUE,
	"name" varchar(255) NOT NULL,
	"firstName" varchar(255) DEFAULT '' NOT NULL,
	"lastName" varchar(255) DEFAULT '' NOT NULL,
	"nameLocallyEdited" boolean DEFAULT false NOT NULL,
	"auth" jsonb DEFAULT '{}' NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL,
	"passkeys" jsonb DEFAULT '{}' NOT NULL,
	"prefs" jsonb DEFAULT '{}' NOT NULL,
	"hasAvatar" boolean DEFAULT false NOT NULL,
	"isActive" boolean DEFAULT false NOT NULL,
	"isSystem" boolean DEFAULT false NOT NULL,
	"isVerified" boolean DEFAULT false NOT NULL,
	"lastLoginAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "apiKeys_siteId_idx" ON "apiKeys" ("siteId");--> statement-breakpoint
CREATE INDEX "apiKeys_userId_idx" ON "apiKeys" ("userId");--> statement-breakpoint
CREATE INDEX "approvalRules_siteId_idx" ON "approvalRules" ("siteId");--> statement-breakpoint
CREATE INDEX "assets_siteId_idx" ON "assets" ("siteId");--> statement-breakpoint
CREATE INDEX "auditLog_createdAt_idx" ON "auditLog" ("createdAt");--> statement-breakpoint
CREATE INDEX "auditLog_actorId_idx" ON "auditLog" ("actorId","createdAt");--> statement-breakpoint
CREATE INDEX "auditLog_event_idx" ON "auditLog" ("event","createdAt");--> statement-breakpoint
CREATE INDEX "auditLog_siteId_idx" ON "auditLog" ("siteId","createdAt");--> statement-breakpoint
CREATE INDEX "blockCredentials_siteId_idx" ON "blockCredentials" ("siteId");--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_composite_idx" ON "blocks" ("siteId","block");--> statement-breakpoint
CREATE INDEX "checklistExecutions_pageId_blockKey_idx" ON "checklistExecutions" ("pageId","blockKey","startedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "checklistExecutions_active_idx" ON "checklistExecutions" ("pageId","blockKey") WHERE "completedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "checklistItemChecks_execution_item_idx" ON "checklistItemChecks" ("executionId","itemKey");--> statement-breakpoint
CREATE INDEX "checklistItemChecks_executionId_idx" ON "checklistItemChecks" ("executionId","checkedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "classificationLevels_sortOrder_idx" ON "classificationLevels" ("sortOrder");--> statement-breakpoint
CREATE UNIQUE INDEX "commentProviders_composite_idx" ON "commentProviders" ("siteId","module");--> statement-breakpoint
CREATE INDEX "comments_pageId_idx" ON "comments" ("pageId","createdAt");--> statement-breakpoint
CREATE INDEX "comments_siteId_idx" ON "comments" ("siteId","createdAt");--> statement-breakpoint
CREATE INDEX "comments_authorId_idx" ON "comments" ("authorId");--> statement-breakpoint
CREATE INDEX "comments_replyTo_idx" ON "comments" ("replyTo");--> statement-breakpoint
CREATE UNIQUE INDEX "contentSyncState_target_content_idx" ON "contentSyncState" ("targetId","contentType","contentId");--> statement-breakpoint
CREATE INDEX "contentSyncState_content_idx" ON "contentSyncState" ("contentType","contentId");--> statement-breakpoint
CREATE INDEX "eventSubscriptions_event_idx" ON "eventSubscriptions" ("event");--> statement-breakpoint
CREATE UNIQUE INDEX "eventSubscriptions_user_event_idx" ON "eventSubscriptions" ("userId","event");--> statement-breakpoint
CREATE UNIQUE INDEX "glossaryTerms_composite_idx" ON "glossaryTerms" ("siteId",lower("term"));--> statement-breakpoint
CREATE INDEX "glossaryVersions_siteId_createdAt_idx" ON "glossaryVersions" ("siteId","createdAt");--> statement-breakpoint
CREATE INDEX "hooks_siteId_idx" ON "hooks" ("siteId");--> statement-breakpoint
CREATE INDEX "jobHistory_dispatchWebhook_hookId_idx" ON "jobHistory" ((payload ->> 'hookId')) WHERE "task" = 'dispatchWebhook';--> statement-breakpoint
CREATE INDEX "jobHistory_active_idx" ON "jobHistory" ("startedAt") WHERE "state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "jobSchedule_task_idx" ON "jobSchedule" ("task");--> statement-breakpoint
CREATE INDEX "jobs_waitUntil_createdAt_idx" ON "jobs" ("waitUntil","createdAt");--> statement-breakpoint
CREATE INDEX "locales_language_idx" ON "locales" ("language");--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_siteId_locale_idx" ON "navigation" ("siteId","locale");--> statement-breakpoint
CREATE INDEX "pageDrafts_updatedAt_idx" ON "pageDrafts" ("updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "pageEditSubmissionApprovals_submission_reviewer_idx" ON "pageEditSubmissionApprovals" ("submissionId","reviewerId");--> statement-breakpoint
CREATE INDEX "pageEditSubmissions_pageId_idx" ON "pageEditSubmissions" ("pageId");--> statement-breakpoint
CREATE INDEX "pageEditSubmissions_siteId_idx" ON "pageEditSubmissions" ("siteId");--> statement-breakpoint
CREATE INDEX "pageEditSubmissions_authorId_idx" ON "pageEditSubmissions" ("authorId");--> statement-breakpoint
CREATE UNIQUE INDEX "pageEditSubmissions_page_author_idx" ON "pageEditSubmissions" ("pageId","authorId") WHERE "authorId" IS NOT NULL AND "status" = 'open';--> statement-breakpoint
CREATE INDEX "pageHistory_pageId_idx" ON "pageHistory" ("pageId","versionDate");--> statement-breakpoint
CREATE INDEX "pageHistory_siteId_idx" ON "pageHistory" ("siteId","locale","path","versionDate");--> statement-breakpoint
CREATE INDEX "pageHistory_authorId_idx" ON "pageHistory" ("authorId");--> statement-breakpoint
CREATE INDEX "pageRenderQueue_createdAt_idx" ON "pageRenderQueue" ("createdAt");--> statement-breakpoint
CREATE INDEX "pageWatchEvents_pending_idx" ON "pageWatchEvents" ("userId","notifyMode","createdAt") WHERE "deliveredAt" IS NULL;--> statement-breakpoint
CREATE INDEX "pageWatchEvents_pageId_idx" ON "pageWatchEvents" ("pageId");--> statement-breakpoint
CREATE INDEX "pageWatchEvents_unread_idx" ON "pageWatchEvents" ("userId","siteId","createdAt") WHERE "readAt" IS NULL;--> statement-breakpoint
CREATE INDEX "pageWatching_user_site_idx" ON "pageWatching" ("userId","siteId");--> statement-breakpoint
CREATE UNIQUE INDEX "pageWatching_page_user_idx" ON "pageWatching" ("pageId","userId");--> statement-breakpoint
CREATE INDEX "pages_authorId_idx" ON "pages" ("authorId");--> statement-breakpoint
CREATE INDEX "pages_creatorId_idx" ON "pages" ("creatorId");--> statement-breakpoint
CREATE INDEX "pages_ownerId_idx" ON "pages" ("ownerId");--> statement-breakpoint
CREATE INDEX "pages_classification_idx" ON "pages" ("classification");--> statement-breakpoint
CREATE INDEX "pages_ts_idx" ON "pages" USING gin ("ts");--> statement-breakpoint
CREATE INDEX "pages_tags_idx" ON "pages" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "pages_title_trgm_idx" ON "pages" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "pages_siteId_locale_path_idx" ON "pages" ("siteId","locale","path");--> statement-breakpoint
CREATE INDEX "pages_siteId_locale_hash_idx" ON "pages" ("siteId","locale","hash");--> statement-breakpoint
CREATE INDEX "pageviews_siteId_pageId_clientType_viewedAt_visitorHash_idx" ON "pageviews" ("siteId","pageId","clientType","viewedAt","visitorHash");--> statement-breakpoint
CREATE INDEX "pageviews_viewedAt_idx" ON "pageviews" ("viewedAt");--> statement-breakpoint
CREATE INDEX "rateLimits_updatedAt_idx" ON "rateLimits" ("updatedAt");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_composite_idx" ON "storage" ("siteId","module");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_composite_idx" ON "tags" ("siteId","tag");--> statement-breakpoint
CREATE INDEX "tree_folderpath_idx" ON "tree" ("folderPath");--> statement-breakpoint
CREATE INDEX "tree_folderpath_gist_idx" ON "tree" USING gist ("folderPath");--> statement-breakpoint
CREATE INDEX "tree_folderpath_filename_gist_idx" ON "tree" USING gist (("folderPath" || "fileName"));--> statement-breakpoint
CREATE INDEX "tree_fileName_idx" ON "tree" ("fileName");--> statement-breakpoint
CREATE INDEX "tree_type_idx" ON "tree" ("tree");--> statement-breakpoint
CREATE INDEX "tree_locale_idx" ON "tree" ("locale");--> statement-breakpoint
CREATE INDEX "tree_navigationMode_idx" ON "tree" ("navigationMode");--> statement-breakpoint
CREATE INDEX "tree_navigationId_idx" ON "tree" ("navigationId");--> statement-breakpoint
CREATE INDEX "tree_tags_idx" ON "tree" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "tree_siteId_idx" ON "tree" ("siteId");--> statement-breakpoint
CREATE UNIQUE INDEX "tree_composite_page_idx" ON "tree" ("siteId","locale","folderPath","fileName") WHERE "tree" = 'page';--> statement-breakpoint
CREATE UNIQUE INDEX "tree_composite_nonpage_idx" ON "tree" ("siteId","locale","folderPath","fileName") WHERE "tree" <> 'page';--> statement-breakpoint
CREATE INDEX "userGroups_groupId_idx" ON "userGroups" ("groupId");--> statement-breakpoint
CREATE INDEX "userKeys_userId_idx" ON "userKeys" ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "userKeys_token_idx" ON "userKeys" ("token");--> statement-breakpoint
CREATE INDEX "users_lastLoginAt_idx" ON "users" ("lastLoginAt");--> statement-breakpoint
ALTER TABLE "apiKeys" ADD CONSTRAINT "apiKeys_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "apiKeys" ADD CONSTRAINT "apiKeys_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "approvalRules" ADD CONSTRAINT "approvalRules_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "auditLog" ADD CONSTRAINT "auditLog_actorId_users_id_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "auditLog" ADD CONSTRAINT "auditLog_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "blockCode" ADD CONSTRAINT "blockCode_blockId_blocks_id_fkey" FOREIGN KEY ("blockId") REFERENCES "blocks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "blockCredentials" ADD CONSTRAINT "blockCredentials_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_startedBy_users_id_fkey" FOREIGN KEY ("startedBy") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "checklistExecutions" ADD CONSTRAINT "checklistExecutions_completedBy_users_id_fkey" FOREIGN KEY ("completedBy") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "checklistItemChecks" ADD CONSTRAINT "checklistItemChecks_executionId_checklistExecutions_id_fkey" FOREIGN KEY ("executionId") REFERENCES "checklistExecutions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "checklistItemChecks" ADD CONSTRAINT "checklistItemChecks_checkedBy_users_id_fkey" FOREIGN KEY ("checkedBy") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "commentProviders" ADD CONSTRAINT "commentProviders_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_replyTo_comments_id_fkey" FOREIGN KEY ("replyTo") REFERENCES "comments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "contentSyncState" ADD CONSTRAINT "contentSyncState_targetId_storage_id_fkey" FOREIGN KEY ("targetId") REFERENCES "storage"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "eventSubscriptions" ADD CONSTRAINT "eventSubscriptions_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "glossaryTerms" ADD CONSTRAINT "glossaryTerms_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "glossaryTerms" ADD CONSTRAINT "glossaryTerms_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "glossaryVersions" ADD CONSTRAINT "glossaryVersions_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "glossaryVersions" ADD CONSTRAINT "glossaryVersions_actorId_users_id_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hooks" ADD CONSTRAINT "hooks_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "icons" ADD CONSTRAINT "icons_prefix_iconSets_prefix_fkey" FOREIGN KEY ("prefix") REFERENCES "iconSets"("prefix");--> statement-breakpoint
ALTER TABLE "navigation" ADD CONSTRAINT "navigation_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageDrafts" ADD CONSTRAINT "pageDrafts_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pageEditSubmissionApprovals" ADD CONSTRAINT "pageEditSubmissionApprovals_dRAFOzuOik4S_fkey" FOREIGN KEY ("submissionId") REFERENCES "pageEditSubmissions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageEditSubmissionApprovals" ADD CONSTRAINT "pageEditSubmissionApprovals_reviewerId_users_id_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD CONSTRAINT "pageEditSubmissions_resolvedBy_users_id_fkey" FOREIGN KEY ("resolvedBy") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD CONSTRAINT "pageEditSubmissions_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD CONSTRAINT "pageEditSubmissions_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageEditSubmissions" ADD CONSTRAINT "pageEditSubmissions_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageHistory" ADD CONSTRAINT "pageHistory_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pageHistory" ADD CONSTRAINT "pageHistory_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageRenderQueue" ADD CONSTRAINT "pageRenderQueue_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageRenderQueue" ADD CONSTRAINT "pageRenderQueue_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageRenderQueue" ADD CONSTRAINT "pageRenderQueue_requestedById_users_id_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD CONSTRAINT "pageWatchEvents_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD CONSTRAINT "pageWatchEvents_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageWatchEvents" ADD CONSTRAINT "pageWatchEvents_actorId_users_id_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "pageWatching" ADD CONSTRAINT "pageWatching_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageWatching" ADD CONSTRAINT "pageWatching_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pageWatching" ADD CONSTRAINT "pageWatching_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_authorId_users_id_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_creatorId_users_id_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_ownerId_users_id_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_classification_classificationLevels_id_fkey" FOREIGN KEY ("classification") REFERENCES "classificationLevels"("id");--> statement-breakpoint
ALTER TABLE "pageviews" ADD CONSTRAINT "pageviews_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pageviews" ADD CONSTRAINT "pageviews_pageId_pages_id_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "siteAssets" ADD CONSTRAINT "siteAssets_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "storage" ADD CONSTRAINT "storage_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tree" ADD CONSTRAINT "tree_navigationId_navigation_id_fkey" FOREIGN KEY ("navigationId") REFERENCES "navigation"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "tree" ADD CONSTRAINT "tree_siteId_sites_id_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id");--> statement-breakpoint
ALTER TABLE "userAvatars" ADD CONSTRAINT "userAvatars_id_users_id_fkey" FOREIGN KEY ("id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "userGroups" ADD CONSTRAINT "userGroups_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "userGroups" ADD CONSTRAINT "userGroups_groupId_groups_id_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "userKeys" ADD CONSTRAINT "userKeys_userId_users_id_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id");
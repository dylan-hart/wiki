import { analytics } from './analytics.ts'
import { apiKeys } from './apiKeys.ts'
import { approvalNotifications } from './approvalNotifications.ts'
import { approvalRules } from './approvalRules.ts'
import { approvals } from './approvals.ts'
import { assetServing } from './assetServing.ts'
import { assets } from './assets.ts'
import { auditLog } from './auditLog.ts'
import { authentication } from './authentication.ts'
import { blockCredentials } from './blockCredentials.ts'
import { blocks } from './blocks.ts'
import { checklists } from './checklists.ts'
import { classificationLevels } from './classificationLevels.ts'
import { commentProviders } from './commentProviders.ts'
import { comments } from './comments.ts'
import { contentSync } from './contentSync.ts'
import { diagramRender } from './diagramRender.ts'
import { exportModel } from './export.ts'
import { extensions } from './extensions.ts'
import { flags } from './flags.ts'
import { glossary } from './glossary.ts'
import { groups } from './groups.ts'
import { hooks } from './hooks.ts'
import { icons } from './icons.ts'
import { pageImport } from './import.ts'
import { importModel as siteImportModel } from './siteImport.ts'
import { jobs } from './jobs.ts'
import { liveData } from './liveData.ts'
import { locales } from './locales.ts'
import { login } from './login.ts'
import { mail } from './mail.ts'
import { navigation } from './navigation.ts'
import { pageHistory } from './pageHistory.ts'
import { pageProblems } from './pageProblems.ts'
import { pages } from './pages.ts'
import { pageWatchEvents } from './pageWatchEvents.ts'
import { pageWatching } from './pageWatching.ts'
import { pageviews } from './pageviews.ts'
import { passkeys } from './passkeys.ts'
import { pdfExport } from './pdfExport.ts'
import { rateLimits } from './rateLimits.ts'
import { renderQueue } from './renderQueue.ts'
import { rendering } from './rendering.ts'
import { search } from './search.ts'
import { security } from './security.ts'
import { sessions } from './sessions.ts'
import { settings } from './settings.ts'
import { sites } from './sites.ts'
import { storage } from './storage.ts'
import { tags } from './tags.ts'
import { tree } from './tree.ts'
import { userCredentials } from './userCredentials.ts'
import { users } from './users.ts'

export default {
  analytics,
  apiKeys,
  approvalNotifications,
  approvalRules,
  approvals,
  assetServing,
  assets,
  auditLog,
  authentication,
  blockCredentials,
  blocks,
  checklists,
  classificationLevels,
  commentProviders,
  comments,
  contentSync,
  diagramRender,
  export: exportModel,
  extensions,
  flags,
  glossary,
  groups,
  hooks,
  icons,
  pageImport,
  import: siteImportModel,
  jobs,
  liveData,
  locales,
  login,
  mail,
  navigation,
  pageHistory,
  pageProblems,
  pages,
  pageWatchEvents,
  pageWatching,
  pageviews,
  passkeys,
  pdfExport,
  rateLimits,
  renderQueue,
  rendering,
  search,
  security,
  sessions,
  settings,
  sites,
  storage,
  tags,
  tree,
  userCredentials,
  users
}

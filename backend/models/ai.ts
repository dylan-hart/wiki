import path from 'node:path'
import { maskSensitiveConfig } from '../helpers/moduleProps.ts'
import {
  loadModule,
  mergeModuleConfig,
  moduleHasFile,
  readModuleDefinitions,
  validateModuleConfig
} from '../helpers/moduleRegistry.ts'
import { withTimeout } from '../helpers/timeout.ts'
import type { ModuleProp } from '../helpers/moduleProps.ts'

export const AI_GENERATE_TIMEOUT_MS = 60_000

export interface AiProviderContext {
  siteId: string
  system?: string
  maxOutputTokens?: number
  signal?: AbortSignal
}

export type AiProviderGenerate = (
  prompt: string,
  context: AiProviderContext,
  config: Record<string, any>
) => Promise<string | null>

export interface AiGenerateOptions {
  system?: string
  maxOutputTokens?: number
  signal?: AbortSignal
  timeoutMs?: number
}

export type AiUnavailableReason = 'offline' | 'noProvider' | 'noImplementation' | 'notConfigured'

export interface AiAvailability {
  available: boolean
  provider: string | null
  reason: AiUnavailableReason | null
}

export interface AiProviderDefinition {
  key: string
  title: string
  description: string
  icon?: string
  logo?: string
  vendor: string
  website: string
  props: Record<string, ModuleProp>
}

export interface AiProvider extends AiProviderDefinition {
  hasImplementation: boolean
  isSelected: boolean
  config: Record<string, any>
}

class AiTimeoutError extends Error {
  override name = 'AiTimeoutError'
}

class Ai {
  definitions: AiProviderDefinition[] = []

  modules: Record<string, AiProviderGenerate> = {}

  async refreshFromDisk(): Promise<void> {
    const aiPath = path.join(CARDINAL.SERVERPATH, 'modules/ai')
    try {
      const definitions = await readModuleDefinitions<AiProviderDefinition>(aiPath, {
        parseProps: true,
        sortPropsByOrder: true
      })
      this.definitions = definitions.sort((a, b) => a.title.localeCompare(b.title))
      CARDINAL.logger.debug('ext', 'loaded module definitions', {
        kind: 'ai',
        modules: this.definitions.length
      })
    } catch (err: any) {
      this.definitions = []
      if (err?.code === 'ENOENT' && err?.path === aiPath) {
        CARDINAL.logger.debug('ext', 'no ai provider modules installed', { kind: 'ai' })
        return
      }
      CARDINAL.logger.error('ext', 'reading the module definitions failed', {
        kind: 'ai',
        path: aiPath,
        error: err
      })
    }
  }

  async hasImplementation(key: string): Promise<boolean> {
    return moduleHasFile(CARDINAL.SERVERPATH, 'modules/ai', key, 'ai.ts')
  }

  getDefinition(key: string): AiProviderDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  async ensureModule(key: string): Promise<AiProviderGenerate | null> {
    const loaded = await loadModule(
      this.modules,
      key,
      () => import(`../modules/ai/${key}/ai.ts`),
      'ai',
      () => this.hasImplementation(key)
    )
    return typeof loaded === 'function' ? loaded : null
  }

  getSelectedKey(siteId: string): string {
    const selected = CARDINAL.sites[siteId]?.config?.ai?.provider
    return typeof selected === 'string' ? selected : ''
  }

  getProviderConfig(siteId: string, key: string): Record<string, any> {
    const stored = (CARDINAL.sites[siteId]?.config?.ai?.providers?.[key] ?? {}) as Record<
      string,
      any
    >
    return this.buildProviderConfig(key, {}, stored)
  }

  buildProviderConfig(
    key: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return mergeModuleConfig(this.getDefinition(key)?.props ?? {}, incoming, existing)
  }

  validateProviderConfig(
    key: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): string | null {
    const definition = this.getDefinition(key)
    return validateModuleConfig(definition?.props ?? {}, incoming, {
      refuseUnknown: true,
      requiredAndPattern: true,
      moduleTitle: definition?.title ?? key,
      existing
    })
  }

  async getSiteProviders(
    siteId: string,
    { mask = false }: { mask?: boolean } = {}
  ): Promise<AiProvider[]> {
    const selected = this.getSelectedKey(siteId)
    const providers: AiProvider[] = []
    for (const definition of this.definitions) {
      const config = this.getProviderConfig(siteId, definition.key)
      providers.push({
        key: definition.key,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        logo: definition.logo,
        vendor: definition.vendor,
        website: definition.website,
        props: definition.props,
        hasImplementation: await this.hasImplementation(definition.key),
        isSelected: definition.key === selected,
        config: mask ? maskSensitiveConfig(definition.props, config) : config
      })
    }
    return providers
  }

  async selectProvider(
    siteId: string,
    key: string,
    incoming: Record<string, any> = {}
  ): Promise<boolean> {
    if (!key) {
      return CARDINAL.models.sites.updateSite(siteId, { config: { ai: { provider: '' } } })
    }
    const stored = (CARDINAL.sites[siteId]?.config?.ai?.providers?.[key] ?? {}) as Record<
      string,
      any
    >
    const config = this.buildProviderConfig(key, incoming, stored)
    return CARDINAL.models.sites.updateSite(siteId, {
      config: { ai: { provider: key, providers: { [key]: config } } }
    })
  }

  async availability(siteId: string): Promise<AiAvailability> {
    const key = this.getSelectedKey(siteId)
    if (!key || !this.getDefinition(key)) {
      return { available: false, provider: null, reason: 'noProvider' }
    }
    if (CARDINAL.config?.offline) {
      return { available: false, provider: key, reason: 'offline' }
    }
    if (!(await this.hasImplementation(key))) {
      return { available: false, provider: key, reason: 'noImplementation' }
    }
    if (this.validateProviderConfig(key, {}, this.getProviderConfig(siteId, key))) {
      return { available: false, provider: key, reason: 'notConfigured' }
    }
    return { available: true, provider: key, reason: null }
  }

  async generate(
    siteId: string,
    prompt: string,
    options: AiGenerateOptions = {}
  ): Promise<string | null> {
    let key: string | null = null
    try {
      const status = await this.availability(siteId)
      if (!status.available || !status.provider) {
        return null
      }
      key = status.provider
      const generate = await this.ensureModule(key)
      if (!generate) {
        return null
      }

      const timeoutMs = options.timeoutMs ?? AI_GENERATE_TIMEOUT_MS
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal

      if (signal.aborted) {
        return null
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      aborted.catch(() => {})

      const work = Promise.resolve(
        generate(
          prompt,
          {
            siteId,
            system: options.system,
            maxOutputTokens: options.maxOutputTokens,
            signal
          },
          this.getProviderConfig(siteId, key)
        )
      )
      const text = await withTimeout(
        Promise.race([work, aborted]),
        timeoutMs,
        () => new AiTimeoutError(`No response within ${timeoutMs}ms.`)
      )
      if (typeof text !== 'string' || text.trim().length < 1) {
        return null
      }
      return text
    } catch (err: any) {
      if (options.signal?.aborted) {
        return null
      }
      CARDINAL.logger.warn('ext', 'ai provider call failed', {
        kind: 'ai',
        module: key,
        site: siteId,
        errorName: typeof err?.name === 'string' ? err.name : typeof err
      })
      return null
    }
  }
}

export const ai = new Ai()

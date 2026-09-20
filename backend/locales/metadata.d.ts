/**
 * `metadata.js` is Localazy-generated output and stays JavaScript; this declaration is what lets
 * the backend import it with `allowJs` off. Keep it in sync with the Localazy export shape.
 */

export interface LocalazyLanguage {
  language: string
  region: string
  script: string
  isRtl: boolean
  name: string
  localizedName: string
  pluralType: (n: number) => string
}

export interface LocalazyMetadata {
  projectUrl: string
  baseLocale: string
  languages: LocalazyLanguage[]
}

declare const localazyMetadata: LocalazyMetadata
export default localazyMetadata

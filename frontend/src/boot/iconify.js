import { addAPIProvider } from 'iconify-icon'

/**
 * `<iconify-icon>` resolves `<prefix>:<name>` by asking an API for the icon data. Replacing the
 * default provider sends that traffic to `/_icons` on this instance instead: nothing about which
 * pages a reader visits leaks to a third party, and the wiki keeps working with no outbound access
 * at all.
 *
 * Importing the package for its side effect is what defines the `<iconify-icon>` custom element.
 */
export function initializeIconify() {
  addAPIProvider('', {
    resources: [`${window.location.origin}/_icons`]
  })
}

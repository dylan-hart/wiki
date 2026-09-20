/**
 * Runtime brand-color theming: writes the `--q-*` custom properties `css/tailwind.css` chains its
 * brand color tokens to, so one call recolors every `bg-primary` / `text-accent` utility in the app.
 * The `--q-` prefix is only a name -- every consumer spells it out, so renaming it would mean
 * touching all of them for no behavioural gain.
 */
export function setCssVar(name, value) {
  if (!value) {
    return
  }
  document.documentElement.style.setProperty(`--q-${name}`, value)
}

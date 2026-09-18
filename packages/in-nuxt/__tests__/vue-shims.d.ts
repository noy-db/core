/**
 * Lets `tsc` RESOLVE the `.vue` single-file components these tests mount
 * (core#40). Without it every SFC import is a TS2307 and the whole test
 * program fails before checking anything else.
 *
 * It lives beside the tests, not in `src`: the shipped code never imports an
 * SFC as a module — `module.ts` resolves `DevtoolsPanel.vue` as a FILE PATH
 * for Nuxt to register — so the package's build program has never needed one
 * and should not gain one.
 *
 * ⚠️ WHAT THIS DOES NOT DO. It gives resolution, not SFC typechecking: every
 * component here is `DefineComponent<{}, {}, any>`, so props passed at a
 * `mount()` call are unchecked. Typechecking the templates and props needs
 * `vue-tsc` in place of `tsc`, which is a different tool in the typecheck
 * script and a decision of its own. Stating the limit here so the coverage
 * this file enables is not read as more than it is.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

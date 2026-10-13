/**
 * `stripComments` / `stripCommentsAndStrings` — the shared source scanner
 * behind 17 architecture checks.
 *
 * ## Why this test exists
 *
 * Until 2026-08-14 the stripper ran **block comments before line comments**.
 * That ordering is silently wrong: a `//` comment that merely *mentions* a path
 * or glob containing `/*` — `// via/lookup/**` is the real example that exposed
 * it — reads as an opening block delimiter to the block regex, which then runs
 * to the next `*​/` anywhere in the file and deletes the real code in between.
 *
 * ⛔ **That fix was HALF a fix, and this suite is why nobody noticed for a
 * year: every one of its original six cases put the comment at the START of a
 * line.** The regex it was testing only ever recognised `/^\s*\/\/.*$/gm`, so a
 * TRAILING comment survived into the later passes and was read as code. Moving
 * case 1's comment to the end of its line reproduced the 2026-08-14 bug
 * exactly — 3 protected-body accesses counted as 1 — and an apostrophe in
 * ordinary comment prose (`// we don't opt in here`) paired with the next quote
 * in the file and blanked the code between (family#207).
 *
 * The failure mode is the one this repo keeps re-learning: **a check that
 * looked right and examined the wrong thing** — and, one layer up, **a TEST
 * that looked like coverage and could not see the class it was written for.**
 *
 * So the cases below assert PROPERTIES, and each is stated for a comment in
 * both positions. The original six are kept verbatim as controls: they prove
 * the 2026-08-14 behaviour survived the rewrite.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHECKER = join(HERE, '..', 'check-architecture.mjs')
const SOURCE = readFileSync(CHECKER, 'utf8')

/**
 * The checker is a script, not a module with exports, so lift the scanner out
 * of its source rather than importing it. Reading the real source is the point:
 * a copy in this file would test the copy.
 *
 * ⚠️ Lifts the whole SENTINEL-DELIMITED region, not one function. The scanner
 * is three functions sharing one pass; slicing a single `function … {` to the
 * next line-start `}` (which this did until family#207) silently drops the
 * shared implementation and fails with a ReferenceError that reads like a
 * scanner bug.
 */
function loadScanner(): {
  stripComments: (s: string) => string
  stripCommentsAndStrings: (s: string) => string
} {
  const start = SOURCE.indexOf('// ─── region: source scanner')
  const end = SOURCE.indexOf('// ─── endregion: source scanner')
  expect(start, 'the source-scanner region sentinel must exist').toBeGreaterThan(-1)
  expect(end, 'the source-scanner endregion sentinel must exist').toBeGreaterThan(start)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(
    `${SOURCE.slice(start, end)}; return { stripComments, stripCommentsAndStrings }`,
  )() as ReturnType<typeof loadScanner>
}

const { stripComments, stripCommentsAndStrings } = loadScanner()

/** Body-field regex, copied from the checker's `BODY_FIELD_ACCESS_RE`. */
const BODY = /\b_iv\s*:|\b_data\s*:|\._data\b/g
const count = (s: string) => (s.match(BODY) ?? []).length

describe('stripComments — a line comment must never swallow code', () => {
  it('1. THE BUG: `// …/**` must not delete the code that follows', () => {
    const src = [
      'function f() {',
      '  // via/lookup/** may not import the enclave',
      "  return { _iv: '', _data: json }",
      '}',
      '/** a real block comment, much later */',
      "const other = { _data: 'x' }",
    ].join('\n')

    // Under the old order the `/**` inside the line comment opened a phantom
    // block that ran to the real block's `*/`, deleting BOTH the return and
    // everything between — the count came back 1 instead of 3.
    expect(count(stripComments(src))).toBe(3)
  })

  it('2. the general property: stripping comments never removes a code line', () => {
    // Each mention is innocuous prose. None may cost us a line of code.
    const mentions = [
      'src/**',
      'a/*.ts',
      'foo/**/bar',
      'capsule/enclave-aes/*',
      'see /* this */ inline',
    ]
    for (const m of mentions) {
      const src = [`  // ${m}`, "  const x = { _iv: '', _data: y }", '/* trailing block */'].join('\n')
      expect(count(stripComments(src)), `line comment mentioning "${m}" ate the code below it`).toBe(2)
    }
  })

  it('3. real block comments are still stripped', () => {
    const src = ["/* const hidden = { _iv: '' } */", "const real = { _data: 'y' }"].join('\n')
    expect(count(stripComments(src))).toBe(1)
  })

  it('4. multi-line block comments are still stripped', () => {
    const src = ['/**', " * const doc = { _iv: '' }", ' */', "const real = { _data: 'y' }"].join('\n')
    expect(count(stripComments(src))).toBe(1)
  })

  it('5. ordinary line comments are still stripped', () => {
    const src = ["// const dead = { _iv: '' }", "const real = { _data: 'y' }"].join('\n')
    expect(count(stripComments(src))).toBe(1)
  })
})

describe('family#207 — the same properties for a TRAILING comment', () => {
  it('7. THE BUG, in the position the suite never tested: `code // …/**`', () => {
    // Case 1 with the comment moved to the end of a line. This is the
    // 2026-08-14 bug, still live after the 2026-08-14 fix.
    const src = [
      'function f() {',
      '  const g = 1 // via/lookup/** may not import the enclave',
      "  return { _iv: '', _data: json }",
      '}',
      '/** a real block comment, much later */',
      "const other = { _data: 'x' }",
    ].join('\n')
    expect(count(stripComments(src)), 'a trailing `// …/**` opened a phantom block').toBe(3)
  })

  it('8. every case-2 mention, trailing instead of leading', () => {
    const mentions = ['src/**', 'a/*.ts', 'foo/**/bar', 'capsule/enclave-aes/*', 'see /* this */ inline']
    for (const m of mentions) {
      const src = [
        `  const keep = 1 // ${m}`,
        "  const x = { _iv: '', _data: y }",
        '/* trailing block */',
      ].join('\n')
      expect(count(stripComments(src)), `trailing comment mentioning "${m}" ate the code below it`).toBe(2)
    }
  })

  it('9. a trailing comment is actually REMOVED, not merely harmless', () => {
    // The weaker property (nothing swallowed) would also hold if trailing
    // comments were passed through untouched — which is what used to happen,
    // and is how `subtle.digest(` or an import specifier mentioned in prose
    // reads as real code to the 17 checks built on this.
    const stripped = stripComments("const real = { _data: 'y' } // const dead = { _iv: '' }")
    expect(count(stripped), 'the trailing comment was read as code').toBe(1)
    expect(stripped).not.toContain('_iv')
  })

  it('10. an apostrophe in comment prose must not blank the code after it', () => {
    // THE family#207 CASE. `don't` leaves an unpaired quote; the string pass
    // then pairs it with the next quote in the FILE and blanks everything
    // between — here, the whole `openVault('acme')` call.
    const src = [
      "const db = await createNoydb({ store })  // we don't opt in here",
      "const v = await db.openVault('acme')",
      'await v.dump()',
    ].join('\n')
    const code = stripCommentsAndStrings(src)
    expect(code, 'an apostrophe in a comment swallowed the next line').toContain('openVault')
    expect(code).toMatch(/\.dump\s*\(/)
    expect(code).not.toContain('opt in here')
  })

  it('11. an UNBALANCED double quote in comment prose is equally inert', () => {
    // ⚠️ TWO conditions, and this case needed both pointed out to it. The
    // comment's quote must be UNPAIRED (it read `// the "right" way` when
    // first written — two quotes, balanced, passed against the old chain and
    // tested nothing), AND there must be a later double-quoted string for it
    // to pair WITH. With a single `"` in the whole source the old chain's
    // `"…"` regex simply finds no match and swallows nothing, so the case
    // passes for the wrong reason. `"acme"` below is the partner that makes
    // the phantom span reach across the code.
    const src = [
      'const db = await createNoydb({ store })  // the "right way to do it',
      'const v = await db.openVault("acme")',
      'await v.ledger()',
    ].join('\n')
    const code = stripCommentsAndStrings(src)
    expect(code, 'an unpaired double quote in a comment swallowed the next line').toContain('openVault')
    expect(code).toMatch(/\.ledger\s*\(/)
  })

  it('12. CONTROL: `//` inside a string or a regex is NOT a comment', () => {
    // ⭐ A CONTROL, and it passes against the OLD chain too — deliberately.
    // It does not discriminate the family#207 bug; it guards the naive FIX for
    // it. Stripping `//.*$` unconditionally breaks exactly here, and a URL in
    // a string is the commonest shape in the tree. The regex case matters because regex bodies are emitted
    // verbatim: blanking them would hide real call shapes from the checks.
    const url = stripComments("const u = 'https://example.com/x'\nconst y = { _data: 1 }")
    expect(url, 'a URL in a string was treated as a comment').toContain('example.com')
    expect(count(url)).toBe(1)

    const re = stripComments('const slashes = /\\/\\//g\nconst y = { _data: 1 }')
    expect(count(re), 'a regex containing // was treated as a comment').toBe(1)
  })

  it('13. line numbers survive the strip, so a reported line still points at the source', () => {
    // Several checks report `file` to the user; a stripped text that loses
    // newlines shifts every line after a multi-line comment or template.
    const src = [
      'const a = 1',
      '/**',
      ' * a doc comment',
      ' */',
      'const b = `a',
      'multi',
      'line`',
      'const c = { _data: 1 } // trailing',
    ].join('\n')
    for (const strip of [stripComments, stripCommentsAndStrings]) {
      expect(strip(src).split('\n').length, 'the stripper moved the line numbering').toBe(
        src.split('\n').length,
      )
    }
  })

  it('14. the REASON survives next to the code, so a future edit cannot silently revert it', () => {
    // Replaces the old case 6, which asserted the line-strip pass preceded the
    // block-strip pass. There are no passes any more — one state-aware walk
    // has no ordering to get wrong — so asserting the ordering would now be
    // asserting the absence of the thing that was broken. What is worth
    // locking is that the next reader meets the trailing-comment class before
    // they decide a regex would be simpler.
    const start = SOURCE.indexOf('// ─── region: source scanner')
    const header = SOURCE.slice(Math.max(0, start - 2600), start)
    expect(header, 'the family#207 reason left the scanner').toMatch(/family#207/)
    expect(header, 'the trailing-comment class is no longer named').toMatch(/TRAILING comment/)
    expect(header, 'the phantom-string mechanism is no longer explained').toMatch(/PHANTOM STRING/)
    // And the regex chain must not come back.
    const region = SOURCE.slice(start, SOURCE.indexOf('// ─── endregion: source scanner'))
    expect(region, 'the line-comment regex chain is back').not.toMatch(/\^\\s\*\\\/\\\/\.\*\$/)
  })
})

/**
 * Refuse a `major` changeset while the version line is 0.x.
 *
 * ⛔ WHY THIS IS A RELEASE PRE-FLIGHT AND NOT A CI CHECK. `.changeset/` is
 * gitignored (`.gitignore:182` — "kept local; release notes come through the
 * workflow"), so a CI job scanning `.changeset/*.md` finds an EMPTY DIRECTORY
 * and passes. Forever, on every branch, while reporting that it checked. The
 * only machine where those files exist is the one about to cut the release.
 *
 * ⭐ WHAT IT CATCHES. In a 0.x line `major` does not mean "1.0.0" — it means
 * "breaking", which this repo already treats as ordinary (`CLAUDE.md`:
 * "Pre-1.0. Public APIs may still change"). The changesets CLI maps `major` to
 * 1.0.0 regardless, so a single `major` entry silently redefines the version
 * line. Measured 2026-09-13: a run produced 1.0.0 for 32 of 36 packages, and
 * the question reached a human as "should we ship 1.0.0?" — which is the wrong
 * question. The answer was that the changeset should not have said `major`.
 *
 * ⚠️ `release.mjs`'s NORMALIZER DOES NOT COVER THIS, and assuming it does is
 * the trap. The normalizer sets every package to whatever HUB landed on; if
 * hub's own changeset said `major`, hub lands on 1.0.0 and the normalizer
 * faithfully propagates 1.0.0 to all 36. It fixes satellite DRIFT, not the
 * line move. The two guards are complementary, not redundant.
 *
 * @module
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Frontmatter entry: `'@noy-db/hub': major` or `"@noy-db/hub": major`. */
const ENTRY_RE = /^\s*['"]?([^'":]+)['"]?\s*:\s*(major|minor|patch)\s*$/

/**
 * Every `major` entry in the pending changesets, as `{ file, pkg }`.
 * Pure over a directory so it can be tested against fixtures.
 */
export function findMajorEntries(changesetDir) {
  if (!existsSync(changesetDir)) return []
  const out = []
  for (const file of readdirSync(changesetDir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue
    const text = readFileSync(join(changesetDir, file), 'utf8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!fm) continue
    for (const line of fm[1].split(/\r?\n/)) {
      const m = ENTRY_RE.exec(line)
      if (m && m[2] === 'major') out.push({ file, pkg: m[1].trim() })
    }
  }
  return out
}

/**
 * Throw when the line is 0.x and any pending changeset says `major`.
 *
 * Silent when the line has reached 1.x — at that point `major` means what the
 * author intended and this guard has no opinion.
 */
export function assertNoMajorWhilePre1(hubVersion, changesetDir) {
  if (typeof hubVersion !== 'string' || !/^\d+\./.test(hubVersion)) {
    throw new Error(
      `[release] could not read the hub version (got ${String(hubVersion)}). ` +
      `Refusing to continue: without it this guard cannot tell 0.x from 1.x.`,
    )
  }
  if (!/^0\./.test(hubVersion)) return

  const offenders = findMajorEntries(changesetDir)
  if (offenders.length === 0) return

  const n = offenders.length
  const subject = n === 1 ? 'entry says' : 'entries say'
  throw new Error(
    `[release] REFUSING: ${n} changeset ${subject} \`major\` ` +
    `while the line is ${hubVersion}.\n\n` +
    offenders.map((o) => `    ${o.file}  (${o.pkg})`).join('\n') +
    `\n\n  In a 0.x line \`major\` does NOT mean 1.0.0 — it means "breaking", which is\n` +
    `  ordinary here (CLAUDE.md: "Pre-1.0. Public APIs may still change"). But the\n` +
    `  changesets CLI maps \`major\` to 1.0.0 regardless, so this would cut 1.0.0\n` +
    `  instead of the minor you intended.\n\n` +
    `  Fix: change those entries to \`minor\` and describe the break in the prose,\n` +
    `  which is where a consumer will actually read it.`,
  )
}

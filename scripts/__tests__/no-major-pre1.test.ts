/**
 * The 0.x `major` guard — and the reason it is a release pre-flight rather
 * than a CI check.
 *
 * On 2026-09-13 a `changeset version` run in this repo produced **1.0.0 for 32
 * of 36 packages**, because pending changesets carried `major`. In a 0.x line
 * `major` does not mean 1.0.0 — it means "breaking", which `CLAUDE.md` already
 * treats as ordinary pre-1.0. The changesets CLI maps it to 1.0.0 anyway, so
 * the version line was silently redefined and the question reached a human as
 * "should we ship 1.0.0?" — the wrong question, from a premise nobody checked.
 *
 * ⭐ `.changeset/` WAS GITIGNORED until 2026-09-14, and that is why this began
 * as a release pre-flight only: a CI job scanning it found an empty directory
 * and passed, forever, while reporting that it checked — the exact shape of a
 * guard that cannot fail. The directory is tracked now, so the repo's OWN
 * pending changesets are asserted below and CI finally sees them.
 *
 * The fixture tests still supply their own directory, deliberately: they must
 * exercise the refusal, and the repo's real changesets must never contain a
 * `major` for them to exercise it against.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { assertNoMajorWhilePre1, findMajorEntries } from '../release/no-major-pre1.mjs'

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'noydb-changesets-'))
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

const cs = (pkg: string, bump: string): string =>
  `---\n'${pkg}': ${bump}\n---\n\nSome prose describing the change.\n`

describe('assertNoMajorWhilePre1', () => {
  it('REFUSES a major entry while the line is 0.x', () => {
    const dir = fixture({ 'a.md': cs('@noy-db/hub', 'major') })
    expect(() => assertNoMajorWhilePre1('0.8.0-pre.0', dir)).toThrow(/major/)
    rmSync(dir, { recursive: true, force: true })
  })

  it('names the offending FILE and PACKAGE, not just the count', () => {
    // A refusal that does not say which file to edit makes the reader grep.
    const dir = fixture({
      'ok.md': cs('@noy-db/hub', 'minor'),
      'bad-one.md': cs('@noy-db/to-file', 'major'),
    })
    try {
      assertNoMajorWhilePre1('0.8.0', dir)
      throw new Error('unreachable — the line above must throw')
    } catch (err) {
      expect((err as Error).message).toContain('bad-one.md')
      expect((err as Error).message).toContain('@noy-db/to-file')
      expect((err as Error).message).not.toContain('ok.md')
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('ACCEPTS minor and patch — the control', () => {
    // Without this the refusal above would pass equally against a guard that
    // refused every changeset.
    const dir = fixture({ 'a.md': cs('@noy-db/hub', 'minor'), 'b.md': cs('@noy-db/cli', 'patch') })
    expect(() => assertNoMajorWhilePre1('0.8.0', dir)).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is SILENT once the line reaches 1.x — it has no opinion there', () => {
    // Past 1.0.0, `major` means what the author intended and this guard must
    // stop editorialising, or it becomes an obstacle to every real major.
    const dir = fixture({ 'a.md': cs('@noy-db/hub', 'major') })
    expect(() => assertNoMajorWhilePre1('1.2.3', dir)).not.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to run blind on an unreadable version', () => {
    // Failing open here would be worse than not existing: the caller would
    // believe the line was checked.
    expect(() => assertNoMajorWhilePre1(undefined as never, '/nonexistent')).toThrow(/could not read/)
  })

  it('says nothing about an empty or missing directory', () => {
    expect(() => assertNoMajorWhilePre1('0.8.0', '/nonexistent-changeset-dir')).not.toThrow()
    const empty = fixture({})
    expect(() => assertNoMajorWhilePre1('0.8.0', empty)).not.toThrow()
    rmSync(empty, { recursive: true, force: true })
  })
})

describe("this repo's own pending changesets", () => {
  it('contain no `major` entry while the line is 0.x', () => {
    // ⭐ Only possible since `.changeset/` became tracked (2026-09-14). While
    // it was gitignored this assertion ran against an empty directory in CI
    // and passed unconditionally — a check that cannot fail, guarding the
    // exact mistake that produced 1.0.0 for 32 of 36 packages.
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.changeset')
    const hub = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'hub', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(() => assertNoMajorWhilePre1(hub.version, dir)).not.toThrow()
  })
})

describe('findMajorEntries — parsing', () => {
  it('reads both quote styles and ignores the prose body', () => {
    const dir = fixture({
      'single.md': `---\n'@noy-db/hub': major\n---\n\nmajor: not frontmatter.\n`,
      'double.md': `---\n"@noy-db/cli": major\n---\n\nbody\n`,
    })
    expect(findMajorEntries(dir).map(e => e.pkg).sort()).toEqual(['@noy-db/cli', '@noy-db/hub'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips README.md and non-markdown files', () => {
    // `.changeset/` ships a README; counting it as a changeset would be a
    // parse error at best and a phantom offender at worst.
    const dir = fixture({
      'README.md': `---\n'@noy-db/hub': major\n---\n`,
      'config.json': '{}',
    })
    expect(findMajorEntries(dir)).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('handles a multi-package changeset', () => {
    const dir = fixture({
      'multi.md': `---\n'@noy-db/hub': minor\n'@noy-db/to-file': major\n---\n\nbody\n`,
    })
    expect(findMajorEntries(dir)).toEqual([{ file: 'multi.md', pkg: '@noy-db/to-file' }])
    rmSync(dir, { recursive: true, force: true })
  })
})

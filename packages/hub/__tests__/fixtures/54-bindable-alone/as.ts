/**
 * `@noy-db/hub/as`, bound ALONE — a format author's whole import list (#54).
 *
 * ⛔ One import line, and it must stay one. See `to.ts` for why.
 *
 * ⚠️ `as-*` is the one family that sees PLAINTEXT by design, and the reason it
 * can be trusted with that is structural: a format receives records and
 * returns bytes and never holds a `Vault`. A fixture that had to import the
 * root barrel to write a format would be evidence that structure had leaked.
 */
import {
  withFormats,
  type NoydbFormat,
  type ExportChunk,
  type DecodedChunk,
  type FormatsStrategy,
} from '@noy-db/hub/as'

/** The contract an `as-*` package implements, written against the port alone. */
const tsvFormat: NoydbFormat<string> = {
  id: 'tsv-fixture',
  extension: 'tsv',
  mimeType: 'text/tab-separated-values;charset=utf-8',
  tier: 'plaintext',

  encode(chunks: readonly ExportChunk[]): string {
    return chunks
      .map(chunk => `# ${chunk.collection}\t${chunk.records.length}`)
      .join('\n')
  },

  decode(input: string): readonly DecodedChunk[] {
    return input
      .split('\n')
      .filter(line => line.startsWith('# '))
      .map(line => ({ collection: line.slice(2).split('\t')[0] ?? '', records: [] }))
  },
}

/**
 * The caller half: build the strategy the app passes to `createNoydb`, and
 * round-trip the format's own two pure functions — which is the whole of what
 * a format author can test without a vault, and deliberately so.
 */
export async function exercise(): Promise<readonly [FormatsStrategy, string, number]> {
  const strategy = withFormats()

  const chunk: ExportChunk = {
    collection: 'invoices',
    schema: null,
    refs: {},
    records: [{ id: 'a' }, { id: 'b' }],
  }

  const encoded = tsvFormat.encode([chunk]) as string
  const decoded = (await tsvFormat.decode?.(encoded)) ?? []

  return [strategy, encoded, decoded.length] as const
}

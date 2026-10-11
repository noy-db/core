/**
 * {{PROJECT_NAME}} — the smallest noy-db app.
 *
 * Three ideas, in order:
 *   1. `createNoydb` derives the encryption key from a secret. The key never
 *      leaves this page; the store only ever sees ciphertext.
 *   2. A vault holds collections; a collection holds typed records.
 *   3. `put` / `get` / `list` — that is the whole API you need on day one.
 *
 * Everything else (queries, history, sync, multi-user, exports) is one
 * `noy-db add <package>` away. Run `noy-db doctor` to see what is enabled.
 */
import { createNoydb } from '@noy-db/hub'
import { toBrowserIdb } from '@noy-db/to-browser-idb'

interface Note { id: string; text: string; at: string }

const out = document.querySelector<HTMLPreElement>('#out')!
const add = document.querySelector<HTMLButtonElement>('#add')!

// A real app asks the user for this; the starter keeps it visible so you can
// see that the SAME secret opens the SAME data on reload. Lose it and the
// data is unrecoverable — by design.
const secret = 'correct horse battery staple'

const db = await createNoydb({
  store: toBrowserIdb({ prefix: '{{PROJECT_NAME}}' }),
  user: 'owner',
  secret,
})
const vault = await db.openVault('app')
const notes = vault.collection<Note>('notes')

async function render(): Promise<void> {
  const all = await notes.list()
  out.textContent = all.length
    ? all.map((n) => `${n.at}  ${n.text}`).join('\n')
    : 'No notes yet — click "Add a note".'
}

add.addEventListener('click', async () => {
  const id = crypto.randomUUID()
  await notes.put(id, { id, text: `note #${(await notes.list()).length + 1}`, at: new Date().toISOString() })
  await render()
})

await render()

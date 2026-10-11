/**
 * Old `noydb` argv → new `noy-db` argv (family#114). The only logic this
 * package still owns; everything else is in `create-noy-db`.
 */
export function translate(argv: readonly string[]): string[] {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'inspect': return ['pod', 'inspect', ...rest]
    case 'verify':  return ['pod', 'verify', ...rest]
    default:        return [...argv]
  }
}

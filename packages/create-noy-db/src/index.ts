/**
 * Public API for `create-noy-db`.
 *
 * Most users won't import from here — they'll invoke the package via
 * `npm create noy-db@latest` (which runs the `create-noy-db` bin) or
 * `pnpm exec noy-db <command>` (which runs the `noy-db` bin). The
 * programmatic exports below exist so:
 *
 *   1. Tests can call `runWizard()` and `addCollection()` directly
 *      without spawning a child process — much faster, much easier to
 *      assert against, and avoids the dependency on a real terminal.
 *
 *   2. Downstream tooling (devtools, IDE extensions, future `nuxi` CLI
 *      extension) can re-use the same prompt logic without forking it.
 *
 * Everything that's exported here is a public API contract — semver
 * applies. Internal helpers stay un-exported.
 */

export { runWizard } from './wizard/run.js'
export type { WizardOptions, WizardResult } from './wizard/types.js'

// i18n re-exports — for test harnesses and downstream tooling that
// resolve locales without reaching into the wizard's private subpath.
export {
  detectLocale,
  loadMessages,
  parseLocaleFlag,
  SUPPORTED_LOCALES,
} from './wizard/i18n/index.js'
export type { Locale, WizardMessages } from './wizard/i18n/index.js'

export { addCollection } from './commands/add.js'
export type { AddCollectionOptions } from './commands/add.js'

export { verifyIntegrity } from './commands/verify.js'
export type { VerifyResult } from './commands/verify.js'

export { rotate } from './commands/rotate.js'
export type { RotateOptions, RotateResult } from './commands/rotate.js'

export { addUser } from './commands/add-user.js'
export type { AddUserOptions, AddUserResult } from './commands/add-user.js'

export { backup, resolveBackupTarget } from './commands/backup.js'
export type { BackupOptions, BackupResult } from './commands/backup.js'

// The pod / config / monitor surface, moved here from @noy-db/cli (family#114).
export { inspect, runInspect } from './commands/pod/inspect.js'
export type { InspectResult } from './commands/pod/inspect.js'
export { verify, runVerify } from './commands/pod/verify.js'
export type { VerifyReport } from './commands/pod/verify.js'
export {
  validateOptions, loadOptionsFromFile, scaffold, listProfiles, PROFILE_IDS,
  runConfigValidate, runConfigScaffold, runConfigProfiles,
} from './commands/pod/config.js'
export type { ValidationIssue, ValidationReport, ScaffoldResult, Profile } from './commands/pod/config.js'
export { runMonitor, formatSnapshot } from './commands/pod/monitor.js'
export type { MonitorOptions, MeterSnapshotView } from './commands/pod/monitor.js'
export { describeBundle, runDescribe } from './commands/pod/describe.js'
export type { DescribeOptions, DescribeFormat, SchemasMode } from './commands/pod/describe.js'

// The doctor (family#116): readiness checks with stable ids. A satellite registers
// checks by exporting `noydbDoctorChecks: DoctorCheck[]` from its root entry.
export { doctor, runDoctor, formatReport, applyFixes, BUILTIN_CHECKS } from './commands/doctor.js'
export type { DoctorCheck, DoctorContext, DoctorFinding, DoctorLevel, DoctorMode, DoctorReport, DoctorOptions } from './commands/doctor.js'
// `noy-db add <package>` / `--list` (family#118): the landscape, from the docs catalog.
export { addPackage, runAddPackage, loadCatalog, bundledCatalog, findPackage, formatList, normalisePrefix, detectPackageManager, installArgv, snippetFor, CATALOG_URL } from './commands/add-package.js'
export type { Catalog, CatalogPackage, CatalogPrefix, AddOptions, AddResult, PackageManager } from './commands/add-package.js'

export type { ReadSecret } from './commands/shared.js'
export { assertRole, parseCollectionList } from './commands/shared.js'

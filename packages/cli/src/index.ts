/**
 * **@noy-db/cli** — DEPRECATED. Every export here is re-exported from
 * `create-noy-db`, where the commands moved on 2026-10-11 (family#114).
 * Import from `create-noy-db` directly; this package goes away at 1.0.
 *
 * @packageDocumentation
 */
export {
  inspect, runInspect, verify, runVerify,
  validateOptions, loadOptionsFromFile, scaffold, listProfiles, runConfigValidate, runConfigScaffold, runConfigProfiles,
  runMonitor, formatSnapshot, describeBundle, runDescribe,
} from 'create-noy-db'
export type {
  InspectResult, VerifyReport, ValidationIssue, ValidationReport, ScaffoldResult, Profile,
  MonitorOptions, MeterSnapshotView, DescribeOptions, DescribeFormat, SchemasMode,
} from 'create-noy-db'

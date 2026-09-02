/**
 * Foundry's `updateSetting` is a document hook:
 * `(setting, changed, options, userId)`.
 *
 * The Setting document carries `.key` (`"module.settingName"`). The third
 * argument is the options object, never a string — treating it as one throws
 * `key.endsWith is not a function` on every setting write (v0.7.41 riding).
 */
export function settingKeyOf(setting: { key?: unknown } | null | undefined): string {
  return typeof setting?.key === "string" ? setting.key : "";
}

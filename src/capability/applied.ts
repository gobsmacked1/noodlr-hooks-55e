// Whether an `on_condition_applied` rule is about the statuses that just landed.
//
// A condition hook fires for EVERY status on the effect. Nature's Ward must not strip poison because
// the creature was frightened. Matching is on the rule's OWN words: a `has_status` / `lacks_status`
// guard names what it is watching for, and a `remove_status` / `apply_status` with no such guard
// names the status in the effect. A rule that names no status at all is skipped — guessing would
// fire every bound rule on every effect, which is how a Wild Shape would cancel itself the moment
// `transformed` landed (its effect removes `transformed`; its guard is `incapacitated`).

import type { CapabilityRule } from "../integration/capability";

export function ruleMatchesApplied(rule: CapabilityRule, applied: string[]): boolean {
  const landed = new Set(applied.map((s) => String(s).toLowerCase()).filter(Boolean));
  if (landed.size === 0) return false;

  const named: string[] = [];
  for (const c of rule.condition ?? []) {
    if (c.kind === "has_status" || c.kind === "lacks_status") {
      const status = String(c.status ?? "").toLowerCase();
      if (status) named.push(status);
    }
  }
  if (named.length) return named.some((s) => landed.has(s));

  const kind = String(rule.effect?.kind ?? "");
  if (kind === "remove_status" || kind === "apply_status") {
    const status = String(rule.effect?.status ?? "").toLowerCase();
    return Boolean(status && landed.has(status));
  }
  return false;
}

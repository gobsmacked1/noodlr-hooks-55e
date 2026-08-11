// Which compiled capabilities each creature on the scene carries.
//
// Its own module rather than part of the executor because two very different things read it: the
// executor, which fires rules, and the action ledger, which wants one standing grant out of them
// (`extra_attack`). Putting the map here keeps the ledger free of the executor and its primitives,
// which would otherwise be a cycle — and the ledger has to work in a world where nothing has ever
// been compiled.
//
// In memory, never written to the world. Bindings are derived from the sheet plus the cache, so they
// can be rebuilt at any moment; storing them would put a second copy of every rule into the world save
// to go stale the first time a GM edits one.

import { debug } from "../constants";
import type { Capability } from "../integration/capability";

export interface Binding {
  capability: Capability;
  /** The feature the prose came from, so the sheet can link a rule back to its item. */
  item?: any;
}

const bindings = new Map<string, Binding[]>();

export function bindCapabilities(actorUuid: string, entries: Binding[]): void {
  if (!actorUuid) return;
  if (entries.length === 0) bindings.delete(actorUuid);
  else bindings.set(actorUuid, entries);
  debug("bound capabilities", { actorUuid, count: entries.length });
}

export function bindingsFor(actor: any): Binding[] {
  return bindings.get(String(actor?.uuid ?? "")) ?? [];
}

export function boundActors(): string[] {
  return [...bindings.keys()];
}

export function clearBindings(actorUuid?: string): void {
  if (actorUuid) bindings.delete(actorUuid);
  else bindings.clear();
}

/**
 * How many attacks one Action buys, according to a compiled capability, or null when none says.
 *
 * Read by `rules/economy/ledger.ts`. It sits above that file's Multiattack regex and below the
 * authored `system.identifier` values, which is the honest ordering: structured data the content team
 * wrote beats a model's reading of a sentence, and a model's reading of the whole sentence beats a
 * regular expression looking for the first number word in it.
 */
export function capabilityAttacksPerAction(actor: any): number | null {
  let best: number | null = null;
  for (const binding of bindingsFor(actor)) {
    if (binding.capability.status === "rejected") continue;
    for (const rule of binding.capability.rules ?? []) {
      if (rule.effect?.kind !== "extra_attack") continue;
      if (rule.adjudication !== "engine") continue;
      const attacks = Number(rule.effect.attacks);
      if (Number.isFinite(attacks) && attacks > 0) best = Math.max(best ?? 0, attacks);
    }
  }
  return best;
}

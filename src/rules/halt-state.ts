// Sentinel Halt: Speed 0 for the rest of the *mover's* current turn.
//
// Leaf. `execute.ts` cannot import `sentinel.ts` (that file offers reactions through `offer.ts`,
// which already imports execute). The flag and the "is it still their turn" test live here so
// leftover cover walks, the Speed budget, and Halt application all ask the same question.
//
// `stampFor` alone is the wrong clock. The action-economy stamp stays "this round" after their
// turn ends, which would keep Halt for the rest of the round. RAW is the rest of the current
// turn only, so the live combatant must still be the halted creature.

import { MODULE_ID } from "../constants";
import { readFlag } from "../util/flags";
import { stampFor } from "./economy/ledger";

const FLAG = "halted";

function combatantFor(combat: any, actor: any): any {
  const uuid = String(actor?.uuid ?? "");
  const id = String(actor?.id ?? "");
  return (combat?.combatants ?? []).find?.(
    (c: any) => String(c?.actor?.uuid ?? "") === uuid || String(c?.actor?.id ?? "") === id,
  );
}

export function hasHalted(actor: any): boolean {
  const combat: any = (globalThis as any).game?.combat;
  if (!combat?.started || !actor) return false;
  const combatant = combatantFor(combat, actor);
  if (!combatant) return false;
  if (String(combat.combatant?.id ?? "") !== String(combatant.id ?? "")) return false;
  return String(readFlag(actor, FLAG) ?? "") === stampFor(combat, combatant);
}

export async function writeHalted(actor: any): Promise<boolean> {
  const combat: any = (globalThis as any).game?.combat;
  if (!combat?.started || !actor) return false;
  const combatant = combatantFor(combat, actor);
  if (!combatant) return false;
  try {
    await actor.setFlag?.(MODULE_ID, FLAG, stampFor(combat, combatant));
    return true;
  } catch {
    return false;
  }
}

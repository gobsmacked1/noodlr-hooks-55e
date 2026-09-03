// The Opportunity Attack that just started, so Halt can see who it was aimed at.
//
// Leaf. `offer.ts` already imports `execute.ts`, so `sentinel.ts` cannot export the pending
// map that offer and `reactions.ts` `strike` both need to write. A player rolling an OA by
// hand, without the prompt, is out of scope — there is no trigger to key.

const TTL_MS = 20_000;

interface Pending {
  targetUuid: string;
  at: number;
}

const pending = new Map<string, Pending>();

export function noteOpportunitySwing(attacker: any, target: any): void {
  const attackerUuid = String(attacker?.uuid ?? "");
  const targetUuid = String(target?.document?.uuid ?? target?.uuid ?? "");
  if (!attackerUuid || !targetUuid) return;
  pending.set(attackerUuid, { targetUuid, at: Date.now() });
}

export function pendingOpportunityTarget(attackerUuid: string): string | null {
  const key = String(attackerUuid ?? "");
  const row = pending.get(key);
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) {
    pending.delete(key);
    return null;
  }
  return row.targetUuid;
}

export function clearOpportunitySwing(attackerUuid: string): void {
  pending.delete(String(attackerUuid ?? ""));
}

export function clearAllOpportunitySwings(): void {
  pending.clear();
}

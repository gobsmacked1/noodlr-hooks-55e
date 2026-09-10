// Foundry moves every controlled token together. That is a feature for staging a party
// onto a dark map, and a bug the moment combat starts: two PCs owned by one player (or
// still selected on the GM after they dropped both) walk in lockstep, out of turn, with
// different initiatives. There is no riding flag and no group document — only the local
// selection, which is not synced and is invisible on the other client.
//
// Out of combat we leave a multi-select alone so the GM can slide the whole party into
// starting squares. In a started combat we keep at most one character token controlled:
// the current combatant if it is a character in the set, otherwise the user's assigned
// character if it is on the scene, otherwise the first. NPCs stay selected (the GM can
// still hold the Beholder). A later box-select of both PCs is collapsed the same way.
//
// Clicking empty canvas also unsticks a live fight with no module change.

import { debug } from "../constants";

export interface PartySelectToken {
  id: string;
  name?: string;
  actorType: string;
  actorId?: string | null;
}

export interface PartySelectContext {
  combatStarted: boolean;
  currentTokenId?: string | null;
  assignedActorId?: string | null;
}

/** Character token ids that should be released. Empty when the selection is fine. */
export function extraCharacterIds(
  tokens: PartySelectToken[],
  ctx: PartySelectContext,
): string[] {
  if (!ctx.combatStarted) return [];
  const chars = tokens.filter((t) => t.actorType === "character");
  if (chars.length < 2) return [];
  const keep = pickCharacterToKeep(chars, ctx);
  return chars.filter((t) => t.id !== keep).map((t) => t.id);
}

export function pickCharacterToKeep(
  chars: PartySelectToken[],
  ctx: PartySelectContext,
): string {
  const current = chars.find((t) => t.id === ctx.currentTokenId);
  if (current) return current.id;
  const assigned = chars.find((t) => t.actorId && t.actorId === ctx.assignedActorId);
  if (assigned) return assigned.id;
  return String(chars[0]?.id ?? "");
}

function liveContext(): PartySelectContext {
  const combat: any = (globalThis as any).game?.combat;
  const user: any = (globalThis as any).game?.user;
  return {
    combatStarted: Boolean(combat?.started),
    currentTokenId: combat?.combatant?.tokenId ?? combat?.current?.tokenId ?? null,
    assignedActorId: user?.character?.id ?? null,
  };
}

function describeControlled(): PartySelectToken[] {
  const list = [...((globalThis as any).canvas?.tokens?.controlled ?? [])];
  return list.map((t: any) => ({
    id: String(t.id ?? t.document?.id ?? ""),
    name: String(t.name ?? t.document?.name ?? "?"),
    actorType: String(t.actor?.type ?? t.document?.actor?.type ?? ""),
    actorId: t.actor?.id ?? t.document?.actorId ?? null,
  }));
}

function extrasNow(): string[] {
  return extraCharacterIds(describeControlled(), liveContext());
}

/** Drop leftover party multi-select so a drag or WASD cannot walk two PCs as one. */
export function collapsePartySelection(): string[] {
  const extras = extrasNow();
  if (!extras.length) return [];
  const layer: any = (globalThis as any).canvas?.tokens;
  const names: string[] = [];
  for (const id of extras) {
    const token = layer?.get?.(id) ?? layer?.placeables?.find((t: any) => t.id === id);
    const name = String(token?.name ?? id);
    names.push(name);
    try {
      token?.release?.();
    } catch {
      /* a token that cannot release is still vetoed at preMoveToken */
    }
  }
  debug("party-select: released extra character tokens so they cannot walk together", {
    released: names,
    kept: describeControlled()
      .filter((t) => t.actorType === "character")
      .map((t) => t.name),
  });
  return extras;
}

/** True when this character would ride along with another selected PC. */
export function isLinkedPartyExtra(doc: any): boolean {
  if (String(doc?.actor?.type ?? "") !== "character") return false;
  const extras = extrasNow();
  const id = String(doc?.id ?? "");
  if (extras.includes(id)) return true;
  // The moving document may not be in `controlled` yet on some keyboard paths.
  if (!id) return false;
  const listed = describeControlled();
  if (listed.some((t) => t.id === id)) return false;
  const next = [
    ...listed,
    {
      id,
      actorType: "character",
      actorId: doc?.actor?.id ?? doc?.actorId ?? null,
    },
  ];
  return extraCharacterIds(next, liveContext()).includes(id);
}

export function registerPartySelect(): void {
  const collapse = (): void => {
    try {
      collapsePartySelection();
    } catch {
      /* a briefing is not worth a thrown hook */
    }
  };
  Hooks.on("combatStart", collapse);
  Hooks.on("updateCombat", (combat: any, changed: any) => {
    if (!combat?.started) return;
    if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
    collapse();
  });
  Hooks.on("controlToken", (_token: any, selected: boolean) => {
    if (!selected) return;
    collapse();
  });
}

export function surveyPartySelect(): Record<string, unknown> {
  const controlled = describeControlled();
  const ctx = liveContext();
  const extras = extraCharacterIds(controlled, ctx);
  return {
    combatStarted: ctx.combatStarted,
    currentTokenId: ctx.currentTokenId ?? null,
    assignedActorId: ctx.assignedActorId ?? null,
    controlled: controlled.map((t) => `${t.name} (${t.actorType || "?"})`),
    extras,
    note:
      extras.length > 0
        ? "these character tokens would walk together — collapsePartySelection() releases them"
        : ctx.combatStarted
          ? "at most one character token is controlled"
          : "out of combat: multi-select is left alone so the GM can place the party",
  };
}

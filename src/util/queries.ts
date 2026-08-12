// Asking the GM's client a question and getting an answer back.
//
// Some rules cannot be resolved wherever the button was pressed. The Influence action is the clear case:
// the rule opens with "the DM then determines whether the monster feels willing, unwilling, or hesitant",
// so the ruling belongs to the GM — and the 24-hour lockout it produces is a flag on an NPC token, which
// a player has no permission to write. Meanwhile the check itself is a roll on the player's own sheet and
// belongs on the player's client. One action, two clients, and no way round it.
//
// WHY QUERIES RATHER THAN A SOCKET. `CONFIG.queries` is core's own request/response channel (v13+): it is
// addressed to a specific user, it returns a promise that resolves with that user's answer, and it times
// out on its own. A socket message is a broadcast with no reply and no addressee, so building this on one
// would mean inventing correlation ids, a reply channel and a timeout — three things core already has.
// It is also what Aura Effects uses to route its writes to a single client, which is the same discipline
// as `isPrimaryGM()` in the newer idiom.
//
// Registered on every client, deliberately: core looks the handler up on the RECEIVING client, and which
// client that is depends on who is playing. A GM asking a question answers it in-process rather than over
// the wire — a query to yourself is a round trip to nowhere, and it is the common case at a solo table.

import { MODULE_ID, log } from "../constants";

type QueryHandler = (data: any) => Promise<unknown>;

const handlers = new Map<string, QueryHandler>();

/** Namespaced, because core reserves unprefixed query names. */
function qualify(name: string): string {
  return `${MODULE_ID}.${name}`;
}

/**
 * Register a question this module's GM client can answer.
 *
 * Any handler must assume the data crossed the wire from a client we do not control: resolve documents
 * by uuid and check what the asking user is entitled to before acting, exactly as a socket handler would.
 */
export function registerQuery(name: string, handler: QueryHandler): void {
  handlers.set(name, handler);
  const queries: Record<string, unknown> | undefined = (globalThis as any).CONFIG?.queries;
  if (!queries) {
    log(`queries: CONFIG.queries is missing; "${name}" will only answer locally`);
    return;
  }
  queries[qualify(name)] = async (data: any) => {
    try {
      return await handler(data ?? {});
    } catch (err) {
      log(`queries: "${name}" failed:`, err);
      return null;
    }
  };
}

/** Is there anybody who could answer? */
export function gmIsListening(): boolean {
  return Boolean(game.user?.isGM || (game.users as any)?.activeGM);
}

/**
 * Put a question to the GM and wait for the answer. Null when nobody answered.
 *
 * Null is a real outcome and every caller has to treat it as one: an offline GM, a closed dialog and a
 * timeout are indistinguishable from here, and all three mean the same thing — no ruling was given, so
 * nothing should be resolved on a guess.
 */
export async function askGm<T>(
  name: string,
  data: Record<string, unknown>,
  options: { timeout?: number } = {},
): Promise<T | null> {
  const local = handlers.get(name);
  if (game.user?.isGM) {
    if (!local) return null;
    try {
      return (await local(data)) as T;
    } catch (err) {
      log(`queries: "${name}" failed locally:`, err);
      return null;
    }
  }

  const gm: any = (game.users as any)?.activeGM;
  if (!gm) {
    log(`queries: nobody to ask about "${name}" — no GM is connected`);
    return null;
  }
  try {
    return (await gm.query(qualify(name), data, { timeout: options.timeout ?? 120000 })) as T;
  } catch (err) {
    log(`queries: the GM did not answer "${name}":`, err);
    return null;
  }
}

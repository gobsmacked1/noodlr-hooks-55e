// How dnd5e names a template's lifetime. Duration units and concentration live on the activity
// (or, when that is an empty override, on the item). A MeasuredTemplate only stores
// `flags.dnd5e.origin` / `.item` — the UUIDs — so the sweep has to resolve those to ask.
//
// `inst` is the schema default (`DurationField`). A save activity on Wall of Fire ships
// `duration.units: inst` with `override: false` — that is "use the item's 1 minute", not
// "this spell is instantaneous". Reading the activity first without honouring override is
// how a lasting wall gets classified as a Fireball leftover.
//
// Value is read off the live activity/item at place time so Extend Spell (and any other
// duration rider) is the number we stamp. We do not look the book's default back up later.
// Range riders (Distant Spell) change placement, not lifetime; the placed template is
// already the modified shape.
//
// Permanent / special / "until dispelled" are not a clock we can honour, so they stay
// until a human or a broken concentration removes them.

export type LifeKind = "instant" | "lasting" | "keep";

const INSTANT = new Set(["inst"]);
const LASTING = new Set(["turn", "round", "second", "minute", "hour", "day", "week", "month", "year"]);

/** 5e: a round is six seconds. 1 minute = 10 rounds. */
export const ROUND_MS = 6_000;

export interface DurationRead {
  units: string;
  value: number | null;
  concentrating: boolean;
  kind: LifeKind;
}

export interface DurationClocks {
  durationMs?: number;
  durationRounds?: number;
  untilMs?: number;
  untilWorld?: number;
  untilRound?: number;
}

export function kindFromUnits(units: unknown): LifeKind {
  const u = String(units ?? "")
    .trim()
    .toLowerCase();
  if (!u || INSTANT.has(u)) return "instant";
  if (LASTING.has(u)) return "lasting";
  return "keep";
}

function numeric(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Activity duration when it actually overrides; otherwise the item.
 *
 * `override: false` (the Wall of Fire save activity) is the item, even though the
 * activity field is the schema default `inst`. A written activity value that differs
 * from the item's is taken anyway — that is how a duration rider lands on the activity
 * without flipping override.
 */
export function durationRecordOf(source: any): { units: string; value: unknown; concentration?: boolean } | null {
  if (!source) return null;
  const item = source.item ?? source;
  const itemDur = item?.system?.duration ?? (!source.item ? source.duration : null);
  const own = source.item ? source.duration : null;
  if (own?.override === true) return own;
  const ownValue = numeric(own?.value);
  const itemValue = numeric(itemDur?.value);
  // A duration rider may write the new value on the activity and leave override
  // false. The activity's `inst` is still "use the item's units".
  if (own && ownValue != null && ownValue !== itemValue) {
    const units =
      own.units && String(own.units).toLowerCase() !== "inst"
        ? own.units
        : (itemDur?.units ?? own.units);
    return { units: String(units ?? ""), value: own.value, concentration: own.concentration };
  }
  return itemDur ?? own ?? null;
}

export function durationOf(source: any): DurationRead {
  const rec = durationRecordOf(source);
  const units = String(rec?.units ?? "").trim();
  const kind = kindFromUnits(units);
  return {
    units,
    value: numeric(rec?.value),
    concentrating: isConcentratingSource(source),
    kind,
  };
}

/** Activity first, then the item — an empty activity duration is "use the item's". */
export function durationUnitsOf(source: any): string {
  return durationOf(source).units;
}

export function isConcentratingSource(source: any): boolean {
  if (source?.duration?.concentration === true) return true;
  const rec = durationRecordOf(source);
  if (rec?.concentration === true) return true;
  const item = source?.item ?? source;
  const props = item?.system?.properties ?? item?.properties;
  if (props && typeof props.has === "function") return props.has("concentration");
  if (Array.isArray(props)) return props.includes("concentration");
  return false;
}

export function classifySource(source: any): { kind: LifeKind; concentrating: boolean } {
  const read = durationOf(source);
  return { kind: read.kind, concentrating: read.concentrating };
}

/**
 * Translate a duration into real-time and round clocks.
 *
 * Same arithmetic as `DurationField.getEffectDuration` for minute/hour/day, plus
 * turn/round/second so a template has a deadline out of combat. Metamagic is
 * already in `value` — we do not look up a book default.
 */
export function clocksFromDuration(
  units: string,
  value: number | null,
  at: number,
  clock: { round?: number },
  worldTime?: number,
): DurationClocks {
  const kind = kindFromUnits(units);
  if (kind !== "lasting" || value == null) return {};
  const u = units.trim().toLowerCase();
  let durationMs: number | undefined;
  let durationRounds: number | undefined;
  switch (u) {
    case "turn":
      durationRounds = value;
      durationMs = value * ROUND_MS;
      break;
    case "round":
      durationRounds = value;
      durationMs = value * ROUND_MS;
      break;
    case "second":
      durationMs = value * 1000;
      durationRounds = Math.max(1, Math.ceil(value / 6));
      break;
    case "minute":
      durationMs = value * 60_000;
      durationRounds = value * 10;
      break;
    case "hour":
      durationMs = value * 3_600_000;
      durationRounds = value * 600;
      break;
    case "day":
      durationMs = value * 86_400_000;
      durationRounds = value * 14_400;
      break;
    case "week":
      durationMs = value * 7 * 86_400_000;
      durationRounds = value * 100_800;
      break;
    case "month":
      durationMs = value * 30 * 86_400_000;
      break;
    case "year":
      durationMs = value * 365 * 86_400_000;
      break;
    default:
      return {};
  }
  const out: DurationClocks = { durationMs, durationRounds };
  if (durationMs != null) {
    out.untilMs = at + durationMs;
    if (Number.isFinite(worldTime)) out.untilWorld = Number(worldTime) + durationMs / 1000;
  }
  if (durationRounds != null && Number.isFinite(clock.round)) {
    out.untilRound = Number(clock.round) + durationRounds;
  }
  return out;
}

// Writing a diagnostic report to the world's data folder.
//
// The only thing this module ever writes to disk is a survey — a JSON census of what the world's
// sheets actually contain, which is how three shipped bugs were found and is far too large to read
// out of a chat message. `noodlr` has a whole media-storage layer with a configurable folder; this
// needs one function and a fixed destination, so it has one.
//
// Foundry v13 forbids uploads into `modules`, `systems`, `worlds` and the data root, but allows any
// new top-level folder, so reports land in `noodlr-hooks/`. A failure here returns null and is
// reported to the console: the report is also printed there, so losing the file loses nothing.

import { log } from "../constants";

/** Resolve the v13 FilePicker class (namespaced), falling back to the legacy global. */
function filePicker(): any {
  const ns = (foundry as any).applications?.apps?.FilePicker;
  return ns ?? (globalThis as any).FilePicker;
}

/** Create each segment of a folder path. An "already exists" error is the normal case. */
async function ensureFolder(folder: string): Promise<void> {
  const fp = filePicker();
  if (!fp?.createDirectory) return;
  let path = "";
  for (const part of folder.split("/").filter(Boolean)) {
    path = path ? `${path}/${part}` : part;
    try {
      await fp.createDirectory("data", path);
    } catch (err) {
      const message = String((err as { message?: string })?.message ?? err);
      if (!/exist/i.test(message)) log("could not create folder:", message);
    }
  }
}

/**
 * Write a JSON report, overwriting any previous file of the same name, and return its path.
 *
 * Overwriting is deliberate: a survey is a snapshot of the world as it is now, and a folder that
 * accumulated one per run would be worse than useless for comparing two of them.
 */
export async function writeReport(
  fileName: string,
  data: unknown,
  folder = "noodlr-hooks",
): Promise<string | null> {
  const fp = filePicker();
  if (!fp?.upload) return null;
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const file = new File([blob], fileName, { type: "application/json" });
    await ensureFolder(folder);
    const res = await fp.upload("data", folder, file, {}, { notify: false });
    return typeof res?.path === "string" ? res.path : `${folder}/${fileName}`;
  } catch (err) {
    log("could not write the report:", err);
    return null;
  }
}

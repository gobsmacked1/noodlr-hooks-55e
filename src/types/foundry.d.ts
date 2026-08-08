// Minimal ambient declarations for the Foundry VTT client globals we touch.
//
// Deliberately loose (`any`): Foundry's API churns across versions (v14 is current
// stable, ApplicationV2 is standard, original Application deprecates in v16), and a
// full community types package tends to lag the live API. We keep our own thin surface
// and tighten specific shapes only where a bug would otherwise slip through. This is a
// clean-room project: these declarations describe the host, they are not host code.

declare global {
  /** The global game object; populated after the "setup"/"ready" lifecycle. */
  const game: any;

  /** UI layer singletons (notifications, sidebar, windows, ...). */
  const ui: any;

  /**
   * The active canvas (scene, placeable layers, vision). Undefined/uninitialized when the game runs
   * with no canvas ("canvas disabled" setting or before first render), so always guard access.
   */
  const canvas: any;

  /** Runtime configuration registry. */
  const CONFIG: any;

  /** The Foundry namespace root (foundry.applications.api.ApplicationV2, ...). */
  const foundry: any;

  /** Handlebars runtime provided by Foundry. */
  const Handlebars: any;

  /** Foundry's event/hook bus. */
  const Hooks: {
    on(hook: string, fn: (...args: any[]) => any): number;
    once(hook: string, fn: (...args: any[]) => any): number;
    off(hook: string, id: number): void;
    call(hook: string, ...args: any[]): boolean;
    callAll(hook: string, ...args: any[]): boolean;
  };
}

export {};

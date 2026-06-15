import { useSettings } from "@/settingsStore";
import { FLAGS, resolveFlag, type FlagKey } from "@/lib/flags";

/** Resolve a single feature flag, reactive to its override.
 *  Read just this flag's override (cheap) and resolve against the build mode. */
export function useFlag(key: FlagKey): boolean {
  const override = useSettings((s) => s.flagOverrides[key]);
  return resolveFlag(FLAGS[key], override, import.meta.env.DEV);
}

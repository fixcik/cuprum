import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import type { Finding, I18nText } from "@/lib/feasibility";

/** Param names carrying a RAW length in mm — formatted via fmtLen at render. */
const LEN_PARAMS = new Set(["len", "w", "h"]);

/** Renderers that resolve a finding's {@link I18nText} to a display string:
 *  length params are unit-formatted, key-like string params (containing ":") are
 *  translated, then the text key is translated with the resulting params. The
 *  returned callbacks are stable (safe to use in `useMemo`/`useCallback` deps).
 *
 *  Shared by FeasibilityTab and DesignInspector, which previously each carried an
 *  identical copy of this logic. */
export function useFindingText() {
  const { t } = useTranslation(["feasibility", "common"]);
  const { fmtLen, fmtLenPair } = useUnitFormat();

  // `lenOverride`, when given, replaces the `len` param's value (so a finding's
  // value and limit can be rendered in one shared unit by the caller).
  const resolveText = useCallback(
    (text?: I18nText, lenOverride?: string): string => {
      if (!text) return "";
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(text.params ?? {})) {
        if (k === "len" && lenOverride != null && typeof v === "number") params[k] = lenOverride;
        else if (Array.isArray(v)) params[k] = v.map((mm) => fmtLen(mm)).join(", ");
        else if (LEN_PARAMS.has(k) && typeof v === "number") params[k] = fmtLen(v);
        else if (typeof v === "string" && v.includes(":")) params[k] = t(v);
        else params[k] = v;
      }
      return t(text.key, params);
    },
    [t, fmtLen],
  );

  const tr = useCallback((text?: I18nText): string => resolveText(text), [resolveText]);
  const trLen = useCallback(
    (text: I18nText | undefined, lenStr: string): string => resolveText(text, lenStr),
    [resolveText],
  );

  // Format a finding's measured + limit in a shared unit when both are simple
  // lengths; otherwise resolve each independently.
  const measuredLimit = useCallback(
    (f: Finding): { measured: string; limit: string } => {
      const m = f.measured?.params?.len;
      const l = f.limit?.params?.len;
      if (typeof m === "number" && typeof l === "number") {
        const [ms, ls] = fmtLenPair([m, l]);
        return { measured: trLen(f.measured, ms), limit: trLen(f.limit, ls) };
      }
      return { measured: tr(f.measured), limit: tr(f.limit) };
    },
    [tr, trLen, fmtLenPair],
  );

  return { tr, trLen, measuredLimit };
}

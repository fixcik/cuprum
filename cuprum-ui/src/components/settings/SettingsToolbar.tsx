import { useTranslation } from "react-i18next";
import { Check, RotateCcw, Search, X } from "lucide-react";

/** Search input for the settings cards. Clears with the trailing X when filled. */
export function SearchBox({ query, setQuery }: { query: string; setQuery: (q: string) => void }) {
  const { t } = useTranslation("settings");
  return (
    <div className="relative flex h-9 w-full items-center rounded-md border border-input bg-[hsl(var(--input)/0.25)] px-2.5">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("equipment.searchPlaceholder")}
        className="w-full bg-transparent px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      {query && (
        <button
          type="button"
          aria-label={t("equipment.searchClear")}
          onClick={() => setQuery("")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/** Changed-from-factory indicator + reset-to-factory button. No "save" — config
 *  persists live via updateMachine. */
export function DirtyBar({ dirtyCount, onReset }: { dirtyCount: number; onReset: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex items-center gap-2">
      {dirtyCount > 0 ? (
        <span className="flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-[11px] font-medium text-primary">
          <span className="size-1.5 rounded-full bg-primary" />
          {t("equipment.dirtyCount", { count: dirtyCount })}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <Check className="size-3.5" />
          {t("equipment.factoryDefaults")}
        </span>
      )}
      <button
        type="button"
        onClick={onReset}
        disabled={dirtyCount === 0}
        title={t("equipment.resetToFactory")}
        aria-label={t("equipment.resetToFactory")}
        className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <RotateCcw className="size-4" />
      </button>
    </div>
  );
}

/** Case-insensitive substring match used by the search filter. */
export function matchesQuery(text: string, query: string): boolean {
  if (!query.trim()) return true;
  return text.toLowerCase().includes(query.trim().toLowerCase());
}

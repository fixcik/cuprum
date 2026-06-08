import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cable, Crosshair, Fan, RotateCcw, Settings2, Sliders } from "lucide-react";
import { api } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SearchBox, matchesQuery } from "@/components/settings/SettingsToolbar";
import { GrblSettingField } from "@/components/settings/GrblSettingField";
import {
  GRBL_SETTINGS,
  GROUP_ORDER,
  criticalAmong,
  defFor,
  diffDrafts,
  type GrblSettingDef,
  type SettingGroup,
} from "@/lib/grblSettings";

const GROUP_ICON: Record<SettingGroup, typeof Settings2> = {
  general: Settings2,
  limits: Crosshair,
  spindle: Fan,
  axis: Sliders,
};

/** GRBL firmware-settings tab: reads the controller's `$$` on connect, collects
 *  edits in a draft, and writes changed `$N=value` lines on Apply (critical
 *  changes go through a confirm dialog), then re-reads. Active only when the
 *  machine is connected. */
export function GrblTab() {
  const { t } = useTranslation("grbl");
  const connected = useMachine((s) => s.connected);
  const [baseline, setBaseline] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Confirm dialog holds BOTH the critical defs (to list) AND the full set of
  // changed `n`s captured at Apply time — so editing a field back to baseline
  // while the dialog is open can't make the write use a stale change set.
  const [confirm, setConfirm] = useState<{ defs: GrblSettingDef[]; ns: number[] } | null>(null);

  // Guard async state updates against unmount: the tab is torn down when the
  // user switches CNC sub-tabs, which can happen mid-read or mid-apply.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Dedupe concurrent reads. `machine_read_settings` claims the single GRBL
  // ack slot for the duration of a `$$` dump, so a second overlapping read is
  // rejected with "machine busy". React StrictMode's double-mount (dev) and
  // fast reconnect/refresh both fire reload() twice — without this guard the
  // second call would surface a spurious "machine busy" over a good first read.
  const readingRef = useRef(false);
  const reload = useCallback(async () => {
    if (readingRef.current) return;
    readingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const list = await api.machine.readSettings();
      if (!mountedRef.current) return;
      setBaseline(Object.fromEntries(list.map((s) => [s.n, s.value])));
      setDraft({});
    } catch (e) {
      if (mountedRef.current) setError(t("readError", { error: String(e) }));
    } finally {
      readingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [t]);

  // Read once when the tab is shown and the machine is connected; clear on
  // disconnect so a reconnect re-reads fresh.
  useEffect(() => {
    if (connected) void reload();
    else {
      setBaseline({});
      setDraft({});
    }
  }, [connected, reload]);

  const changed = useMemo(() => diffDrafts(baseline, draft), [baseline, draft]);
  const valueOf = (n: number) => draft[n] ?? baseline[n] ?? "";
  const setValue = (n: number, raw: string) => setDraft((d) => ({ ...d, [n]: raw }));

  // Settings present on the controller but not in the catalog → "other" group.
  const unknownNs = useMemo(
    () =>
      Object.keys(baseline)
        .map(Number)
        .filter((n) => !defFor(n))
        .sort((a, b) => a - b),
    [baseline],
  );
  const filteredUnknown = useMemo(
    () => unknownNs.filter((n) => matchesQuery(`$${n}`, query)),
    [unknownNs, query],
  );

  const doApply = async (ns: number[]) => {
    setApplying(true);
    setError(null);
    let current = ns[0];
    try {
      for (const n of ns) {
        current = n;
        await api.machine.sendAwaitOk(`$${n}=${draft[n]}`);
      }
      await reload();
    } catch (e) {
      // `e` is the rejected line's error; `current` is the setting that failed.
      if (mountedRef.current) setError(t("applyError", { n: current, error: String(e) }));
    } finally {
      if (mountedRef.current) setApplying(false);
    }
  };

  const onApply = () => {
    if (changed.length === 0) return;
    const crit = criticalAmong(changed);
    if (crit.length > 0) setConfirm({ defs: crit, ns: changed });
    else void doApply(changed);
  };

  if (!connected) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <Cable className="size-6 opacity-60" />
          <p className="max-w-xs text-[12px]">{t("connectPrompt")}</p>
        </div>
      </div>
    );
  }

  const matchDef = (d: GrblSettingDef) =>
    matchesQuery(`$${d.n} ${t(`setting.${d.key}.label`)} ${t(`setting.${d.key}.desc`)}`, query);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <div className="w-[300px]">
          <SearchBox query={query} setQuery={setQuery} />
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading || applying}
          title={t("refresh")}
          aria-label={t("refresh")}
          className="grid size-9 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {changed.length > 0 ? t("changeCount", { count: changed.length }) : t("noChanges")}
          </span>
          <Button variant="ghost" onClick={() => setDraft({})} disabled={changed.length === 0 || applying}>
            {t("reset")}
          </Button>
          <Button onClick={onApply} disabled={changed.length === 0 || applying}>
            {applying ? t("applying") : t("apply")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-[12px] text-destructive">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
        {GROUP_ORDER.map((group) => {
          const defs = GRBL_SETTINGS.filter((d) => d.group === group && matchDef(d));
          if (defs.length === 0) return null;
          const Icon = GROUP_ICON[group];
          return (
            <Card key={group} icon={Icon} title={t(`group.${group}`)}>
              <div className="divide-y divide-border/50">
                {defs.map((d) => (
                  <GrblSettingField
                    key={d.n}
                    n={d.n}
                    def={d}
                    value={valueOf(d.n)}
                    dirty={changed.includes(d.n)}
                    onChange={(raw) => setValue(d.n, raw)}
                  />
                ))}
              </div>
            </Card>
          );
        })}

        {filteredUnknown.length > 0 && (
          <Card icon={Sliders} title={t("group.other")}>
            <div className="divide-y divide-border/50">
              {filteredUnknown.map((n) => (
                <GrblSettingField
                  key={n}
                  n={n}
                  value={valueOf(n)}
                  dirty={changed.includes(n)}
                  onChange={(raw) => setValue(n, raw)}
                />
              ))}
            </div>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const ns = confirm?.ns ?? [];
          setConfirm(null);
          void doApply(ns);
        }}
        title={t("confirmCritical.title")}
        confirmLabel={t("confirmCritical.confirm")}
        cancelLabel={t("confirmCritical.cancel")}
        destructive
        message={
          <span className="block">
            {t("confirmCritical.body")}
            <span className="mt-2 block space-y-1 font-mono text-[12px]">
              {(confirm?.defs ?? []).map((d) => (
                <span key={d.n} className="block">
                  ${d.n} {t(`setting.${d.key}.label`)}: {baseline[d.n]} → {draft[d.n]}
                </span>
              ))}
            </span>
          </span>
        }
      />
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { CircuitBoard, FolderOpen, LayoutGrid, List, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { RecentTile } from "@/components/home/RecentTile";
import { Button } from "@/components/ui/Button";
import { DashedAddTile } from "@/components/ui/DashedAddTile";
import { TextInput } from "@/components/ui/TextInput";
import { Select } from "@/components/ui/Select";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useShell } from "@/shellStore";

type SortKey = "date" | "name";
type Layout = "grid" | "list";

export function HomePage() {
  const { t } = useTranslation("home");
  const recents = useShell((s) => s.recents);
  const recentsLoading = useShell((s) => s.recentsLoading);
  const loadRecents = useShell((s) => s.loadRecents);
  const newProject = useShell((s) => s.newProject);
  const openFromPicker = useShell((s) => s.openProjectFromPicker);
  const error = useShell((s) => s.error);
  const homeNotice = useShell((s) => s.homeNotice);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [layout, setLayout] = useState<Layout>("grid");

  useEffect(() => {
    loadRecents();
  }, [loadRecents]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = recents.filter((r) => r.name.toLowerCase().includes(q));
    return [...list].sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : b.last_opened_at - a.last_opened_at,
    );
  }, [recents, query, sort]);

  const recentCount = recents.length;
  const loading = recentsLoading && recents.length === 0;
  // Full empty state only when there are genuinely no projects; an empty *search*
  // result keeps the toolbar and shows a "nothing found" line instead.
  const showFullEmpty = !loading && recentCount === 0;
  const showNoResults = !loading && recentCount > 0 && filtered.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-6 py-3.5">
        <div className="mx-auto flex max-w-[1120px] items-center gap-3">
          <h1 className="text-[15px] font-semibold text-foreground">{t("title")}</h1>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button onClick={newProject}>
            <Plus />
            {t("newProject")}
          </Button>
          <Button variant="outline" onClick={openFromPicker}>
            <FolderOpen />
            {t("open")}
          </Button>
          <div className="relative ml-auto w-64">
            <TextInput
              className="h-9"
              icon={<Search className="size-3.5" />}
              placeholder={t("searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto flex h-full max-w-[1120px] flex-col">
          {error && <p className="mb-3 shrink-0 text-[12px] text-destructive">{error}</p>}
          {homeNotice && (
            <p className="mb-3 shrink-0 text-[12px] text-muted-foreground">{homeNotice}</p>
          )}

          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-[12px] text-muted-foreground">{t("loading")}</p>
            </div>
          ) : showFullEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
              <div className="grid size-14 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
                <CircuitBoard className="size-7" />
              </div>
              <div>
                <div className="text-[15px] font-semibold text-foreground">{t("emptyTitle")}</div>
                <p className="mt-1 max-w-sm text-[12px] text-muted-foreground">{t("emptyDesc")}</p>
              </div>
              <div className="flex gap-2">
                <Button onClick={newProject}>
                  <Plus />
                  {t("newProject")}
                </Button>
                <Button variant="outline" onClick={openFromPicker}>
                  <FolderOpen />
                  {t("open")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-4 flex shrink-0 items-center gap-3 border-b border-border pb-3">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("recents")}
                  <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground/70">
                    · {recentCount}
                  </span>
                </span>
                <SegmentedControl
                  value={layout}
                  onChange={setLayout}
                  options={[
                    {
                      value: "grid",
                      icon: <LayoutGrid className="size-3.5" />,
                      title: t("viewGrid"),
                    },
                    { value: "list", icon: <List className="size-3.5" />, title: t("viewList") },
                  ]}
                />
                <Select
                  className="h-7"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                >
                  <option value="date">{t("sortByDate")}</option>
                  <option value="name">{t("sortByName")}</option>
                </Select>
              </div>

              {showNoResults ? (
                <div className="flex flex-1 items-center justify-center px-4 text-center">
                  <p className="max-w-md text-[13px] text-muted-foreground">{t("noResults")}</p>
                </div>
              ) : layout === "grid" ? (
                <div
                  className="grid gap-4"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
                >
                  <DashedAddTile
                    onClick={newProject}
                    icon={<Plus className="size-7" />}
                    title={t("newProject")}
                    subtitle={t("newTileHint")}
                    className="min-h-[210px]"
                  />
                  {filtered.map((p) => (
                    <RecentTile key={p.path} project={p} layout="grid" />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {filtered.map((p) => (
                    <RecentTile key={p.path} project={p} layout="list" />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Grid3x3, List, Plus, Search } from "lucide-react";
import { RecentTile } from "@/components/home/RecentTile";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { Select } from "@/components/ui/Select";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useShell } from "@/shellStore";

type SortKey = "date" | "name";
type Layout = "grid" | "list";

export function HomePage() {
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

  const showEmpty = !recentsLoading && filtered.length === 0;
  const recentCount = recents.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="sticky top-0 z-10 shrink-0 border-b border-border bg-background px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Button size="sm" onClick={newProject}>
            <Plus />
            Новый проект
          </Button>
          <Button size="sm" variant="outline" onClick={openFromPicker}>
            <FolderOpen />
            Открыть…
          </Button>
          <div className="min-w-0 flex-1">
            <TextInput
              icon={<Search className="size-3.5" />}
              placeholder="Поиск по недавним…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
      </header>

      <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
        {homeNotice && (
          <p className="mb-3 shrink-0 text-[12px] text-muted-foreground">{homeNotice}</p>
        )}

        <div className="mb-3 flex shrink-0 items-center gap-2.5 border-b border-border pb-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Недавние
            {recentCount > 0 && (
              <span className="ml-1.5 font-normal normal-case tracking-normal text-muted-foreground/80">
                · {recentCount}
              </span>
            )}
          </span>
          <SegmentedControl
            value={layout}
            onChange={setLayout}
            options={[
              { value: "grid", icon: <Grid3x3 className="size-3.5" />, title: "Сетка" },
              { value: "list", icon: <List className="size-3.5" />, title: "Список" },
            ]}
          />
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="date">по дате</option>
            <option value="name">по имени</option>
          </Select>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {recentsLoading && recents.length === 0 ? (
            <div className="flex h-full min-h-[12rem] items-center justify-center">
              <p className="text-[12px] text-muted-foreground">Загрузка…</p>
            </div>
          ) : showEmpty ? (
            <div className="flex h-full min-h-[12rem] flex-col items-center justify-center px-4 text-center">
              <p className="max-w-md text-[13px] text-muted-foreground">
                {query.trim()
                  ? "Ничего не найдено. Попробуй другой запрос."
                  : "Пока нет проектов — создай новый или открой существующий."}
              </p>
              {!query.trim() && (
                <div className="mt-4 flex gap-2">
                  <Button size="sm" onClick={newProject}>
                    <Plus />
                    Новый проект
                  </Button>
                  <Button size="sm" variant="outline" onClick={openFromPicker}>
                    <FolderOpen />
                    Открыть…
                  </Button>
                </div>
              )}
            </div>
          ) : layout === "grid" ? (
            <div
              className="grid gap-x-3.5 gap-y-4"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}
            >
              {filtered.map((p) => (
                <RecentTile key={p.path} project={p} layout="grid" />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {filtered.map((p) => (
                <RecentTile key={p.path} project={p} layout="list" />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { Home, LayoutGrid, Printer, Settings } from "lucide-react";
import { useShell, type View } from "@/shellStore";

interface RailItem {
  view: View;
  icon: typeof Home;
  label: string;
  /** Disabled until a project is open. */
  needsProject?: boolean;
}

const ITEMS: RailItem[] = [
  { view: "home", icon: Home, label: "Home" },
  { view: "project", icon: LayoutGrid, label: "Проект", needsProject: true },
  { view: "printer", icon: Printer, label: "Принтер" },
];

export function NavRail() {
  const view = useShell((s) => s.view);
  const setView = useShell((s) => s.setView);
  const hasProject = useShell((s) => s.currentPath !== null);

  const btnClass = (active: boolean, disabled: boolean) =>
    [
      "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
      active ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground",
      disabled ? "opacity-30 cursor-default" : "",
    ].join(" ");

  return (
    <nav className="flex w-[52px] flex-none flex-col items-center gap-1.5 border-r border-border bg-panel py-2.5">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const disabled = !!item.needsProject && !hasProject;
        return (
          <button
            key={item.view}
            title={item.label}
            disabled={disabled}
            onClick={() => setView(item.view)}
            className={btnClass(view === item.view, disabled)}
          >
            <Icon size={20} />
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        title="Настройки"
        onClick={() => setView("settings")}
        className={btnClass(view === "settings", false)}
      >
        <Settings size={20} />
      </button>
    </nav>
  );
}

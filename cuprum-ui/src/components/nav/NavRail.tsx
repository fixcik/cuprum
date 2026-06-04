import { Cpu, Home, LayoutGrid, Printer, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShell, type View } from "@/shellStore";

interface RailItem {
  view: View;
  icon: typeof Home;
  key: "home" | "project" | "printer" | "machine";
  /** Disabled until a project is open. */
  needsProject?: boolean;
}

const ITEMS: RailItem[] = [
  { view: "home", icon: Home, key: "home" },
  { view: "project", icon: LayoutGrid, key: "project", needsProject: true },
  { view: "printer", icon: Printer, key: "printer" },
  { view: "machine", icon: Cpu, key: "machine" },
];

export function NavRail() {
  const { t } = useTranslation("nav");
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
            title={t(item.key)}
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
        title={t("settings")}
        onClick={() => setView("settings")}
        className={btnClass(view === "settings", false)}
      >
        <Settings size={20} />
      </button>
    </nav>
  );
}

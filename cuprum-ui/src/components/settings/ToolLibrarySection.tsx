import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/settingsStore";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TextInput } from "@/components/ui/TextInput";
import { NumberField } from "@/components/settings/fields";
import type { Tool, ToolKind, ToolMaterial } from "@/lib/toolLibrary";

function ToolRow({ tool }: { tool: Tool }) {
  const { t } = useTranslation("settings");
  const update = useSettings((s) => s.updateTool);
  const remove = useSettings((s) => s.removeTool);
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <TextInput
          value={tool.name}
          onChange={(e) => update(tool.id, { name: e.target.value })}
          className="flex-1 text-[12px]"
        />
        <button
          type="button"
          onClick={() => remove(tool.id)}
          aria-label={t("tools.remove")}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<ToolKind>
          value={tool.kind}
          onChange={(kind) => update(tool.id, { kind })}
          options={[
            { value: "drill", label: t("tools.kind.drill") },
            { value: "endmill", label: t("tools.kind.endmill") },
            { value: "vbit", label: t("tools.kind.vbit") },
          ]}
        />
        <SegmentedControl<ToolMaterial>
          value={tool.material}
          onChange={(material) => update(tool.id, { material })}
          options={[
            { value: "carbide", label: t("tools.material.carbide") },
            { value: "hss", label: t("tools.material.hss") },
          ]}
        />
      </div>
      <div className="divide-y divide-border/60">
        <NumberField
          label={t("tools.diameter")}
          value={tool.diameterMm}
          dim="fine"
          onChange={(diameterMm) => update(tool.id, { diameterMm })}
        />
        <NumberField
          label={t("tools.rpm")}
          value={tool.recommendedRpm}
          step="100"
          onChange={(recommendedRpm) => update(tool.id, { recommendedRpm })}
        />
        <NumberField
          label={t("tools.feed")}
          value={tool.recommendedFeedMmMin}
          step="10"
          onChange={(recommendedFeedMmMin) => update(tool.id, { recommendedFeedMmMin })}
        />
        <NumberField
          label={t("tools.plunge")}
          value={tool.recommendedPlungeMmMin}
          step="10"
          onChange={(recommendedPlungeMmMin) => update(tool.id, { recommendedPlungeMmMin })}
        />
        {tool.kind === "vbit" && (
          <NumberField
            label={t("tools.angle")}
            value={tool.angleDeg ?? 30}
            step="1"
            onChange={(angleDeg) => update(tool.id, { angleDeg })}
          />
        )}
      </div>
    </div>
  );
}

export function ToolLibrarySection() {
  const { t } = useTranslation("settings");
  const tools = useSettings((s) => s.tools);
  const addTool = useSettings((s) => s.addTool);
  return (
    <div className="flex flex-col gap-2">
      {tools.map((tool) => (
        <ToolRow key={tool.id} tool={tool} />
      ))}
      <button
        type="button"
        onClick={addTool}
        className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-4" /> {t("tools.add")}
      </button>
    </div>
  );
}

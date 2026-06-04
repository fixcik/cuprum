import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  SlidersHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Ruler,
  Layers,
  ChevronDown,
  RotateCw,
  AlertTriangle,
  Save,
  type LucideIcon,
} from "lucide-react";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { SettingRow } from "@/components/ui/settings/SettingRow";
import { UnitField } from "@/components/ui/settings/UnitField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { StackupDiagram } from "@/components/project/StackupDiagram";
import { PlacementFields } from "@/components/project/PlacementFields";
import { COPPER_WEIGHTS, type PanelPreset } from "@/lib/panel";

// ---- local sub-components ----

function AccordionSection({
  icon: Icon,
  title,
  open,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-[12px] font-semibold text-foreground">{title}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}

function PresetMini({ w, h }: { w: number; h: number }) {
  const rw = Math.max(6, Math.min(19, (w / 240) * 19));
  const rh = Math.max(5, Math.min(13, (h / 200) * 13));
  return (
    <svg width={22} height={16} viewBox="0 0 22 16" className="shrink-0">
      <rect x={1.5} y={1.5} width={rw} height={rh} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.2} rx={1} />
    </svg>
  );
}

// ---- main component ----

interface PanelInspectorProps {
  width: number;
  height: number;
  copperWeight: number;
  substrate: number;
  doubleSided: boolean;
  setWidth: (n: number) => void;
  setHeight: (n: number) => void;
  setCopperWeight: (n: number) => void;
  setSubstrate: (n: number) => void;
  setDoubleSided: (b: boolean) => void;
  widthTooBig: boolean;
  heightTooBig: boolean;
  maxW: number;
  maxH: number;
  offPanelCount: number;
  presets: PanelPreset[];
  onApplyPreset: (id: string) => void;
  onSavePreset: () => void;
  onRotate: () => void;
}

/** Collapsible, resizable right-dock inspector for panel parameters.
 *  Presentational: values + setters come from props; dock UI state
 *  (collapsed/width/accordion sections open) is persisted in settingsStore. */
export function PanelInspector({
  width,
  height,
  copperWeight,
  substrate,
  doubleSided,
  setWidth,
  setHeight,
  setCopperWeight,
  setSubstrate,
  setDoubleSided,
  widthTooBig,
  heightTooBig,
  maxW,
  maxH,
  offPanelCount,
  presets,
  onApplyPreset,
  onSavePreset,
  onRotate,
}: PanelInspectorProps) {
  const { t } = useTranslation("project");
  const { fmtLen } = useUnitFormat();

  const ui = useSettings((s) => s.panelInspector);
  const setUi = useSettings((s) => s.setPanelInspector);

  // Resize drag state — stored in refs so pointer handlers don't trigger re-renders.
  const resizeDrag = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (ui.collapsed) return;
    resizeDrag.current = { startX: e.clientX, startWidth: ui.width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeDrag.current) return;
    const { startX, startWidth } = resizeDrag.current;
    const next = Math.max(280, Math.min(480, startWidth + (startX - e.clientX)));
    setUi({ width: next });
  };

  const handleResizePointerUp = () => {
    resizeDrag.current = null;
  };

  return (
    <div
      className="relative flex shrink-0 border-l border-border bg-panel"
      style={{ width: ui.collapsed ? 44 : ui.width }}
    >
      {/* Resize handle — left edge, only when expanded */}
      {!ui.collapsed && (
        <div
          className="absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
        />
      )}

      {/* Collapsed rail */}
      {ui.collapsed && (
        <div className="flex w-[44px] flex-col items-center gap-3 py-3">
          <button
            type="button"
            title={t("setup.inspectorExpand")}
            aria-label={t("setup.inspectorExpand")}
            onClick={() => setUi({ collapsed: false })}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <PanelRightOpen className="size-[18px]" />
          </button>
          <div className="mt-1 rotate-180 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground [writing-mode:vertical-rl]">
            {t("setup.inspectorTitle")}
          </div>
        </div>
      )}

      {/* Expanded content */}
      {!ui.collapsed && (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <div className="flex items-center gap-2 text-[12px] font-semibold text-foreground">
              <SlidersHorizontal className="size-4 text-muted-foreground" />
              {t("setup.inspectorTitle")}
            </div>
            <button
              type="button"
              title={t("setup.inspectorCollapse")}
              aria-label={t("setup.inspectorCollapse")}
              onClick={() => setUi({ collapsed: true })}
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <PanelRightClose className="size-4" />
            </button>
          </div>

          {/* Summary */}
          <div className="border-b border-border px-3 py-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-[11px] text-muted-foreground">{t("setup.blankSummaryLabel")}</div>
                <div className="text-[18px] font-semibold tabular-nums text-foreground">
                  {fmtLen(width)} × {fmtLen(height)}
                </div>
              </div>
              <span className="rounded-md bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
                {t("setup.workZone", { w: fmtLen(maxW), h: fmtLen(maxH) })}
              </span>
            </div>
            {(widthTooBig || heightTooBig) && (
              <div className="mt-2 flex items-center gap-1.5 rounded-md bg-warning/15 px-2 py-1.5 text-[11px] text-warning">
                <AlertTriangle className="size-3.5 shrink-0" />
                {t("setup.overWorkArea", { w: fmtLen(maxW), h: fmtLen(maxH) })}
              </div>
            )}
          </div>

          {/* Scrollable accordion body */}
          <div className="min-h-0 flex-1 overflow-auto">
            {/* Numeric placement inspector for the current selection (self-
                contained: subscribes to the selection + panel stores). Renders
                nothing when no instance is selected. */}
            <PlacementFields panelW={width} panelH={height} />

            {/* Size accordion */}
            <AccordionSection
              icon={Ruler}
              title={t("setup.sectionBlank")}
              open={ui.sizeOpen}
              onToggle={() => setUi({ sizeOpen: !ui.sizeOpen })}
            >
              {/* Preset chips */}
              <div className="mb-1 text-[11px] text-muted-foreground">{t("setup.preset")}</div>
              <div className="mb-3 grid grid-cols-2 gap-1.5">
                {presets.map((p) => {
                  const active =
                    p.widthMm === width &&
                    p.heightMm === height &&
                    p.stackup.copper_weight_oz === copperWeight &&
                    p.stackup.substrate_thickness_mm === substrate &&
                    (p.stackup.double_sided ?? false) === doubleSided;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onApplyPreset(p.id)}
                      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[11px] ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      <PresetMini w={p.widthMm} h={p.heightMm} />
                      <span className="truncate tabular-nums">{p.name}</span>
                    </button>
                  );
                })}
              </div>

              {/* Save preset button */}
              <button
                type="button"
                onClick={onSavePreset}
                className="mt-0.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <Save className="size-3.5" />
                {t("setup.savePreset")}
              </button>

              {/* Width / Height fields */}
              <SettingRow label={t("setup.width")}>
                <UnitField value={width} onChange={setWidth} dim="coarse" step="1" invalid={widthTooBig} />
              </SettingRow>
              <SettingRow label={t("setup.height")}>
                <UnitField value={height} onChange={setHeight} dim="coarse" step="1" invalid={heightTooBig} />
              </SettingRow>

              {/* Rotate button */}
              <button
                type="button"
                onClick={onRotate}
                className="mt-1.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                <RotateCw className="size-3.5" />
                {t("setup.rotate90")}
              </button>

              {/* Off-panel warning */}
              {offPanelCount > 0 && (
                <p className="mt-1.5 text-[11px] text-warning">
                  {t("setup.offPanelWarning", { count: offPanelCount })}
                </p>
              )}
            </AccordionSection>

            {/* Stackup accordion */}
            <AccordionSection
              icon={Layers}
              title={t("setup.sectionStackup")}
              open={ui.stackupOpen}
              onToggle={() => setUi({ stackupOpen: !ui.stackupOpen })}
            >
              <div className="mb-3">
                <StackupDiagram copperWeight={copperWeight} substrateMm={substrate} doubleSided={doubleSided} />
              </div>

              <SettingRow label={t("setup.sides")}>
                <SegmentedControl<"single" | "double">
                  value={doubleSided ? "double" : "single"}
                  onChange={(v) => setDoubleSided(v === "double")}
                  options={[
                    { value: "single", label: t("setup.sidesSingle") },
                    { value: "double", label: t("setup.sidesDouble") },
                  ]}
                />
              </SettingRow>

              <SettingRow label={t("setup.copperWeight")}>
                <Select
                  value={String(copperWeight)}
                  onChange={(e) => setCopperWeight(parseFloat(e.target.value))}
                  className="w-28"
                >
                  {COPPER_WEIGHTS.map((w) => (
                    <option key={w} value={w}>
                      {w} oz
                    </option>
                  ))}
                </Select>
              </SettingRow>

              <SettingRow label={t("setup.substrate")}>
                <UnitField value={substrate} onChange={setSubstrate} dim="fine" step="0.1" />
              </SettingRow>
            </AccordionSection>
          </div>
        </div>
      )}
    </div>
  );
}

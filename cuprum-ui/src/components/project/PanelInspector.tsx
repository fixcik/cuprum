import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  SlidersHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Ruler,
  Layers,
  ShieldCheck,
  ChevronDown,
  RotateCw,
  Save,
  X,
  type LucideIcon,
} from "lucide-react";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { SettingRow } from "@/components/ui/settings/SettingRow";
import { UnitField } from "@/components/ui/settings/UnitField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { StackupDiagram } from "@/components/project/StackupDiagram";
import { COPPER_WEIGHTS, type PanelPreset } from "@/lib/panel";
import { usePanelFindings } from "@/hooks/usePanelFindings";
import { usePanelSelection } from "@/panelSelectionStore";
import { SEVERITY } from "@/lib/severity";
import { overallVerdict } from "@/lib/feasibility";
import type { PanelFinding } from "@/lib/panelFeasibility";

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

/** Compact verdict badge pill. */
function VerdictPill({ findings }: { findings: PanelFinding[] }) {
  const { t } = useTranslation("feasibility");
  const verdict = overallVerdict(findings);
  const sev = verdict === "ok" ? "ok" : verdict === "warn" ? "warn" : "block";
  const { Icon, fg, bg } = SEVERITY[sev];
  const key = verdict === "ok" ? "verdict.ok" : verdict === "warn" ? "verdict.warn" : "verdict.block";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${bg} ${fg}`}>
      <Icon className="size-3" />
      {t(key)}
    </span>
  );
}

/** One finding row: severity icon + text; clicking selects the culprit instances. */
function FindingRow({ finding, onSelect }: { finding: PanelFinding; onSelect: (ids: string[]) => void }) {
  const { t } = useTranslation("feasibility");
  const { Icon, fg } = SEVERITY[finding.severity];
  const text = t(finding.title.key, finding.title.params as Record<string, string | number>);
  return (
    <button
      type="button"
      className={`flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-foreground/8 ${finding.instanceIds.length > 0 ? "cursor-pointer" : "cursor-default"}`}
      onClick={() => { if (finding.instanceIds.length > 0) onSelect(finding.instanceIds); }}
      title={finding.instanceIds.length > 0 ? t("panel.clickToHighlight") : undefined}
    >
      <Icon className={`mt-px size-3 shrink-0 ${fg}`} />
      <span className="leading-snug text-foreground/80">{text}</span>
    </button>
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
  offPanelCount: number;
  presets: PanelPreset[];
  onApplyPreset: (id: string) => void;
  onSavePreset: () => void;
  onDeletePreset: (id: string) => void;
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
  offPanelCount,
  presets,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  onRotate,
}: PanelInspectorProps) {
  const { t } = useTranslation("project");
  const { fmtLen } = useUnitFormat();

  const ui = useSettings((s) => s.panelInspector);
  const setUi = useSettings((s) => s.setPanelInspector);

  // Panel-level findings — single source of truth.
  const { findings: panelFindings } = usePanelFindings();
  const setSelection = usePanelSelection((s) => s.set);

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
            <div className="text-[11px] text-muted-foreground">{t("setup.blankSummaryLabel")}</div>
            <div className="text-[18px] font-semibold tabular-nums text-foreground">
              {fmtLen(width)} × {fmtLen(height)}
            </div>
          </div>

          {/* Scrollable accordion body */}
          <div className="min-h-0 flex-1 overflow-auto">
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
                    <div key={p.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => onApplyPreset(p.id)}
                        className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 pr-6 text-left text-[11px] ${
                          active
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        <PresetMini w={p.widthMm} h={p.heightMm} />
                        <span className="truncate tabular-nums">{p.name}</span>
                      </button>
                      {/* Delete affordance — appears on hover; built-ins are hidden,
                          user presets removed (handled by the parent). */}
                      <button
                        type="button"
                        title={t("setup.deletePreset")}
                        aria-label={t("setup.deletePreset")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeletePreset(p.id);
                        }}
                        className="absolute right-1 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded text-muted-foreground opacity-0 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
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
                <UnitField value={width} onChange={setWidth} dim="coarse" step="1" />
              </SettingRow>
              <SettingRow label={t("setup.height")}>
                <UnitField value={height} onChange={setHeight} dim="coarse" step="1" />
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

            {/* Layout check (feasibility) accordion */}
            <AccordionSection
              icon={ShieldCheck}
              title={t("feasibility:panel.sectionTitle")}
              open={ui.feasibilityOpen}
              onToggle={() => setUi({ feasibilityOpen: !ui.feasibilityOpen })}
            >
              {/* Verdict badge */}
              <div className="mb-2 flex items-center gap-2">
                <VerdictPill findings={panelFindings} />
              </div>
              {/* Findings list — skip the "empty" info finding to keep it quiet */}
              {panelFindings.filter((f) => f.category !== "empty").length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {panelFindings.some((f) => f.category === "empty") || panelFindings.length === 0
                    ? t("feasibility:panel.empty")
                    : t("feasibility:panel.ok")}
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {panelFindings
                    .filter((f) => f.category !== "empty")
                    .map((f) => (
                      <FindingRow key={f.id} finding={f} onSelect={setSelection} />
                    ))}
                </div>
              )}
            </AccordionSection>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { classifyBindZ, type ZBindBand } from "@/lib/drillZHeadroom";
import { isSafeDescentTarget, parseZTarget } from "@/lib/zbar";
import { cn } from "@/lib/utils";

const clamp01 = (f: number) => (f <= 0 ? 0 : f >= 1 ? 1 : f);

/** Z± button — a compact square at each end of the strip (matches the jog-pad style). */
const Z_BTN =
  "grid h-9 w-12 shrink-0 place-items-center rounded-md border border-border bg-card text-foreground transition-colors hover:border-primary/40 hover:bg-foreground/5 active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

/** Props for DrillManualZBar in default (tool-change) mode. */
interface DefaultModeProps {
  /** Machine Z (mm) of the last manual touch-off this session — yellow reference tick. */
  lastZMm: number | null;
  /** Safe machine-Z bind band (from `zBindBand`). null/unknown → no forbidden zones drawn. */
  band?: ZBindBand | null;
  /** Safe-descent mode disabled — this is the default tool-change behaviour. */
  safeDescent?: false;
  zLabel?: never;
  caption?: never;
  safeSteps?: never;
  descentFeedMmMin?: never;
}

/** Props for DrillManualZBar in safe-descent (fiducial capture) mode.
 *
 *  In this mode:
 *  - Steps are overridden to `safeSteps` (fine only; no "cont").
 *  - Z− steps use `descentFeedMmMin` (slow); Z+ uses the normal jog feed.
 *  - Track clicks only move Z upward; downward clicks are silently ignored.
 *  - The inline readout is read-only (no keyboard jog to an arbitrary height).
 *  - `lastZMm` and `band` are unused (no reference tick, no forbidden zones). */
interface SafeDescentModeProps {
  lastZMm?: never;
  band?: never;
  /** Enable safe-descent restrictions. */
  safeDescent: true;
  /** Step sizes (mm) to offer in safe mode. Defaults to [0.05, 0.1, 0.5]. */
  safeSteps?: number[];
  /** Feed rate for downward steps (mm/min). Defaults to 60. */
  descentFeedMmMin?: number;
  /** Label next to the Z badge (override for the default tool-change label). */
  zLabel?: string;
  /** Caption below the bar (override for the default tool-change hint). */
  caption?: string;
}

export type DrillManualZBarProps = DefaultModeProps | SafeDescentModeProps;

const DEFAULT_SAFE_STEPS = [0.05, 0.1, 0.5];
const DEFAULT_DESCENT_FEED = 60;

/** Manual Z touch-off bar for the tool-change card: a Z badge + live readout, a step
 *  selector, and a horizontal track `Z−` | bar | `Z+`. The track maps the MACHINE Z
 *  over the travel `[-maxZMm, 0]` (left = lowest / into the material, right = the homed
 *  ceiling); the blue thumb tracks the live position. Clicking the track jogs Z to that
 *  height (cancel-then-retarget, like the work-zero strip); the Z± buttons step- or
 *  hold-jog by the shared step. A yellow tick marks the previous manual touch-off Z
 *  (`lastZMm`) so the operator can repeat the height for a same-diameter bit.
 *
 *  When a Z-headroom `band` is known, the regions of travel where binding the zero would
 *  trip the envelope are painted red (left = floor: too little plunge room; right = ceiling:
 *  the safe/tool-change rapid would punch past Z=0); the safe band stays dark. The thumb
 *  turns red while the live Z sits in a forbidden zone — the confirm button is gated to match.
 *
 *  Optional `safeDescent` mode restricts controls for safe fiducial capture: only upward
 *  track clicks, no inline editing, no continuous hold, slow descent feed (see
 *  SafeDescentModeProps).
 *
 *  It does NOT bind Z — the card's confirm button does that (G10 L20 P1 on Z). */
export function DrillManualZBar(props: DrillManualZBarProps) {
  const { t } = useTranslation("drill");

  const safeDescent = props.safeDescent === true;
  const safeSteps = safeDescent ? (props.safeSteps ?? DEFAULT_SAFE_STEPS) : null;
  const descentFeed = safeDescent ? (props.descentFeedMmMin ?? DEFAULT_DESCENT_FEED) : null;

  const maxZMm = useSettings((s) => s.cncProfile.workEnvelopeMm.z);
  const profileSteps = useSettings((s) => s.cncProfile.jogStepsMm);
  const steps = safeSteps ?? profileSteps;

  // Live machine/work Z — the work offset converts a track target to a work-frame jog.
  const mz = useMachine((s) => s.status.mpos[2]);
  const wz = useMachine((s) => s.status.wpos[2]);
  const wcoZ = mz - wz;

  // Z-only clamp; X/Y are never jogged from here so their bounds are inert.
  const bounds = {
    x: [0, 0] as [number, number],
    y: [0, 0] as [number, number],
    z: [-maxZMm, 0] as [number, number],
  };
  const { enabled, step, setStep, continuous, go, startContinuous, stopContinuous, jogTo } =
    useJog({ bounds });

  // In safe-descent mode: select the first safe step if the current step is not in the list
  // (e.g. user was on a coarse step from the jog pad before switching to capture mode).
  // Do this on mount / when safeSteps changes rather than every render to avoid a loop.
  const [safeStepInit, setSafeStepInit] = useState(false);
  useEffect(() => {
    if (!safeDescent) { setSafeStepInit(false); return; }
    if (safeStepInit) return;
    const validStep = typeof step === "number" && safeSteps!.includes(step);
    if (!validStep) setStep(safeSteps![1] ?? safeSteps![0] ?? 0.1);
    setSafeStepInit(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeDescent]);

  // Stop any in-flight continuous jog on unmount.
  useEffect(() => () => stopContinuous(), [stopContinuous]);

  const trackRef = useRef<HTMLDivElement>(null);
  const range = maxZMm || 1;
  // Thumb / mark fraction: 0 at the bottom (left, -maxZMm) → 1 at the ceiling (right, 0).
  const fracOf = (machineZ: number) => clamp01((machineZ + maxZMm) / range);
  const thumbFrac = fracOf(mz);

  // Default mode: last-Z mark and forbidden zones.
  const lastZMm = !safeDescent ? (props as DefaultModeProps).lastZMm : null;
  const band = !safeDescent ? (props as DefaultModeProps).band : null;
  const lastFrac = lastZMm != null ? fracOf(lastZMm) : null;

  const known = band?.known ?? false;
  const floorZoneFrac = known ? fracOf(band!.minZ) : 0;
  const ceilZoneFrac = known ? fracOf(band!.maxZ) : 1;
  const thumbBlocked = known && classifyBindZ(band!, mz) != null;
  const RED = "#ef4444";

  // Hover target (fraction along the track) for the tooltip + ghost line.
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);

  // Inline-editable readout (default mode only — disabled in safe-descent mode).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  const draftValid = parseZTarget(draft, maxZMm) != null;

  useEffect(() => {
    if (editing) {
      doneRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    if (!enabled || safeDescent) return;
    setDraft(mz.toFixed(1));
    setEditing(true);
  };
  const commitEdit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const target = parseZTarget(draft, maxZMm);
    if (target != null) void jogTo({ z: target - wcoZ });
  };
  const cancelEdit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
  };

  // Machine Z under the cursor on the track (left edge = -maxZMm, right edge = 0).
  const machineZAtFrac = (f: number) => -maxZMm + f * maxZMm;
  const fracAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return thumbFrac;
    const r = el.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width);
  };

  const onTrackClick = (e: React.MouseEvent) => {
    if (!enabled) return;
    const targetMachineZ = machineZAtFrac(fracAt(e.clientX));
    const targetWorkZ = targetMachineZ - wcoZ;
    if (safeDescent && !isSafeDescentTarget(wz, targetWorkZ)) {
      // Downward track click in safe mode: silently ignore.
      return;
    }
    void jogTo({ z: targetWorkZ });
  };

  // In safe-descent mode: Z− uses slow descent feed, Z+ uses the normal jog feed.
  // Neither supports hold/continuous — click-step only.
  const zPropsDefault = (dz: number) =>
    continuous
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            void startContinuous(0, 0, dz);
          },
          onPointerUp: () => stopContinuous(),
          onPointerLeave: () => stopContinuous(),
          onPointerCancel: () => stopContinuous(),
        }
      : { onClick: () => go(0, 0, dz) };

  const zPropsSafe = (dz: number) => ({
    onClick: () => {
      if (!enabled || typeof step !== "number") return;
      // The step is shared with the XY jog pad, which may offer coarser steps
      // (e.g. 1/10 mm for a long approach) — clamp Z moves to the fine safe
      // range so a coarse XY step can't turn into a deep slow plunge.
      const zStep = Math.min(step, Math.max(...safeSteps!));
      const { wpos } = useMachine.getState().status;
      const targetWorkZ = wpos[2] + dz * zStep;
      const feed = dz < 0 ? descentFeed! : undefined;
      void jogTo({ z: targetWorkZ }, feed ?? undefined);
    },
  });

  const zProps = (dz: number) => (safeDescent ? zPropsSafe(dz) : zPropsDefault(dz));

  // Labels: safe mode can override both the Z badge label and the caption.
  const zLabel = safeDescent
    ? (props as SafeDescentModeProps).zLabel ?? t("toolChange.zTouchLabel")
    : t("toolChange.zTouchLabel");
  const caption = safeDescent
    ? (props as SafeDescentModeProps).caption ?? t("toolChange.manualBarHint")
    : t("toolChange.manualBarHint");

  return (
    <div className="rounded-lg border border-border bg-card/40 p-2.5">
      {/* Z badge + live readout */}
      <div className="flex items-center gap-2">
        <span
          className="grid size-7 place-items-center rounded-md text-[12px] font-bold text-background"
          style={{ background: "hsl(var(--axis-z))" }}
        >
          Z
        </span>
        <span className="text-[12px] font-medium text-foreground">{zLabel}</span>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            inputMode="decimal"
            aria-label={t("toolChange.zEditLabel")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              else if (e.key === "Escape") cancelEdit();
            }}
            className={cn(
              "ml-auto w-20 rounded border bg-background px-1 text-right text-[20px] font-bold leading-none tabular-nums text-foreground outline-none focus-visible:ring-1",
              draftValid
                ? "border-input focus-visible:ring-ring"
                : "border-red-500 focus-visible:ring-red-500",
            )}
          />
        ) : (
          <button
            type="button"
            onClick={safeDescent ? undefined : startEdit}
            disabled={!enabled || safeDescent}
            title={safeDescent ? undefined : t("toolChange.zEditHint")}
            className={cn(
              "ml-auto rounded px-1 text-[20px] font-bold leading-none tabular-nums text-foreground",
              !safeDescent && "hover:bg-foreground/5 disabled:hover:bg-transparent enabled:cursor-text",
            )}
          >
            {mz.toFixed(1)}
          </button>
        )}
        <span className="text-[11px] text-muted-foreground">{t("common:unit.mm")}</span>
      </div>

      {/* Step selector */}
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-0.5 text-[10px] text-muted-foreground">{t("toolChange.stepMm")}</span>
        {steps.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(s)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] tabular-nums transition-colors",
              step === s
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Z− | track | Z+ */}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" title="Z−" disabled={!enabled} className={Z_BTN} {...zProps(-1)}>
          <ChevronDown className="size-4" />
        </button>

        <div
          ref={trackRef}
          onClick={onTrackClick}
          onMouseMove={(e) => setHoverFrac(fracAt(e.clientX))}
          onMouseLeave={() => setHoverFrac(null)}
          className={cn(
            "relative h-9 flex-1 overflow-visible rounded-md border border-border",
            enabled && "cursor-pointer",
          )}
          style={{ background: "#0c0e11" }}
        >
          {/* Forbidden bind zones (floor / ceiling) — default mode only */}
          {floorZoneFrac > 0 && (
            <div
              className="pointer-events-none absolute bottom-0 left-0 top-0 rounded-l-md"
              style={{
                width: `${floorZoneFrac * 100}%`,
                background: "hsl(0 70% 55% / 0.22)",
                borderRight: `1px solid ${RED}`,
              }}
            />
          )}
          {ceilZoneFrac < 1 && (
            <div
              className="pointer-events-none absolute bottom-0 right-0 top-0 rounded-r-md"
              style={{
                width: `${(1 - ceilZoneFrac) * 100}%`,
                background: "hsl(0 70% 55% / 0.22)",
                borderLeft: `1px solid ${RED}`,
              }}
            />
          )}

          {/* Scale ticks */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-2 opacity-60">
            {Array.from({ length: 15 }, (_, i) => (
              <span key={i} className="h-3 w-px bg-border" />
            ))}
          </div>

          {/* Previous manual-Z mark (vertical line + diamond cap) — default mode only */}
          {lastFrac != null && (
            <>
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px"
                style={{ left: `${lastFrac * 100}%`, background: "#e8c14a" }}
              />
              <div
                className="pointer-events-none absolute -top-1 size-1.5 -translate-x-1/2 rotate-45"
                style={{ left: `${lastFrac * 100}%`, background: "#e8c14a" }}
              />
            </>
          )}

          {/* Hover ghost line + target tooltip */}
          {hoverFrac != null && (
            <>
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px"
                style={{ left: `${hoverFrac * 100}%`, background: "hsl(var(--axis-z) / 0.55)" }}
              />
              <div
                className="pointer-events-none absolute top-full z-20 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] tabular-nums text-foreground shadow-lg"
                style={{
                  left: `${hoverFrac * 100}%`,
                  background: "#0c0e11",
                  borderColor: "hsl(var(--axis-z) / 0.4)",
                }}
              >
                → {machineZAtFrac(hoverFrac).toFixed(1)} {t("common:unit.mm")}
              </div>
            </>
          )}

          {/* Live-position thumb — red while Z sits in a forbidden bind zone */}
          <div
            className="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-[5px] shadow-[0_1px_4px_rgba(0,0,0,.4)]"
            style={{ left: `${thumbFrac * 100}%`, background: thumbBlocked ? RED : "hsl(var(--axis-z))" }}
          />
        </div>

        <button type="button" title="Z+" disabled={!enabled} className={Z_BTN} {...zProps(1)}>
          <ChevronUp className="size-4" />
        </button>
      </div>

      {/* Caption */}
      <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        {caption}
        {lastFrac != null && (
          <>
            {" "}
            <span style={{ color: "#e8c14a" }}>{t("toolChange.manualBarMark")}</span>{" "}
            {t("toolChange.manualBarMarkRest")}
          </>
        )}
      </div>
    </div>
  );
}

import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { Fan, Gauge, Minus, Plus } from "lucide-react";
import { useMachine } from "@/machineStore";
import {
  useMachineActions,
  type OverrideAction,
} from "@/components/machine/MachineActionsContext";

/** One override row: icon + label, then a "− {value}% +" stepper on the right.
 *  −/+ nudge by 10 %, clicking the percent resets to 100 %. */
function OverrideRow({
  label,
  icon: Icon,
  value,
  kind,
  disabled,
  resetTitle,
  onOverride,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  value: number;
  kind: "feed" | "spindle";
  disabled: boolean;
  resetTitle: string;
  onOverride: (kind: "feed" | "spindle", action: OverrideAction) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      <span className="w-16 text-[11px] text-muted-foreground">{label}</span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onOverride(kind, "-10")}
          className="grid size-7 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Minus className="size-3.5" />
        </button>
        <button
          type="button"
          disabled={disabled}
          title={resetTitle}
          onClick={() => onOverride(kind, "100")}
          className="w-12 rounded-md py-1 text-center font-mono text-[13px] font-semibold tabular-nums text-foreground transition-colors hover:bg-foreground/5 disabled:pointer-events-none disabled:opacity-40"
        >
          {value}%
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onOverride(kind, "+10")}
          className="grid size-7 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Feed and spindle realtime-override steppers. Values mirror GRBL's reported
 *  `Ov:` percentages (overrides = [feed, rapid, spindle]); each button sends a
 *  realtime override byte. Rapid override is intentionally not surfaced here. */
export function Overrides() {
  const { t } = useTranslation("machine");
  const a = useMachineActions();
  const connected = useMachine((s) => s.connected);
  const overrides = useMachine((s) => s.status.overrides ?? [100, 100, 100]);
  const reset = t("overrides.reset");

  return (
    <div className="flex flex-col gap-2.5">
      <OverrideRow
        label={t("overrides.feed")}
        icon={Gauge}
        value={overrides[0]}
        kind="feed"
        disabled={!connected}
        resetTitle={reset}
        onOverride={(k, act) => a.override(k, act)}
      />
      <OverrideRow
        label={t("overrides.spindle")}
        icon={Fan}
        value={overrides[2]}
        kind="spindle"
        disabled={!connected}
        resetTitle={reset}
        onOverride={(k, act) => a.override(k, act)}
      />
    </div>
  );
}

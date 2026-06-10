import { useEffect, useState } from "react";
import { FlipHorizontal2, Contrast, Crosshair, Zap, LayoutGrid, Grid3x3, CircleStop } from "lucide-react";
import { useStore } from "@/store";
import { api, SCREEN_W_MM, SCREEN_H_MM } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { Switch } from "@/components/ui/Switch";

const round1 = (v: number) => Math.round(v * 10) / 10;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border px-3 py-3">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  // Local text state so a cleared field doesn't snap back on every keystroke;
  // only finite parses are committed (clearing the field must not push NaN
  // into the store — that made the board vanish). Mirrors settings/fields.tsx.
  const [text, setText] = useState(String(value));
  // Resync when the model value changes elsewhere (canvas drag, Center button).
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={text}
          step={step}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="h-7 w-20 rounded-md border border-input bg-background px-2 text-right tabular-nums outline-none focus:ring-1 focus:ring-ring"
        />
        {suffix && <span className="w-5 text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  );
}

function ToggleRow({
  icon,
  label,
  checked,
  onChange,
}: {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  onChange: (b: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-[12px]">
        {icon}
        {label}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function Inspector() {
  const s = useStore();
  const selectedList = s.placements.filter((p) => s.selectedIds.includes(p.id));
  const selected = selectedList.length === 1 ? selectedList[0] : null;
  const multi = selectedList.length > 1;
  const [count, setCount] = useState(4);
  const [gap, setGap] = useState(2);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-panel">
      <Section title="Board (reference)">
        <NumberField label="Width" value={s.boardWmm} suffix="mm" onChange={(v) => s.setBoard(v || 1, s.boardHmm)} />
        <NumberField label="Height" value={s.boardHmm} suffix="mm" onChange={(v) => s.setBoard(s.boardWmm, v || 1)} />
        <NumberField label="X" value={round1(s.boardXmm)} step={0.5} suffix="mm" onChange={(v) => s.setBoardPos(v, s.boardYmm)} />
        <NumberField label="Y" value={round1(s.boardYmm)} step={0.5} suffix="mm" onChange={(v) => s.setBoardPos(s.boardXmm, v)} />
        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[11px] text-muted-foreground">
            screen {SCREEN_W_MM}×{SCREEN_H_MM} mm
          </span>
          <Button size="sm" variant="ghost" onClick={s.centerBoard}>
            <Crosshair /> Center
          </Button>
        </div>
      </Section>

      <Section title={multi ? `Selected (${selectedList.length})` : "Selected"}>
        {selectedList.length > 0 ? (
          <>
            {selected ? (
              <>
                <div className="truncate text-[12px]" title={selected.name}>
                  {selected.name}
                </div>
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  {selected.wMm.toFixed(2)} × {selected.hMm.toFixed(2)} mm @ ({selected.xMm.toFixed(1)},{" "}
                  {selected.yMm.toFixed(1)})
                </div>
              </>
            ) : (
              <div className="text-[12px] text-muted-foreground">{selectedList.length} placements</div>
            )}
            {!multi && (
              <div className="pt-1">
                <Button size="sm" variant="secondary" onClick={s.centerSelected}>
                  <Crosshair /> Center on screen
                </Button>
              </div>
            )}
          </>
        ) : (
          <p className="text-[12px] text-muted-foreground">Nothing selected — Shift-click to multi-select</p>
        )}
      </Section>

      <Section title="Auto-arrange">
        <NumberField label="Copies" value={count} step={1} onChange={(v) => setCount(Math.max(1, Math.round(v || 1)))} />
        <NumberField label="Gap" value={gap} step={0.5} suffix="mm" onChange={(v) => setGap(Math.max(0, v || 0))} />
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={s.placements.length === 0}
            onClick={() => s.autoArrange(count, gap)}
          >
            <LayoutGrid /> Arrange
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            disabled={s.placements.length === 0}
            onClick={() => s.fillBoard(gap)}
            title="Fill the board with as many copies as fit"
          >
            <Grid3x3 /> Fill
          </Button>
        </div>
        <p className="text-[11px] leading-tight text-muted-foreground">
          Arrange = N copies; Fill = as many as fit on the board.
        </p>
      </Section>

      <Section title="Transform">
        <ToggleRow
          icon={<FlipHorizontal2 className="size-3.5" />}
          label="Mirror (emulsion-down)"
          checked={s.mirror}
          onChange={s.setMirror}
        />
        <ToggleRow
          icon={<Contrast className="size-3.5" />}
          label="Invert (resist)"
          checked={s.invert}
          onChange={s.setInvert}
        />
      </Section>

      <Section title="Exposure">
        <div>
          <div className="mb-1 flex justify-between text-[12px]">
            <span className="text-muted-foreground">Time</span>
            <span className="tabular-nums">{s.exposureS}s</span>
          </div>
          <Slider value={[s.exposureS]} min={1} max={300} step={1} onValueChange={([v]) => s.setExposure(v)} />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-[12px]">
            <span className="text-muted-foreground">UV power</span>
            <span className="tabular-nums">{s.pwm}</span>
          </div>
          <Slider value={[s.pwm]} min={1} max={255} step={1} onValueChange={([v]) => s.setPwm(v)} />
        </div>
      </Section>

      <div className="mt-auto space-y-2 p-3">
        {s.busy ? (
          <Button variant="destructive" className="w-full" onClick={() => api.stopPrint().catch(() => {})}>
            <CircleStop /> Stop
          </Button>
        ) : (
          <Button className="w-full" disabled={s.placements.length === 0} onClick={s.print}>
            <Zap /> Expose
          </Button>
        )}
        <p className="text-center text-[10px] leading-tight text-muted-foreground">
          Fires the UV screen — remove the build plate first.
        </p>
      </div>
    </aside>
  );
}

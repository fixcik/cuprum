import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair, Fan, Plug, Ruler, Scan, ShieldCheck, Terminal } from "lucide-react";
import { useSettings } from "@/settingsStore";
import { Card } from "@/components/ui/Card";
import { Row } from "@/components/ui/Row";
import { Switch } from "@/components/ui/Switch";
import { NumberInput } from "@/components/settings/fields";
import { WorkZone, type WorkZoneAxis } from "@/components/settings/WorkZone";
import { matchesQuery } from "@/components/settings/SettingsToolbar";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import type { CncMachine } from "@/lib/machine";
import { toolChangeZWarning } from "@/lib/machine";

/** Card-based config editor for a CNC machine. Reads/writes live via
 *  `updateMachine`; `query` filters rows/cards by their translated labels. The
 *  dirty set is computed once in the parent and passed down. */
export function CncSettingsCards({
  machine,
  query,
  dirty,
}: {
  machine: CncMachine;
  query: string;
  dirty: Set<string>;
}) {
  const { t } = useTranslation("settings");
  const update = useSettings((s) => s.updateMachine);
  const { toDisplay, unitLabel } = useUnitFormat();
  // Active axis highlights its dim label in the WorkZone while editing X/Y/Z.
  const [activeAxis, setActiveAxis] = useState<WorkZoneAxis | undefined>();

  const env = machine.workEnvelopeMm;
  const tcWarn = toolChangeZWarning({
    safeZMm: machine.safeZMm,
    toolChangeZMm: machine.toolChangeZMm,
    envZMm: env.z,
  });

  // A card is shown when its title matches, or when it has any matching row.
  // A row is shown when the card title matches, or its own label matches.
  const cardVisible = (title: string, rowLabels: string[]) =>
    matchesQuery(title, query) || rowLabels.some((l) => matchesQuery(l, query));
  const rowVisible = (cardTitle: string, label: string) =>
    matchesQuery(cardTitle, query) || matchesQuery(label, query);

  // Card titles (translated) — also used as the search "section" match target.
  const tWorkField = t("equipment.cards.workField");
  const tSpindle = t("equipment.cards.spindle");
  const tSafetyZ = t("equipment.cards.safetyZ");
  const tProbe = t("equipment.cards.probe");
  const tMechanics = t("equipment.cards.mechanics");
  const tConnection = t("equipment.cards.connection");
  const tGcode = t("equipment.cards.gcode");

  // Row labels grouped per card, so filtering can decide visibility. The probe
  // sub-fields are only rendered when hasProbe; include them in the searchable set
  // only then, so a search can't surface the probe card with just the toggle.
  const labels = useMemo(
    () => ({
      spindle: [t("cnc.spindleMaxRpm"), t("cnc.spindleControllable"), t("cnc.spindleHasPwm")],
      safety: [t("cnc.safeZ"), t("cnc.machineSafeZ"), t("cnc.toolChangeZ")],
      probe: machine.hasProbe
        ? [t("cnc.hasProbe"), t("cnc.probeFeed"), t("cnc.probeMaxDist"), t("cnc.probePlateOffset")]
        : [t("cnc.hasProbe")],
      mechanics: [t("cnc.runout"), t("cnc.backlashX"), t("cnc.backlashY"), t("cnc.backlashZ")],
      connection: [t("cnc.baud")],
      gcode: [t("cnc.dialect"), t("cnc.prepend"), t("cnc.append")],
    }),
    [t, machine.hasProbe],
  );

  const showWorkField = cardVisible(tWorkField, [t("cnc.envX"), t("cnc.envY"), t("cnc.envZ")]);
  const showSpindle = cardVisible(tSpindle, labels.spindle);
  const showSafety = cardVisible(tSafetyZ, labels.safety);
  // Probe rows beyond the toggle only exist when hasProbe; still searchable by title.
  const showProbe = cardVisible(tProbe, labels.probe);
  const showMechanics = cardVisible(tMechanics, labels.mechanics);
  const showConnection = cardVisible(tConnection, labels.connection);
  const showGcode = cardVisible(tGcode, labels.gcode);

  return (
    <div className="mx-auto max-w-[1180px] [column-fill:_balance] [column-gap:1rem] sm:columns-2 2xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
      {/* Cards flow in a balanced multi-column (masonry) layout so uneven heights
          pack without leaving large gaps. Each card is a direct child kept intact
          via break-inside-avoid. Work field — viz + X/Y/Z editors. */}
      {showWorkField && (
          <Card
            icon={Scan}
            title={tWorkField}
            accent
            headerRight={
              <span className="rounded-md bg-muted px-2 py-1 text-[10px] tabular-nums text-muted-foreground">
                {toDisplay(env.x, "coarse")} × {toDisplay(env.y, "coarse")} × {toDisplay(env.z, "coarse")}{" "}
                {unitLabel("coarse")}
              </span>
            }
          >
            <WorkZone x={env.x} y={env.y} z={env.z} activeAxis={activeAxis} />
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(
                [
                  ["x", t("cnc.axisX"), "envelope.x"],
                  ["y", t("cnc.axisY"), "envelope.y"],
                  ["z", t("cnc.axisZ"), "envelope.z"],
                ] as const
              ).map(([axis, short, key]) => (
                <AxisField
                  key={axis}
                  short={short}
                  value={env[axis]}
                  dirty={dirty.has(key)}
                  onFocus={() => setActiveAxis(axis)}
                  onBlur={() => setActiveAxis(undefined)}
                  onChange={(v) => update(machine.id, { workEnvelopeMm: { ...env, [axis]: v } })}
                />
              ))}
            </div>
          </Card>
      )}

      {showSpindle && (
            <Card icon={Fan} title={tSpindle}>
              <div className="divide-y divide-border/50">
                {rowVisible(tSpindle, t("cnc.spindleMaxRpm")) && (
                  <Row label={t("cnc.spindleMaxRpm")}>
                    <NumberInput
                      value={machine.spindleMaxRpm}
                      step="100"
                      suffix={t("cnc.unitRpm")}
                      dirty={dirty.has("spindleMaxRpm")}
                      onChange={(spindleMaxRpm) => update(machine.id, { spindleMaxRpm })}
                    />
                  </Row>
                )}
                {rowVisible(tSpindle, t("cnc.spindleControllable")) && (
                  <Row label={t("cnc.spindleControllable")}>
                    <Switch
                      checked={machine.spindleControllable}
                      onCheckedChange={(spindleControllable) => update(machine.id, { spindleControllable })}
                    />
                  </Row>
                )}
                {rowVisible(tSpindle, t("cnc.spindleHasPwm")) && (
                  <Row label={t("cnc.spindleHasPwm")}>
                    <Switch
                      checked={machine.spindleHasPwm}
                      onCheckedChange={(spindleHasPwm) => update(machine.id, { spindleHasPwm })}
                    />
                  </Row>
                )}
              </div>
            </Card>
          )}

          {showSafety && (
            <Card icon={ShieldCheck} title={tSafetyZ}>
              <div className="divide-y divide-border/50">
                {rowVisible(tSafetyZ, t("cnc.safeZ")) && (
                  <Row label={t("cnc.safeZ")} help={t("cnc.safeZHelp")}>
                    <NumberInput
                      value={machine.safeZMm}
                      dim="coarse"
                      dirty={dirty.has("safeZMm")}
                      onChange={(safeZMm) => update(machine.id, { safeZMm })}
                    />
                  </Row>
                )}
                {rowVisible(tSafetyZ, t("cnc.machineSafeZ")) && (
                  <Row label={t("cnc.machineSafeZ")} help={t("cnc.machineSafeZHelp")}>
                    <NumberInput
                      value={machine.machineSafeZMm}
                      dim="coarse"
                      dirty={dirty.has("machineSafeZMm")}
                      onChange={(machineSafeZMm) => update(machine.id, { machineSafeZMm })}
                    />
                  </Row>
                )}
                {rowVisible(tSafetyZ, t("cnc.toolChangeZ")) && (
                  <Row label={t("cnc.toolChangeZ")} help={t("cnc.toolChangeZHelp")}>
                    <NumberInput
                      value={machine.toolChangeZMm}
                      dim="coarse"
                      dirty={dirty.has("toolChangeZMm")}
                      onChange={(toolChangeZMm) => update(machine.id, { toolChangeZMm })}
                    />
                  </Row>
                )}
                {tcWarn && rowVisible(tSafetyZ, t("cnc.toolChangeZ")) && (
                  <p className="pt-2 text-[11px] text-amber-400">{t(`cnc.toolChangeZWarn.${tcWarn}`)}</p>
                )}
              </div>
            </Card>
          )}

          {showProbe && (
            <Card icon={Crosshair} title={tProbe}>
              <div className="divide-y divide-border/50">
                {rowVisible(tProbe, t("cnc.hasProbe")) && (
                  <Row label={t("cnc.hasProbe")} help={t("cnc.hasProbeHelp")}>
                    <Switch
                      checked={machine.hasProbe}
                      onCheckedChange={(hasProbe) => update(machine.id, { hasProbe })}
                    />
                  </Row>
                )}
                {machine.hasProbe && (
                  <>
                    {rowVisible(tProbe, t("cnc.probeFeed")) && (
                      <Row label={t("cnc.probeFeed")} help={t("cnc.probeFeedHelp")}>
                        <NumberInput
                          value={machine.probeFeedMmMin}
                          step="1"
                          suffix={t("cnc.unitMmMin")}
                          dirty={dirty.has("probeFeedMmMin")}
                          onChange={(probeFeedMmMin) => update(machine.id, { probeFeedMmMin })}
                        />
                      </Row>
                    )}
                    {rowVisible(tProbe, t("cnc.probeMaxDist")) && (
                      <Row label={t("cnc.probeMaxDist")} help={t("cnc.probeMaxDistHelp")}>
                        <NumberInput
                          value={machine.probeMaxDistMm}
                          dim="coarse"
                          dirty={dirty.has("probeMaxDistMm")}
                          onChange={(probeMaxDistMm) => update(machine.id, { probeMaxDistMm })}
                        />
                      </Row>
                    )}
                    {rowVisible(tProbe, t("cnc.probePlateOffset")) && (
                      <Row label={t("cnc.probePlateOffset")} help={t("cnc.probePlateOffsetHelp")}>
                        <NumberInput
                          value={machine.probePlateOffsetMm}
                          dim="fine"
                          dirty={dirty.has("probePlateOffsetMm")}
                          onChange={(probePlateOffsetMm) => update(machine.id, { probePlateOffsetMm })}
                        />
                      </Row>
                    )}
                  </>
                )}
              </div>
            </Card>
          )}
      {showMechanics && (
                  <Card icon={Ruler} title={tMechanics}>
                    <div className="divide-y divide-border/50">
                      {rowVisible(tMechanics, t("cnc.runout")) && (
                        <Row label={t("cnc.runout")}>
                          <NumberInput
                            value={machine.runoutMm}
                            dim="fine"
                            dirty={dirty.has("runoutMm")}
                            onChange={(runoutMm) => update(machine.id, { runoutMm })}
                          />
                        </Row>
                      )}
                      {rowVisible(tMechanics, t("cnc.backlashX")) && (
                        <Row label={t("cnc.backlashX")}>
                          <NumberInput
                            value={machine.backlashMm.x}
                            dim="fine"
                            dirty={dirty.has("backlash.x")}
                            onChange={(x) => update(machine.id, { backlashMm: { ...machine.backlashMm, x } })}
                          />
                        </Row>
                      )}
                      {rowVisible(tMechanics, t("cnc.backlashY")) && (
                        <Row label={t("cnc.backlashY")}>
                          <NumberInput
                            value={machine.backlashMm.y}
                            dim="fine"
                            dirty={dirty.has("backlash.y")}
                            onChange={(y) => update(machine.id, { backlashMm: { ...machine.backlashMm, y } })}
                          />
                        </Row>
                      )}
                      {rowVisible(tMechanics, t("cnc.backlashZ")) && (
                        <Row label={t("cnc.backlashZ")}>
                          <NumberInput
                            value={machine.backlashMm.z}
                            dim="fine"
                            dirty={dirty.has("backlash.z")}
                            onChange={(z) => update(machine.id, { backlashMm: { ...machine.backlashMm, z } })}
                          />
                        </Row>
                      )}
                    </div>
                  </Card>
                )}

      {showConnection && (
                  <Card icon={Plug} title={tConnection}>
                    <div className="divide-y divide-border/50">
                      {rowVisible(tConnection, t("cnc.baud")) && (
                        <Row label={t("cnc.baud")}>
                          <NumberInput
                            value={machine.baud}
                            step="1"
                            dirty={dirty.has("baud")}
                            onChange={(baud) => update(machine.id, { baud })}
                          />
                        </Row>
                      )}
                    </div>
                  </Card>
                )}

      {showGcode && (
                  <Card icon={Terminal} title={tGcode}>
                    <div className="flex flex-col gap-3">
                      {rowVisible(tGcode, t("cnc.dialect")) && (
                        <Row label={t("cnc.dialect")}>
                          <span className="rounded px-2 py-0.5 text-[11px] text-muted-foreground">GRBL 1.1</span>
                        </Row>
                      )}
                      {rowVisible(tGcode, t("cnc.prepend")) && (
                        <label className="flex flex-col gap-1">
                          <span className="text-[12px] text-foreground/90">{t("cnc.prepend")}</span>
                          <textarea
                            value={machine.prependGcode}
                            onChange={(e) => update(machine.id, { prependGcode: e.target.value })}
                            rows={2}
                            className="rounded-md border border-border bg-[hsl(var(--input)/0.25)] px-2 py-1 font-mono text-[11px] text-foreground outline-none focus-visible:border-muted-foreground/60"
                          />
                        </label>
                      )}
                      {rowVisible(tGcode, t("cnc.append")) && (
                        <label className="flex flex-col gap-1">
                          <span className="text-[12px] text-foreground/90">{t("cnc.append")}</span>
                          <textarea
                            value={machine.appendGcode}
                            onChange={(e) => update(machine.id, { appendGcode: e.target.value })}
                            rows={2}
                            className="rounded-md border border-border bg-[hsl(var(--input)/0.25)] px-2 py-1 font-mono text-[11px] text-foreground outline-none focus-visible:border-muted-foreground/60"
                          />
                        </label>
                      )}
                    </div>
                  </Card>
      )}
    </div>
  );
}

/** One axis editor in the work-field card: short uppercase label + a bare numeric
 *  input (orange when dirty) + unit suffix. Focus drives the WorkZone highlight.
 *  Value is stored in mm; display/input honour the active units setting. */
function AxisField({
  short,
  value,
  dirty,
  onChange,
  onFocus,
  onBlur,
}: {
  short: string;
  value: number;
  dirty: boolean;
  onChange: (v: number) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const { units, toDisplay, fromDisplay, unitLabel } = useUnitFormat();
  const shown = toDisplay(value, "coarse");
  const [text, setText] = useState(String(shown));
  // Keep the field in sync when the value or the units setting changes (e.g.
  // reset). Depend on the stable `units` rather than the per-render `toDisplay`
  // identity, so an unrelated re-render can't stomp an in-progress edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setText(String(toDisplay(value, "coarse"))), [value, units]);
  return (
    <label
      className={`flex flex-col gap-1 rounded-lg border bg-[hsl(var(--input)/0.25)] px-2.5 py-2 ${
        dirty ? "border-primary/60" : "border-border/70"
      }`}
    >
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{short}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          inputMode="decimal"
          value={text}
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(fromDisplay(v, "coarse"));
          }}
          className={`w-full min-w-0 bg-transparent text-[15px] font-semibold tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
            dirty ? "text-primary" : "text-foreground"
          }`}
        />
        <span className="text-[10px] text-muted-foreground">{unitLabel("coarse")}</span>
      </div>
    </label>
  );
}

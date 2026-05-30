import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { Switch } from "@/components/ui/Switch";
import { HelpTip } from "@/components/ui/HelpTip";
import { Diagrams } from "@/components/settings/diagrams";
import { useSettings } from "@/settingsStore";
import type { CapabilityProfile } from "@/lib/capabilityProfile";

/** Label cell: text + optional inline hint + an optional "?" help tooltip. */
function FieldLabel({ label, hint, help, helpImage }: { label: string; hint?: string; help?: string; helpImage?: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-foreground">
      {label}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      {help && <HelpTip text={help} image={helpImage} />}
    </span>
  );
}

/** A labelled numeric field that commits any valid number live. */
function NumberField({
  label,
  value,
  onChange,
  step = "0.01",
  suffix,
  hint,
  help,
  helpImage,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  suffix?: string;
  hint?: string;
  help?: string;
  helpImage?: React.ReactNode;
}) {
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => setText(String(value)), [value]);
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <FieldLabel label={label} hint={hint} help={help} helpImage={helpImage} />
      <div className="flex shrink-0 items-center gap-1.5">
        <TextInput
          type="number"
          step={step}
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(v);
          }}
          className="w-24 text-right tabular-nums"
        />
        <span className="w-7 text-[11px] text-muted-foreground">{suffix}</span>
      </div>
    </label>
  );
}

function BoolField({
  label,
  value,
  onChange,
  help,
  helpImage,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  help?: string;
  helpImage?: React.ReactNode;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <FieldLabel label={label} help={help} helpImage={helpImage} />
      <Switch checked={value} onCheckedChange={onChange} />
    </label>
  );
}

/** Edits a numeric array as a comma/space-separated list (e.g. the drill bit set). */
function ArrayField({
  label,
  value,
  onChange,
  hint,
  help,
}: {
  label: string;
  value: number[];
  onChange: (v: number[]) => void;
  hint?: string;
  help?: string;
}) {
  const [text, setText] = React.useState(value.join(", "));
  React.useEffect(() => setText(value.join(", ")), [value]);
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <FieldLabel label={label} hint={hint} help={help} />
      <TextInput
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const arr = e.target.value
            .split(/[,\s]+/)
            .map(parseFloat)
            .filter((x) => !Number.isNaN(x) && x > 0)
            .sort((a, b) => a - b);
          if (arr.length) onChange(arr);
        }}
        className="w-48 text-right text-[11px] tabular-nums"
      />
    </label>
  );
}

type CategoryId = "panel" | "copper" | "drill" | "maskSilk";
const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: "panel", label: "Размер панели" },
  { id: "copper", label: "Медь" },
  { id: "drill", label: "Сверловка" },
  { id: "maskSilk", label: "Маска / шелк / контур" },
];

export function SettingsPage() {
  const profile = useSettings((s) => s.profile);
  const setProfile = useSettings((s) => s.setProfile);
  const resetProfile = useSettings((s) => s.resetProfile);
  const set = <K extends keyof CapabilityProfile>(k: K) => (v: CapabilityProfile[K]) => setProfile({ [k]: v });
  const [active, setActive] = React.useState<CategoryId>("panel");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h1 className="text-[14px] font-semibold text-foreground">Профиль возможностей станка</h1>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Пределы, по которым плата проверяется на выполнимость при импорте.
          </p>
        </div>
        <Button variant="ghost" onClick={resetProfile} title="Сбросить к Saturn 4 Ultra 16K">
          <RotateCcw className="size-4" /> Сбросить
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left tab menu (extensible: future settings groups go here). */}
        <nav className="w-52 shrink-0 border-r border-border bg-panel p-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setActive(c.id)}
              className={`mb-0.5 w-full rounded-md px-3 py-2 text-left text-[12px] transition-colors ${
                active === c.id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {c.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-xl divide-y divide-border/60 p-6">
            {active === "panel" && (
              <>
                <NumberField
                  label="Макс. ширина панели"
                  value={profile.maxPanelWidthMm}
                  onChange={set("maxPanelWidthMm")}
                  suffix="мм"
                  help="Максимальный размер заготовки, влезающий в рабочее поле станка. Плата больше — нельзя изготовить в один проход (засветка или CNC)."
                  helpImage={Diagrams.panelSize}
                />
                <NumberField
                  label="Макс. высота панели"
                  value={profile.maxPanelHeightMm}
                  onChange={set("maxPanelHeightMm")}
                  suffix="мм"
                  help="Вторая сторона рабочего поля. Плата сравнивается с этим размером (с учётом поворота, если он разрешён)."
                  helpImage={Diagrams.panelSize}
                />
                <BoolField
                  label="Пробовать поворот на 90°"
                  value={profile.allowRotateToFit}
                  onChange={set("allowRotateToFit")}
                  help="Если плата не влезает как есть — попробовать повернуть её на 90° перед тем, как считать слишком большой."
                />
              </>
            )}

            {active === "copper" && (
              <>
                <NumberField
                  label="Макс. слоёв меди"
                  value={profile.maxCopperLayers}
                  onChange={set("maxCopperLayers")}
                  step="1"
                  suffix="шт"
                  help="Сколько медных слоёв реально изготовить (дома обычно 1–2)."
                />
                <BoolField
                  label="Разрешить внутренние слои"
                  value={profile.allowInnerLayers}
                  onChange={set("allowInnerLayers")}
                  help="Разрешить платы с внутренними медными слоями (4+). В DIY недоступно."
                />
                <NumberField
                  label="Мин. ширина дорожки"
                  value={profile.minTraceMm}
                  onChange={set("minTraceMm")}
                  suffix="мм"
                  help="Самая тонкая дорожка, которую процесс воспроизводит. Тоньше — риск разрыва или непропечатки."
                  helpImage={Diagrams.traceWidth}
                />
                <NumberField
                  label="Мин. зазор"
                  value={profile.minSpaceMm}
                  onChange={set("minSpaceMm")}
                  suffix="мм"
                  help="Минимальный зазор между разными цепями. Меньше — соседние дорожки слипнутся (короткое)."
                  helpImage={Diagrams.clearance}
                />
                <NumberField
                  label="Игнорировать ниже"
                  value={profile.ignoreBelowMm}
                  onChange={set("ignoreBelowMm")}
                  suffix="мм"
                  help="Геометрические дефекты меди/зазора/маски тоньше этого порога считаются артефактами расчёта (вырожденные слайверы) и не показываются. По умолчанию 0.05 мм (50 мкм)."
                />
              </>
            )}

            {active === "drill" && (
              <>
                <NumberField
                  label="Мин. размер отверстия"
                  value={profile.minDrillMm}
                  onChange={set("minDrillMm")}
                  suffix="мм"
                  help="Самое маленькое отверстие, которое готов делать. Отдельно от набора бит — это твой нижний предел по диаметру отверстий."
                  helpImage={Diagrams.drill}
                />
                <ArrayField
                  label="Набор бит"
                  value={profile.drillBitSetMm}
                  onChange={set("drillBitSetMm")}
                  hint="через запятую, мм"
                  help="Доступные диаметры свёрл. Диаметры платы вне набора (с учётом допуска) → предупреждение."
                />
                <NumberField
                  label="Допуск снапа к биту"
                  value={profile.drillBitToleranceMm}
                  onChange={set("drillBitToleranceMm")}
                  suffix="мм"
                  help="Насколько диаметр отверстия может отличаться от бита, чтобы считаться совпавшим."
                />
                <NumberField
                  label="Мин. поясок"
                  value={profile.minAnnularRingMm}
                  onChange={set("minAnnularRingMm")}
                  suffix="мм"
                  help="Минимальное кольцо меди вокруг отверстия (поясок). Узкое — сверло уводит в край пада или прорывает его."
                  helpImage={Diagrams.annular}
                />
                <BoolField
                  label="Есть металлизация отверстий"
                  value={profile.viaPlatingAvailable}
                  onChange={set("viaPlatingAvailable")}
                  help="Можно ли металлизировать отверстия. Если нет — переходные (via) делаются вручную, и их количество важно."
                />
                <NumberField
                  label="Via — макс. диаметр"
                  value={profile.viaMaxDiameterMm}
                  onChange={set("viaMaxDiameterMm")}
                  suffix="мм"
                  hint="отверстия ≤ — это via"
                  help="Отверстия не больше этого диаметра считаются переходными (via) для эвристики подсчёта."
                />
                <NumberField
                  label="Via — порог предупреждения"
                  value={profile.viaWarnCount}
                  onChange={set("viaWarnCount")}
                  step="1"
                  suffix="шт"
                  help="Сколько via без металлизации допустимо до предупреждения (каждое металлизируется вручную)."
                />
                <NumberField
                  label="Via — порог блокировки"
                  value={profile.viaBlockCount}
                  onChange={set("viaBlockCount")}
                  step="1"
                  suffix="шт"
                  help="Сколько via без металлизации делают плату практически невыполнимой."
                />
              </>
            )}

            {active === "maskSilk" && (
              <>
                <NumberField
                  label="Мин. перемычка маски"
                  value={profile.minMaskDamMm}
                  onChange={set("minMaskDamMm")}
                  suffix="мм"
                  help="Минимальная перемычка паяльной маски между соседними вскрытиями. Тоньше — не пропечатается."
                  helpImage={Diagrams.maskDam}
                />
                <NumberField
                  label="Мин. линия шелка"
                  value={profile.minSilkLineMm}
                  onChange={set("minSilkLineMm")}
                  suffix="мм"
                  help="Минимальная ширина линии/текста шелкографии. Тоньше — пропадёт при печати."
                  helpImage={Diagrams.silkLine}
                />
                <NumberField
                  label="Макс. выход за контур"
                  value={profile.maxOvershootMm}
                  onChange={set("maxOvershootMm")}
                  suffix="мм"
                  help="Насколько элементы слоёв могут выступать за контур платы. Больше — что-то торчит за краем."
                  helpImage={Diagrams.overshoot}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

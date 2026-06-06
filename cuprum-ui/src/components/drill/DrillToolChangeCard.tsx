import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface DrillToolChangeCardProps {
  toolName: string;
  diameterMm: number;
  nextColor: string;
  onConfirm: () => void;
}

export function DrillToolChangeCard({
  toolName,
  diameterMm,
  nextColor,
  onConfirm,
}: DrillToolChangeCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 mx-4 mb-3 flex flex-col gap-2">
      {/* Title */}
      <p className="text-[13px] font-semibold text-amber-300">
        {t("toolChange.title")}
      </p>

      {/* Colour tile + install instruction */}
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-3 w-3 shrink-0 rounded-sm"
          style={{ backgroundColor: nextColor }}
        />
        <span className="text-xs text-amber-200">
          {t("toolChange.install", { diameter: fmtLen(diameterMm) })}
        </span>
        {toolName && (
          <span className="ml-auto text-[11px] text-amber-300/70 truncate max-w-[120px]">
            {toolName}
          </span>
        )}
      </div>

      {/* Checklist */}
      <ol className="flex flex-col gap-1 text-[11px] text-amber-200/80 list-decimal list-inside">
        <li>{t("toolChange.step1")}</li>
        <li>{t("toolChange.step2")}</li>
        <li>{t("toolChange.step3")}</li>
      </ol>

      {/* Confirm button */}
      <Button
        size="sm"
        className="mt-1 w-full border-amber-500/40 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"
        onClick={onConfirm}
      >
        {t("toolChange.confirm")}
      </Button>
    </div>
  );
}

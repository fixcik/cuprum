import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type OperationRun } from "@/lib/api";
import { useShell } from "@/shellStore";
import { OPERATION_KINDS, type OpKind } from "@/lib/operationKind";
import { StepCard } from "./StepCard";

export function ProductionSteps({
  selStep,
  onSelect,
}: {
  selStep: string | null;
  onSelect: (kind: string) => void;
}) {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  const manifestName = useShell((s) => s.currentManifest?.name ?? "");
  const [lastByKind, setLastByKind] = useState<Record<OpKind, OperationRun | null>>({
    drill: null,
    expose: null,
    mill: null,
  });

  // Last run per op type (one cheap `limit 1` query each); refresh on journal change.
  useEffect(() => {
    if (!currentPath) {
      setLastByKind({ drill: null, expose: null, mill: null });
      return;
    }
    let active = true;
    const load = () => {
      for (const op of OPERATION_KINDS) {
        void api.operationLog
          .list(currentPath, 1, 0, op.kind)
          .then((rows) => {
            if (active) setLastByKind((p) => ({ ...p, [op.kind]: rows[0] ?? null }));
          })
          .catch(() => {});
      }
    };
    load();
    let unlisten: (() => void) | null = null;
    void api.operationLog.onChanged(load).then((un) => {
      if (active) unlisten = un;
      else un();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [currentPath]);

  return (
    <div className="flex h-full min-h-0 w-[43%] shrink-0 flex-col">
      <div className="flex items-center gap-3 px-1 pb-3">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          {t("operations.heading")}
        </span>
        {manifestName && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            {manifestName}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {OPERATION_KINDS.map((op) => (
          <StepCard
            key={op.kind}
            op={op}
            lastRun={lastByKind[op.kind]}
            selected={selStep === op.kind}
            onSelect={() => onSelect(op.kind)}
          />
        ))}
      </div>
    </div>
  );
}

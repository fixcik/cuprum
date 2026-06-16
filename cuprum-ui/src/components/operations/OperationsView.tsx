import { useState } from "react";
import { ProductionSteps } from "./ProductionSteps";
import { OperationHistory } from "./OperationHistory";

/** Operations view: production steps (left) + run history (right). Owns the
 *  selected-step state that links the two columns (card selection ↔ history
 *  filter). */
export function OperationsView() {
  const [selStep, setSelStep] = useState<string | null>(null);
  const toggle = (kind: string) => setSelStep((cur) => (cur === kind ? null : kind));

  return (
    <div className="flex h-full min-h-0 gap-6 p-6">
      <ProductionSteps selStep={selStep} onSelect={toggle} />
      <div className="min-w-0 flex-1 border-l border-border pl-6">
        <OperationHistory selStep={selStep} onClearStep={() => setSelStep(null)} />
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { HelpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

/** A small "?" icon that shows an explanatory tooltip on hover/focus, with an
 *  optional illustration (e.g. an SVG diagram) above the text. */
export function HelpTip({ text, image }: { text: string; image?: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <TooltipPrimitive.Provider delayDuration={120}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("helpHint")}
            className="inline-flex cursor-help items-center justify-center rounded-full p-0.5 text-muted-foreground/40 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <HelpCircle className="size-3.5" />
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="left"
            align="center"
            sideOffset={8}
            collisionPadding={8}
            className="z-50 max-w-[260px] rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg"
          >
            {image && (
              <div className="mb-2 flex justify-center rounded bg-background/60 p-2 text-foreground">{image}</div>
            )}
            {text}
            <TooltipPrimitive.Arrow className="fill-border" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

import { useTranslation } from "react-i18next";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/ContextMenu";

/** Contents of the panel canvas context menu. Branches between the keep-out zone
 *  menu (when a zone is selected) and the board instance menu. Pure declarative
 *  JSX — every entry calls an action handler owned by the parent. */
export function PanelContextMenuContent({
  hasSelection,
  selectedCount,
  keepOutSelectedCount,
  onDeleteKeepOut,
  onOpenDesign,
  onDuplicate,
  onRotateCw,
  onRotateCcw,
  onResetRotation,
  onRenest,
  onDelete,
}: {
  /** Whether any board instance is selected (enables the board actions). */
  hasSelection: boolean;
  selectedCount: number;
  keepOutSelectedCount: number;
  onDeleteKeepOut: () => void;
  onOpenDesign: () => void;
  onDuplicate: () => void;
  onRotateCw: () => void;
  onRotateCcw: () => void;
  onResetRotation: () => void;
  onRenest: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  return (
    <ContextMenuContent>
      {keepOutSelectedCount > 0 ? (
        // Keep-out zone context menu.
        <>
          <ContextMenuItem onSelect={onDeleteKeepOut}>
            {t("panel.keepout.delete")}
          </ContextMenuItem>
        </>
      ) : (
        // Board instance context menu.
        <>
          <ContextMenuItem disabled={selectedCount !== 1} onSelect={onOpenDesign}>
            {t("panel.menu.openDesign")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!hasSelection} onSelect={onDuplicate}>
            {t("panel.menu.duplicate")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasSelection} onSelect={onRotateCw}>
            {t("panel.menu.rotateCw")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasSelection} onSelect={onRotateCcw}>
            {t("panel.menu.rotateCcw")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasSelection} onSelect={onResetRotation}>
            {t("panel.menu.resetRotation")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!hasSelection} onSelect={onRenest}>
            {t("panel.menu.renest")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!hasSelection} onSelect={onDelete}>
            {t("panel.menu.delete")}
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}

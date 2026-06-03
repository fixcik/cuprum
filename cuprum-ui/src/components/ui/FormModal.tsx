import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

/** A {@link Modal} with the standard form footer — a ghost Cancel and a primary
 *  Save (disabled until `canSave`). The body is the caller's `children`; the
 *  caller owns the fields, their state and the save logic. Shared by the small
 *  name/description dialogs (rename design, project & recent settings), which
 *  previously each re-implemented this identical footer. */
export function FormModal({
  open,
  onClose,
  title,
  onSave,
  canSave,
  saveLabel,
  cancelLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  onSave: () => void;
  /** Whether Save is enabled (e.g. a required name is non-empty). */
  canSave: boolean;
  /** Override the default "Save" / "Cancel" labels. */
  saveLabel?: string;
  cancelLabel?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("project");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {cancelLabel ?? t("settings.cancel")}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={onSave}>
            {saveLabel ?? t("settings.save")}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

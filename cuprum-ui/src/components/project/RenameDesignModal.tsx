import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "@/components/ui/FormModal";
import { LabeledTextInput } from "@/components/ui/LabeledTextInput";
import { useShell } from "@/shellStore";
import type { ProjectDesign } from "@/lib/api";

/** Rename a design from the gallery card (gear → dialog). The inspector renames
 *  in place via EditableText; this is the card's equivalent. */
export function RenameDesignModal({
  open,
  onClose,
  design,
}: {
  open: boolean;
  onClose: () => void;
  design: ProjectDesign;
}) {
  const { t } = useTranslation("project");
  const renameDesign = useShell((s) => s.renameDesign);
  const [name, setName] = useState(design.source_name);

  useEffect(() => {
    if (open) setName(design.source_name);
  }, [open, design.source_name]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    if (n !== design.source_name) void renameDesign(design.id, n);
    onClose();
  };

  return (
    <FormModal open={open} onClose={onClose} title={t("designs.renameTitle")} onSave={save} canSave={!!name.trim()}>
      <LabeledTextInput
        label={t("settings.name")}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
    </FormModal>
  );
}

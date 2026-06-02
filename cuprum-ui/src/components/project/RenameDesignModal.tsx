import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
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
    <Modal
      open={open}
      onClose={onClose}
      title={t("designs.renameTitle")}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("settings.cancel")}
          </Button>
          <Button size="sm" disabled={!name.trim()} onClick={save}>
            {t("settings.save")}
          </Button>
        </>
      }
    >
      <label className="mb-1 block text-[11px] text-muted-foreground">{t("settings.name")}</label>
      <TextInput
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
        className="w-full"
      />
    </Modal>
  );
}

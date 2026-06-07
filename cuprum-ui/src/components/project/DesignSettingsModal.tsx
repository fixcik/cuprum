import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "@/components/ui/FormModal";
import { LabeledTextInput } from "@/components/ui/LabeledTextInput";

/** Edit a design's settings (currently just its name) from the inspector window's
 *  gear. The inspector is a remote view, so it commits via the `onRename` emit
 *  callback rather than the shell store — unlike the gallery's RenameDesignModal,
 *  which runs in the main window and can use useShell directly. */
export function DesignSettingsModal({
  open,
  onClose,
  name,
  onRename,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  onRename: (name: string) => void;
}) {
  const { t } = useTranslation("project");
  const [value, setValue] = useState(name);

  useEffect(() => {
    if (open) setValue(name);
  }, [open, name]);

  const save = () => {
    const n = value.trim();
    if (!n) return;
    if (n !== name) onRename(n);
    onClose();
  };

  return (
    <FormModal open={open} onClose={onClose} title={t("designs.renameTitle")} onSave={save} canSave={!!value.trim()}>
      <LabeledTextInput
        label={t("settings.name")}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
    </FormModal>
  );
}

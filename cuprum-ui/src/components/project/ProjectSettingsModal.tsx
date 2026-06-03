import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormModal } from "@/components/ui/FormModal";
import { LabeledTextInput } from "@/components/ui/LabeledTextInput";
import { useShell } from "@/shellStore";

/** Project settings (rename + description), opened from the tab-bar cog. */
export function ProjectSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("project");
  const manifest = useShell((s) => s.currentManifest);
  const updateProjectMetadata = useShell((s) => s.updateProjectMetadata);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open && manifest) {
      setName(manifest.name);
      setDescription(manifest.description);
    }
  }, [open, manifest]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    updateProjectMetadata(n, description.trim());
    onClose();
  };

  return (
    <FormModal open={open} onClose={onClose} title={t("settings.title")} onSave={save} canSave={!!name.trim()}>
      <LabeledTextInput
        label={t("settings.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-3 w-full"
        autoFocus
      />
      <LabeledTextInput
        label={t("settings.description")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("descriptionPlaceholder")}
      />
    </FormModal>
  );
}

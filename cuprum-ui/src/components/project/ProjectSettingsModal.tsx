import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
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
    <Modal
      open={open}
      onClose={onClose}
      title={t("settings.title")}
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
      <TextInput value={name} onChange={(e) => setName(e.target.value)} className="mb-3 w-full" autoFocus />
      <label className="mb-1 block text-[11px] text-muted-foreground">{t("settings.description")}</label>
      <TextInput
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("descriptionPlaceholder")}
        className="w-full"
      />
    </Modal>
  );
}

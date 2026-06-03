import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { api, type RecentProject } from "@/lib/api";
import { useShell } from "@/shellStore";

/** Edit a recent project's name/description without opening it (gear on the card).
 *  Mirrors ProjectSettingsModal, but works by `.cuprum` path: it reads the manifest
 *  on open to prefill, and saves via the path-based store action. */
export function RecentSettingsModal({
  open,
  onClose,
  project,
}: {
  open: boolean;
  onClose: () => void;
  project: RecentProject;
}) {
  const { t } = useTranslation(["project", "home"]);
  const updateRecentMetadata = useShell((s) => s.updateRecentMetadata);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState("");

  // Prefill from the manifest (the catalog only knows the name; description lives
  // in the .cuprum). Name shows immediately from the recents row, then both are
  // overwritten with the authoritative manifest values once read.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setName(project.name);
    setDescription("");
    api
      .readProjectManifest(project.path)
      .then((m) => {
        if (cancelled) return;
        setName(m.name);
        setDescription(m.description);
      })
      .catch(() => {
        /* fall back to the recents name + empty description */
      });
    return () => {
      cancelled = true;
    };
  }, [open, project.path, project.name]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    void updateRecentMetadata(project.path, n, description.trim());
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("project:settings.title")}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("project:settings.cancel")}
          </Button>
          <Button size="sm" disabled={!name.trim()} onClick={save}>
            {t("project:settings.save")}
          </Button>
        </>
      }
    >
      <label className="mb-1 block text-[11px] text-muted-foreground">{t("project:settings.name")}</label>
      <TextInput value={name} onChange={(e) => setName(e.target.value)} className="mb-3 w-full" autoFocus />
      <label className="mb-1 block text-[11px] text-muted-foreground">{t("project:settings.description")}</label>
      <TextInput
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t("project:descriptionPlaceholder")}
        className="w-full"
      />
    </Modal>
  );
}

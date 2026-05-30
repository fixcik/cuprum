import { useTranslation } from "react-i18next";

export function PrinterPage() {
  const { t } = useTranslation("printer");
  return <div className="flex-1 p-6 text-sm text-muted-foreground">{t("comingSoon")}</div>;
}

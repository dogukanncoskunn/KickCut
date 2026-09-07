import { useT } from "../i18n";
import { EmptyState } from "../lib/ui";

export function Setup() {
  const t = useT();
  return <EmptyState icon="scissors">{t("empty.setup")}</EmptyState>;
}

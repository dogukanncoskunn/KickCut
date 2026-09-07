import { useT } from "../i18n";
import { EmptyState } from "../lib/ui";

export function Library() {
  const t = useT();
  return <EmptyState icon="search">{t("empty.library")}</EmptyState>;
}

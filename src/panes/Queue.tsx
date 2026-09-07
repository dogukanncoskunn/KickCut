import { useT } from "../i18n";
import { EmptyState } from "../lib/ui";

export function Queue() {
  const t = useT();
  return <EmptyState icon="queue">{t("empty.queue")}</EmptyState>;
}

import { t } from '../../core/i18n.js';

const LABELS = { auto: t("msg_automatic_353cf589", "Автоматически"), site: t("msg_for_this_site_810aa684", "Для сайта"), import: t("msg_from_a_file_4d212eef", "Из файла"), manual: t("msg_manual_3e17d77f", "Вручную"), undo: t("msg_after_undo_9d1dd80d", "После отмены") };
export const ruleSourceLabel = meta => meta ? LABELS[meta.source] || t("msg_saved_rule_c9b76410", "Сохранённое правило") : t("msg_previously_saved_f1a20268", "Ранее сохранено");

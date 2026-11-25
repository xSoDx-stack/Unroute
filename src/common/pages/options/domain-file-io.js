import { t } from '../../core/i18n.js';
import { parseDomainRuleLines } from '../../core/domain-rules.js';
import { suggestDomainListName } from '../../core/domain-lists.js';

const MAX_DOMAIN_FILE_BYTES = 5 * 1024 * 1024;

function decodeDomainFile(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function hasBinaryControls(text) {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text);
}

function parseImportText(text) {
  const parsed = parseListText(text);
  const reference = parsed.errors.find(row => row.code === 'UNSUPPORTED_INCLUDE');
  if (reference) throw new Error(reference.error);
  return parsed;
}

export function parseListText(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length - Number(lines.at(-1) === '') > 100000) throw new Error(t('dlLimit', 'Не более 100 000 доменов; файл до 5 МБ.'));
  const parsed = parseDomainRuleLines(lines);
  if (parsed.validDomains.length > 100000) throw new Error(t('dlLimit', 'Не более 100 000 доменов; файл до 5 МБ.'));
  return parsed;
}

export function domainListImportName(filename, existingNames = []) {
  // eslint-disable-next-line no-control-regex
  const base = filename.replace(/\.txt$/i, '').replace(/[\x00-\x1F\x7F]/g, '_').normalize('NFKC').trim();
  return suggestDomainListName(base || t('dlImportedName', 'Лист'), existingNames);
}

export function domainListExportFilename(name) {
  // Keep Unicode and punctuation except characters forbidden in file names.
  // eslint-disable-next-line no-control-regex
  let base = String(name || '').replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_').replace(/[. ]+$/g, '') || 'domains';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = '_' + base;
  return `${base}.txt`;
}

export async function readListFile(file) {
  if (!file || !/\.txt$/i.test(file.name) || file.size > MAX_DOMAIN_FILE_BYTES) throw new Error(t('dlFileType', 'Выберите текстовый файл UTF-8 (.txt), не более 5 МБ.'));
  const text = decodeDomainFile(await file.arrayBuffer());
  if (hasBinaryControls(text)) throw new Error(t('dlFileType', 'Выберите текстовый файл UTF-8 (.txt), не более 5 МБ.'));
  const parsed = parseImportText(text);
  if (!parsed.validDomains.length) throw new Error(t('dlEmptyImport', 'Нет корректных доменов. Существующие данные не изменены.'));
  return parsed;
}

export function listPreviewText(parsed) {
  return t('dlPreview', 'Доменов: $1 · некорректных строк: $2. URL преобразуются в домены, пути не учитываются.', [parsed.validDomains.length, parsed.skippedCount])
    + (parsed.errors.length ? '\n' + parsed.errors.slice(0, 10).map(row => `${row.line}: ${row.value}`).join('\n') : '');
}

/**
 * Safely parse and validate domains from an uploaded File object.
 */
export async function readManualDomainFile(file) {
  if (!file) {
    throw new Error(t("msg_no_file_selected_69848927", "Файл не выбран"));
  }

  // 1. Check file extension against known incompatible/dangerous binary extensions
  const fileName = (file.name || '').toLowerCase();
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  const dangerousExts = [
    'exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'iso', 'pdf',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mp3', 'avi', 'mkv',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'apk', 'dmg', 'class',
    'jar', 'dat', 'db', 'sqlite'
  ];

  if (ext && dangerousExts.includes(ext)) {
    throw new Error(t("msg_unsupported_file_format_sub_only_text_files_t_cf5e1a57", "Файл имеет неподдерживаемый формат (.$1). Поддерживаются только текстовые файлы (.txt) со списком доменов.", [ext]));
  }

  // 2. File size limit (5MB max ~ 100,000 domains)
  if (file.size > MAX_DOMAIN_FILE_BYTES) {
    throw new Error(t("msg_the_file_is_too_large_sub_mb_the_maximum_text_91d224d0", "Файл слишком большой ($1 МБ). Максимальный размер текстового файла: 5 МБ.", [(file.size / (1024 * 1024)).toFixed(1)]));
  }

  // Read bytes with a timeout, then reject invalid UTF-8 instead of repairing it.
  const bytes = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    const timer = setTimeout(() => {
      reject(new Error(t("msg_reading_the_file_timed_out_17a620bb", "Превышено время чтения файла")));
      reader.abort();
    }, 15000);

    reader.onload = () => {
      clearTimeout(timer);
      resolve(reader.result);
    };
    reader.onerror = () => {
      clearTimeout(timer);
      reject(new Error(t("msg_failed_to_read_the_file_9985b0ad", "Не удалось прочитать файл")));
    };
    reader.onabort = () => {
      clearTimeout(timer);
      reject(new Error(t("msg_file_reading_was_cancelled_0f5f331d", "Чтение файла прервано")));
    };

    reader.readAsArrayBuffer(file);
  });

  let rawText;
  try { rawText = decodeDomainFile(bytes); }
  catch {
    throw new Error(t("msg_failed_to_decode_the_file_contents_4db11ffb", "Не удалось декодировать содержимое файла"));
  }


  if (!rawText.trim()) {
    throw new Error(t("msg_the_file_is_empty_or_contains_only_whitespace_43e3a1ec", "Файл пуст или содержит только пробелы"));
  }

  // Reject binary control characters throughout the file.
  if (hasBinaryControls(rawText)) {
    throw new Error(t("msg_the_file_contains_unreadable_binary_data_only_c1ccf183", "Файл содержит нечитаемые бинарные данные. Поддерживаются только текстовые файлы (.txt) в кодировке UTF-8."));
  }

  // Keep the same line budget as list imports; never save a truncated file.
  const parsed = parseImportText(rawText);
  const { validDomains, skippedCount } = parsed;

  if (validDomains.length === 0) {
    throw new Error(t("msg_no_valid_domain_names_were_found_in_the_file__2067fc4b", "В файле не найдено ни одного корректного доменного имени (пропущено некорректных строк: $1).", [skippedCount]));
  }

  return { validDomains, skippedCount };
}


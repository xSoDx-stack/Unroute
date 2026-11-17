import { t } from '../../core/i18n.js';
import { initAppearance, normalizeHex } from './appearance.js';

const instances = new WeakMap();
let sequence = 0;

// No HTML templates: even storage errors and user-entered colors remain plain text.
export function initAppearanceControls(container, controller = initAppearance()) {
  if (!container || !controller) return null;
  if (instances.has(container)) return instances.get(container);
  const doc = container.ownerDocument;
  const prefix = 'appearance-' + ++sequence;
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const select = (name, options) => {
    const node = element('select', 'appearance-select'); node.id = prefix + '-' + name;
    for (const [value, label] of options) {
      const option = element('option', '', label); option.value = value; node.append(option);
    }
    return node;
  };
  const row = (label, control) => {
    const node = element('div', 'appearance-row');
    const labelNode = element('label', 'appearance-label', label);
    labelNode.htmlFor = control.id; node.append(labelNode, control); return node;
  };
  const title = element('h2', 'appearance-title', t('appearance_title', 'Оформление'));
  const description = element('p', 'appearance-description', t('appearance_description', 'Настройки сохраняются автоматически только в этом браузере.'));
  const theme = select('theme', [
    ['system', t('appearance_theme_system', 'Как в системе')],
    ['light', t('appearance_theme_light', 'Светлая')], ['dark', t('appearance_theme_dark', 'Тёмная')],
  ]);
  theme.id = 'appearanceTheme';
  const accent = element('div', 'appearance-presets'); accent.id = prefix + '-presets';
  accent.setAttribute('role', 'group'); accent.setAttribute('aria-label', t('appearance_accent', 'Акцентный цвет'));
  const presets = {};
  for (const [value, label] of [
    ['mint', t('appearance_accent_mint', 'Мятный')], ['blue', t('appearance_accent_blue', 'Голубой')],
    ['sage', t('appearance_accent_sage', 'Шалфей')], ['custom', t('appearance_accent_custom', 'Свой цвет')],
  ]) {
    const button = element('button', 'appearance-preset', label); button.type = 'button';
    button.setAttribute('data-accent', value); presets[value] = button; accent.append(button);
  }
  const color = element('input', 'appearance-color'); color.type = 'color'; color.id = 'appearanceColor';
  color.setAttribute('aria-label', t('appearance_color_picker', 'Выбрать свой цвет'));
  const hex = element('input', 'appearance-hex'); hex.type = 'text'; hex.id = 'appearanceHex';
  hex.maxLength = 7; hex.spellcheck = false; hex.autocomplete = 'off'; hex.placeholder = '#78c6b0';
  hex.setAttribute('aria-label', t('appearance_custom_hex', 'Цвет в формате HEX'));
  const validation = element('p', 'appearance-validation'); validation.id = prefix + '-validation';
  validation.hidden = true; validation.setAttribute('aria-live', 'polite');
  hex.setAttribute('aria-describedby', validation.id);
  const customFields = element('div', 'appearance-custom-fields'); customFields.append(color, hex);
  const customLabel = element('label', 'appearance-label', t('appearance_custom_hex', 'Цвет в формате HEX')); customLabel.htmlFor = hex.id;
  const customRow = element('div', 'appearance-custom'); customRow.append(customLabel, customFields, validation);
  const hint = element('p', 'appearance-description', t('appearance_contrast_hint', 'Контраст текста и фокуса подбирается автоматически. Значок Unroute остаётся мятным.'));
  const status = element('p', 'appearance-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const retry = element('button', 'appearance-retry', t('appearance_retry', 'Повторить сохранение')); retry.type = 'button'; retry.hidden = true;
  const feedback = element('div', 'appearance-feedback'); feedback.append(status, retry);
  container.classList.add('appearance-settings');
  container.replaceChildren(title, description, row(t('appearance_theme', 'Тема'), theme), row(t('appearance_accent', 'Акцентный цвет'), accent), customRow, hint, feedback);
  let editingHex = false;
  const clearValidation = () => {
    hex.setAttribute('aria-invalid', 'false'); hex.setCustomValidity(''); validation.hidden = true; validation.textContent = '';
  };
  const updateHex = () => {
    editingHex = true;
    const custom = normalizeHex(hex.value);
    if (!custom) {
      const message = t('appearance_invalid_hex', 'Введите цвет в формате #RGB или #RRGGBB.');
      hex.setAttribute('aria-invalid', 'true'); hex.setCustomValidity(message); validation.textContent = message; validation.hidden = false;
      return;
    }
    clearValidation(); controller.update({ accent: 'custom', customColor: custom });
  };
  theme.addEventListener('change', () => controller.update({ theme: theme.value }));
  for (const [value, button] of Object.entries(presets)) button.addEventListener('click', () => {
    editingHex = false; clearValidation(); controller.update({ accent: value });
  });
  hex.addEventListener('input', updateHex);
  hex.addEventListener('change', () => {
    updateHex();
    const custom = normalizeHex(hex.value);
    if (custom) { editingHex = false; hex.value = custom; }
  });
  color.addEventListener('input', () => {
    editingHex = false; clearValidation();
    const custom = normalizeHex(color.value);
    if (custom) controller.update({ accent: 'custom', customColor: custom });
  });
  retry.addEventListener('click', () => controller.flush());
  controller.subscribe(state => {
    theme.value = state.appearance.theme;
    for (const [value, button] of Object.entries(presets)) button.setAttribute('aria-pressed', String(state.appearance.accent === value));
    color.value = state.appearance.customColor;
    if (!editingHex) hex.value = state.appearance.customColor;
    customRow.hidden = state.appearance.accent !== 'custom';
    for (const control of [theme, ...Object.values(presets), color, hex]) control.disabled = state.status === 'loading';
    retry.hidden = state.status !== 'error' || state.errorKind !== 'save';
    status.dataset.state = state.status;
    if (state.status === 'error') status.textContent = (state.errorKind === 'load'
      ? t('appearance_load_error', 'Не удалось загрузить оформление. Используются настройки по умолчанию: ')
      : t('appearance_save_error', 'Не удалось сохранить оформление: ')) + state.error;
    else status.textContent = state.status === 'saving' ? t('appearance_saving', 'Сохранение…')
      : state.status === 'saved' ? t('appearance_saved', 'Сохранено')
        : state.status === 'loading' ? t('appearance_loading', 'Загрузка…') : '';
  });
  const controls = { theme, accent, presets, color, hex, status, retry, validation };
  instances.set(container, controls);
  return controls;
}

'use strict';

import { t } from '../../core/i18n.js';
import { parseDomainRuleLines } from '../../core/domain-rules.js';
import { sendMessage } from '../shared/client.js';
import { refreshSettingsHelp } from './settings-help.js';

let nextEditorScope = 0;

function button(text, onClick, className = 'btn btn-secondary') {
  const node = document.createElement('button');
  node.type = 'button'; node.className = className; node.textContent = text;
  node.addEventListener('click', onClick);
  return node;
}

function listIcon(kind) {
  const paths = {
    grip: 'M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01',
    up: 'm6 14 6-6 6 6', down: 'm6 10 6 6 6-6',
    rename: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z',
    delete: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
  };
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path'); path.setAttribute('d', paths[kind]);
  icon.append(path); return icon;
}

function iconButton(label, kind, onClick, className = 'btn btn-secondary domain-list-icon') {
  const node = button('', onClick, className);
  node.setAttribute('aria-label', label); node.append(listIcon(kind)); return node;
}

// Native dialog, styled with the same settings tokens. No browser confirm/prompt.
export function confirmListAction(root, text, details = '') {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'domain-list-dialog';
    dialog.setAttribute('aria-label',text);
    const title = document.createElement('h2'); title.textContent = text;
    const body = document.createElement('p'); body.textContent = details;
    const actions = document.createElement('div'); actions.className = 'domain-list-actions';
    actions.append(button(t('dlCancel', 'Отмена'), () => dialog.close('cancel')),
      button(t('dlConfirm', 'Подтвердить'), () => dialog.close('confirm'), 'btn btn-primary'));
    dialog.append(title, body, actions); root.append(dialog);
    refreshSettingsHelp(dialog);
    dialog.addEventListener('close', () => { const ok = dialog.returnValue === 'confirm'; dialog.remove(); resolve(ok); }, { once: true });
    dialog.showModal();
  });
}

export function parseListText(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.length > 100001) throw new Error(t('dlLimit', 'Не более 100 000 доменов; файл до 5 МБ.'));
  const parsed = parseDomainRuleLines(lines);
  if (parsed.validDomains.length > 100000) throw new Error(t('dlLimit', 'Не более 100 000 доменов; файл до 5 МБ.'));
  return parsed;
}

export async function readListFile(file) {
  if (!file || !/\.txt$/i.test(file.name) || file.size > 5 * 1024 * 1024) throw new Error(t('dlFileType', 'Выберите текстовый файл UTF-8 (.txt), не более 5 МБ.'));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) throw new Error(t('dlFileType', 'Выберите текстовый файл UTF-8 (.txt), не более 5 МБ.'));
  const parsed = parseListText(text);
  if (!parsed.validDomains.length) throw new Error(t('dlEmptyImport', 'Нет корректных доменов. Существующие данные не изменены.'));
  return parsed;
}

export function listPreviewText(parsed) {
  return t('dlPreview', 'Доменов: $1 · некорректных строк: $2. URL преобразуются в домены, пути не учитываются.', [parsed.validDomains.length, parsed.skippedCount])
    + (parsed.errors.length ? '\n' + parsed.errors.slice(0, 10).map(row => `${row.line}: ${row.value}`).join('\n') : '');
}

export function initDomainListsEditor(root, options, createEditor) {
  const { notify, onApplicationState } = options;
  const catalog = root.querySelector('#domainListsOverview');
  const rows = root.querySelector('#domainListsRows');
  const status = root.querySelector('#domainListsStatus');
  const form = root.querySelector('#domainListForm');
  const name = root.querySelector('#domainListName');
  const target = root.querySelector('#domainListProxy');
  const file = root.querySelector('#domainListFile');
  const preview = root.querySelector('#domainListPreview');
  const save = root.querySelector('#domainListSave');
  const retry = root.querySelector('#domainListsRetry');
  const back = root.querySelector('#domainListsBack');
  const scopeTitle = root.querySelector('#domainListScopeTitle');
  let manualRoot = root.querySelector('#manualSitesEditor');
  const template = manualRoot.cloneNode(true);
  let manual = createEditor(manualRoot, options);
  const editors = new Map();
  let active = null;
  let data = null;
  let generation = 0;
  let reads = 0;
  let busy = false;
  let failed = false;
  let editing = null;
  let importMode = false;
  let parsed = null;
  let formRevision = null;
  let fileRead = 0;
  let awaitingReadback = null;
  let drag = null;
  let dragFrame = 0;
  manualRoot.hidden = true;

  const canReorder = () => Boolean(data && !busy && !failed && !awaitingReadback && !active && form.hidden);
  const rowNodes = () => [...rows.querySelectorAll('.domain-list-row')];
  function focusHandle(id) {
    rowNodes().find(row => row.dataset.listId === id)?.querySelector('.domain-list-handle')?.focus({preventScroll:true});
  }
  function announce(text) {
    root.querySelector('#domainListsAnnouncement').textContent = text;
  }
  function updatePositions() {
    const items = rowNodes();
    items.forEach((row, index) => {
      row.querySelector('.domain-list-priority').textContent = String(index + 1);
      row.querySelectorAll('[data-move]').forEach(node => {
        const target = index + Number(node.dataset.move);
        node.dataset.boundary = String(target < 0 || target >= items.length);
      });
    });
  }
  async function reorderAndFocus(ids, id, revision) {
    const gen = generation;
    const saved = await write({action:'REORDER_DOMAIN_LISTS',listIds:ids}, revision);
    if (gen !== generation || !data) return false;
    if (!saved) render();
    focusHandle(id);
    if (saved) announce(t('dlOrderSaved','Порядок сохранён. Позиция $1 из $2.',
      [data.lists.findIndex(list => list.id === id) + 1, data.lists.length]));
    return saved;
  }
  function moveAdjacent(id, offset) {
    if (!canReorder()) return;
    const ids = data.lists.map(list => list.id), index = ids.indexOf(id), target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index],ids[target]] = [ids[target],ids[index]];
    return reorderAndFocus(ids, id, data.revision);
  }
  function previewDrag() {
    if (!drag?.moved) return;
    const session = drag, others = rowNodes().filter(row => row !== session.row);
    const next = others.find(row => {
      const box = row.getBoundingClientRect(); return session.y < box.top + box.height / 2;
    });
    session.row.style.transform = '';
    // Removing/reinserting the captured subtree releases pointer capture, even
    // for insertBefore(row, row.nextSibling). Move only its neighbours instead.
    const index = next ? others.indexOf(next) : others.length;
    let anchor = session.row;
    for (let i = index - 1; i >= 0; i--) {
      const sibling = others[i];
      if (sibling.nextElementSibling !== anchor) rows.insertBefore(sibling, anchor);
      anchor = sibling;
    }
    anchor = session.row;
    for (const sibling of others.slice(index)) {
      if (anchor.nextElementSibling !== sibling) rows.insertBefore(sibling, anchor.nextSibling);
      anchor = sibling;
    }
    const box = session.row.getBoundingClientRect();
    rows.style.setProperty('--drop-top', `${box.top - rows.getBoundingClientRect().top}px`);
    session.row.style.transform = `translateY(${session.y - session.offset - box.top}px)`;
    updatePositions();
  }
  function scrollDrag() {
    if (!drag?.moved) return;
    const scroller = document.scrollingElement, before = scroller.scrollTop;
    const delta = drag.y < 48 ? -12 : drag.y > innerHeight - 48 ? 12 : 0;
    if (delta) scroller.scrollTop += delta;
    if (scroller.scrollTop !== before) previewDrag();
    dragFrame = requestAnimationFrame(scrollDrag);
  }
  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.moved && Math.abs(drag.y - drag.startY) < 5) return;
    if (!drag.moved) {
      drag.moved = true; drag.row.classList.add('is-dragging'); rows.classList.add('is-sorting');
      document.documentElement.classList.add('domain-list-dragging');
      dragFrame = requestAnimationFrame(scrollDrag);
    }
    previewDrag();
  }
  function finishDrag(commit = false, event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const session = drag, bounds = rows.getBoundingClientRect();
    const inside = !event || (event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= Math.max(0,bounds.top) && event.clientY <= Math.min(innerHeight,bounds.bottom));
    const ids = rowNodes().map(row => row.dataset.listId);
    drag = null; cancelAnimationFrame(dragFrame); dragFrame = 0;
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragUp);
    document.removeEventListener('pointercancel', onDragCancel);
    document.removeEventListener('keydown', onDragKey, true);
    document.removeEventListener('visibilitychange', onDragVisibility);
    window.removeEventListener('blur', onDragCancel);
    session.row.style.transform = ''; session.row.classList.remove('is-dragging'); rows.classList.remove('is-sorting');
    rows.style.removeProperty('--drop-top');
    document.documentElement.classList.remove('domain-list-dragging');
    if (session.handle.hasPointerCapture?.(session.pointerId)) session.handle.releasePointerCapture(session.pointerId);
    if (commit && inside && session.moved && session.generation === generation && canReorder() &&
        data.revision === session.revision && ids.some((id,index) => id !== session.ids[index])) {
      void reorderAndFocus(ids, session.row.dataset.listId, session.revision);
      return;
    }
    const existing = new Map(rowNodes().map(row => [row.dataset.listId,row]));
    for (const id of session.ids) if (existing.has(id)) rows.append(existing.get(id));
    updatePositions(); controls();
    if (session.moved) announce(t('dlOrderCancelled','Перемещение отменено. Порядок не изменён.'));
    focusHandle(session.row.dataset.listId);
  }
  function onDragUp(event) { finishDrag(true, event); }
  function onDragCancel(event) { finishDrag(false, event?.type === 'pointercancel' ? event : undefined); }
  function onDragVisibility() { if (document.hidden) finishDrag(false); }
  function onDragKey(event) {
    if (event.key !== 'Escape' && event.key !== 'Tab') return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
    finishDrag(false);
  }
  function beginDrag(event, row, handle) {
    if (event.button !== 0 || drag || !canReorder() || data.lists.length < 2) return;
    event.preventDefault(); handle.focus({preventScroll:true});
    drag = {row,handle,pointerId:event.pointerId,x:event.clientX,y:event.clientY,startY:event.clientY,
      offset:event.clientY-row.getBoundingClientRect().top,ids:data.lists.map(list=>list.id),
      revision:data.revision,generation,moved:false};
    // Real pointers are captured; scripted accessibility/browser fixtures still
    // use the document listeners if the browser has no active pointer to capture.
    try { handle.setPointerCapture(event.pointerId); } catch { /* no active pointer */ }
    document.addEventListener('pointermove', onDragMove, {passive:false});
    document.addEventListener('pointerup', onDragUp);
    document.addEventListener('pointercancel', onDragCancel);
    document.addEventListener('keydown', onDragKey, true);
    document.addEventListener('visibilitychange', onDragVisibility);
    window.addEventListener('blur', onDragCancel);
    controls();
  }

  function targets(select, selected, creation = false) {
    select.replaceChildren();
    for (const proxy of data?.proxyCatalog || []) {
      const option = new Option(proxy.name, proxy.id); option.disabled = !proxy.enabled; select.add(option);
    }
    if (selected && ![...select.options].some(option => option.value === selected)) {
      const missing = new Option(t('dlMissing', 'Прокси недоступен: $1', [selected]), selected); missing.disabled = true; select.add(missing);
    }
    if (selected) select.value = selected;
    else select.selectedIndex = creation ? [...select.options].findIndex(option => !option.disabled) : -1;
  }
  function controls() {
    catalog.querySelectorAll('button,input,select').forEach(control => {
      control.disabled = busy || failed || Boolean(awaitingReadback) || !data || control.dataset.boundary === 'true' ||
        Boolean(drag && control !== drag.handle) ||
        (control.matches('.domain-list-handle,[data-move]') && (!form.hidden || (data?.lists.length || 0) < 2));
    });
    retry.disabled = busy;
    retry.hidden = !failed && !awaitingReadback;
    if (!form.hidden) save.disabled = busy || failed || Boolean(awaitingReadback) || !data || (importMode && !parsed);
  }
  function error(response) {
    failed = true; retry.hidden = false;
    status.textContent = response?.error?.message || (typeof response?.error === 'string' ? response.error : t('dlLoadError', 'Не удалось обновить данные. Черновик сохранён; повторите загрузку.'));
    notify(status.textContent); controls();
  }
  async function refresh() {
    finishDrag(false);
    const read = ++reads, gen = generation;
    try {
      const response = await sendMessage({ action: 'GET_DOMAIN_LISTS' });
      if (read !== reads || gen !== generation) return false;
      if (!response?.success || !response.data || !Array.isArray(response.data.lists) || !Number.isSafeInteger(response.data.revision)) { error(response); return false; }
      data = response.data; failed = false; retry.hidden = true;
      onApplicationState(response.settingsState);
      status.textContent = t('dlPriority', 'Приоритет сверху вниз: первый включённый лист с совпадением. Выключенные листы пропускаются.');
      render();
      // Preserve name/file draft and its displayed base revision on external refresh.
      if (!form.hidden) targets(target, target.value || editing?.proxyId || data.defaultProxyId, true);
      return true;
    } catch (cause) { if (read === reads && gen === generation) error({error:cause.message}); return false; }
  }
  async function verifyWrite(pending) {
    if (pending.generation !== generation) return false;
    // Storage notifications/background refresh can supersede this read after
    // the write already committed. Retry only abandoned snapshots, never the
    // mutation or a genuine read error, and bound retries under ongoing churn.
    let loaded = false;
    for (let attempt = 0; attempt < 3 && pending.generation === generation; attempt++) {
      const read = reads + 1;
      if (await refresh()) { loaded = true; break; }
      // A current read failed for real; an older failed flag must not make a
      // superseded Retry snapshot look like a new transport/read error.
      if (read === reads) return false;
    }
    if (!loaded) return false;
    const message = pending.message;
    if (message.action === 'SAVE_DOMAIN_LIST') {
      const id = pending.listId || data.lists.find(list=>!pending.knownIds.includes(list.id) && list.name===message.name)?.id;
      if (!id) { error(null); return false; }
      const response = await sendMessage({action:'GET_DOMAIN_LIST',listId:id});
      if (pending.generation !== generation) return false;
      const actual = response?.data?.list;
      if (!response?.success || !actual || ['name','proxyId','enabled','domains'].some(key=>Object.hasOwn(message,key) && JSON.stringify(actual[key])!==JSON.stringify(message[key]))) { error(response); return false; }
      onApplicationState(response.settingsState);
    } else if (message.action === 'DELETE_DOMAIN_LIST' && data.lists.some(list=>list.id===message.listId)) { error(null); return false; }
    else if (message.action === 'REORDER_DOMAIN_LISTS' && JSON.stringify(data.lists.map(list=>list.id))!==JSON.stringify(message.listIds)) { error(null); return false; }
    awaitingReadback=null;
    return true;
  }
  async function write(message, revision = data?.revision, formWrite = false) {
    if (busy || failed || awaitingReadback || !Number.isSafeInteger(revision)) return false;
    const gen = generation;
    busy = true; controls();
    try {
      const response = await sendMessage({ ...message, expectedRevision: revision });
      if (gen !== generation) return false;
      onApplicationState(response?.settingsState);
      if (!response?.success) { error(response); return false; }
      awaitingReadback={message,listId:response.data?.listId || message.listId,knownIds:data.lists.map(list=>list.id),generation:gen,formWrite};
      if (!await verifyWrite(awaitingReadback)) return false;
      status.textContent = response.settingsState?.pending ? t('msg_saved_waiting_to_apply_cee8b842', 'Сохранено · ожидает применения') : t('msg_saved_6c67d096', '✓ Сохранено');
      return true;
    } catch (cause) { if (gen === generation) error({error:cause.message}); return false; }
    finally { if (gen === generation) { busy = false; controls(); } }
  }
  async function showEditor(list) {
    if (busy) return;
    if (active && !await active.editor.flush()) return;
    catalog.hidden = true; back.hidden = false;
    for (const entry of editors.values()) entry.root.hidden = true;
    manualRoot.hidden = true;
    if (!list) {
      active = {editor:manual,root:manualRoot}; manualRoot.hidden = false;
      scopeTitle.textContent = t('dlManual', 'Ручные правила');
    } else {
      if (!editors.has(list.id)) {
        const node = template.cloneNode(true);
        // Monotonic across editor lifetimes; deleted Map entries cannot reuse IDs.
        const prefix = `scope${nextEditorScope++}-`;
        node.id = `${prefix}listEditor`; node.dataset.listScope = list.id;
        node.querySelectorAll('[id]').forEach(element => { element.id = prefix + element.id; });
        node.querySelectorAll('[for]').forEach(element => { element.htmlFor = prefix + element.htmlFor; });
        node.dataset.idPrefix = prefix;
        root.append(node);
        editors.set(list.id, {root:node,editor:createEditor(node, {...options,listId:list.id})});
      }
      active = editors.get(list.id); active.root.hidden = false; scopeTitle.textContent = list.name;
    }
    await active.editor.activate();
  }
  async function goBack() {
    if (active && !await active.editor.flush()) return false;
    if (active) active.root.hidden = true;
    active = null; back.hidden = true; scopeTitle.textContent = ''; catalog.hidden = false;
    await refresh(); return true;
  }
  function render() {
    const focused = document.activeElement;
    const focusedId = rows.contains(focused) && focused.matches('.domain-list-handle')
      ? focused.closest('.domain-list-row').dataset.listId : null;
    rows.replaceChildren();
    data.lists.forEach((list, index) => {
      const row = document.createElement('div'); row.className = 'domain-list-row'; row.dataset.listId = list.id;
      row.classList.toggle('is-disabled', !list.enabled);
      const handle = iconButton(t('dlDragFor','Переместить лист «$1»',[list.name]), 'grip', () => {}, 'domain-list-handle');
      handle.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      handle.setAttribute('aria-describedby', 'domainListsReorderHint');
      handle.addEventListener('pointerdown', event => beginDrag(event, row, handle));
      handle.addEventListener('lostpointercapture', () => { if (drag?.handle === handle) finishDrag(false); });
      handle.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowUp','ArrowDown'].includes(event.key) || drag) return;
        event.preventDefault(); void moveAdjacent(list.id, event.key === 'ArrowUp' ? -1 : 1);
      });
      const priority = document.createElement('span'); priority.className = 'domain-list-priority'; priority.textContent = String(index + 1);
      handle.append(priority);
      const identity = document.createElement('div'); identity.className = 'domain-list-identity';
      const open = button(list.name, () => showEditor(list), 'domain-list-name'); open.dataset.open = list.id;
      const count = document.createElement('small'); count.className = 'domain-list-count';
      count.textContent = t('dlDomainsCount','Домены: $1',[new Intl.NumberFormat(document.documentElement.lang || 'ru').format(list.count)]);
      identity.append(open, count);
      const routing = document.createElement('div'); routing.className = 'domain-list-controls';
      const select = document.createElement('select'); targets(select, list.proxyId);
      select.setAttribute('aria-label', t('dlProxyFor', 'Прокси для листа $1', [list.name]));
      select.addEventListener('change', async () => { if (!await write({action:'SAVE_DOMAIN_LIST',listId:list.id,proxyId:select.value})) select.value = list.proxyId; });
      const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = list.enabled;
      const toggle = document.createElement('label'); toggle.className = 'switch domain-list-toggle';
      const slider = document.createElement('span'); slider.className = 'slider'; slider.setAttribute('aria-hidden','true');
      toggle.append(enabled, slider);
      enabled.setAttribute('aria-label', t('dlEnabledFor', 'Включить лист $1', [list.name]));
      enabled.addEventListener('change', async () => { if (!await write({action:'SAVE_DOMAIN_LIST',listId:list.id,enabled:enabled.checked})) enabled.checked = list.enabled; });
      const actions = document.createElement('div'); actions.className = 'domain-list-actions';
      for (const [offset, label] of [[-1,t('dlUp','Выше')],[1,t('dlDown','Ниже')]]) {
        const move = iconButton(label, offset < 0 ? 'up' : 'down', () => { void moveAdjacent(list.id, offset); });
        move.dataset.move = String(offset);
        move.setAttribute('aria-label', `${label}: ${list.name}`); move.dataset.boundary = String(index+offset < 0 || index+offset >= data.lists.length); actions.append(move);
      }
      actions.append(iconButton(t('dlRename','Переименовать'), 'rename', () => openForm(list)), iconButton(t('dlDelete','Удалить'), 'delete', async () => {
        const revision = data.revision, gen = generation;
        if (await confirmListAction(root,t('dlDeleteTitle','Удалить лист «$1»?', [list.name]),t('dlDeleteHint','Домены других листов и ручные правила сохранятся.'))) {
          if (gen !== generation) return;
          if (await write({action:'DELETE_DOMAIN_LIST',listId:list.id},revision)) { editors.get(list.id)?.editor.invalidate(); editors.get(list.id)?.root.remove(); editors.delete(list.id); }
        }
      },'btn btn-danger domain-list-icon'));
      routing.append(select, toggle, actions); row.append(handle,identity,routing); rows.append(row);
    });
    if (!data.lists.length) { const empty=document.createElement('p'); empty.className='empty-state'; empty.textContent=t('dlEmpty','Листов пока нет. Добавьте пустой лист или загрузите .txt.'); rows.append(empty); }
    controls();
    rows.querySelectorAll('[data-boundary="true"]').forEach(control => { control.disabled = true; });
    refreshSettingsHelp(rows);
    rows.querySelectorAll('.domain-list-name').forEach(node => { node.title = `${node.textContent}\n${node.title}`; });
    if (focusedId) focusHandle(focusedId);
  }
  function openForm(list = null, importing = false) {
    editing = list; importMode = importing; parsed = null; ++fileRead;
    formRevision = data.revision;
    form.hidden = false; name.value = list?.name || ''; file.value = ''; file.hidden = !importing;
    root.querySelector('label[for="domainListFile"]').hidden = !importing;
    target.closest('label').hidden = Boolean(list); targets(target,list?.proxyId || data.defaultProxyId,true);
    preview.textContent = ''; save.textContent = list ? t('dlRename','Переименовать') : t('dlCreate','Создать лист');
    controls(); name.focus();
  }
  root.querySelector('#domainListAdd').addEventListener('click',()=>openForm());
  root.querySelector('#domainListImport').addEventListener('click',()=>openForm(null,true));
  root.querySelector('#domainListCancel').addEventListener('click',()=>{ form.hidden=true; ++fileRead; });
  root.querySelector('#manualRulesLink').addEventListener('click',()=>showEditor(null));
  retry.addEventListener('click',async()=>{
    if (busy) return;
    const gen=generation;
    busy=true; controls();
    try {
      const pending=awaitingReadback;
      const loaded=pending ? await verifyWrite(pending) : await refresh();
      if (gen!==generation) return;
      if (loaded) {
        formRevision=data.revision;
        if (pending?.formWrite) { form.hidden=true; parsed=null; }
      }
    } catch(cause) { if (gen===generation) error({error:cause.message}); }
    finally { if (gen===generation) { busy=false; controls(); } }
  });
  back.addEventListener('click',goBack);
  file.addEventListener('change',async()=>{
    const read=++fileRead, gen=generation; parsed=null; controls();
    try { const result=await readListFile(file.files[0]); if(read!==fileRead || gen!==generation) return; parsed=result; preview.textContent=listPreviewText(result); }
    catch(cause) { if(read===fileRead && gen===generation) preview.textContent=cause.message; }
    controls();
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const normalized=name.value.normalize('NFKC').trim();
    if(!normalized || [...normalized].length>64) { preview.textContent=t('dlNameError','Название: от 1 до 64 символов.'); return; }
    if(!editing && !data.proxyCatalog.some(proxy=>proxy.enabled && proxy.id===target.value)) { preview.textContent=t('mpErrorChoice','Выберите прокси для новых сайтов.'); return; }
    if(importMode && !parsed) return;
    const payload=editing ? {action:'SAVE_DOMAIN_LIST',listId:editing.id,name:normalized} : {action:'SAVE_DOMAIN_LIST',name:normalized,proxyId:target.value,enabled:true,domains:parsed?.validDomains || []};
    if(await write(payload,formRevision,true)) { form.hidden=true; parsed=null; }
  });
  controls();
  return {
    reset:()=>{
      finishDrag(false); ++generation; ++reads; ++fileRead;
      manual.invalidate();
      for (const entry of editors.values()) { entry.editor.invalidate(); entry.root.remove(); }
      editors.clear(); active=null; data=null; failed=true; busy=false;
      awaitingReadback=null; formRevision=null; editing=null; parsed=null;
      const fresh=template.cloneNode(true); manualRoot.replaceWith(fresh); manualRoot=fresh;
      manualRoot.hidden=true; manual=createEditor(manualRoot,options);
      form.hidden=true; name.value=''; file.value=''; preview.textContent='';
      back.hidden=true; scopeTitle.textContent=''; catalog.hidden=false; rows.replaceChildren();
      controls();
    },
    activate: async()=>{ if(active) return goBack(); return refresh(); },
    refresh: async()=>{ const result=await refresh(); if(active) await active.editor.refresh(); return result; },
    cancelRead:()=>{ finishDrag(false); ++reads; manual.cancelRead(); for(const entry of editors.values()) entry.editor.cancelRead(); },
    invalidate:()=>{ finishDrag(false); ++generation; ++reads; ++fileRead; data=null; failed=true; formRevision=null; awaitingReadback=null; manual.invalidate(); for(const entry of editors.values()) entry.editor.invalidate(); controls(); },
    flush:()=>{ finishDrag(false); return active ? active.editor.flush() : Promise.resolve(!busy); },
  };
}

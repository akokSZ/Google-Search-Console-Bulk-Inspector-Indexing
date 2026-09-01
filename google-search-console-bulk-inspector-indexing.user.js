// ==UserScript==
// @name         Google Search Console — Bulk Inspector & Indexing
// @namespace    gsc-bulk-inspector-indexing
// @version      5.0
// @description  Массовая проверка URL и запрос переобхода через интерфейс Google Search Console
// @match        https://search.google.com/search-console*
// @run-at       document-idle
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/akokSZ/Google-Search-Console-Bulk-Inspector-Indexing/main/google-search-console-bulk-inspector-indexing.user.js
// @downloadURL  https://raw.githubusercontent.com/akokSZ/Google-Search-Console-Bulk-Inspector-Indexing/main/google-search-console-bulk-inspector-indexing.user.js
// @supportURL   https://github.com/akokSZ/Google-Search-Console-Bulk-Inspector-Indexing/issues
// @homepageURL  https://github.com/akokSZ/Google-Search-Console-Bulk-Inspector-Indexing
// @license      The Unlicense
// ==/UserScript==

(function () {
    'use strict';

    const LEGACY_STORAGE_KEY = 'gsc_bulk_inspector_indexing_v8';
    const MIN_DELAY = 20000;
    const MAX_DELAY = 40000;
    const WAIT_FOR_RESULT = 60000;
    const WAIT_FOR_BUTTON = 30000;
    const WAIT_FOR_REQUEST_RESULT = 30000;
    const WAIT_FOR_POPUP_CLOSE = 5000;
    const APP_VERSION = '5.0';

    function createInitialState(resourceId = null) {
        return {
            version: APP_VERSION,
            resourceId,
            urls: [],
            results: {},
            logs: [],
            action: null,
            actionUrls: [],
            currentIndex: 0,
            running: false,
            paused: false,
            stopped: false,
            resumeAfterNavigation: false,
            quotaPaused: false,
            panelCollapsed: false
        };
    }

    let state = createInitialState();
    let processing = false;
    let resourceInfo = null;

    function getStorageKey() {
        if (!resourceInfo || !resourceInfo.resourceId) {
            return LEGACY_STORAGE_KEY;
        }
        return LEGACY_STORAGE_KEY + ':' + encodeURIComponent(resourceInfo.resourceId);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function randomDelay() {
        return Math.floor(MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY));
    }

    function getElement(id) {
        return document.getElementById(id);
    }

    function setStatus(text) {
        const el = getElement('gsc-status');
        if (el) {
            el.textContent = text;
        }
        console.log('[GSC Bulk]', text);
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function waitFor(condition, timeout, interval = 300) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = setInterval(() => {
                let result = false;
                try {
                    result = condition();
                } catch (e) {
                    clearInterval(timer);
                    reject(e);
                    return;
                }

                if (result) {
                    clearInterval(timer);
                    resolve(result);
                    return;
                }

                if (Date.now() - started > timeout) {
                    clearInterval(timer);
                    reject(new Error('Timeout'));
                }
            }, interval);
        });
    }

    function saveState() {
        try {
            localStorage.setItem(getStorageKey(), JSON.stringify(state));
        } catch (e) {
            console.error('[GSC Bulk] Ошибка сохранения:', e);
        }
    }

    function loadState() {
        try {
            const storageKey = getStorageKey();
            let raw = localStorage.getItem(storageKey);
            let isLegacy = false;

            if (!raw && storageKey !== LEGACY_STORAGE_KEY) {
                raw = localStorage.getItem(LEGACY_STORAGE_KEY);
                isLegacy = Boolean(raw);
            }

            if (!raw) {
                return;
            }

            const saved = JSON.parse(raw);

            if (!saved || !Array.isArray(saved.urls)) {
                return;
            }

            if (isLegacy && saved.resourceId && resourceInfo && saved.resourceId !== resourceInfo.resourceId) {
                return;
            }

            state = {
                ...state,
                ...saved,
                running: false,
                paused: Boolean(saved.paused),
                stopped: false
            };

            if (!state.results || typeof state.results !== 'object' || Array.isArray(state.results)) {
                state.results = {};
            }

            if (!Array.isArray(state.logs)) {
                state.logs = [];
            }

            if (!Array.isArray(state.actionUrls)) {
                state.actionUrls = [];
            }
        } catch (e) {
            console.error('[GSC Bulk] Ошибка загрузки:', e);
        }
    }

    function addLog(url, status, message = '') {
        state.logs.push({
            time: new Date().toLocaleTimeString(),
            url,
            status,
            message
        });

        if (state.logs.length > 500) {
            state.logs = state.logs.slice(-500);
        }

        saveState();
        renderLog();
    }

    function getCurrentResourceId() {
        const params = new URLSearchParams(window.location.search);
        return params.get('resource_id');
    }

    function detectResource() {
        const resourceId = getCurrentResourceId();
        if (!resourceId) {
            return null;
        }

        if (resourceId.toLowerCase().startsWith('sc-domain:')) {
            const host = resourceId.substring('sc-domain:'.length).trim().toLowerCase();
            if (!host) {
                return null;
            }
            return { resourceId, type: 'domain', host, prefix: null };
        }

        try {
            const parsed = new URL(resourceId);
            return { resourceId, type: 'url-prefix', host: parsed.hostname.toLowerCase(), prefix: parsed.href };
        } catch (e) {
            return null;
        }
    }

    function getResourceLabel() {
        if (!resourceInfo) {
            return 'Не определён';
        }
        if (resourceInfo.type === 'domain') {
            return resourceInfo.host + ' [Domain Property]';
        }
        return resourceInfo.prefix + ' [URL-prefix]';
    }

    function isAllowedUrl(url) {
        if (!resourceInfo) {
            return false;
        }

        let parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            return false;
        }

        if (parsed.protocol !== 'https:') {
            return false;
        }

        if (resourceInfo.type === 'domain') {
            const host = parsed.hostname.toLowerCase();
            return host === resourceInfo.host || host.endsWith('.' + resourceInfo.host);
        }

        if (resourceInfo.type === 'url-prefix') {
            return parsed.href.startsWith(resourceInfo.prefix);
        }

        return false;
    }

    function normalizeUrl(url) {
        url = String(url).trim().replace(/^['"]|['"]$/g, '');
        if (!url) {
            return null;
        }

        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:') {
                return null;
            }
            parsed.hash = '';
            parsed.hostname = parsed.hostname.toLowerCase();
            if (!isAllowedUrl(parsed.href)) {
                return null;
            }
            return parsed.href;
        } catch (e) {
            return null;
        }
    }

    function parseUrls(text) {
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const urls = [];
        const seen = new Set();
        let invalid = 0;
        let duplicates = 0;

        for (const line of lines) {
            const url = normalizeUrl(line);
            if (!url) {
                invalid++;
                continue;
            }
            if (seen.has(url)) {
                duplicates++;
                continue;
            }
            seen.add(url);
            urls.push(url);
        }

        return { urls, invalid, duplicates };
    }

    function addUrlsFromTextarea() {
        const textarea = getElement('gsc-url-input');
        if (!textarea) {
            return;
        }

        const parsed = parseUrls(textarea.value);
        if (!parsed.urls.length) {
            setStatus(`Ничего не добавлено. Некорректных/чужих URL: ${parsed.invalid}.`);
            return;
        }

        const existing = new Set(state.urls);
        let added = 0;

        for (const url of parsed.urls) {
            if (existing.has(url)) {
                continue;
            }
            state.urls.push(url);
            existing.add(url);
            added++;
        }

        textarea.value = '';
        saveState();
        render();
        setStatus(`Добавлено: ${added}. Всего URL: ${state.urls.length}.`);

        if (parsed.duplicates) {
            addLog('', 'INFO', `Дубликатов: ${parsed.duplicates}`);
        }

        if (parsed.invalid) {
            addLog('', 'INFO', `Отклонено URL: ${parsed.invalid}`);
        }
    }

    function clearProject() {
        if (state.running) {
            setStatus('Сначала остановите текущую операцию.');
            return;
        }
        if (!confirm('Удалить очередь, результаты и журнал?')) {
            return;
        }

        state = createInitialState(resourceInfo ? resourceInfo.resourceId : null);
        saveState();
        render();
        setStatus('Проект очищен.');
    }

    function saveProject() {
        const project = {
            app: 'Google Search Console — Bulk Inspector & Indexing',
            version: APP_VERSION,
            savedAt: new Date().toISOString(),
            resourceId: resourceInfo ? resourceInfo.resourceId : state.resourceId,
            urls: state.urls,
            results: state.results,
            logs: state.logs,
            action: state.action,
            actionUrls: state.actionUrls,
            currentIndex: state.currentIndex
        };

        const json = JSON.stringify(project, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = 'gsc-project-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        setStatus('Проект сохранён в JSON.');
    }

    function loadProject() {
        if (state.running) {
            setStatus('Сначала остановите текущую операцию.');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';

        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            if (!file) {
                return;
            }

            try {
                const text = await file.text();
                const project = JSON.parse(text);

                if (!project || !Array.isArray(project.urls)) {
                    throw new Error('Невалидный файл проекта.');
                }

                if (project.resourceId && resourceInfo && project.resourceId !== resourceInfo.resourceId) {
                    throw new Error('Проект относится к другому Search Console property.');
                }

                state.urls = project.urls || [];
                state.results = project.results && typeof project.results === 'object' ? project.results : {};
                state.logs = Array.isArray(project.logs) ? project.logs : [];
                state.action = project.action || null;
                state.actionUrls = Array.isArray(project.actionUrls) ? project.actionUrls : [];
                state.currentIndex = Number.isInteger(project.currentIndex) ? project.currentIndex : 0;
                state.resourceId = resourceInfo ? resourceInfo.resourceId : project.resourceId;
                state.running = false;
                state.paused = false;
                state.stopped = false;
                state.resumeAfterNavigation = false;
                state.quotaPaused = false;

                saveState();
                render();
                setStatus(`Проект загружен. URL: ${state.urls.length}.`);
            } catch (e) {
                setStatus(`Ошибка загрузки проекта: ${e.message}`);
            }
        });

        input.click();
    }

    function exportResults() {
        if (!state.urls.length) {
            setStatus('Нет URL для экспорта.');
            return;
        }

        const rows = [['URL', 'Статус', 'Статус индекса', 'Время', 'Комментарий']];

        for (const url of state.urls) {
            const result = state.results[url];
            if (!result) {
                rows.push([url, 'NOT_PROCESSED', '', '', '']);
                continue;
            }
            rows.push([
                url,
                result.status || '',
                result.indexState || '',
                result.time || '',
                result.message || ''
            ]);
        }

        const csv = rows.map(row => row.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(';')).join('\r\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = 'gsc-results-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
        setStatus('Результаты экспортированы в CSV.');
    }

    function getStats() {
        let indexed = 0;
        let notIndexed = 0;
        let sent = 0;
        let skipped = 0;
        let errors = 0;

        for (const url of state.urls) {
            const result = state.results[url];
            if (!result) {
                continue;
            }

            if (result.indexState === 'indexed') {
                indexed++;
            }
            if (result.indexState === 'not_indexed') {
                notIndexed++;
            }
            if (result.status === 'success') {
                sent++;
            }
            if (result.status === 'skipped') {
                skipped++;
            }
            if (result.status === 'error') {
                errors++;
            }
        }

        return { total: state.urls.length, indexed, notIndexed, sent, skipped, errors };
    }

    function render() {
        const stats = getStats();
        const values = {
            'gsc-total': stats.total,
            'gsc-indexed': stats.indexed,
            'gsc-not-indexed': stats.notIndexed,
            'gsc-sent': stats.sent,
            'gsc-skipped': stats.skipped,
            'gsc-errors': stats.errors
        };

        for (const [id, value] of Object.entries(values)) {
            const el = getElement(id);
            if (el) {
                el.textContent = value;
            }
        }

        const pauseButton = getElement('gsc-pause');
        if (pauseButton) {
            pauseButton.textContent = state.paused ? 'Продолжить' : 'Пауза';
        }

        const collapseButton = getElement('gsc-collapse');
        if (collapseButton) {
            collapseButton.textContent = state.panelCollapsed ? '+' : '−';
        }

        const panel = getElement('gsc-panel');
        if (panel) {
            if (state.panelCollapsed) {
                panel.classList.add('collapsed');
            } else {
                panel.classList.remove('collapsed');
            }
        }

        renderCurrent();
        renderLog();
        updateButtons();
    }

    function renderCurrent() {
        const el = getElement('gsc-current-url');
        if (!el) {
            return;
        }

        if (processing && Array.isArray(state.actionUrls) && state.currentIndex < state.actionUrls.length) {
            el.textContent = state.actionUrls[state.currentIndex];
        } else {
            el.textContent = '—';
        }
    }

    function renderLog() {
        const el = getElement('gsc-log');
        if (!el) {
            return;
        }

        const logs = state.logs.slice(-150).reverse();
        el.innerHTML = logs.map(item => {
            let cls = 'gsc-log-info';
            if (item.status === 'SUCCESS') cls = 'gsc-log-success';
            if (item.status === 'SKIPPED') cls = 'gsc-log-skipped';
            if (item.status === 'ERROR') cls = 'gsc-log-error';
            if (item.status === 'QUOTA') cls = 'gsc-log-quota';
            if (item.status === 'INDEXED') cls = 'gsc-log-indexed';
            if (item.status === 'NOT_INDEXED') cls = 'gsc-log-not-indexed';

            return `
                <div class="${cls}">
                    <span class="gsc-time">${escapeHtml(item.time)}</span>
                    <span class="gsc-log-status">${escapeHtml(item.status)}</span>
                    <span class="gsc-log-url">${escapeHtml(item.url || '')}</span>
                    ${item.message ? `<span class="gsc-log-message">${escapeHtml(item.message)}</span>` : ''}
                </div>
            `;
        }).join('');

        el.scrollTop = 0;
    }

    function updateButtons() {
        const hasUrls = state.urls.length > 0;
        const hasNotIndexed = state.urls.some(url => state.results[url] && state.results[url].indexState === 'not_indexed');

        const inspectButton = getElement('gsc-inspect');
        const sendNotIndexedButton = getElement('gsc-send-not-indexed');
        const sendAllButton = getElement('gsc-send-all');

        if (inspectButton) inspectButton.disabled = state.running || !hasUrls;
        if (sendNotIndexedButton) sendNotIndexedButton.disabled = state.running || !hasNotIndexed;
        if (sendAllButton) sendAllButton.disabled = state.running || !hasUrls;
    }

    function findInspectionInput() {
        const inputs = [...document.querySelectorAll('input, textarea')].filter(el => !el.closest('#gsc-panel'));

        for (const el of inputs) {
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
            if (aria.includes('проверка') || aria.includes('inspect') || aria.includes('url inspection') || placeholder.includes('проверка') || placeholder.includes('inspect') || placeholder.includes('url inspection')) {
                return el;
            }
        }

        const visible = inputs.filter(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });

        for (const el of visible) {
            const value = el.value || '';
            if (resourceInfo && value.includes(resourceInfo.host)) {
                return el;
            }
        }

        if (visible.length === 1) {
            return visible[0];
        }

        return null;
    }

    function setInputValue(input, value) {
        input.focus();
        const prototype = Object.getPrototypeOf(input);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function pressEnter(input) {
        input.focus();
        const options = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
        input.dispatchEvent(new KeyboardEvent('keydown', options));
        input.dispatchEvent(new KeyboardEvent('keypress', options));
        input.dispatchEvent(new KeyboardEvent('keyup', options));
    }

    function getInspectionBodyText() {
        return (document.body && document.body.innerText ? document.body.innerText : '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function hasIndexingInProgress() {
        const text = getInspectionBodyText();
        const patterns = [
            'проверяется возможность индексации',
            'проверка возможности индексации',
            'проверяется, можно ли проиндексировать эту страницу',
            'checking whether this page can be indexed',
            'checking if this page can be indexed',
            'this page is being checked for indexing',
            'получение данных',
            'loading',
            'please wait'
        ];

        return patterns.some(pattern => text.includes(pattern));
    }

    function getIndexState() {
        const bodyText = getInspectionBodyText();
        if (!bodyText) {
            console.log('[GSC Bulk DEBUG] getIndexState: bodyText пуст');
            return null;
        }

        if (hasIndexingInProgress()) {
            console.log('[GSC Bulk DEBUG] getIndexState: индексирование в процессе');
            return null;
        }

        const notIndexedPatterns = [
            'эта страница не проиндексирована',
            'эта страница не индексируется',
            'страница не проиндексирована',
            'url не в индексе google',
            'url нет в индексе google',
            'url отсутствует в индексе google',
            'url is not on google',
            'the page is not indexed',
            'page is not indexed',
            'not on google'
        ];

        const indexedPatterns = [
            'url есть в индексе google',
            'url is on google',
            'эта страница проиндексирована',
            'эта страница уже проиндексирована',
            'страница проиндексирована',
            'the page is indexed',
            'page is indexed',
            'url is indexed',
            'this url is on google'
        ];

        // Проверяем сначала паттерны «не в индексе», чтобы избежать ложных срабатываний на совпадения вроде
        // "page is not indexed" vs "page is indexed" в разных частях текста.
        const matchedNotIndexed = notIndexedPatterns.find(pattern => bodyText.includes(pattern));
        if (matchedNotIndexed) {
            console.log('[GSC Bulk DEBUG] getIndexState: найден паттерн not_indexed:', matchedNotIndexed);
            return 'not_indexed';
        }

        const matchedIndexed = indexedPatterns.find(pattern => bodyText.includes(pattern));
        if (matchedIndexed) {
            console.log('[GSC Bulk DEBUG] getIndexState: найден паттерн indexed:', matchedIndexed);
            return 'indexed';
        }

        console.log('[GSC Bulk DEBUG] getIndexState: не найдено ни одного паттерна');
        return null;
    }

    function findGoogleError() {
        const bodyText = getInspectionBodyText();
        if (!bodyText) {
            return null;
        }

        const quotaPatterns = [
            'мы не можем обработать этот запрос, так как вы превысили ежедневную квоту',
            'превысили ежедневную квоту',
            'превышена квота',
            'для вашего ресурса превышена ежедневная квота',
            'для вашего ресурса превышена ежедневная квота на количество проверок url',
            'ежедневная квота на количество проверок url',
            'ежедневную квоту',
            'exceeded your daily quota',
            'daily quota'
        ];

        const matchedQuota = quotaPatterns.find(pattern => bodyText.includes(pattern));
        if (matchedQuota) {
            return { type: 'quota', message: matchedQuota };
        }

        const errorPatterns = [
            'не удалось загрузить проверку',
            'не удалось выполнить проверку',
            'не удалось проверить url',
            'не удалось обработать запрос',
            'произошла ошибка при проверке',
            'произошла ошибка',
            'something went wrong',
            'failed to inspect',
            'failed to load inspection',
            'inspection failed',
            'request failed',
            'try again later'
        ];

        const matchedError = errorPatterns.find(pattern => bodyText.includes(pattern));
        if (matchedError) {
            return { type: 'error', message: matchedError };
        }

        return null;
    }

    async function waitForInspectionResult() {
        setStatus('Жду результат проверки URL...');

        try {
            let attempts = 0;
            return await waitFor(() => {
                attempts++;
                const indexState = getIndexState();
                if (indexState) {
                    console.log('[GSC Bulk] Найден статус индекса:', indexState);
                    return indexState;
                }

                const googleError = findGoogleError();
                if (googleError) {
                    console.log('[GSC Bulk] Найдена ошибка Google:', googleError);
                    return googleError;
                }

                // Логируем каждую 10-ю попытку для отладки
                if (attempts % 10 === 0) {
                    const bodyText = getInspectionBodyText();
                    console.log('[GSC Bulk] Попытка', attempts, '- видимый текст (первые 200 символов):', bodyText.substring(0, 200));
                }

                return false;
            }, WAIT_FOR_RESULT, 300);
        } catch (e) {
            const bodyText = getInspectionBodyText();
            console.log('[GSC Bulk] Timeout - видимый текст:', bodyText);
            return null;
        }
    }

    function findQuotaMessage() {
        const quotaPatterns = [
            'мы не можем обработать этот запрос, так как вы превысили ежедневную квоту',
            'превысили ежедневную квоту',
            'превышена квота',
            'для вашего ресурса превышена ежедневная квота',
            'для вашего ресурса превышена ежедневная квота на количество проверок url',
            'превышена ежедневная квота',
            'ежедневная квота на количество проверок url',
            'ежедневную квоту',
            'exceeded your daily quota',
            'daily quota'
        ];

        const bodyText = getInspectionBodyText();
        return quotaPatterns.find(pattern => bodyText.includes(pattern)) || null;
    }

    function pauseBecauseOfQuota(url, message) {
        state.quotaPaused = true;
        state.running = false;
        state.paused = true;
        state.stopped = true;
        state.resumeAfterNavigation = false;
        processing = false;

        const previous = state.results[url] || {};
        state.results[url] = {
            status: 'quota',
            indexState: previous.indexState || null,
            time: new Date().toISOString(),
            message
        };

        addLog(url, 'QUOTA', message);
        saveState();
        render();
        setStatus('Достигнута дневная квота Google. Очередь остановлена.');
    }

    function findRequestIndexingButton() {
        const ariaElements = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
        for (const el of ariaElements) {
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            if (aria.includes('запросить индексирование') || aria.includes('request indexing')) {
                return el;
            }
        }

        const elements = document.querySelectorAll('button, [role="button"]');
        for (const el of elements) {
            const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if ((text.includes('запросить индексирование') && text.length < 150) || (text.includes('request indexing') && text.length < 150)) {
                return el;
            }
        }

        return null;
    }

    function hasIndexingConfirmation() {
        const text = getInspectionBodyText();
        const patterns = [
            'url добавлен в приоритетную очередь сканирования',
            'url добавлен в очередь сканирования',
            'добавлен в очередь сканирования',
            'добавлен в приоритетную очередь сканирования',
            'отправлен запрос на индексирование',
            'запрос на индексирование отправлен',
            'индексирование запрошено',
            'url добавлен в приоритетную очередь индексирования',
            'в приоритетной очереди',
            'request submitted',
            'indexing requested',
            'request for indexing has been submitted',
            'queued for crawling',
            'queued for indexing',
            'submitted for indexing',
            'url has been added to the crawl queue'
        ];

        return patterns.some(pattern => text.includes(pattern));
    }

    async function waitForRequestResult() {
        setStatus('Жду результат запроса Google...');
        console.log('[GSC Bulk] waitForRequestResult: начало ожидания');

        try {
            let attempts = 0;
            return await waitFor(() => {
                attempts++;
                
                const quota = findQuotaMessage();
                if (quota) {
                    console.log('[GSC Bulk DEBUG] waitForRequestResult попытка', attempts, '- найдена квота');
                    return { type: 'quota', message: quota };
                }

                if (hasIndexingInProgress()) {
                    if (attempts % 10 === 0) {
                        console.log('[GSC Bulk DEBUG] waitForRequestResult попытка', attempts, '- индексирование в процессе');
                    }
                    return false;
                }

                const hasConfirm = hasIndexingConfirmation();
                const hasElement = findConfirmationElement();
                
                if (attempts % 10 === 0) {
                    console.log('[GSC Bulk DEBUG] waitForRequestResult попытка', attempts, '- hasIndexingConfirmation:', hasConfirm, '- findConfirmationElement:', !!hasElement);
                }
                
                if (hasConfirm || hasElement) {
                    console.log('[GSC Bulk DEBUG] waitForRequestResult - SUCCESS найдено подтверждение');
                    return { type: 'success', message: 'Запрос принят Google.' };
                }

                return false;
            }, WAIT_FOR_REQUEST_RESULT, 300);
        } catch (e) {
            console.log('[GSC Bulk] waitForRequestResult: timeout после', WAIT_FOR_REQUEST_RESULT, 'мс');
            const bodyText = getInspectionBodyText();
            console.log('[GSC Bulk] waitForRequestResult timeout - видимый текст (первые 500 символов):', bodyText.substring(0, 500));
            return null;
        }
    }

    function findConfirmationElement() {
        const successPatterns = [
            'приоритетную очередь',
            'очередь сканирования',
            'запрос на индексирование',
            'индексирование запрошено',
            'request submitted',
            'indexing requested',
            'queued for crawling',
            'queued for indexing',
            'submitted for indexing',
            'added to the crawl queue'
        ];

        const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alertdialog"]');
        for (const el of dialogs) {
            const text = (el.innerText || '').toLowerCase();
            if (successPatterns.some(pattern => text.includes(pattern))) {
                return el;
            }
        }

        const elements = document.querySelectorAll('div, span, p, button');
        for (const el of elements) {
            const text = (el.innerText || '').toLowerCase();
            if (text.length < 1200 && successPatterns.some(pattern => text.includes(pattern))) {
                return el;
            }
        }

        return null;
    }

    async function closeConfirmationPopup() {
        const popup = findConfirmationElement();
        if (!popup) {
            return true;
        }

        try {
            const candidates = popup.querySelectorAll('button, [role="button"], div[aria-label], a');
            for (const el of candidates) {
                try {
                    const text = (el.innerText || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
                    const title = (el.getAttribute('title') || '').trim().toLowerCase();

                    if (aria.includes('закрыть') || aria.includes('close') || title.includes('закрыть') || title.includes('close') || text === 'закрыть' || text === 'close') {
                        try {
                            // Просто кликаем на кнопку, не ожидая закрытия диалога
                            // Это позволяет Google самостоятельно обработать закрытие
                            el.click();
                            // Небольшая пауза, чтобы Google обработал клик
                            await sleep(300);
                            return true;
                        } catch (clickError) {
                            console.log('[GSC Bulk] closeConfirmationPopup: ошибка при клике на кнопку:', clickError.message);
                            // Продолжаем со следующей кнопки
                        }
                    }
                } catch (itemError) {
                    console.log('[GSC Bulk] closeConfirmationPopup: ошибка при обработке элемента:', itemError.message);
                    // Продолжаем
                }
            }
        } catch (e) {
            console.log('[GSC Bulk] closeConfirmationPopup: ошибка при получении элементов:', e.message);
        }

        // Fallback: пытаемся закрыть с помощью Escape
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            await sleep(300);
        } catch (e) {
            console.log('[GSC Bulk] closeConfirmationPopup: ошибка при отправке Escape:', e.message);
        }

        return true;
    }

    async function openInspectionForUrl(url) {
        setStatus('Открываю проверку URL...');

        const input = findInspectionInput();
        if (!input) {
            throw new Error('Поле проверки URL не найдено.');
        }

        setInputValue(input, url);
        await sleep(800);
        pressEnter(input);
        await sleep(2000);
        setStatus('Проверка URL запущена.');
    }

    async function inspectUrl(url) {
        await openInspectionForUrl(url);
        const result = await waitForInspectionResult();

        if (!result) {
            const googleError = findGoogleError();
            if (googleError) {
                if (googleError.type === 'quota') {
                    pauseBecauseOfQuota(url, googleError.message);
                    return { status: 'quota' };
                }
                throw new Error(googleError.message);
            }
            throw new Error('Не дождались результата проверки URL.');
        }

        if (typeof result === 'object') {
            if (result.type === 'quota') {
                pauseBecauseOfQuota(url, result.message);
                return { status: 'quota' };
            }
            throw new Error(result.message || 'Ошибка Google.');
        }

        const indexState = result;
        const bodyText = getInspectionBodyText();
        console.log('[GSC Bulk] Результат проверки URL:', url);
        console.log('[GSC Bulk] Статус индекса:', indexState);
        console.log('[GSC Bulk] === ПОЛНЫЙ ВИДИМЫЙ ТЕКСТ ===');
        console.log(bodyText);
        console.log('[GSC Bulk] === КОНЕЦ ===');

        if (indexState === 'indexed') {
            state.results[url] = {
                status: 'indexed',
                indexState,
                time: new Date().toISOString(),
                message: 'URL есть в индексе Google.'
            };
            addLog(url, 'INDEXED', 'URL есть в индексе Google.');
        } else {
            state.results[url] = {
                status: 'not_indexed',
                indexState,
                time: new Date().toISOString(),
                message: 'URL отсутствует в индексе Google.'
            };
            addLog(url, 'NOT_INDEXED', 'URL отсутствует в индексе Google.');
        }

        saveState();
        render();

        // Даем пользователю время увидеть результат перед переходом к следующему URL
        await sleep(2000);

        return { status: 'inspected', indexState };
    }

    async function sendUrl(url) {
        console.log('[GSC Bulk] sendUrl: начало для URL:', url);
        await openInspectionForUrl(url);
        setStatus('Ищу «Запросить индексирование»...');
        console.log('[GSC Bulk] sendUrl: ищу кнопку "Запросить индексирование"');

        let button;
        try {
            button = await waitFor(() => findRequestIndexingButton(), WAIT_FOR_BUTTON);
        } catch (e) {
            console.log('[GSC Bulk] sendUrl: не удалось найти кнопку за', WAIT_FOR_BUTTON, 'мс');
            const googleError = findGoogleError();
            if (googleError) {
                console.log('[GSC Bulk] sendUrl: обнаружена ошибка Google:', googleError);
                if (googleError.type === 'quota') {
                    pauseBecauseOfQuota(url, googleError.message);
                    return { status: 'quota' };
                }
                throw new Error(googleError.message);
            }
            throw new Error('Кнопка «Запросить индексирование» не найдена.');
        }

        if (!button) {
            console.log('[GSC Bulk] sendUrl: кнопка не найдена (button === null)');
            throw new Error('Кнопка «Запросить индексирование» не найдена.');
        }

        console.log('[GSC Bulk] sendUrl: кнопка найдена, нажимаю её');
        button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);

        setStatus('Отправляю запрос на переобход...');
        button.click();
        console.log('[GSC Bulk] sendUrl: кнопка нажата, жду результат');

        const requestResult = await waitForRequestResult();
        console.log('[GSC Bulk] sendUrl: результат запроса:', requestResult);
        
        if (!requestResult) {
            console.log('[GSC Bulk] sendUrl: результат пуст (null)');
            const googleError = findGoogleError();
            if (googleError && googleError.type === 'quota') {
                pauseBecauseOfQuota(url, googleError.message);
                return { status: 'quota' };
            }
            throw new Error('Google не показал результат отправки запроса.');
        }

        if (requestResult.type === 'quota') {
            console.log('[GSC Bulk] sendUrl: достигнута квота');
            pauseBecauseOfQuota(url, requestResult.message);
            return { status: 'quota' };
        }

        if (requestResult.type === 'success') {
            console.log('[GSC Bulk] sendUrl: успех! закрываю popup');
            setStatus('Запрос принят. Закрываю окно подтверждения...');
            
            try {
                await closeConfirmationPopup();
            } catch (popupError) {
                console.log('[GSC Bulk] sendUrl: ошибка при закрытии popup (игнорируем):', popupError.message);
            }
            
            await sleep(3000);

            const previous = state.results[url] || {};
            state.results[url] = {
                status: 'success',
                indexState: previous.indexState || null,
                time: new Date().toISOString(),
                message: 'URL добавлен в приоритетную очередь сканирования.'
            };

            addLog(url, 'SUCCESS', 'URL добавлен в приоритетную очередь сканирования.');
            saveState();
            render();
            console.log('[GSC Bulk] sendUrl: завершено успешно');
            return { status: 'success', waitAfter: randomDelay() };
        }

        console.log('[GSC Bulk] sendUrl: неизвестный результат:', requestResult);
        throw new Error('Неизвестный результат запроса Google.');
    }

    async function waitIfPaused() {
        while (state.paused && !state.stopped) {
            setStatus('Операция на паузе.');
            await sleep(500);
        }
    }

    async function waitAfterSending(ms) {
        const end = Date.now() + ms;
        const el = getElement('gsc-countdown');

        while (Date.now() < end && !state.stopped) {
            await waitIfPaused();
            if (state.stopped) {
                return false;
            }

            const remaining = Math.ceil((end - Date.now()) / 1000);
            const minutes = Math.floor(remaining / 60);
            const seconds = remaining % 60;

            if (el) {
                el.textContent = `Следующий запрос через ${minutes}:${String(seconds).padStart(2, '0')}`;
            }

            await sleep(500);
        }

        if (el) el.textContent = '';
        return !state.stopped;
    }

    function isSearchConsolePage() {
        try {
            return /^https:\/\/search\.google\.com\/search-console/i.test(window.location.href);
        } catch (e) {
            return false;
        }
    }

    function navigateToConsoleHome() {
        if (!resourceInfo || state.stopped || state.paused || state.quotaPaused) {
            state.resumeAfterNavigation = false;
            saveState();
            return;
        }

        if (!isSearchConsolePage()) {
            state.resumeAfterNavigation = false;
            saveState();
            return;
        }

        if (!state.running || !state.action || !Array.isArray(state.actionUrls) || state.currentIndex >= state.actionUrls.length) {
            state.resumeAfterNavigation = false;
            saveState();
            return;
        }

        state.resumeAfterNavigation = true;
        saveState();

        const url = 'https://search.google.com/search-console?resource_id=' + encodeURIComponent(resourceInfo.resourceId);
        window.location.href = url;
    }

    async function startInspection() {
        if (processing) {
            setStatus('Операция уже выполняется.');
            return;
        }

        const targets = state.urls.filter(url => {
            const result = state.results[url];
            return !(result && (result.status === 'indexed' || result.status === 'not_indexed'));
        });

        if (!targets.length) {
            setStatus('Все URL уже имеют результат инспекции.');
            return;
        }

        state.action = 'inspect';
        state.actionUrls = targets;
        state.currentIndex = 0;
        state.running = true;
        state.paused = false;
        state.stopped = false;
        state.quotaPaused = false;
        state.resumeAfterNavigation = false;
        saveState();

        processing = true;
        setStatus(`Начата инспекция: ${targets.length} URL.`);
        await processInspectionQueue();
    }

    async function processInspectionQueue() {
        while (state.currentIndex < state.actionUrls.length) {
            if (state.stopped) {
                break;
            }

            await waitIfPaused();
            if (state.stopped) {
                break;
            }

            const url = state.actionUrls[state.currentIndex];
            renderCurrent();

            try {
                const result = await inspectUrl(url);
                if (result.status === 'quota') {
                    processing = false;
                    return;
                }
            } catch (e) {
                state.results[url] = {
                    status: 'error',
                    indexState: null,
                    time: new Date().toISOString(),
                    message: e.message
                };
                addLog(url, 'ERROR', e.message);
                saveState();
            }

            state.currentIndex++;
            saveState();
            render();

            if (state.stopped || state.paused || state.quotaPaused) {
                processing = false;
                state.running = false;
                state.resumeAfterNavigation = false;
                saveState();
                return;
            }

            if (state.currentIndex < state.actionUrls.length) {
                navigateToConsoleHome();
                return;
            }
        }

        processing = false;
        state.running = false;
        state.resumeAfterNavigation = false;
        saveState();
        setStatus(state.stopped ? 'Инспекция остановлена.' : 'Инспекция списка завершена.');
        render();
    }

    async function startSendNotIndexed() {
        if (processing) {
            setStatus('Операция уже выполняется.');
            return;
        }

        const targets = state.urls.filter(url => state.results[url] && state.results[url].indexState === 'not_indexed');
        if (!targets.length) {
            setStatus('Нет URL со статусом NOT_INDEXED.');
            return;
        }

        await startSendQueue(targets, 'send_not_indexed');
    }

    async function startSendAll() {
        if (processing) {
            setStatus('Операция уже выполняется.');
            return;
        }

        if (!state.urls.length) {
            setStatus('Список URL пуст.');
            return;
        }

        await startSendQueue([...state.urls], 'send_all');
    }

    async function startSendQueue(targets, action) {
        state.action = action;
        state.actionUrls = targets;
        state.currentIndex = 0;
        state.running = true;
        state.paused = false;
        state.stopped = false;
        state.quotaPaused = false;
        state.resumeAfterNavigation = false;
        saveState();

        processing = true;
        setStatus(`Начата отправка: ${targets.length} URL.`);
        await processSendQueue();
    }

    async function processSendQueue() {
        while (state.currentIndex < state.actionUrls.length) {
            if (state.stopped) {
                break;
            }

            await waitIfPaused();
            if (state.stopped) {
                break;
            }

            const url = state.actionUrls[state.currentIndex];
            renderCurrent();

            try {
                const result = await sendUrl(url);
                if (result.status === 'quota') {
                    processing = false;
                    return;
                }

                if (result.waitAfter && state.currentIndex + 1 < state.actionUrls.length) {
                    const ok = await waitAfterSending(result.waitAfter);
                    if (!ok) {
                        break;
                    }
                }
            } catch (e) {
                console.log('[GSC Bulk] processSendQueue: ошибка при отправке URL:', url);
                console.log('[GSC Bulk] processSendQueue: сообщение об ошибке:', e.message);
                console.log('[GSC Bulk] processSendQueue: stack:', e.stack);
                
                const previous = state.results[url] || {};
                state.results[url] = {
                    status: 'error',
                    indexState: previous.indexState || null,
                    time: new Date().toISOString(),
                    message: e.message
                };
                addLog(url, 'ERROR', e.message);
                saveState();
            }

            state.currentIndex++;
            saveState();
            render();

            if (state.stopped || state.paused || state.quotaPaused) {
                processing = false;
                state.running = false;
                state.resumeAfterNavigation = false;
                saveState();
                return;
            }

            if (state.currentIndex < state.actionUrls.length) {
                navigateToConsoleHome();
                return;
            }
        }

        processing = false;
        state.running = false;
        state.resumeAfterNavigation = false;
        saveState();
        setStatus(state.stopped ? 'Отправка остановлена.' : 'Отправка списка завершена.');
        render();
    }

    function pauseQueue() {
        if (state.paused) {
            state.quotaPaused = false;
            state.paused = false;
            state.stopped = false;
            saveState();
            render();
            setStatus('Операция продолжена.');

            if (!processing && state.action && Array.isArray(state.actionUrls) && state.currentIndex < state.actionUrls.length) {
                processing = true;
                state.running = true;
                if (state.action === 'inspect') {
                    processInspectionQueue();
                } else {
                    processSendQueue();
                }
            }
            return;
        }

        if (!state.running && !processing) {
            setStatus('Операция сейчас не выполняется.');
            return;
        }

        state.paused = true;
        saveState();
        render();
        setStatus('Операция поставлена на паузу.');
    }

    function stopQueue() {
        state.stopped = true;
        state.running = false;
        state.paused = false;
        state.resumeAfterNavigation = false;
        processing = false;
        saveState();
        render();
        setStatus('Операция остановлена. Прогресс сохранён.');
    }

    function resumeAfterNavigation() {
        if (state.quotaPaused) {
            state.resumeAfterNavigation = false;
            saveState();
            render();
            setStatus('Очередь остановлена из-за дневной квоты Google.');
            return;
        }

        if (state.stopped || state.paused) {
            state.resumeAfterNavigation = false;
            saveState();
            return;
        }

        if (!isSearchConsolePage()) {
            return;
        }

        if (!state.resumeAfterNavigation) {
            return;
        }

        if (!state.action || !Array.isArray(state.actionUrls) || !state.actionUrls.length || state.currentIndex >= state.actionUrls.length) {
            state.resumeAfterNavigation = false;
            saveState();
            return;
        }

        state.resumeAfterNavigation = false;
        state.running = true;
        state.stopped = false;
        saveState();

        setTimeout(() => {
            if (processing || state.paused || state.quotaPaused || state.stopped) {
                return;
            }
            processing = true;
            if (state.action === 'inspect') {
                processInspectionQueue();
            } else {
                processSendQueue();
            }
        }, 1000);
    }

    function togglePanelCollapse() {
        state.panelCollapsed = !state.panelCollapsed;
        saveState();
        render();
    }

    function createPanel() {
        if (getElement('gsc-panel')) {
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'gsc-panel';
        panel.innerHTML = `
            <div class="gsc-header">
                <span class="gsc-header-title">Google Search Console — Bulk Inspector & Indexing</span>
                <button id="gsc-collapse" class="gsc-collapse-btn">−</button>
            </div>
            <div class="gsc-content">
                <div class="gsc-resource">
                    <b>Ресурс:</b>
                    <span id="gsc-resource">${escapeHtml(getResourceLabel())}</span>
                </div>
                <div class="gsc-label">URL — один адрес на строку:</div>
                <textarea id="gsc-url-input" spellcheck="false" placeholder="https://example.com/page-1/\nhttps://example.com/page-2/\nhttps://example.com/page-3/"></textarea>
                <div class="gsc-buttons">
                    <button id="gsc-add">Добавить ссылки</button>
                    <button id="gsc-inspect">Проверить список</button>
                </div>
                <div class="gsc-buttons">
                    <button id="gsc-send-not-indexed">Отправить только неиндексированные</button>
                    <button id="gsc-send-all">Отправить весь список без проверки</button>
                </div>
                <div class="gsc-buttons">
                    <button id="gsc-pause">Пауза</button>
                    <button id="gsc-stop">Стоп</button>
                    <button id="gsc-clear">Очистить</button>
                </div>
                <div class="gsc-buttons">
                    <button id="gsc-save-project">Сохранить проект</button>
                    <button id="gsc-load-project">Загрузить проект</button>
                    <button id="gsc-export">Экспорт результатов</button>
                </div>
                <div class="gsc-stat">
                    <div><b>Всего</b><span id="gsc-total">0</span></div>
                    <div class="gsc-indexed-box"><b>В индексе</b><span id="gsc-indexed">0</span></div>
                    <div><b>Не в индексе</b><span id="gsc-not-indexed">0</span></div>
                    <div><b>Отправлено</b><span id="gsc-sent">0</span></div>
                    <div><b>Пропущено</b><span id="gsc-skipped">0</span></div>
                    <div><b>Ошибок</b><span id="gsc-errors">0</span></div>
                </div>
                <div class="gsc-current">
                    <b>Текущий URL:</b>
                    <div id="gsc-current-url">—</div>
                </div>
                <div class="gsc-status">
                    <b>Статус:</b>
                    <span id="gsc-status">Готов</span>
                </div>
                <div id="gsc-countdown" class="gsc-countdown"></div>
                <div class="gsc-label">Журнал:</div>
                <div id="gsc-log"></div>
            </div>
        `;

        document.body.appendChild(panel);

        getElement('gsc-add').addEventListener('click', addUrlsFromTextarea);
        getElement('gsc-inspect').addEventListener('click', startInspection);
        getElement('gsc-send-not-indexed').addEventListener('click', startSendNotIndexed);
        getElement('gsc-send-all').addEventListener('click', startSendAll);
        getElement('gsc-pause').addEventListener('click', pauseQueue);
        getElement('gsc-stop').addEventListener('click', stopQueue);
        getElement('gsc-clear').addEventListener('click', clearProject);
        getElement('gsc-save-project').addEventListener('click', saveProject);
        getElement('gsc-load-project').addEventListener('click', loadProject);
        getElement('gsc-export').addEventListener('click', exportResults);
        getElement('gsc-collapse').addEventListener('click', togglePanelCollapse);

        render();
    }

    GM_addStyle(`
        #gsc-panel {
            position: fixed;
            right: 18px;
            bottom: 18px;
            width: 720px;
            max-height: 92vh;
            z-index: 2147483647;
            background: #ffffff;
            color: #222222;
            border: 2px solid #555555;
            border-radius: 8px;
            box-shadow: 0 8px 35px rgba(0,0,0,.35);
            font-family: Arial, sans-serif;
            font-size: 13px;
            overflow: hidden;
        }

        #gsc-panel .gsc-header {
            padding: 13px 15px;
            background: #eeeeee;
            border-bottom: 1px solid #cccccc;
            font-size: 16px;
            font-weight: bold;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        #gsc-panel .gsc-header-title {
            flex: 1;
        }

        .gsc-collapse-btn {
            width: 28px;
            height: 28px;
            padding: 0;
            border: 1px solid #999999;
            border-radius: 4px;
            background: #f5f5f5;
            cursor: pointer;
            font-size: 18px;
            font-weight: bold;
            line-height: 1;
            margin-left: 10px;
        }

        .gsc-collapse-btn:hover {
            background: #e5e5e5;
        }

        #gsc-panel.collapsed .gsc-content {
            display: none;
        }

        #gsc-panel.collapsed {
            width: auto;
            min-width: 300px;
        }

        #gsc-panel .gsc-content { padding: 13px; }
        .gsc-resource {
            padding: 9px;
            margin-bottom: 10px;
            background: #f7f7f7;
            border: 1px solid #dddddd;
            border-radius: 4px;
            word-break: break-all;
        }
        .gsc-label { font-weight: bold; margin: 5px 0 7px; }
        #gsc-url-input {
            width: 100%;
            height: 150px;
            box-sizing: border-box;
            resize: vertical;
            padding: 9px;
            border: 1px solid #aaaaaa;
            border-radius: 4px;
            font-family: Consolas, monospace;
            font-size: 12px;
            line-height: 1.45;
            margin-bottom: 10px;
        }
        .gsc-buttons { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 9px; }
        .gsc-buttons button {
            padding: 8px 12px;
            border: 1px solid #999999;
            border-radius: 4px;
            background: #f5f5f5;
            cursor: pointer;
            font-size: 13px;
        }
        .gsc-buttons button:hover { background: #e5e5e5; }
        .gsc-buttons button:disabled { opacity: .45; cursor: default; }
        .gsc-stat {
            display: grid;
            grid-template-columns: repeat(6, 1fr);
            gap: 5px;
            margin-bottom: 8px;
        }
        .gsc-stat > div {
            padding: 8px 5px;
            text-align: center;
            background: #f5f5f5;
            border: 1px solid #dddddd;
            border-radius: 4px;
        }
        .gsc-stat span {
            display: block;
            font-size: 16px;
            margin-top: 3px;
        }
        .gsc-indexed-box {
            background: #e8f5e9 !important;
            border-color: #a5d6a7 !important;
            color: #1b5e20;
        }
        .gsc-current {
            padding: 9px;
            background: #f7f7f7;
            border: 1px solid #dddddd;
            border-radius: 4px;
            margin-bottom: 9px;
        }
        #gsc-current-url {
            margin-top: 5px;
            word-break: break-all;
            font-family: Consolas, monospace;
            font-size: 11px;
        }
        .gsc-status {
            padding: 9px;
            background: #eef5ff;
            border: 1px solid #ccdfff;
            border-radius: 4px;
            margin-bottom: 7px;
        }
        .gsc-countdown {
            min-height: 18px;
            margin-bottom: 8px;
            text-align: center;
            font-weight: bold;
        }
        #gsc-log {
            height: 250px;
            overflow-y: auto;
            border: 1px solid #dddddd;
            background: #fafafa;
            font-family: Consolas, monospace;
            font-size: 10px;
        }
        .gsc-log-info, .gsc-log-success, .gsc-log-skipped, .gsc-log-error, .gsc-log-quota, .gsc-log-indexed, .gsc-log-not-indexed {
            padding: 5px 6px;
            border-bottom: 1px solid #eeeeee;
            word-break: break-word;
        }
        .gsc-log-indexed { background: #e8f5e9; border-left: 4px solid #2e7d32; }
        .gsc-log-not-indexed { background: #fff8e1; border-left: 4px solid #f9a825; }
        .gsc-log-success { background: #edf8ed; border-left: 4px solid #43a047; }
        .gsc-log-skipped { background: #eef5ff; border-left: 4px solid #1976d2; }
        .gsc-log-error { background: #fff0f0; border-left: 4px solid #d32f2f; }
        .gsc-log-quota { background: #ffe5e5; border-left: 4px solid #b71c1c; font-weight: bold; }
        .gsc-time { display: inline-block; width: 65px; }
        .gsc-log-status { display: inline-block; width: 95px; font-weight: bold; }
        .gsc-log-url { display: inline; }
        .gsc-log-message { display: block; margin-top: 3px; opacity: .8; }
    `);

    function init() {
        if (!document.body) {
            setTimeout(init, 500);
            return;
        }

        resourceInfo = detectResource();
        if (!resourceInfo) {
            console.warn('[GSC Bulk] resource_id не найден.');
            return;
        }

        loadState();

        if (state.resourceId && state.resourceId !== resourceInfo.resourceId) {
            state = createInitialState(resourceInfo.resourceId);
        }

        state.resourceId = resourceInfo.resourceId;
        saveState();

        createPanel();
        render();
        resumeAfterNavigation();
        console.log('[GSC Bulk] Initialized:', resourceInfo);
    }

    init();
})();

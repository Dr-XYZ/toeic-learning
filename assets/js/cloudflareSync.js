// Cloudflare KV Cloud-First Auto-Sync Manager
import { DB } from './db.js';
import { t } from './i18n.js';
import { logError, toErrorMessage } from './errorPolicy.js';

let _callbacks = { renderHistory: null, loadLastSession: null, renderVocabTab: null };
let _debounceTimer = null;
let _isSyncing = false;

export const DEFAULT_WORKER_URL = 'https://toeic-tutor-storage.an-xyz-tw.workers.dev';

export const CloudflareSync = {
    setCallbacks(cbs) {
        _callbacks = { ..._callbacks, ...cbs };
    },

    async getConfig() {
        const savedUrl = await DB.getSetting('cf_worker_url');
        const url = (savedUrl != null && savedUrl !== '') ? savedUrl : DEFAULT_WORKER_URL;
        const token = (await DB.getSetting('cf_auth_token')) || '';
        return { url: url.trim().replace(/\/+$/, ''), token: token.trim() };
    },

    async setConfig(url, token) {
        await DB.setSetting('cf_worker_url', (url || '').trim());
        await DB.setSetting('cf_auth_token', (token || '').trim());
        await this.updateUI();
    },

    isConfigured(cfg) {
        return !!(cfg && cfg.url && cfg.token);
    },

    async getHeaders(cfg) {
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.token) {
            headers['Authorization'] = `Bearer ${cfg.token}`;
        }
        return headers;
    },

    // Runs automatically on app boot
    async initCloudSync() {
        const cfg = await this.getConfig();
        this.updateUI();
        if (!this.isConfigured(cfg)) return false;

        this.setSyncStatus('syncing', t('cloudSyncPulling'));
        try {
            const resp = await fetch(`${cfg.url}/api/data`, {
                headers: await this.getHeaders(cfg),
            });

            if (!resp.ok) {
                const errJson = await resp.json().catch(() => ({}));
                throw new Error(errJson.error || `HTTP ${resp.status}`);
            }

            const data = await resp.json();
            if (data && (Array.isArray(data.history) || Array.isArray(data.savedWords))) {
                await this.applyRemoteData(data);
                const syncTime = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : new Date().toLocaleString();
                await DB.setSetting('cf_last_sync_time', syncTime);
                this.setSyncStatus('synced', t('cloudSyncSyncedAt', { time: syncTime }));
                return true;
            }
            this.setSyncStatus('synced', t('cloudSyncReady'));
            return true;
        } catch (e) {
            logError('Cloudflare init sync failed', e);
            this.setSyncStatus('error', t('cloudSyncFailed', { message: toErrorMessage(e) }));
            return false;
        }
    },

    // Apply remote cloud data into local IndexedDB
    async applyRemoteData(data) {
        if (Array.isArray(data.history)) {
            await DB.clearHistory();
            for (const item of data.history) {
                if (item && item.id !== undefined) {
                    await DB.addHistory(item);
                }
            }
        }
        if (Array.isArray(data.savedWords)) {
            const existing = await DB.getSavedWords();
            for (const w of existing) {
                await DB.deleteSavedWord(w.id);
            }
            for (const w of data.savedWords) {
                if (w && w.id !== undefined) {
                    await DB.addSavedWord(w);
                }
            }
        }

        if (_callbacks.renderHistory) _callbacks.renderHistory();
        if (_callbacks.loadLastSession) await _callbacks.loadLastSession();
        if (_callbacks.renderVocabTab) _callbacks.renderVocabTab();
    },

    // Triggered automatically whenever local data changes (debounce 1.5s)
    autoSync() {
        if (_debounceTimer) clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
            this.pushToCloud();
        }, 1500);
    },

    // Push local state to Cloudflare KV
    async pushToCloud() {
        const cfg = await this.getConfig();
        if (!this.isConfigured(cfg) || _isSyncing) return;

        _isSyncing = true;
        this.setSyncStatus('syncing', t('cloudSyncPushing'));

        try {
            const [history, savedWords] = await Promise.all([
                DB.getHistory(),
                DB.getSavedWords(),
            ]);

            const lightHistory = history.map((h) => ({ ...h, audio: null }));
            const payload = {
                version: 1,
                exportedAt: Date.now(),
                history: lightHistory,
                savedWords,
            };

            const resp = await fetch(`${cfg.url}/api/data`, {
                method: 'POST',
                headers: await this.getHeaders(cfg),
                body: JSON.stringify(payload),
            });

            if (!resp.ok) {
                const errJson = await resp.json().catch(() => ({}));
                throw new Error(errJson.error || `HTTP ${resp.status}`);
            }

            const resData = await resp.json();
            const syncTime = new Date(resData.updatedAt || Date.now()).toLocaleString();
            await DB.setSetting('cf_last_sync_time', syncTime);
            this.setSyncStatus('synced', t('cloudSyncSyncedAt', { time: syncTime }));
        } catch (e) {
            logError('Cloudflare push sync failed', e);
            this.setSyncStatus('error', t('cloudSyncFailed', { message: toErrorMessage(e) }));
        } finally {
            _isSyncing = false;
        }
    },

    // Manual Backup button handler
    async manualBackup() {
        const cfg = await this.getConfig();
        if (!this.isConfigured(cfg)) {
            alert(t('cloudSyncUnconfiguredAlert'));
            return;
        }
        await this.pushToCloud();
    },

    // Manual Restore button handler
    async manualRestore() {
        const cfg = await this.getConfig();
        if (!this.isConfigured(cfg)) {
            alert(t('cloudSyncUnconfiguredAlert'));
            return;
        }
        const ok = await this.initCloudSync();
        if (ok) {
            alert(t('cloudSyncRestoreSuccessAlert'));
        }
    },

    setSyncStatus(state, message) {
        const statusEl = document.getElementById('cfSyncStatusText');
        const badgeEl = document.getElementById('cfSyncBadge');

        if (statusEl) statusEl.textContent = message || '';

        if (badgeEl) {
            badgeEl.className = `cf-sync-badge sync-state-${state}`;
            badgeEl.textContent =
                state === 'syncing' ? t('cloudSyncBadgeSyncing') :
                state === 'synced' ? t('cloudSyncBadgeSynced') :
                state === 'error' ? t('cloudSyncBadgeError') : '';
            badgeEl.title = message || '';
        }
    },

    async updateUI() {
        const cfg = await this.getConfig();
        const urlInput = document.getElementById('cfWorkerUrlInput');
        const tokenInput = document.getElementById('cfAuthTokenInput');
        const lastSyncEl = document.getElementById('cfLastSyncTime');

        if (urlInput && urlInput.value !== cfg.url) urlInput.value = cfg.url;
        if (tokenInput && tokenInput.value !== cfg.token) tokenInput.value = cfg.token;

        const lastSync = await DB.getSetting('cf_last_sync_time');
        if (lastSyncEl) {
            lastSyncEl.textContent = lastSync
                ? t('cloudLastSync', { value: lastSync })
                : t('cloudNotSynced');
        }

        if (this.isConfigured(cfg)) {
            if (lastSync) {
                this.setSyncStatus('synced', t('cloudSyncSyncedAt', { time: lastSync }));
            } else {
                this.setSyncStatus('synced', t('cloudSyncReady'));
            }
        } else {
            this.setSyncStatus('unconfigured', t('cloudSyncUnconfigured'));
        }
    },
};

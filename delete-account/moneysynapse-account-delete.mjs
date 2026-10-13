import {
  DeletionFlowError,
  runDeletionAction,
} from './moneysynapse-delete-core.mjs';
import { createClient } from './supabase-js-2.117.2.bundle.mjs';

const EXPECTED_ORIGIN = 'https://eyhdjwharvkrdzamzlql.supabase.co';
const CONFIG = globalThis.MONEY_SYNAPSE_DELETE_CONFIG;
const $ = (id) => document.getElementById(id);
const text = new TextEncoder();
const decoder = new TextDecoder();

function fail(code) {
  throw new DeletionFlowError(code);
}

function readConfig() {
  if (!CONFIG || CONFIG.enabled !== true ||
      typeof CONFIG.deletionEnabled !== 'boolean' ||
      typeof CONFIG.supabaseUrl !== 'string' ||
      typeof CONFIG.publishableKey !== 'string' ||
      CONFIG.publishableKey.length < 20) {
    fail('WEB_DELETION_NOT_CONFIGURED');
  }
  const origin = new URL(CONFIG.supabaseUrl).origin;
  if (origin !== EXPECTED_ORIGIN || CONFIG.supabaseUrl !== origin) {
    fail('PRODUCTION_PROJECT_MISMATCH');
  }
  return { ...CONFIG, supabaseUrl: origin };
}

function openProofDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('moneysynapse-account-deletion-v2', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('keys');
      request.result.createObjectStore('proofs');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

class EncryptedBrowserProofStore {
  async key(db) {
    let transaction = db.transaction('keys', 'readonly');
    let key = await requestValue(transaction.objectStore('keys').get('v1'));
    await transactionDone(transaction);
    if (key) return key;
    key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    transaction = db.transaction('keys', 'readwrite');
    transaction.objectStore('keys').put(key, 'v1');
    await transactionDone(transaction);
    return key;
  }

  async read() {
    const db = await openProofDb();
    try {
      const transaction = db.transaction('proofs', 'readonly');
      const envelope = await requestValue(
        transaction.objectStore('proofs').get('current'),
      );
      await transactionDone(transaction);
      if (!envelope) return null;
      const key = await this.key(db);
      const clear = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: envelope.iv },
        key,
        envelope.ciphertext,
      );
      return JSON.parse(decoder.decode(clear));
    } catch (_) {
      throw new DeletionFlowError('WITHDRAWAL_PROOF_CORRUPT');
    } finally {
      db.close();
    }
  }

  async write(proof) {
    const db = await openProofDb();
    try {
      const key = await this.key(db);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        text.encode(JSON.stringify(proof)),
      );
      const transaction = db.transaction('proofs', 'readwrite');
      transaction.objectStore('proofs').put({ iv, ciphertext }, 'current');
      await transactionDone(transaction);
    } finally {
      db.close();
    }
  }

  async remove(expected) {
    const current = await this.read();
    if (!current || current.userId !== expected.userId ||
        current.requestId !== expected.requestId ||
        current.token !== expected.token) {
      throw new DeletionFlowError('WITHDRAWAL_PROOF_CONFLICT');
    }
    const db = await openProofDb();
    try {
      const transaction = db.transaction('proofs', 'readwrite');
      transaction.objectStore('proofs').delete('current');
      await transactionDone(transaction);
    } finally {
      db.close();
    }
  }
}

class BrowserGateway {
  constructor(client, config) {
    this.client = client;
    this.config = config;
  }

  async currentUser() {
    const { data: sessionData } = await this.client.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) return null;
    let issuedAt = 0;
    try {
      const part = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
      const padded = part.padEnd(Math.ceil(part.length / 4) * 4, '=');
      issuedAt = Number(JSON.parse(atob(padded)).iat || 0);
    } catch (_) {
      return null;
    }
    // This page is a destructive surface. A remembered browser session alone
    // is insufficient: require a token minted by a fresh password/OAuth flow.
    if (issuedAt <= 0 || Math.floor(Date.now() / 1000) - issuedAt > 10 * 60) {
      return null;
    }
    const { data, error } = await this.client.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id };
  }

  async prepareReceipt(requestId, tokenHash) {
    const { data, error } = await this.client.rpc('prepare_withdrawal_receipt', {
      p_request_id: requestId,
      p_token_hash: tokenHash,
    });
    if (error) throw new DeletionFlowError('WITHDRAWAL_RECEIPT_PREPARE_FAILED');
    return data;
  }

  async post(body, authenticated) {
    const headers = {
      apikey: this.config.publishableKey,
      'Content-Type': 'application/json',
    };
    if (authenticated) {
      const { data } = await this.client.auth.getSession();
      if (!data.session?.access_token) throw new DeletionFlowError('AUTH_REQUIRED');
      headers.Authorization = `Bearer ${data.session.access_token}`;
    }
    let response;
    try {
      response = await fetch(`${this.config.supabaseUrl}/functions/v1/delete-account`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (_) {
      throw new DeletionFlowError('NETWORK_ERROR', { uncertain: true });
    }
    let payload = {};
    try { payload = await response.json(); } catch (_) { /* fail below */ }
    if (!response.ok) {
      return { ...payload, status: response.status };
    }
    return payload;
  }

  async deleteAuthenticated() {
    const result = await this.post({}, true);
    if (result.error) {
      throw new DeletionFlowError(result.error, { status: result.status });
    }
    return result;
  }

  resume(requestId, token) {
    return this.post({ action: 'resume_cleanup', request_id: requestId, token }, false);
  }
}

function status(message, kind = '') {
  const target = $('ms-delete-status');
  target.textContent = message;
  target.dataset.kind = kind;
}

function userMessage(error) {
  const code = error instanceof DeletionFlowError ? error.code : 'UNKNOWN';
  const messages = {
    WEB_DELETION_NOT_CONFIGURED: '웹 탈퇴 기능은 아직 운영 설정 전입니다.',
    PRODUCTION_PROJECT_MISMATCH: '안전하지 않은 연결 대상이 감지되어 중단했습니다.',
    AUTH_REQUIRED: '먼저 기존 MoneySynapse 계정으로 로그인해 주세요.',
    WITHDRAWAL_PROOF_ACCOUNT_CONFLICT: '다른 계정의 진행 중 탈퇴가 이 브라우저에 남아 있어 중단했습니다. 고객지원 확인이 필요합니다.',
    WITHDRAWAL_PROOF_CORRUPT: '보호된 탈퇴 확인 정보를 읽지 못했습니다. 브라우저 데이터를 지우지 말고 고객지원에 문의해 주세요.',
    WITHDRAWAL_PROOF_WRITE_FAILED: '탈퇴 확인 정보를 안전하게 저장하지 못해 서버 요청을 보내지 않았습니다.',
    ACCOUNT_DELETION_DISABLED: '현재 안전 점검 중이라 탈퇴 처리가 잠시 중단되어 있습니다.',
    SHARED_REFERENCE_PRESENT: '다른 계정과 공유된 파일이 확인되어 자동 삭제를 중단했습니다. 고객지원 확인이 필요합니다.',
    NETWORK_ERROR: '처리 상태를 확정하지 못했습니다. 새 요청은 만들지 않았습니다. 같은 브라우저에서 다시 확인해 주세요.',
  };
  return messages[code] || `요청을 완료하지 못했습니다. 고객지원에 오류 코드 ${code}를 알려주세요.`;
}

async function main() {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    status(userMessage(error), 'error');
    document.querySelectorAll('#ms-delete-panel button, #ms-delete-panel input')
      .forEach((element) => { element.disabled = true; });
    return;
  }
  const client = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  const gateway = new BrowserGateway(client, config);
  const store = new EncryptedBrowserProofStore();

  async function refresh() {
    const user = await gateway.currentUser();
    $('ms-delete-authenticated').hidden = !user;
    $('ms-delete-login').hidden = Boolean(user);
    if (user) {
      status('최근 계정 인증이 확인되었습니다. 삭제 대상을 별도로 입력할 수 없으며 현재 로그인 계정만 처리됩니다.');
    } else {
      status('삭제 전 기존 로그인 수단으로 다시 본인 확인해 주세요.');
    }
  }

  $('ms-delete-password-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    status('로그인 정보를 확인하고 있습니다.');
    const form = new FormData(event.currentTarget);
    const { error } = await client.auth.signInWithPassword({
      email: String(form.get('email') || ''),
      password: String(form.get('password') || ''),
    });
    event.currentTarget.reset();
    if (error) status('기존 계정 인증에 실패했습니다.', 'error');
    else await refresh();
  });

  document.querySelectorAll('[data-ms-provider]').forEach((button) => {
    button.addEventListener('click', async () => {
      const provider = button.dataset.msProvider;
      status('기존 로그인 제공자로 이동합니다.');
      const { error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: config.redirectUrl },
      });
      if (error) status('로그인 제공자 연결에 실패했습니다.', 'error');
    });
  });

  $('ms-delete-signout').addEventListener('click', async () => {
    await client.auth.signOut();
    await refresh();
  });

  $('ms-delete-confirm').addEventListener('input', () => {
    $('ms-delete-submit').disabled =
      !config.deletionEnabled ||
      $('ms-delete-confirm').value.trim() !== '계정 삭제' ||
      !$('ms-delete-subscription').checked;
  });
  $('ms-delete-subscription').addEventListener('change', () =>
    $('ms-delete-confirm').dispatchEvent(new Event('input')));

  $('ms-delete-submit').addEventListener('click', async () => {
    if (!config.deletionEnabled) {
      status('현재 안전 점검 중이라 탈퇴 처리가 잠시 중단되어 있습니다.', 'error');
      return;
    }
    const button = $('ms-delete-submit');
    button.disabled = true;
    status('법정보존 분리와 파일 정리를 안전하게 처리하고 있습니다. 창을 닫지 마세요.');
    try {
      const result = await runDeletionAction({ gateway, store, cryptoProvider: crypto });
      if (result.state === 'pending') {
        status('파일 정리가 일부 완료되었습니다. 같은 브라우저에서 아래 버튼을 다시 눌러 이어서 처리해 주세요.', 'pending');
        button.textContent = '같은 요청 이어서 처리';
        button.disabled = false;
      } else {
        status('계정 삭제가 완료되었습니다. 법령상 보관 대상은 분리 보관 후 기간 만료 시 파기됩니다.', 'success');
        $('ms-delete-controls').hidden = true;
        await client.auth.signOut();
      }
    } catch (error) {
      status(userMessage(error), 'error');
      button.disabled = false;
    }
  });

  await refresh();
  if (!config.deletionEnabled) {
    $('ms-delete-submit').disabled = true;
    status('본인 확인 경로는 준비됐지만 탈퇴 처리는 현재 안전 점검 중입니다. 서버 요청은 전송되지 않습니다.');
  }
}

main();

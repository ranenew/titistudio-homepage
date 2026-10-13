const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY = /^[0-9a-f]{64}$/;

export class DeletionFlowError extends Error {
  constructor(code, { status = null, uncertain = false } = {}) {
    super(code);
    this.name = 'DeletionFlowError';
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
  }
}

export function assertProof(value) {
  if (!value || value.schemaVersion !== 1 ||
      typeof value.userId !== 'string' || !UUID_V4.test(value.requestId) ||
      !CAPABILITY.test(value.token)) {
    throw new DeletionFlowError('WITHDRAWAL_PROOF_CORRUPT');
  }
  return value;
}

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createProof(userId, cryptoProvider = globalThis.crypto) {
  if (!userId || !cryptoProvider?.randomUUID || !cryptoProvider?.getRandomValues) {
    throw new DeletionFlowError('WITHDRAWAL_PROOF_CREATE_FAILED');
  }
  const token = new Uint8Array(32);
  cryptoProvider.getRandomValues(token);
  return assertProof({
    schemaVersion: 1,
    userId,
    requestId: cryptoProvider.randomUUID(),
    token: hex(token),
  });
}

export async function capabilityDigest(token, cryptoProvider = globalThis.crypto) {
  if (!CAPABILITY.test(token) || !cryptoProvider?.subtle) {
    throw new DeletionFlowError('WITHDRAWAL_PROOF_CORRUPT');
  }
  const bytes = Uint8Array.from(token.match(/.{2}/g), (pair) =>
    Number.parseInt(pair, 16));
  return hex(new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', bytes)));
}

function completed(body) {
  return body?.success === true && body.account_deleted === true &&
    body.cleanup_pending === false;
}

function pending(body) {
  return body?.success === true && body.account_deleted === false &&
    body.cleanup_pending === true;
}

async function verifySaved(store, expected) {
  await store.write(expected);
  const actual = assertProof(await store.read());
  if (actual.userId !== expected.userId ||
      actual.requestId !== expected.requestId || actual.token !== expected.token) {
    throw new DeletionFlowError('WITHDRAWAL_PROOF_WRITE_FAILED');
  }
}

async function terminalCheck(gateway, store, proof) {
  const result = await gateway.resume(proof.requestId, proof.token);
  if (completed(result)) {
    await store.remove(proof);
    return { state: 'completed', requestId: proof.requestId };
  }
  if (result?.error === 'CLEANUP_NOT_READY') {
    return { state: 'pending', requestId: proof.requestId };
  }
  throw new DeletionFlowError(result?.error || 'UNKNOWN', {
    status: result?.status ?? null,
    uncertain: result?.error === 'NETWORK_ERROR',
  });
}

// One explicit user action performs at most one authenticated delete call and,
// only if that response is lost, one capability-only terminal check. There is
// no timer, retry loop or target user id parameter.
export async function runDeletionAction({ gateway, store, cryptoProvider }) {
  let proof = await store.read();
  if (proof != null) proof = assertProof(proof);

  const user = await gateway.currentUser();
  if (!user) {
    if (!proof) throw new DeletionFlowError('AUTH_REQUIRED');
    return terminalCheck(gateway, store, proof);
  }

  if (proof && proof.userId !== user.id) {
    throw new DeletionFlowError('WITHDRAWAL_PROOF_ACCOUNT_CONFLICT');
  }
  if (!proof) {
    proof = createProof(user.id, cryptoProvider);
    await verifySaved(store, proof);
  }

  const tokenHash = await capabilityDigest(proof.token, cryptoProvider);
  const receipt = await gateway.prepareReceipt(proof.requestId, tokenHash);
  if (receipt?.request_id !== proof.requestId || receipt?.state !== 'pending') {
    throw new DeletionFlowError('WITHDRAWAL_RECEIPT_CONFLICT');
  }

  let result;
  try {
    result = await gateway.deleteAuthenticated();
  } catch (error) {
    if (!(error instanceof DeletionFlowError) || !error.uncertain) throw error;
    return terminalCheck(gateway, store, proof);
  }
  if (completed(result)) {
    await store.remove(proof);
    return { state: 'completed', requestId: proof.requestId };
  }
  if (pending(result)) {
    return { state: 'pending', requestId: proof.requestId };
  }
  throw new DeletionFlowError(result?.error || 'UNKNOWN', {
    status: result?.status ?? null,
  });
}

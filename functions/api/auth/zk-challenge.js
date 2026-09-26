// POST /api/auth/zk-challenge — retired. It issued nonces for the experimental
// private-upload proofs, which are disabled because their verifier accepts false
// statements (see tests/unigroth-risk.test.cjs). Uploads use a signed session.
export async function onRequestPost() {
  return Response.json({ error: 'Experimental ZK uploads are disabled. Use a signed session.', code: 'zk_disabled' }, { status: 410 });
}

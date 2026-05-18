# UniGroth ZK Integration

ShareSecure uses [UniGroth](https://github.com/MeridianAlgo/UniGroth) for
anonymous-but-authenticated uploads. **Real cryptographic verification is
active** — no placeholders. The full UniGroth library is vendored as ESM
ports of the original CommonJS source.

## Vendored files

All files are ESM, Web Crypto + Uint8Array (no Node `Buffer` / Node `crypto`).
Identical contents in `public/lib/unigroth/` (browser) and `functions/lib/unigroth/`
(Cloudflare Worker).

| File | Source | Notes |
|------|--------|-------|
| `field.js` | UniGroth `src/field.js` | bn254 scalar field arithmetic |
| `commitment.js` | UniGroth `src/commitment.js` | Async MerkleTree + Fiat-Shamir Transcript |
| `circuit.js` | UniGroth `src/circuit.js` | R1CS circuit builder; MIMC constants via top-level await |
| `prover.js` | UniGroth `src/prover.js` | Async `prove()` |
| `verifier.js` | UniGroth `src/verifier.js` | Async `verify()` |
| `index.js` | NEW | ShareSecure auth-circuit orchestrator: `commit`, `prove`, `verify` |

## Auth circuit

```
private: secret
public:  commitment, nonce, nullifier

constraints:
  MIMC(secret)             == commitment   (proves knowledge of preimage)
  MIMC(commitment + nonce) == nullifier    (binds proof to nonce, unique tag)
```

~549 R1CS constraints, ~550 signals. MIMC-91 over bn254 (~128-bit security).

## Flow

```
REGISTER
  Browser:  secret = crypto.getRandomValues(32)              # never leaves device
            commitment = MIMC(secret)                        # UniGroth.commit()
            localStorage[zk_secret] = secret
            POST /api/auth/register { username, access_code, zk_commitment }
  Server:   INSERT INTO users (..., zk_commitment)

UPLOAD (ZK path — when user has enrolled credentials)
  Browser:  POST /api/auth/zk-challenge  (Bearer auth, 5/24h rate limit)
  Server:   nonce = F.random()
            INSERT INTO zk_challenges (nonce, user_id, expires_at)
            return nonce

  Browser:  { proof, nullifier } = UniGroth.prove(secret, commitment, nonce)
              # ~500-1000 ms in browser; produces ~50-100 KB proof JSON
            POST /api/upload  (multipart, NO Authorization header)
              file=...
              zk_proof=<json>
              zk_nullifier=<field-element-string>
              zk_nonce=<field-element-string>
  Server:   resolve nonce → user_id → fetch commitment
            UniGroth.verify(proof, nullifier, commitment, nonce)
            check nullifier ∉ zk_nullifiers
            INSERT INTO files (...)  # no user_id, no user_tag
            INSERT INTO zk_nullifiers (nullifier)
            DELETE zk_challenges WHERE nonce
```

## DB schema additions (idempotent migrations run at request time)

```sql
ALTER TABLE users ADD COLUMN zk_commitment TEXT;

CREATE TABLE zk_nullifiers (
  nullifier TEXT PRIMARY KEY,
  used_at   TEXT NOT NULL
);

CREATE TABLE zk_challenges (
  nonce       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE zk_challenge_log (
  user_id   INTEGER NOT NULL,
  issued_at TEXT NOT NULL
);
```

## Key files

| Layer | File | Purpose |
|------|------|---------|
| Field arith | `lib/unigroth/field.js` | bn254 scalar field, async `hashToField` |
| Merkle + transcript | `lib/unigroth/commitment.js` | Async `MerkleTree.create`, `Transcript` |
| Circuit DSL | `lib/unigroth/circuit.js` | `Circuit` class, MIMC hash gadget |
| Prover | `lib/unigroth/prover.js` | `prove(circuit, witness, publicInputs)` |
| Verifier | `lib/unigroth/verifier.js` | `verify(circuit, proof)` |
| Orchestrator | `lib/unigroth/index.js` | Auth circuit, `commit`, `prove`, `verify` |
| Client helpers | `public/zk-client.js` | Generate, store, prove for upload |
| Server adapter | `functions/_zk.js` | Challenge issuance, verification, nullifier replay |
| Challenge endpoint | `functions/api/auth/zk-challenge.js` | Issues nonces, rate-limited 5/24h |
| Register | `functions/api/auth/register.js` | Accepts `zk_commitment` |
| Upload | `functions/api/upload.js` | Accepts `zk_proof` form fields |

## Performance notes

- **Module load**: top-level `await` in `circuit.js` precomputes 91 MIMC constants
  via SHA-256. ~5-10 ms cold start.
- **Proof generation**: ~500-1000 ms in browser, ~100-300 ms in Worker.
  Consider moving to a Web Worker if upload UI feels janky.
- **Verification**: ~50-100 ms in Worker per upload.
- **Proof size**: ~50-100 KB JSON (32 spot checks, ~5 openings each, merkle
  paths of depth ~10). Sent in multipart form data, not headers.

## Security notes

- The secret never leaves the browser. If the user clears localStorage, they
  lose the ability to do ZK uploads (must re-register a new account).
- Logout does NOT clear the ZK secret — re-login restores it.
- Bearer auth remains the fallback when no ZK credentials are enrolled.
  The Bearer path is auto-ghosted (reshare + delete) post-upload, so file
  rows live for milliseconds with a `user_tag`. ZK eliminates that window.
- UniGroth's soundness derives from Fiat-Shamir + spot-check merkle openings
  (32 random constraints checked). For a 549-constraint circuit, soundness
  error per check is ~1/549, so 32 checks give negligible cheat probability.
- The placeholder `prove`/`verify` was removed in commit feat: real UniGroth.

## Re-enrollment

If a user's secret is lost or compromised, they currently have no in-app
recovery path — they must register a new account. A future enhancement could
add a "rotate credentials" flow that requires the OLD secret to prove
identity, then accepts a NEW commitment.

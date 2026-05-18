# UniGroth ZK Integration

ShareSecure uses [UniGroth](https://github.com/MeridianAlgo/UniGroth) for
anonymous-but-authenticated uploads. The integration scaffolding is in place;
the cryptographic core currently runs as a **placeholder** until the full
UniGroth bundle is dropped in.

## What's wired today

| Layer | File | Status |
|------|------|--------|
| Field arithmetic | `public/lib/unigroth/field.js`, `functions/lib/unigroth/field.js` | **Real** — ESM port of UniGroth's `src/field.js`, Web Crypto SHA-256 |
| Commit / prove / verify | `public/lib/unigroth/index.js`, `functions/lib/unigroth/index.js` | **Placeholder** — hash-based, not zero-knowledge |
| Client helpers | `public/zk-client.js` | **Real** — credential gen, commitment storage, challenge fetch, proof prep |
| Server adapter | `functions/_zk.js` | **Real** — schema, challenge issuance, verification dispatch, nullifier replay protection |
| Challenge endpoint | `functions/api/auth/zk-challenge.js` | **Real** — rate-limited to 5/24h per user |
| Register | `functions/api/auth/register.js` | **Real** — accepts and stores `zk_commitment` |
| Upload | `functions/api/upload.js` | **Real** — accepts `X-ZK-Proof/-Nullifier/-Nonce` headers, writes no `user_tag` when ZK |
| Client registration | `public/app.js` | **Real** — generates secret + commitment in browser at sign-up |
| Client upload | `public/app.js` | **Real** — when ZK enrolled, sends ZK headers instead of `Authorization` |

## Flow

```
REGISTER
  Browser:  secret = crypto.getRandomValues(32)
            commitment = UniGroth.commit(secret)           # H(DS_COMMIT, secret) in bn254
            localStorage[zk_secret] = secret
            POST /api/auth/register { username, access_code, zk_commitment }
  Server:   INSERT INTO users (..., zk_commitment)
            # server NEVER sees the secret

UPLOAD (with ZK)
  Browser:  POST /api/auth/zk-challenge  (Bearer auth)
  Server:   nonce = random bn254 field element
            INSERT INTO zk_challenges (nonce, user_id, expires_at)
            return nonce

  Browser:  { proof, nullifier } = UniGroth.prove(secret, commitment, nonce)
            POST /api/upload  (no Authorization header)
              X-ZK-Proof:     <proof>
              X-ZK-Nullifier: <nullifier>
              X-ZK-Nonce:     <nonce>
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

## What needs to happen to go from placeholder → real Groth16

The placeholder `prove`/`verify` in `lib/unigroth/index.js` is hash-based and
**will not provide zero-knowledge guarantees**. To swap in real UniGroth:

1. **Build the UniGroth circuit**
   - The minimum circuit asserts: *"I know `s` such that MIMC(s) == commitment"*
   - Also outputs `nullifier = MIMC(s, nonce)` as a public input
   - Compile via `UniGroth.compile(circuit)`

2. **Trusted setup (or transparent setup)**
   - UniGroth claims hash-based, transparent setup — call `UniGroth.setup()` once
   - Persist the compiled circuit (the artifact returned by `compile()`) and ship it
     to both the browser bundle and the Worker bundle.

3. **Replace the placeholder bodies**
   - In `public/lib/unigroth/index.js` and `functions/lib/unigroth/index.js`:
     ```js
     // ESM-import the real UniGroth (vendored as ./unigroth-core.js or similar)
     import { UniGroth } from './unigroth-core.js';

     // At module load (or lazily on first call):
     const compiledCircuit = UniGroth.compile(buildAuthCircuit());

     export async function prove({ secret, commitment, nonce }) {
       const proof = await UniGroth.prove(compiledCircuit, {
         secret, commitment, nonce
       });
       const nullifier = await UniGroth.mimcHash([secret, nonce]);
       return { proof: serialize(proof), nullifier: nullifier.toString() };
     }

     export async function verify({ proof, nullifier, commitment, nonce }) {
       return UniGroth.verify(compiledCircuit, deserialize(proof));
     }
     ```

4. **Port UniGroth's remaining files** (`circuit.js`, `prover.js`, `verifier.js`)
   from CommonJS + Node `crypto`/`Buffer` to ESM + Web Crypto / Uint8Array.
   `field.js` and `commitment.js` are already ported as a reference.

5. **Decide on proof serialization**
   - JSON-friendly: array of decimal field element strings, embeddable in
     HTTP headers (HTTP/2 frame size limit ~16 KB after base64 — Groth16
     proofs are ~200 bytes serialized, so this is comfortable)

6. **Performance**
   - Proof generation is CPU-heavy (~100–500 ms in browser). Consider moving
     `UniGroth.prove()` into a Web Worker so the upload UI stays responsive.

## Security notes

- The secret never leaves the browser. If the user clears localStorage, they
  lose the ability to do ZK uploads (must re-register).
- Logout does NOT clear the ZK secret — re-login restores it. This is
  intentional: clearing the secret has no server-side recovery path.
- The placeholder verifier accepts ANY well-formed inputs. **Do not deploy
  the placeholder to production as the only auth path** — leave the existing
  Bearer auth as the primary until real Groth16 is wired in.
- The Bearer fallback path still runs through the auto-ghost flow, so even
  without ZK, file rows live for milliseconds with a `user_tag` before being
  reshare+delete-cleaned. ZK eliminates that millisecond window entirely.

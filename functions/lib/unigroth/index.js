// UniGroth orchestrator for ShareSecure
// Builds the auth circuit, runs prove/verify, derives commitment + nullifier.
//
// Auth circuit:
//   private: secret
//   public:  commitment, nonce, nullifier
//   asserts:
//     MIMC(secret)            == commitment
//     MIMC(commitment + nonce) == nullifier
//
// The verifier learns: "the prover knows some `s` whose MIMC hash equals
// `commitment`, and `nullifier` is bound to `s` and `nonce`." Without `s`,
// the verifier cannot link `nullifier` back to `commitment` across uses.

import * as F from './field.js';
import { Circuit, MIMC_CONSTANTS, MIMC_ROUNDS } from './circuit.js';
import { prove as uniProve } from './prover.js';
import { verify as uniVerify } from './verifier.js';

// In-circuit MIMC == out-of-circuit MIMC. Used to compute commitment + nullifier
// values BEFORE we run the prover (the prover needs them as inputs).
export function mimcHash(input) {
  let x = F.toBigInt(input);
  for (let i = 0; i < MIMC_ROUNDS; i++) {
    x = F.add(x, MIMC_CONSTANTS[i]);
    x = F.mul(F.mul(x, x), x);
  }
  return x;
}

let _authCircuit = null;
function getAuthCircuit() {
  if (_authCircuit) return _authCircuit;
  const c = new Circuit('sharesecure_auth');
  const secret     = c.privateInput('secret');
  const commitment = c.publicInput('commitment');
  const nonce      = c.publicInput('nonce');
  const nullifier  = c.publicInput('nullifier');

  const h1 = c.hash(secret);
  c.assertEqual(h1, commitment);

  const combined = c.add(h1, nonce);
  const h2 = c.hash(combined);
  c.assertEqual(h2, nullifier);

  _authCircuit = c;
  return c;
}

// Compute the commitment for a fresh secret. Run once at registration.
// Returns a decimal string of a bn254 field element.
export async function commit(secret) {
  return mimcHash(secret).toString();
}

// Generate a proof of knowledge of the secret behind `commitment`, bound to `nonce`.
// Returns { proof, nullifier } — proof is a serializable object, nullifier is a string.
export async function prove({ secret, commitment, nonce }) {
  const secretField     = F.toBigInt(secret);
  const commitmentField = F.toBigInt(commitment);
  const nonceField      = F.toBigInt(nonce);

  const expected = mimcHash(secretField);
  if (!F.eq(expected, commitmentField)) {
    throw new Error('commit(secret) does not match stored commitment');
  }

  const nullifierField = mimcHash(F.add(expected, nonceField));

  const circuit = getAuthCircuit();
  const witness = circuit.computeWitness({
    secret:     secretField,
    commitment: commitmentField,
    nonce:      nonceField,
    nullifier:  nullifierField,
  });

  const fullProof = await uniProve(circuit, witness, {
    commitment: commitmentField.toString(),
    nonce:      nonceField.toString(),
    nullifier:  nullifierField.toString(),
  });

  // Strip parts the verifier never reads (blindedEvals is unused; metadata is
  // informational). Saves ~80% of wire size on a 547-constraint circuit.
  const wireProof = {
    protocol:           fullProof.protocol,
    curve:              fullProof.curve,
    witnessCommitment:  fullProof.witnessCommitment,
    blindingCommitment: fullProof.blindingCommitment,
    aggregatedCheck:    fullProof.aggregatedCheck,
    spotChecks:         fullProof.spotChecks,
    publicInputs:       fullProof.publicInputs,
  };

  return {
    proof:     wireProof,
    nullifier: nullifierField.toString(),
  };
}

// Verify a wire-format proof against expected public inputs.
export async function verify({ proof, nullifier, commitment, nonce }) {
  if (!proof || !nullifier || !commitment || !nonce) return false;

  // 1. Sanity-check the proof claims the right public inputs
  if (proof.publicInputs?.nullifier  !== nullifier)  return false;
  if (proof.publicInputs?.commitment !== commitment) return false;
  if (proof.publicInputs?.nonce      !== nonce)      return false;

  // 2. Run UniGroth verifier
  try {
    const circuit = getAuthCircuit();
    const result = await uniVerify(circuit, proof);
    return result.passed === true;
  } catch {
    return false;
  }
}

export { F as Field, getAuthCircuit };

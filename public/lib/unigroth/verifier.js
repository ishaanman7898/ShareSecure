// UniGroth verifier — verifies zero-knowledge proofs
// Browser ESM port: async (Web Crypto inside).
// Source: github.com/MeridianAlgo/UniGroth/blob/main/src/verifier.js (ISC)
//
// Hardened: the verifier never trusts values it can recompute. Spot-check
// indices are re-derived from the Fiat-Shamir transcript, every opening must be
// a Merkle path to the exact leaf position of its signal, every signal a
// checked constraint touches must be opened, and the constant-one signal and
// all public inputs must be opened and equal their claimed values.

import * as F from './field.js';
import { MerkleTree, Transcript, hexToBytes } from './commitment.js';

const MAX_SPOT_CHECKS = 32;

// Number of Merkle layers above the leaves for a tree of n leaves (matches MerkleTree._build).
function treeDepth(n) {
  let len = n, depth = 0;
  while (len > 1) { len = Math.ceil(len / 2); depth++; }
  return depth;
}

// Spot-check indices exactly as the prover derives them from gamma.
export function spotCheckIndices(gamma, nConstraints) {
  const count = Math.min(MAX_SPOT_CHECKS, nConstraints);
  const out = [];
  for (let i = 0; i < count; i++) {
    const idx = Number(F.mod(F.add(gamma, BigInt(i))) % BigInt(nConstraints));
    if (!out.includes(idx)) out.push(idx);
  }
  return out;
}

function isFieldString(v) {
  return typeof v === 'string' && /^\d{1,80}$/.test(v) && BigInt(v) < F.ORDER;
}

// Verify one opening: value is a field element and the path leads from leaf
// position `sigIdx` (and only that position) to the committed root.
async function openingValid(sigIdx, opening, root, depth) {
  if (!opening || !isFieldString(opening.value) || !Array.isArray(opening.proof)) return false;
  if (opening.proof.length !== depth) return false;
  let idx = sigIdx;
  const path = [];
  for (const step of opening.proof) {
    const expected = idx % 2 === 0 ? 'right' : 'left';
    if (step?.position !== expected || typeof step.hash !== 'string' || step.hash.length !== 64) return false;
    path.push({ hash: hexToBytes(step.hash), position: step.position });
    idx = Math.floor(idx / 2);
  }
  return MerkleTree.verify(BigInt(opening.value), path, root);
}

function fail(results, name, detail) {
  results.checks.push({ name, passed: false, detail });
  results.passed = false;
  return results;
}

export async function verify(circuit, proof) {
  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  const results = { checks: [], passed: true };

  if (!proof || typeof proof !== 'object') return fail(results, 'format', 'proof missing');
  if (!/^[0-9a-f]{64}$/.test(proof.witnessCommitment || '') || !/^[0-9a-f]{64}$/.test(proof.blindingCommitment || '')) {
    return fail(results, 'format', 'bad commitments');
  }
  if (!Array.isArray(proof.spotChecks) || !proof.publicInputs || !proof.publicOpenings) {
    return fail(results, 'format', 'missing spot checks or public openings');
  }

  const nSignals = circuit.nSignals;
  const nConstraints = circuit.constraints.length;
  const depth = treeDepth(nSignals);

  // 1. Parse commitments
  const witnessRoot = hexToBytes(proof.witnessCommitment);
  const blindRoot   = hexToBytes(proof.blindingCommitment);

  // 2. Rebuild fiat-shamir transcript (must match prover)
  const transcript = await Transcript.create('unigroth_prove_v1');
  await transcript.absorbBytes(witnessRoot);
  await transcript.absorbBytes(blindRoot);

  const claimed = {};
  for (const pi of circuit.publicInputs) {
    const pubVal = proof.publicInputs[pi.name];
    if (!isFieldString(pubVal)) return fail(results, 'public_input', `missing or invalid: ${pi.name}`);
    claimed[pi.index] = BigInt(pubVal);
    await transcript.absorb(claimed[pi.index]);
  }

  // 3. Derive challenges (same order as the prover)
  await transcript.squeeze();            // alpha
  await transcript.squeeze();            // beta
  const gamma = await transcript.squeeze();

  // 4. Bind the committed witness to the constant one and the public inputs
  const bound = { 0: 1n, ...claimed };
  for (const [idxStr, value] of Object.entries(bound)) {
    const idx = Number(idxStr);
    const opening = proof.publicOpenings[idx];
    if (!(await openingValid(idx, opening, witnessRoot, depth)) || BigInt(opening.value) !== value) {
      return fail(results, `public_opening_${idx}`, 'committed value does not match');
    }
  }
  results.checks.push({ name: 'public_inputs_bound', passed: true, detail: 'constant and public inputs opened' });

  // 5. Aggregated constraint check (prover-supplied; informational)
  if (!F.eq(BigInt(proof.aggregatedCheck ?? 1), 0n)) return fail(results, 'aggregated_constraint_check', 'T != 0');

  // 6. Spot checks at transcript-derived indices only
  const expected = spotCheckIndices(gamma, nConstraints);
  if (proof.spotChecks.length !== expected.length) {
    return fail(results, 'spot_checks', `expected ${expected.length}, got ${proof.spotChecks.length}`);
  }

  for (let k = 0; k < expected.length; k++) {
    const sc = proof.spotChecks[k];
    if (!sc || sc.constraintIndex !== expected[k] || !sc.openings) {
      return fail(results, `spot_check_${k}`, 'constraint index not derived from transcript');
    }
    const con = circuit.constraints[expected[k]];
    const needed = new Set([...Object.keys(con.a), ...Object.keys(con.b), ...Object.keys(con.c)].map(Number));

    const values = {};
    for (const sigIdx of needed) {
      const opening = sc.openings[sigIdx];
      if (!(await openingValid(sigIdx, opening, witnessRoot, depth))) {
        return fail(results, `merkle_opening_${sigIdx}`, 'opening missing or not bound to its position');
      }
      values[sigIdx] = BigInt(opening.value);
      if (sigIdx in bound && values[sigIdx] !== bound[sigIdx]) {
        return fail(results, `merkle_opening_${sigIdx}`, 'inconsistent with public input');
      }
    }

    const lc = terms => Object.entries(terms).reduce((acc, [i, coeff]) => F.add(acc, F.mul(coeff, values[Number(i)])), 0n);
    if (!F.eq(F.mul(lc(con.a), lc(con.b)), lc(con.c))) {
      return fail(results, `constraint_${expected[k]}`, 'constraint not satisfied');
    }
  }

  results.checks.push({ name: 'spot_checks_summary', passed: true, detail: `${expected.length}/${expected.length} spot checks passed` });

  const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  results.verifyTimeMs = Math.round((t1 - t0) * 100) / 100;
  return results;
}
